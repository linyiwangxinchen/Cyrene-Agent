import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import type extract from "extract-zip";

type Options = extract.Options;
type Entry = Parameters<NonNullable<Options["onEntry"]>>[0];
type Zip = Parameters<NonNullable<Options["onEntry"]>>[1];
const yauzl = createRequire(require.resolve("extract-zip"))("yauzl") as {
  fromBuffer(buffer: Buffer, options: object, callback: (error: Error | null, zip: Zip) => void): void;
};

/** Keep yauzl's format/size validation, but avoid its file-backed fd-slicer
 * stream which stalls on large entries with Windows Node 24. Archives are
 * already bounded by the installer; each extracted file is also size/CRC checked.
 */
export async function extractPluginArchive(file: string, options: Options, maxArchiveBytes: number): Promise<void> {
  const buffer = await readFile(file);
  if (buffer.length > maxArchiveBytes) throw new Error("ZIP 文件超过大小限制");
  await mkdir(options.dir, { recursive: true });
  const root = await realpath(options.dir);
  const zip = await new Promise<Zip>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, archive) => error ? reject(error) : resolve(archive));
  });
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const fail = (error: unknown) => { if (!finished) { finished = true; zip.close(); reject(error); } };
    zip.once("error", fail);
    zip.once("end", () => { if (!finished) { finished = true; zip.close(); resolve(); } });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        if (finished) return;
        if (entry.fileName.startsWith("__MACOSX/")) { zip.readEntry(); return; }
        options.onEntry?.(entry, zip);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) throw new Error("ZIP 不允许包含符号链接");
        const target = path.resolve(root, entry.fileName);
        const relative = path.relative(root, target);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("ZIP 路径越界");
        const directory = entry.fileName.endsWith("/") || (mode & 0xf000) === 0x4000
          || ((entry.versionMadeBy >>> 8) === 0 && entry.externalFileAttributes === 16);
        await mkdir(directory ? target : path.dirname(target), { recursive: true });
        const parent = await realpath(directory ? target : path.dirname(target));
        const parentRelative = path.relative(root, parent);
        if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw new Error("ZIP 路径越界");
        if (!directory) {
          const input = await new Promise<Readable>((res, rej) => zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream!)));
          let size = 0, crc = 0;
          const integrity = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > entry.uncompressedSize) return callback(new Error("ZIP 实际解压大小超过声明"));
            crc = crc32(chunk, crc);
            callback(null, chunk);
          } });
          await pipeline(input, integrity, createWriteStream(target, { flags: "wx", mode: (mode & 0o777) || 0o644 }),
            { signal: AbortSignal.timeout(60_000) });
          if (size !== entry.uncompressedSize || crc !== entry.crc32) throw new Error("ZIP 条目完整性校验失败");
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}
