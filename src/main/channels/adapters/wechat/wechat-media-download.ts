import { createDecipheriv } from "node:crypto";
import type { CDNMedia } from "./ilink-protocol-client";
import { readWechatMediaResponse, withWechatMediaTimeout } from "./wechat-media-transfer";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface DownloadOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function decodeWechatAesKey(value: string): Buffer {
  const raw = value.trim();
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) {
    return decoded;
  }

  const decodedText = decoded.toString("utf8");
  if (/^[0-9a-fA-F]{32}$/.test(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }

  throw new Error("unsupported WeChat AES key format");
}

export function decryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export async function downloadWechatMedia(
  media: CDNMedia,
  options: DownloadOptions = {},
): Promise<Buffer> {
  return withWechatMediaTimeout(async (signal) => {
    const encryptQueryParam = media.encrypt_query_param?.trim();
    if (!encryptQueryParam && !media.full_url) throw new Error("missing WeChat media download URL");
    const fetchImpl = options.fetchImpl ?? fetch;
    const url = media.full_url || `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam!)}`;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !(parsed.hostname.endsWith(".cdn.weixin.qq.com") || parsed.hostname === "cdn.weixin.qq.com")) throw new Error("不受支持的微信媒体下载地址");
    const response = await fetchImpl(url, { signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CDN download failed: HTTP ${response.status}`);
    }
    const encrypted = await readWechatMediaResponse(response, signal);
    return media.encrypt_type === 0 ? encrypted : decryptAesEcb(encrypted, decodeWechatAesKey(media.aes_key));
  }, options);
}
