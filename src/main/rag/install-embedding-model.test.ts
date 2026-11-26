import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalEmbeddingModelInstaller } from "./install-embedding-model";

const files = [
  { relativePath: "config.json", contents: "fixture config" },
  { relativePath: "onnx/model_quantized.onnx", contents: "fixture binary" },
];
const manifest = files.map(({ relativePath, contents }) => ({
  relativePath,
  bytes: Buffer.byteLength(contents),
  sha256: createHash("sha256").update(contents).digest("hex"),
}));

describe("local embedding model installation", () => {
  let root: string;
  let destination: string;
  let modelParent: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-embedding-installer-"));
    modelParent = path.join(root, "models", "Xenova");
    destination = path.join(modelParent, "bge-m3");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("deduplicates concurrent clicks and publishes only after all files are verified", async () => {
    const lastFileRequested = Promise.withResolvers<void>();
    const releaseLastFile = Promise.withResolvers<void>();
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      const file = files.find(({ relativePath }) => url.pathname.endsWith(`/${relativePath}`));
      if (!file) return new Response(null, { status: 404 });
      if (file === files[1]) {
        lastFileRequested.resolve();
        await releaseLastFile.promise;
      }
      return new Response(file.contents, { headers: { "content-length": String(Buffer.byteLength(file.contents)) } });
    });
    const install = createLocalEmbeddingModelInstaller(manifest, { request });

    const first = install(root);
    expect(install(path.join(root, "."))).toBe(first);
    try {
      await lastFileRequested.promise;
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseLastFile.resolve();
      await first;
    }

    expect(request).toHaveBeenCalledTimes(files.length);
    for (const [input] of request.mock.calls) {
      expect(String(input)).toMatch(/^https:\/\/huggingface\.co\/Xenova\/bge-m3\/resolve\/[a-f0-9]{40}\//);
    }
    for (const file of files) {
      await expect(fs.readFile(path.join(destination, file.relativePath), "utf8")).resolves.toBe(file.contents);
    }
    await expect(fs.readdir(modelParent)).resolves.toEqual(["bge-m3"]);
  });

  it("preserves an existing complete model from a different revision", async () => {
    for (const file of files) {
      const filePath = path.join(destination, file.relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "existing content");
    }
    const request = vi.fn<typeof fetch>();
    const install = createLocalEmbeddingModelInstaller(manifest, { request });

    await install(root);
    expect(request).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(destination, files[1].relativePath), "utf8")).resolves.toBe("existing content");
  });

  it("preserves an incomplete pre-existing model and explains how to retry", async () => {
    const existing = path.join(destination, files[0].relativePath);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(existing, "manual content");
    const request = vi.fn<typeof fetch>();
    const install = createLocalEmbeddingModelInstaller(manifest, { request });

    await expect(install(root)).rejects.toThrow("模型目录不完整");
    expect(request).not.toHaveBeenCalled();
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("manual content");
  });

  it("cleans a checksum failure and allows the same user to retry", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(files[0].contents))
      .mockResolvedValueOnce(new Response("x".repeat(manifest[1].bytes)))
      .mockResolvedValueOnce(new Response(files[0].contents))
      .mockResolvedValueOnce(new Response(files[1].contents));
    const install = createLocalEmbeddingModelInstaller(manifest, { request });

    await expect(install(root)).rejects.toThrow("SHA-256");
    await expect(fs.readdir(modelParent)).resolves.toEqual([]);
    await expect(install(root)).resolves.toBeUndefined();
    await expect(fs.readdir(modelParent)).resolves.toEqual(["bge-m3"]);
  });

  it("rejects a response that exceeds the pinned size even with no Content-Length header", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${files[0].contents}extra`));
    const install = createLocalEmbeddingModelInstaller(manifest, { request });

    await expect(install(root)).rejects.toThrow("超过预期文件长度");
    await expect(fs.readdir(modelParent)).resolves.toEqual([]);
  });

  it("aborts a stalled body and removes its staging directory", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream()));
    const install = createLocalEmbeddingModelInstaller(manifest, { request, idleTimeoutMs: 30 });

    await expect(install(root)).rejects.toThrow("等待数据时超时");
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(fs.readdir(modelParent)).resolves.toEqual([]);
  });
});
