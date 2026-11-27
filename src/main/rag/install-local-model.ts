import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

interface ModelFile {
  relativePath: string;
  bytes: number;
  sha256: string;
}

interface LocalModel {
  name: string;
  directory: readonly string[];
  repository: string;
  revision: string;
  files: readonly ModelFile[];
}

// The pinned ModelScope trees contain the byte-identical Xenova files used by
// Transformers.js v2. Keeping the same BGE-M3 weights preserves existing vectors.
export const BGE_M3: LocalModel = {
  name: "BGE-M3",
  directory: ["Xenova", "bge-m3"],
  repository: "Xenova/bge-m3",
  revision: "0bccab823e9e294c2940cbed845be6b3292d61ae",
  files: [
    { relativePath: "config.json", bytes: 770, sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95" },
    { relativePath: "tokenizer_config.json", bytes: 1173, sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4" },
    { relativePath: "tokenizer.json", bytes: 17082821, sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790" },
    { relativePath: "onnx/model_quantized.onnx", bytes: 569694530, sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d" },
  ],
};

export const BGE_RERANKER: LocalModel = {
  name: "bge-reranker-base",
  directory: ["bge-reranker-base"],
  repository: "Xenova/bge-reranker-base",
  revision: "74ab3f01e5063880e3e840c243239fe7c67ff668",
  files: [
    { relativePath: "config.json", bytes: 782, sha256: "b6575b9d5be20d6747417c8e20c5a0db1636356e0b6d422d7244c628423c4d4c" },
    { relativePath: "tokenizer_config.json", bytes: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" },
    { relativePath: "tokenizer.json", bytes: 17098079, sha256: "48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c" },
    { relativePath: "onnx/model_quantized.onnx", bytes: 279301077, sha256: "dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244" },
  ],
};

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

export function createLocalModelInstaller(
  model: LocalModel,
  { request = fetch, totalTimeoutMs = 30 * 60_000, idleTimeoutMs = 45_000 }: InstallerOptions = {},
) {
  const inFlight = new Map<string, Promise<void>>();

  async function isComplete(destination: string): Promise<boolean> {
    const stats = await Promise.all(model.files.map(({ relativePath }) => fileStat(path.join(destination, relativePath))));
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
      const url = new URL(`https://www.modelscope.cn/api/v1/models/${model.repository}/repo`);
      url.searchParams.set("Revision", model.revision);
      url.searchParams.set("FilePath", file.relativePath);
      const response = await request(url, {
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
      throw new Error(`${model.name} 文件 ${file.relativePath} 下载失败：${message}`, { cause });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async function install(destination: string): Promise<void> {
    if (await isComplete(destination)) return;
    if (await fileStat(destination, false)) {
      throw new Error(`${model.name} 模型目录不完整。请将现有目录移到其他位置后重试：${destination}`);
    }

    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    const resolvedParent = await fs.realpath(parent);
    const stagingDir = await fs.mkdtemp(path.join(resolvedParent, `.${path.basename(destination)}-`));
    const totalSignal = AbortSignal.timeout(totalTimeoutMs);
    try {
      for (const file of model.files) await download(file, stagingDir, totalSignal);
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
    const destination = path.resolve(userDataDir, "models", ...model.directory);
    const key = process.platform === "win32" ? destination.toLowerCase() : destination;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = install(destination).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  };
}

export const installLocalEmbeddingModel = createLocalModelInstaller(BGE_M3);
export const installLocalRerankerModel = createLocalModelInstaller(BGE_RERANKER);
