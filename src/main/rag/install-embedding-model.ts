import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const MODEL_REVISION = "4de13258303883538bd53b696b452bf8099f0858";
const MODEL_URL = `https://huggingface.co/Xenova/bge-m3/resolve/${MODEL_REVISION}/`;

interface ModelFile {
  relativePath: string;
  bytes: number;
  sha256: string;
}

// Matches the filenames loaded by Transformers.js v2's quantized feature-extraction pipeline.
const MODEL_FILES: readonly ModelFile[] = [
  { relativePath: "config.json", bytes: 770, sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95" },
  { relativePath: "tokenizer_config.json", bytes: 1173, sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4" },
  { relativePath: "tokenizer.json", bytes: 17082821, sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790" },
  { relativePath: "onnx/model_quantized.onnx", bytes: 569694530, sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d" },
];

interface InstallerOptions {
  request?: typeof fetch;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

async function fileStat(filePath: string, followLinks = true) {
  try {
    return await (followLinks ? fs.stat(filePath) : fs.lstat(filePath));
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export function createLocalEmbeddingModelInstaller(
  files: readonly ModelFile[],
  { request = fetch, totalTimeoutMs = 30 * 60_000, idleTimeoutMs = 45_000 }: InstallerOptions = {},
) {
  const inFlight = new Map<string, Promise<void>>();

  async function isComplete(destination: string): Promise<boolean> {
    const stats = await Promise.all(files.map(({ relativePath }) => fileStat(path.join(destination, relativePath))));
    // Existing models can be user-provided, including a different compatible revision.
    return stats.every((stat) => stat?.isFile() && stat.size > 0);
  }

  async function download(file: ModelFile, stagingDir: string, totalSignal: AbortSignal): Promise<void> {
    totalSignal.throwIfAborted();
    const filePath = path.join(stagingDir, file.relativePath);
    const partialPath = `${filePath}.partial`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("连接或下载在等待数据时超时")), idleTimeoutMs);
    const signal = AbortSignal.any([totalSignal, controller.signal]);
    try {
      const response = await request(`${MODEL_URL}${file.relativePath}`, {
        signal,
        headers: { "Accept-Encoding": "identity" },
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      timeout.refresh();

      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      if (length !== null && (!encoding || encoding === "identity") && Number(length) !== file.bytes) {
        throw new Error("服务器返回的文件长度与模型清单不一致");
      }

      const hash = createHash("sha256");
      let bytes = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          timeout.refresh();
          bytes += chunk.length;
          if (bytes > file.bytes) {
            callback(new Error("下载的数据超过预期文件长度"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
      await pipeline(body, verify, createWriteStream(partialPath, { flags: "wx" }), { signal });
      if (bytes !== file.bytes || hash.digest("hex") !== file.sha256) {
        throw new Error("文件长度或 SHA-256 校验不符");
      }
      await fs.rename(partialPath, filePath);
    } catch (error) {
      const cause = signal.aborted ? signal.reason : error;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`BGE-M3 文件 ${file.relativePath} 下载失败：${message}`, { cause });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async function install(destination: string): Promise<void> {
    if (await isComplete(destination)) return;
    if (await fileStat(destination, false)) {
      throw new Error(`BGE-M3 模型目录不完整。请将现有目录移到其他位置后重试：${destination}`);
    }

    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    const resolvedParent = await fs.realpath(parent);
    const stagingDir = await fs.mkdtemp(path.join(resolvedParent, ".bge-m3-"));
    const totalSignal = AbortSignal.timeout(totalTimeoutMs);
    try {
      for (const file of files) await download(file, stagingDir, totalSignal);
      totalSignal.throwIfAborted();

      // Publishing the directory in one rename keeps the runtime from seeing partial files.
      try {
        await fs.rename(stagingDir, destination);
      } catch (error) {
        if (!await isComplete(destination)) throw error;
      }
    } finally {
      // Only remove the generated sibling directory in the resolved model parent.
      if (path.dirname(path.resolve(stagingDir)) === resolvedParent) {
        await fs.rm(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      }
    }
  }

  return function installForUserData(userDataDir: string): Promise<void> {
    const destination = path.resolve(userDataDir, "models", "Xenova", "bge-m3");
    const key = process.platform === "win32" ? destination.toLowerCase() : destination;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = install(destination).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  };
}

export const installLocalEmbeddingModel = createLocalEmbeddingModelInstaller(MODEL_FILES);
