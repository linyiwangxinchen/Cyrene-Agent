export const WECHAT_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
export const WECHAT_MEDIA_TIMEOUT_MS = 120_000;

export async function withWechatMediaTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("微信媒体传输超时，请稍后重试")), options.timeoutMs ?? WECHAT_MEDIA_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    signal.throwIfAborted();
    return await operation(signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally { clearTimeout(timer); }
}

/** Bound memory even when the CDN omits Content-Length. */
export async function readWechatMediaResponse(response: Response, signal: AbortSignal): Promise<Buffer> {
  const limit = WECHAT_MEDIA_MAX_BYTES + 16; // AES padding
  if (Number(response.headers?.get("content-length")) > limit) throw new Error("微信媒体超过本程序的 64 MiB 传输上限");
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("微信媒体超过本程序的 64 MiB 传输上限");
    signal.throwIfAborted();
    return bytes;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("微信媒体超过本程序的 64 MiB 传输上限");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
