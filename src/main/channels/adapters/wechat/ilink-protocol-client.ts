// iLink Protocol Client —— 直接打微信 iLink Bot API 的 HTTP 协议客户端。
// 零依赖（只用 Node 22 内置 fetch + crypto.randomUUID），不走任何 ESM SDK。
//
// 参考实现：
//   - weclaw (Go): github.com/fastclaw-ai/weclaw
//   - 协议文档:    https://www.wechatbot.dev/zh/protocol
//
// Base URL: https://ilinkai.weixin.qq.com + /ilink/bot/...
// weclaw (Go): github.com/fastclaw-ai/weclaw
// 协议文档:    https://www.wechatbot.dev/zh/protocol
import { randomUUID } from "node:crypto";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS = 35_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ItemType = 1 | 2 | 3 | 4 | 5;  // text|image|voice|file|video
export type MessageType = 1;               // 摘要只描述了 user→bot 类型
export enum MediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE = 3,
  VOICE = 4,
}

export interface Credentials {
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;            // 一般就是 BASE_URL
  ilinkUserId: string;
  /** 显示用的账号 id（用 ilinkBotId @ 之前的一段，或完整） */
  accountId?: string;
}

/** 入站消息（已展开成单一形状） */
export interface WeixinMessage {
  msgId: string;
  fromUserId: string;
  toUserId: string;
  msgType: number;            // 1=user, 2=bot echo
  content: string;            // 从 item_list[].text_item.text 提取
  items: WeixinItem[];
  contextToken: string;       // ⚠️ 回复时原样带回
  createTimeMs?: number;
  raw: unknown;
}

/** iLink item 形状（与 SDK WireMessageItem 一致） */
export interface WeixinItem {
  type: ItemType;             // 1=text 2=image 3=voice 4=file 5=video
  text_item?: { text: string };
  image_item?: any;
  voice_item?: any;
  file_item?: any;
  video_item?: any;
}

/** iLink 原始 WireMessage 形状（snake_case） */
export interface WireMessage {
  message_id?: number | string;
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state?: number;
  context_token: string;
  create_time_ms?: number;
  item_list: WeixinItem[];
  [k: string]: unknown;
}

/** getupdates 响应（iLink 真实字段名：snake_case + msgs） */
interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WireMessage[];                // ← 真实字段是 msgs，不是 messages
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface CDNMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type?: 0 | 1;
  full_url?: string;
}

export interface SendMessageItem {
  type: ItemType;
  text_item?: { text: string };
  image_item?: any;
  voice_item?: any;
  file_item?: any;
  video_item?: any;
}

export interface GetUploadUrlRequest {
  filekey: string;
  media_type: MediaType;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResponse {
  upload_param: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export interface ILinkClientOptions {
  /** 注入的随机 wechat-uin 生成器（测试时可固定） */
  wechatUin?: string;
  requestTimeoutMs?: number;
  longPollTimeoutMs?: number;
}

export class ILinkClient {
  private baseUrl: string;
  private botToken: string;
  private botId: string;
  private wechatUin: string;
  private requestTimeoutMs: number;
  private longPollTimeoutMs: number;

  constructor(creds: Credentials, opts: ILinkClientOptions = {}) {
    this.baseUrl = (creds.baseUrl || BASE_URL).replace(/\/+$/, "");
    this.botToken = creds.botToken.trim();
    this.botId = creds.ilinkBotId;
    this.wechatUin = opts.wechatUin ?? randomWechatUin();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.longPollTimeoutMs = opts.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS + 5_000;
  }

  botUserId(): string {
    return this.botId;
  }

  // ── Long poll loop ────────────────────────────────────────────────────────

  /**
   * Long-poll for new messages.
   * 后端最长挂 35 秒；如果返回就立刻拿新 get_updates_buf 再次请求。
   * 收到会话过期（ret=-14）抛 SessionExpired。
   * signal：调用方（适配器停止）中止时立刻打断在途请求，不必等本次 long-poll 自然返回。
   */
  async getUpdates(buf = "", signal?: AbortSignal): Promise<{ messages: WeixinMessage[]; buf: string; pollCompleted?: boolean }> {
    try {
      const resp = await this.doJson<unknown>("POST", "/ilink/bot/getupdates", {
        get_updates_buf: buf,
        base_info: { channel_version: "2.0.0" },
      }, { signal }, this.longPollTimeoutMs);

      const data = resp as GetUpdatesResponse;
      assertApiSuccess(data, "getupdates");

      // 跳过 bot 自己发出去的消息（message_type=2）
      const wires = (data.msgs ?? []).filter((m) => m.message_type === 1);
      return {
        messages: wires.map((m) => this.#wireToMessage(m)),
        buf: data.get_updates_buf || buf,
        pollCompleted: true,
      };
    } catch (error) {
      // A quiet long poll timing out is normal; keep the last successful cursor.
      if (error instanceof RequestTimeoutError && !signal?.aborted) return { messages: [], buf, pollCompleted: false };
      throw error;
    }
  }

  /** 把 iLink WireMessage（snake_case + item_list）转成我们用的 WeixinMessage */
  #wireToMessage(w: WireMessage): WeixinMessage {
    // 提取文本：遍历 item_list 找 text_item.text
    const text = (w.item_list ?? [])
      .filter((it) => it.type === 1 && it.text_item?.text)
      .map((it) => it.text_item!.text)
      .join("");
    return {
      msgId: String(w.message_id ?? ""),
      fromUserId: w.from_user_id,
      toUserId: w.to_user_id,
      msgType: w.message_type,
      content: text,
      items: w.item_list ?? [],
      contextToken: w.context_token,
      createTimeMs: w.create_time_ms,
      raw: w,
    };
  }

  // ── Send ────────────────────────────────────────────────────────────────

  /** 发文本消息（最常用） */
  async sendText(toUserId: string, text: string, contextToken: string): Promise<{ ok: boolean; error?: string }> {
    return this.sendMessage(toUserId, [{ type: 1, text_item: { text } }], contextToken);
  }

  /**
   * 通用 sendmessage。
   * @param toUserId 收信人 user id（从入站消息的 from_user_id 拿）
   * @param itemList 包含 1 个或多个 item（text/image/voice/file/video）
   * @param contextToken 从入站消息原样带回
   */
  async sendMessage(
    toUserId: string,
    itemList: SendMessageItem[],
    contextToken: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      // iLink 真实协议（与 corespeed-io/wechatbot SDK 完全一致）：
      //   - from_user_id: "" 空字符串（出站消息不携带 from，服务端用 token 鉴权）
      //   - client_id: 随机 UUID（消息唯一 ID，服务端用来去重/排序）
      //   - to_user_id: 真实接收者
      //   - message_type: 2=bot
      //   - message_state: 2=finish
      //   - item_list: [{ type: 1, text_item: { text } }]
      const resp = await this.doJson<unknown>("POST", "/ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: itemList,
        },
        base_info: { channel_version: "2.0.0" },
      });
      assertApiSuccess(resp as ApiResult, "sendmessage");
      return { ok: true };
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      return { ok: false, error: String(err) };
    }
  }

  async getUploadUrl(req: GetUploadUrlRequest): Promise<GetUploadUrlResponse> {
    const resp = await this.doJson<unknown>("POST", "/ilink/bot/getuploadurl", {
      ...req,
      base_info: { channel_version: "2.0.0" },
    });
    const data = resp as GetUploadUrlResponse & ApiResult;
    assertApiSuccess(data, "getuploadurl");
    return data;
  }

  // ── Typing ──────────────────────────────────────────────────────────────

  /** 拉 typing_ticket（per-user） */
  async getConfig(userId: string, contextToken: string): Promise<{ typingTicket?: string }> {
    try {
      const resp = await this.doJson<unknown>("POST", "/ilink/bot/getconfig", {
        ilink_user_id: userId,
        context_token: contextToken,
      });
      const data = resp as { ret?: number; typing_ticket?: string; errmsg?: string };
      if (data.ret === 0) {
        return { typingTicket: data.typing_ticket };
      }
      return {};
    } catch {
      return {};
    }
  }

  /** 发送"正在输入" */
  async sendTyping(userId: string, typingTicket: string, status: 1 | 2 = 1): Promise<void> {
      await this.doJson<unknown>("POST", "/ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
    });
  }

  // ── Low level ───────────────────────────────────────────────────────────

  private async doJson<T>(method: string, path: string, body: unknown, init?: RequestInit, timeoutMs = this.requestTimeoutMs): Promise<T> {
    return requestJson<T>(this.baseUrl + path, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
      ...init,
    }, timeoutMs);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${this.botToken}`,
      "X-WECHAT-UIN": this.wechatUin,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login flow (anonymous client)
// ─────────────────────────────────────────────────────────────────────────────

export interface QrCodeResp {
  qrcode: string;
  qrcode_img_content: string;   // base64 PNG
}

export interface QrStatusResp {
  status: "init" | "scanned" | "confirmed" | "expired" | string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** 拿登录二维码 */
export async function fetchQrCode(signal?: AbortSignal): Promise<QrCodeResp> {
  const uin = randomWechatUin();
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const data = await requestJson<QrCodeResp & ApiResult>(url, { headers: { "X-WECHAT-UIN": uin }, signal }, REQUEST_TIMEOUT_MS);
  assertApiSuccess(data, "get_bot_qrcode");
  if (!data.qrcode || !data.qrcode_img_content) throw new Error("微信未返回有效二维码，请重试");
  return data;
}

/** 轮询扫码状态（long-poll 40s） */
export async function pollQrStatus(qrcode: string, signal?: AbortSignal, baseUrl = BASE_URL): Promise<QrStatusResp> {
  const uin = randomWechatUin();
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  return requestJson<QrStatusResp>(url, {
    headers: { "X-WECHAT-UIN": uin },
    signal,
  }, LONG_POLL_TIMEOUT_MS + 5_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export class SessionExpiredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SessionExpiredError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(operation: string) { super(`微信请求超时：${operation}`); this.name = "RequestTimeoutError"; }
}

type ApiResult = { ret?: number; errcode?: number };
function assertApiSuccess(data: ApiResult, operation: string): void {
  if (data.ret === -14 || data.errcode === -14) throw new SessionExpiredError(`微信登录已失效：${operation} (ret=${data.ret ?? 0}, errcode=${data.errcode ?? 0})`);
  if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) {
    throw new Error(`微信接口失败：${operation} (ret=${data.ret ?? 0}, errcode=${data.errcode ?? 0})`);
  }
}

async function requestJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const external = init.signal;
  const signal = external ? AbortSignal.any([external, timeout.signal]) : timeout.signal;
  const operation = new URL(url).pathname.split("/").pop()!;
  try {
    const res = await fetch(url, { ...init, signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`微信 HTTP ${res.status}：${operation}`);
    // Node 24 exposes the original numeric token, so uint64 message IDs retain precision.
    return JSON.parse(text, (key: string, value: unknown, context?: { source: string }) =>
      ["message_id", "msg_id", "svr_id"].includes(key) && typeof value === "number" ? context?.source ?? String(value) : value,
    ) as T;
  } catch (error) {
    if (external?.aborted) throw external.reason ?? new DOMException("Aborted", "AbortError");
    if (timeout.signal.aborted) throw new RequestTimeoutError(operation);
    throw error;
  } finally { clearTimeout(timer); }
}

function randomWechatUin(): string {
  // weclaw 实现：随 uint32 → 字符串 → base64
  const n = (Math.random() * 0xffffffff) >>> 0;
  const s = String(n);
  return Buffer.from(s, "utf8").toString("base64");
}
