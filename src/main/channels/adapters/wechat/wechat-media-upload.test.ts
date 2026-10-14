import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadWechatMedia, MediaType } from "./wechat-media-upload";

describe("uploadWechatMedia", () => {
  afterEach(() => vi.useRealTimers());
  it("encrypts media, uses upload_full_url, and returns CDN media fields", async () => {
    const getUploadUrl = vi.fn(async () => ({
      upload_param: "fallback-param",
      upload_full_url: "https://cdn.example/upload/full",
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name.toLowerCase() === "x-encrypted-param" ? "encrypted-param" : null,
      },
    } as Response));

    const result = await uploadWechatMedia(
      { getUploadUrl },
      "wx-user-1",
      Buffer.from("hello"),
      MediaType.IMAGE,
      {
        aesKey: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
        fileKey: "file-key-1",
        fetchImpl,
      },
    );

    expect(getUploadUrl).toHaveBeenCalledWith({
      filekey: "file-key-1",
      media_type: MediaType.IMAGE,
      to_user_id: "wx-user-1",
      rawsize: 5,
      rawfilemd5: "5d41402abc4b2a76b9719d911017c592",
      filesize: 16,
      no_need_thumb: true,
      aeskey: "00112233445566778899aabbccddeeff",
    }, { signal: expect.any(AbortSignal) });
    expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example/upload/full", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    }));
    expect(result).toEqual({
      encrypt_query_param: "encrypted-param",
      aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
      encrypt_type: 1,
      rawSize: 5,
      ciphertextSize: 16,
    });
  });

  it("refuses empty buffers before requesting an upload URL", async () => {
    const getUploadUrl = vi.fn();
    await expect(uploadWechatMedia({ getUploadUrl }, "user", Buffer.alloc(0), MediaType.FILE)).rejects.toThrow("空");
    expect(getUploadUrl).not.toHaveBeenCalled();
  });
  it("times out a stuck CDN upload and clears its timer", async () => {
    vi.useFakeTimers();
    const getUploadUrl = vi.fn(async () => ({ upload_param: "upload" }));
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    const pending = uploadWechatMedia({ getUploadUrl }, "user", Buffer.from("report"), MediaType.FILE, { fetchImpl, timeoutMs: 100 });
    const check = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100); await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("requires the CDN download reference before reporting upload success", async () => {
    const getUploadUrl = vi.fn(async () => ({ upload_param: "upload" }));
    const fetchImpl = vi.fn(async () => new Response(null));
    await expect(uploadWechatMedia({ getUploadUrl }, "user", Buffer.from("report"), MediaType.FILE, { fetchImpl })).rejects.toThrow("x-encrypted-param");
  });
});
