import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { CDNMedia, GetUploadUrlRequest, GetUploadUrlResponse } from "./ilink-protocol-client";
import { MediaType } from "./ilink-protocol-client";
import { WECHAT_MEDIA_MAX_BYTES, withWechatMediaTimeout } from "./wechat-media-transfer";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface UploadClient {
  getUploadUrl(req: GetUploadUrlRequest, options?: { signal?: AbortSignal }): Promise<GetUploadUrlResponse>;
}

interface UploadOptions {
  aesKey?: Buffer;
  fileKey?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export { MediaType, WECHAT_MEDIA_MAX_BYTES };
export interface UploadedWechatMedia extends CDNMedia { rawSize: number; ciphertextSize: number }

export function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function encodeAesKeyHex(key: Buffer): string {
  return key.toString("hex");
}

function encodeAesKeyBase64(key: Buffer): string {
  return Buffer.from(key.toString("hex"), "utf8").toString("base64");
}

export async function uploadWechatMedia(
  client: UploadClient,
  userId: string,
  data: Buffer,
  mediaType: MediaType,
  options: UploadOptions = {},
): Promise<UploadedWechatMedia> {
  if (!data.length) throw new Error("不能发送空的微信附件");
  if (data.length > WECHAT_MEDIA_MAX_BYTES) throw new Error("微信附件超过本程序的 64 MiB 传输上限");
  return withWechatMediaTimeout(async (signal) => {
    const aesKey = options.aesKey ?? randomBytes(16);
    const filekey = options.fileKey ?? randomBytes(16).toString("hex");
    const ciphertext = encryptAesEcb(data, aesKey);
    const uploadParams = await client.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: userId,
      rawsize: data.length,
      rawfilemd5: createHash("md5").update(data).digest("hex"),
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: encodeAesKeyHex(aesKey),
    }, { signal });

    const uploadFullUrl = uploadParams.upload_full_url?.trim();
    if (!uploadFullUrl && !uploadParams.upload_param) {
      throw new Error("getuploadurl returned no upload URL");
    }
    const uploadUrl = uploadFullUrl
      || `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParams.upload_param)}&filekey=${encodeURIComponent(filekey)}`;

    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal,
    });
    if (!response.ok) {
      const errMsg = response.headers.get("x-error-message") ?? `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CDN upload failed: ${errMsg}`);
    }
    const encryptQueryParam = response.headers.get("x-encrypted-param");
    await response.body?.cancel().catch(() => undefined);
    if (!encryptQueryParam) {
      throw new Error("CDN upload response missing x-encrypted-param header");
    }

    return {
      encrypt_query_param: encryptQueryParam,
      aes_key: encodeAesKeyBase64(aesKey),
      encrypt_type: 1,
      rawSize: data.length,
      ciphertextSize: ciphertext.length,
    };
  }, options);
}

export async function uploadWechatMediaFile(
  client: UploadClient,
  userId: string,
  filePath: string,
  mediaType: MediaType,
  options: UploadOptions = {},
): Promise<UploadedWechatMedia> {
  options.signal?.throwIfAborted();
  const handle = await fs.open(filePath, "r");
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error("微信附件必须是非空普通文件");
    if (stat.size > WECHAT_MEDIA_MAX_BYTES) throw new Error("微信附件超过本程序的 64 MiB 传输上限");
    data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      options.signal?.throwIfAborted();
      const result = await handle.read(data, offset, data.length - offset, offset);
      if (!result.bytesRead) throw new Error("附件在读取过程中发生变化，请重新发送");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("附件在读取过程中发生变化，请重新发送");
  } finally { await handle.close(); }
  return uploadWechatMedia(client, userId, data, mediaType, options);
}
