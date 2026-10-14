import { createCipheriv } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWechatMedia } from "./wechat-media-download";

function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

describe("downloadWechatMedia", () => {
  afterEach(() => vi.useRealTimers());
  it("downloads CDN bytes and decrypts base64 hex AES keys", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const encrypted = encryptAesEcb(Buffer.from("hello image"), key);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
      text: async () => "",
    } as Response));

    const result = await downloadWechatMedia(
      {
        encrypt_query_param: "download-param",
        aes_key: Buffer.from(key.toString("hex"), "utf8").toString("base64"),
        encrypt_type: 1,
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=download-param",
      { signal: expect.any(AbortSignal), redirect: "error" },
    );
    expect(result).toEqual(Buffer.from("hello image"));
  });

  it("prefers a full CDN URL and accepts raw-byte base64 keys", async () => {
    const key = Buffer.alloc(16, 7);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(encryptAesEcb(Buffer.from("report"), key))));
    expect(await downloadWechatMedia({ encrypt_query_param: "", full_url: "https://novac2c.cdn.weixin.qq.com/c2c/full", aes_key: key.toString("base64") }, { fetchImpl })).toEqual(Buffer.from("report"));
    expect(fetchImpl.mock.calls[0][0]).toBe("https://novac2c.cdn.weixin.qq.com/c2c/full");
  });
  it("receives explicitly unencrypted media without requiring an AES key", async () => {
    const fetchImpl = vi.fn(async () => new Response("plain file"));
    expect(await downloadWechatMedia({ encrypt_query_param: "plain", aes_key: "", encrypt_type: 0 }, { fetchImpl })).toEqual(Buffer.from("plain file"));
  });
  it("rejects a foreign full URL before networking", async () => {
    const fetchImpl = vi.fn();
    await expect(downloadWechatMedia({ encrypt_query_param: "", full_url: "http://127.0.0.1/private", aes_key: "" }, { fetchImpl })).rejects.toThrow("不受支持");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects oversized responses without reading their body", async () => {
    const read = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: true, headers: new Headers({ "content-length": String(65 * 1024 * 1024) }), arrayBuffer: read } as unknown as Response));
    await expect(downloadWechatMedia({ encrypt_query_param: "large", aes_key: "", encrypt_type: 0 }, { fetchImpl })).rejects.toThrow("64 MiB");
    expect(read).not.toHaveBeenCalled();
  });
  it("cancels a stalled response body on timeout", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const downloading = downloadWechatMedia({ encrypt_query_param: "pending", aes_key: "", encrypt_type: 0 }, { fetchImpl, timeoutMs: 100 });
    const checked = expect(downloading).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(cancelled).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("passes external cancellation through to a stalled fetch", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    const pending = downloadWechatMedia({ encrypt_query_param: "pending", aes_key: "" }, { fetchImpl, signal: abort.signal });
    const check = expect(pending).rejects.toThrow("channel disabled");
    abort.abort(new Error("channel disabled")); await check;
  });
});
