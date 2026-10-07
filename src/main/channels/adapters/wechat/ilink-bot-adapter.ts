// ILink Bot Adapter —— 用 iLinkProtocolClient 包出 ChannelAdapter。
//
// 流程：
//   微信用户发消息
//     └─ ILinkClient.getUpdates() (long-poll 35s)
//           └─ adapter.onMessage() → dispatcher → buildAndRunAgent → OutgoingMessage
//                 └─ ILinkClient.sendText() → POST /sendmessage → 微信
//
// 凭据存盘：<userData>/weixin/<botId>.json
// （首次运行需在 UI 点"扫码登录"生成；之后自动续用）
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { decode, isSilk } from "silk-wasm";
import {
  ILinkClient,
  MediaType,
  pollQrStatus,
  RequestTimeoutError,
  SessionExpiredError,
  type CDNMedia,
  type Credentials,
  type SendMessageItem,
  type WeixinMessage,
} from "./ilink-protocol-client";
import { uploadWechatMedia, uploadWechatMediaFile } from "./wechat-media-upload";
import { downloadWechatMedia } from "./wechat-media-download";
import { encodeWechatVoiceSilk } from "./wechat-voice-encoding";
import {
  SAVE_INTENT_TTL_MS,
  buildUnsupportedWechatFilePrompt,
  buildWechatAsrFailedPrompt,
  buildWechatAsrMissingPrompt,
  buildWechatSaveSuccessPrompt,
  buildWechatSaveIntentPrompt,
  buildWechatVideoPrompt,
  describeInboundWechatMedia,
  getWechatDisplayName,
  isWechatSaveIntent,
  type InboundMediaDescriptor,
} from "./inbound-media";
import { getAsrConfig, type AsrConfig } from "../../../asr/asr-config";
import { createAsrStream } from "../../../asr/asr-dispatcher";
import type {
  ChannelAttachment,
  ChannelCapability,
  ChannelId,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
} from "../../types";
import type { ChannelAdapter } from "../base";
import { logger, LogTag } from "../../../logger";
import { loadChannelsSettings } from "../../settings-store";

const LOG_PREFIX = "[WechatBot]";
const USER_PROFILE_FILE = "user-profile.json";

interface PendingInboundMedia {
  media: InboundMediaDescriptor;
  messageId: string;
  expiresAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: false,
  file: true,
  video: true,
  markdown: false,
  card: false,
  sticker: true,
  maxTextLength: 2048,
};

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export class ILinkBotAdapter implements ChannelAdapter {
  constructor(private readonly onStatusChanged?: () => void) {}
  readonly id: ChannelId = "wechat";
  readonly displayName = "微信";
  readonly capability = CAPABILITY;

  /** 由 ChannelManager.setDispatcher 注入 */
  onMessage: MessageHandler | null = null;

  private client: ILinkClient | null = null;
  private pollAbort: AbortController | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  /** 账号是否已登录（凭证存在） */
  isLoggedIn = false;
  /** 当前 credentials（动态加载） */
  currentCredentials: Credentials | null = null;
  private replyContextByTarget = new Map<string, string>();
  private pendingSaveIntentByTarget = new Map<string, number>();
  private pendingUnsupportedMediaByTarget = new Map<string, PendingInboundMedia>();
  private uploadMedia = uploadWechatMediaFile;
  private uploadMediaData = uploadWechatMedia;
  private downloadMedia = downloadInboundWechatMedia;
  private saveInboundMedia = saveInboundWechatMedia;
  private transcribeVoice = transcribeInboundWechatVoice;
  private isAsrConfigured = isWechatAsrConfigured;
  private encodeVoice = encodeWechatVoiceSilk;

  status: ChannelStatus = { enabled: false, phase: "offline" };

  // ── ChannelAdapter ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.pollAbort) await this.stop();
    const configured = loadChannelsSettings().wechat.enabled;
    if (!configured) {
      await this.stop();
      this.status = { enabled: false, phase: "offline", message: "微信未启用" };
      return;
    }
    this.status = { enabled: true, phase: "starting", message: "正在验证微信收消息连接" };
    logger.info(LogTag.Wechat, "Starting...");

    // 1. 加载已存凭证
    const creds = await loadCredentials();
    if (!creds) {
      this.status = {
        enabled: true,
        phase: "config_missing",
        message: "未登录，请先扫码",
      };
      console.log(LOG_PREFIX, "No credentials, please run /wechat login");
      return;
    }

    this.currentCredentials = creds;
    this.client = new ILinkClient(creds);
    this.isLoggedIn = true;

    // 2. 启动 long-poll 循环
    this.pollAbort = new AbortController();
    this.pollLoopPromise = this.#pollLoop();

  }

  async stop(): Promise<void> {
    console.log(LOG_PREFIX, "Stopping...");
    this.status = { enabled: false, phase: "offline", message: "微信未启用" };
    this.onStatusChanged?.();
    this.pollAbort?.abort();
    if (this.pollLoopPromise) {
      try {
        await this.pollLoopPromise;
      } catch {}
      this.pollLoopPromise = null;
    }
    this.pollAbort = null;
    this.client = null;
    this.isLoggedIn = false;
    this.status = { enabled: false, phase: "offline", message: "微信未启用" };
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.status.enabled) return { ok: false, error: "微信未连接" };
    const client = this.client;
    const contextToken = this.replyContextByTarget.get(msg.targetId);
    if (!contextToken) return { ok: false, error: "缺少微信 context_token，无法回复" };
    const sendMessage = (items: SendMessageItem[]) =>
      this.client === client && this.status.enabled
        ? client.sendMessage(msg.targetId, items, contextToken)
        : Promise.resolve({ ok: false, error: "channel_disabled" });

    let anyOk = false;
    let lastErr: string | undefined;

    for (const part of msg.parts) {
      if (this.client !== client || !this.status.enabled) return { ok: false, error: "channel_disabled" };
      if (part.kind === "text") {
        const text = part.text.trim();
        if (!text) continue;
        const textResult = await this.client.sendText(msg.targetId, text, contextToken);
        if (textResult.ok) {
          anyOk = true;
        } else {
          lastErr = textResult.error ?? "微信文本发送失败";
          console.warn(LOG_PREFIX, "text_item 发送失败:", lastErr);
        }
      } else if (part.kind === "image") {
        if (!part.filePath) return { ok: false, error: "微信图片发送需要本地 filePath" };
        const media = await this.uploadMedia(this.client, msg.targetId, part.filePath, MediaType.IMAGE);
        const result = await sendMessage([buildImageItem(media)]);
        if (result.ok) anyOk = true;
        else {
          lastErr = result.error ?? "微信图片发送失败";
          console.warn(LOG_PREFIX, "image_item 发送失败:", lastErr);
        }
      } else if (part.kind === "sticker") {
        const media = await this.uploadMedia(this.client, msg.targetId, part.imagePath, MediaType.IMAGE);
        const result = await sendMessage([buildImageItem(media)]);
        if (result.ok) anyOk = true;
        else {
          lastErr = result.error ?? "微信表情发送失败";
          console.warn(LOG_PREFIX, "sticker image_item 发送失败:", lastErr);
        }
      } else if (part.kind === "audio") {
        const voice = await this.buildVoiceItem(msg.targetId, part.filePath).catch((err) => {
          console.warn(LOG_PREFIX, "voice_item 构造失败（跳过语音）:", err instanceof Error ? err.message : err);
          return null;
        });
        if (voice) {
          const result = await sendMessage([voice]);
          if (result.ok) anyOk = true;
          else {
            lastErr = result.error ?? "微信语音发送失败";
            console.warn(LOG_PREFIX, "voice_item 发送失败:", lastErr);
          }
        }
      } else if (part.kind === "file") {
        const media = await this.uploadMedia(this.client, msg.targetId, part.filePath, MediaType.FILE);
        const result = await sendMessage([buildFileItem(media, path.basename(part.name ?? part.filePath))]);
        if (result.ok) anyOk = true;
        else {
          lastErr = result.error ?? "微信文件发送失败";
          console.warn(LOG_PREFIX, "file_item 发送失败:", lastErr);
        }
      } else if (part.kind === "video") {
        const media = await this.uploadMedia(this.client, msg.targetId, part.filePath, MediaType.VIDEO);
        const result = await sendMessage([buildVideoItem(media)]);
        if (result.ok) anyOk = true;
        else {
          lastErr = result.error ?? "微信视频发送失败";
          console.warn(LOG_PREFIX, "video_item 发送失败:", lastErr);
        }
      }
    }
    if (!anyOk && lastErr) return { ok: false, error: lastErr };
    return { ok: true };
  }

  private async buildVoiceItem(targetId: string, filePath: string): Promise<SendMessageItem> {
    if (!this.client) throw new Error("微信未连接");
    const source = await fs.readFile(filePath);
    const encoded = await this.encodeVoice(source, { format: "wav" });
    const media = await this.uploadMediaData(this.client, targetId, encoded.data, MediaType.VOICE);
    return buildVoiceItem(media, encoded.durationMs, encoded.sampleRate, encoded.encodeType);
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  // ── Login UI flow ────────────────────────────────────────────────────────

  /**
   * 扫码登录入口（由 init.ts 调用）。
   * init.ts 已经调用过 fetchQrCode() + createQrDataUrl() 把 PNG 推到 renderer，
   * 这里只负责等扫码结果。
   *
   * @param qrcode  原始 qrcode 字符串（由 init.ts 传入）
   */
  async login(qrcode: string, signal?: AbortSignal): Promise<Credentials> {
    console.log(LOG_PREFIX, "Waiting for QR scan...");
    let baseUrl = "https://ilinkai.weixin.qq.com";
    const deadline = Date.now() + 5 * 60_000;

    while (true) {
      if (signal?.aborted) throw new Error("login aborted");
      if (Date.now() >= deadline) throw new Error("二维码登录超时，请重新扫码");
      let status: Awaited<ReturnType<typeof pollQrStatus>>;
      try {
        status = await pollQrStatus(qrcode, signal, baseUrl);
      } catch (err) {
        // timeout 是正常的 long-poll，继续
        if (signal?.aborted) throw new Error("login aborted");
        if (!(err instanceof RequestTimeoutError)) {
          console.warn(LOG_PREFIX, "QR polling failed:", err instanceof Error ? err.message : String(err));
          await waitForRetry(2_000, signal);
        }
        continue;
      }
      console.log(LOG_PREFIX, "QR status:", status.status);
      if (status.status === "scaned_but_redirect" && status.redirect_host) {
        const redirect = new URL(`https://${status.redirect_host}`);
        if (!redirect.hostname.endsWith(".weixin.qq.com") || redirect.port || redirect.username || redirect.password) throw new Error("微信返回了不受支持的登录重定向地址");
        baseUrl = redirect.origin;
        continue;
      }
      if (status.status === "need_verifycode" || status.status === "verify_code_blocked") throw new Error("微信要求手机配对验证，请重新扫码登录");
      if (status.status === "binded_redirect") throw new Error("该二维码对应已绑定的客户端，请重新生成二维码登录");
      if (status.status === "confirmed") {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error("confirmed but missing bot_token or ilink_bot_id");
        }
        const creds: Credentials = {
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          baseUrl: status.baseurl || baseUrl,
          ilinkUserId: status.ilink_user_id ?? "",
        };
        if (signal?.aborted) throw new Error("login aborted");
        await saveCredentials(creds);
        return creds;
      }
      if (status.status === "expired") {
        throw new Error("二维码已过期，请重新扫码");
      }
      // pending/scanning — 继续轮询
    }
  }

  /** 注销（删除凭证文件） */
  async logout(): Promise<void> {
    await this.stop();
    await deleteCredentials();
    this.currentCredentials = null;
    this.isLoggedIn = false;
    this.status = { enabled: false, phase: "offline", message: "已登出" };
  }

  // ── Internal: poll loop ──────────────────────────────────────────────────

  async #pollLoop(): Promise<void> {
    if (!this.client || !this.pollAbort) return;
    // 捕获本轮轮询的信号：stop() 会把它置空，循环体只认这一个信号。
    const signal = this.pollAbort.signal;
    const client = this.client;
    let buf = "";
    let sessionExpired = false;
    let failures = 0;
    let timeoutCount = 0;
    let receivedMessages = 0;
    let lastPollAt: string | undefined;

    while (!signal.aborted && !sessionExpired) {
      try {
        const { messages, buf: newBuf, pollCompleted } = await client.getUpdates(buf, signal);
        if (signal.aborted) break;
        if (pollCompleted === false) {
          if (++timeoutCount >= 2) throw new Error("微信收消息请求持续超时，正在重连");
          continue;
        }
        timeoutCount = 0;
        if (this.status.phase !== "running") console.log(LOG_PREFIX, "Receive polling connected");
        failures = 0;
        lastPollAt = new Date().toISOString();
        receivedMessages += messages.length;
        this.status = { enabled: true, phase: "running", message: "微信已连接", detail: { lastPollAt, receivedMessages, consecutiveFailures: 0 } };
        this.onStatusChanged?.();
        buf = newBuf;
        for (const msg of messages) {
          if (signal.aborted) break;
          try { await this.dispatchInbound(msg); }
          catch (error) { console.warn(LOG_PREFIX, "Inbound processing failed:", error instanceof Error ? error.message : String(error)); }
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          console.warn(LOG_PREFIX, "Session expired — please re-login");
          sessionExpired = true;
          this.isLoggedIn = false;
          this.status = {
            enabled: true,
            phase: "error",
            message: "会话已过期，请重新扫码登录",
          };
          this.onStatusChanged?.();
          break;
        }
        if (signal.aborted) break;
        const error = err instanceof Error ? err.message : String(err);
        failures++;
        this.status = { enabled: true, phase: "error", message: `收消息失败，正在重试：${error}`, detail: { lastPollAt, receivedMessages, consecutiveFailures: failures } };
        this.onStatusChanged?.();
        if (failures === 1 || failures % 10 === 0) console.warn(LOG_PREFIX, "Receive polling failed:", error);
        await waitForRetry(Math.min(2_000 * 2 ** Math.min(failures - 1, 4), 30_000), signal);
      }
    }
  }

  private async dispatchInbound(msg: WeixinMessage): Promise<void> {
    if (!this.status.enabled) return;
    const client = this.client;
    if (!this.onMessage) {
      console.warn(LOG_PREFIX, "onMessage 未注入，跳过消息");
      return;
    }
    console.log(LOG_PREFIX, `inbound received: items=${msg.items.length}, textLength=${msg.content?.length ?? 0}`);
    this.replyContextByTarget.set(msg.fromUserId, msg.contextToken);

    const media = describeInboundWechatMedia(msg.items);
    const voiceText = await this.#maybeTranscribeInboundVoice(msg, media);
    if (voiceText === null) return;
    const intercept = await this.#maybeInterceptInboundMedia(msg, media);
    if (intercept.handled) {
      if (intercept.text) void this.#sendInterceptText(msg.fromUserId, msg.contextToken, intercept.text);
      return;
    }
    const attachments = await this.#downloadInboundAttachments(msg, media);
    if (attachments === null) return;

    const incoming: IncomingMessage = {
      channel: "wechat",
      senderId: msg.fromUserId,
      chatId: msg.fromUserId,
      // 透传平台消息 ID：turn ID 由此保持稳定，同一入站消息重投不会重复执行
      messageId: msg.msgId,
      text: voiceText || msg.content || "",
      attachments: attachments.length > 0 ? attachments : undefined,
      at: new Date(),
      _raw: msg,
    };

    if (!this.status.enabled || this.client !== client) return;
    void this.onMessage(incoming).catch((err) => {
      console.error(LOG_PREFIX, "dispatcher error:", err);
    });
  }

  async #maybeInterceptInboundMedia(msg: WeixinMessage, media: InboundMediaDescriptor[]): Promise<{ handled: boolean; text?: string }> {
    const now = Date.now();
    this.#clearExpiredInboundState(msg.fromUserId, now);

    const username = loadWechatPreferredName();
    const text = msg.content ?? "";

    if (isWechatSaveIntent(text)) {
      const mediaToSave = firstSaveableMedia(media);
      if (mediaToSave) {
        const result = await this.#saveInboundMedia(mediaToSave, msg.msgId || String(now), username);
        return { handled: true, text: result };
      }
      const pending = this.pendingUnsupportedMediaByTarget.get(msg.fromUserId);
      if (pending) {
        const result = await this.#saveInboundMedia(pending.media, pending.messageId, username);
        this.pendingUnsupportedMediaByTarget.delete(msg.fromUserId);
        return { handled: true, text: result };
      }
      this.pendingSaveIntentByTarget.set(msg.fromUserId, now + SAVE_INTENT_TTL_MS);
      return { handled: true, text: buildWechatSaveIntentPrompt(username) };
    }

    if (media.length === 0) return { handled: false };

    const saveIntentUntil = this.pendingSaveIntentByTarget.get(msg.fromUserId);
    if (saveIntentUntil !== undefined) {
      const mediaToSave = firstSaveableMedia(media);
      if (mediaToSave) {
        this.pendingSaveIntentByTarget.delete(msg.fromUserId);
        const result = await this.#saveInboundMedia(mediaToSave, msg.msgId || String(now), username);
        return { handled: true, text: result };
      }
    }

    const video = media.find((item) => item.kind === "video");
    if (video) {
      if (this.pendingSaveIntentByTarget.has(msg.fromUserId)) {
        this.pendingSaveIntentByTarget.delete(msg.fromUserId);
        const result = await this.#saveInboundMedia(video, msg.msgId || String(now), username);
        return { handled: true, text: result };
      }
      this.pendingUnsupportedMediaByTarget.set(msg.fromUserId, { media: video, messageId: msg.msgId || String(now), expiresAt: now + SAVE_INTENT_TTL_MS });
      return { handled: true, text: buildWechatVideoPrompt(username) };
    }

    const voice = media.find((item) => item.kind === "voice");
    if (voice && !this.isAsrConfigured()) {
      return { handled: true, text: buildWechatAsrMissingPrompt(username) };
    }

    const unsupportedFile = media.find((item) => item.kind === "file" && !item.analyzable);
    if (unsupportedFile) {
      if (this.pendingSaveIntentByTarget.has(msg.fromUserId)) {
        this.pendingSaveIntentByTarget.delete(msg.fromUserId);
        const result = await this.#saveInboundMedia(unsupportedFile, msg.msgId || String(now), username);
        return { handled: true, text: result };
      }
      this.pendingUnsupportedMediaByTarget.set(msg.fromUserId, { media: unsupportedFile, messageId: msg.msgId || String(now), expiresAt: now + SAVE_INTENT_TTL_MS });
      return { handled: true, text: buildUnsupportedWechatFilePrompt(username) };
    }

    return { handled: false };
  }

  async #saveInboundMedia(
    media: InboundMediaDescriptor,
    messageId: string,
    username: string,
  ): Promise<string> {
    try {
      const filePath = await this.saveInboundMedia(media, messageId);
      return buildWechatSaveSuccessPrompt(username, filePath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(LOG_PREFIX, "入站媒体保存失败:", reason);
      return `${username}，这个文件保存失败啦：${reason}`;
    }
  }

  async #maybeTranscribeInboundVoice(msg: WeixinMessage, media: InboundMediaDescriptor[]): Promise<string | undefined | null> {
    const voice = media.find((item) => item.kind === "voice");
    if (!voice) return undefined;

    const username = loadWechatPreferredName();
    if (!this.isAsrConfigured()) {
      await this.#sendInterceptText(msg.fromUserId, msg.contextToken, buildWechatAsrMissingPrompt(username));
      return null;
    }

    try {
      const transcript = (await this.transcribeVoice(voice, msg.msgId || String(Date.now()))).trim();
      if (!transcript) {
        await this.#sendInterceptText(msg.fromUserId, msg.contextToken, buildWechatAsrFailedPrompt(username, "没有识别到文字"));
        return null;
      }
      return transcript;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(LOG_PREFIX, "入站语音识别失败:", reason);
      await this.#sendInterceptText(msg.fromUserId, msg.contextToken, buildWechatAsrFailedPrompt(username, reason));
      return null;
    }
  }

  async #downloadInboundAttachments(msg: WeixinMessage, media: InboundMediaDescriptor[]): Promise<ChannelAttachment[] | null> {
    const attachments: ChannelAttachment[] = [];
    for (const item of media) {
      if (item.kind !== "image" && !(item.kind === "file" && item.analyzable)) continue;
      if (!item.media) {
        await this.#sendInterceptText(msg.fromUserId, msg.contextToken, `${loadWechatPreferredName()}，这个微信附件缺少下载信息，可以再发一次试试看哦~~`);
        return null;
      }
      try {
        const downloaded = await this.downloadMedia(item, msg.msgId || String(Date.now()));
        attachments.push({
          kind: item.kind === "image" ? "image" : "file",
          filePath: downloaded.filePath,
          mime: downloaded.mime,
          caption: item.fileName,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(LOG_PREFIX, "入站媒体下载失败:", reason);
        await this.#sendInterceptText(msg.fromUserId, msg.contextToken, `${loadWechatPreferredName()}，这个微信附件下载失败啦：${reason}。可以再发一次试试看哦~~`);
        return null;
      }
    }
    return attachments;
  }

  #clearExpiredInboundState(targetId: string, now: number): void {
    const saveIntentUntil = this.pendingSaveIntentByTarget.get(targetId);
    if (saveIntentUntil !== undefined && saveIntentUntil <= now) {
      this.pendingSaveIntentByTarget.delete(targetId);
    }
    const pendingMedia = this.pendingUnsupportedMediaByTarget.get(targetId);
    if (pendingMedia && pendingMedia.expiresAt <= now) {
      this.pendingUnsupportedMediaByTarget.delete(targetId);
    }
  }

  async #sendInterceptText(toUserId: string, contextToken: string, text: string): Promise<void> {
    if (!this.client || !this.status.enabled) return;
    const result = await this.client.sendText(toUserId, text, contextToken);
    if (!result.ok) {
      console.warn(LOG_PREFIX, "入站媒体拦截回复发送失败:", result.error);
    }
  }
}

function buildImageItem(media: CDNMedia): SendMessageItem {
  return {
    type: 2,
    image_item: { media },
  };
}

function buildFileItem(media: CDNMedia, fileName: string): SendMessageItem {
  return {
    type: 4,
    file_item: {
      file_name: fileName,
      media,
    },
  };
}

function buildVideoItem(media: CDNMedia): SendMessageItem {
  return {
    type: 5,
    video_item: {
      media,
    },
  };
}

function buildVoiceItem(media: CDNMedia, playtime: number, sampleRate: number, encodeType: number): SendMessageItem {
  return {
    type: 3,
    voice_item: {
      media,
      encode_type: encodeType,
      sample_rate: sampleRate,
      playtime,
    },
  };
}

function firstSaveableMedia(media: InboundMediaDescriptor[]): InboundMediaDescriptor | undefined {
  return media.find((item) =>
    (item.kind === "image" || item.kind === "file" || item.kind === "video") && Boolean(item.media),
  );
}

interface DownloadedInboundMedia {
  filePath: string;
  mime: string;
}

async function downloadInboundWechatMedia(
  item: InboundMediaDescriptor,
  messageId: string,
): Promise<DownloadedInboundMedia> {
  if (!item.media) throw new Error("缺少媒体下载参数");
  const data = await downloadWechatMedia(item.media);
  const ext = pickInboundExtension(item, data);
  const cacheDir = path.join(app.getPath("userData"), "channels", "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, buildStoredFileName("wechat", messageId, item.fileName || item.kind, ext));
  await fs.writeFile(filePath, data);
  return { filePath, mime: mimeFromExtension(ext) };
}

async function saveInboundWechatMedia(
  item: InboundMediaDescriptor,
  messageId: string,
): Promise<string> {
  if (!item.media) throw new Error("缺少媒体下载参数");
  const data = await downloadWechatMedia(item.media);
  const ext = pickInboundExtension(item, data);
  const inboxDir = path.join(app.getPath("desktop"), "Cyrene 收件箱");
  await fs.mkdir(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, buildStoredFileName("wechat", messageId, item.fileName || item.kind, ext));
  await fs.writeFile(filePath, data);
  return filePath;
}

async function transcribeInboundWechatVoice(
  item: InboundMediaDescriptor,
  _messageId: string,
): Promise<string> {
  if (!item.media) throw new Error("缺少语音下载参数");
  const cfg = getAsrConfig();
  if (!cfg
      || (cfg.engine === "aliyun" && (!cfg.appKey || !cfg.accessKeyId || !cfg.accessKeySecret))
      || ((cfg.engine === "mossland" || cfg.engine === "minimax") && !cfg.apiKey)) {
    throw new Error("ASR 未配置");
  }

  const source = await downloadWechatMedia(item.media);
  const sampleRate = item.sampleRate ?? 16000;
  if (sampleRate !== 16000) {
    throw new Error(`暂不支持 ${sampleRate}Hz 微信语音识别`);
  }

  let pcm = source;
  if (isSilk(source)) {
    const decoded = await decode(source, sampleRate);
    pcm = Buffer.from(decoded.data);
  }
  return transcribePcmWithConfiguredAsr(pcm, cfg);
}

async function transcribePcmWithConfiguredAsr(pcm: Buffer, cfg: AsrConfig): Promise<string> {
  const finals: string[] = [];
  const stream = createAsrStream(
    cfg,
    () => {},
    (text) => {
      if (text.trim()) finals.push(text.trim());
    },
  );

  if (cfg.engine === "mossland" || cfg.engine === "minimax") {
    await stream.start();
    stream.sendAudio(pcm);
    const completed = await stream.stop();
    const result = (completed || finals.join("")).trim();
    if (result) return result;
    throw new Error("没有识别到文字");
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stream.stop();
      const result = finals.join("").trim();
      if (result) resolve(result);
      else reject(new Error("ASR timeout"));
    }, 15_000);

    stream.start()
      .then(async () => {
        await delay(500);
        stream.sendAudio(pcm);
        stream.stop();
        await delay(2500);
        clearTimeout(timeout);
        const result = finals.join("").trim();
        if (result) resolve(result);
        else reject(new Error("没有识别到文字"));
      })
      .catch((err) => {
        clearTimeout(timeout);
        stream.stop();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickInboundExtension(item: InboundMediaDescriptor, data: Buffer): string {
  if (item.extension) return item.extension;
  if (item.kind === "image") return inferImageExtension(data) ?? ".jpg";
  return ".bin";
}

function inferImageExtension(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return ".gif";
  if (data.length >= 12 && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "BM") return ".bmp";
  return undefined;
}

function mimeFromExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".txt":
    case ".md":
    case ".markdown":
    case ".log":
    case ".csv":
    case ".tsv": return "text/plain";
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default: return "application/octet-stream";
  }
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return sanitized || "attachment";
}

function buildStoredFileName(prefix: string, messageId: string, fileName: string, ext: string): string {
  const parsed = path.parse(fileName);
  const base = sanitizeFileName(parsed.name || fileName);
  return `${sanitizeFileName(prefix)}-${sanitizeFileName(messageId)}-${Date.now()}-${base}${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials storage
// ─────────────────────────────────────────────────────────────────────────────

function credPath(): string {
  return path.join(app.getPath("userData"), "weixin", "credentials.json");
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(credPath(), "utf8");
    const creds = JSON.parse(raw) as Credentials;
    if (!creds.botToken || !creds.ilinkBotId) return null;
    return creds;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: Credentials): Promise<void> {
  const p = credPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(creds, null, 2), "utf8");
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function deleteCredentials(): Promise<void> {
  try {
    await fs.unlink(credPath());
  } catch {}
}

function loadWechatPreferredName(): string {
  try {
    const filePath = path.join(app.getPath("userData"), USER_PROFILE_FILE);
    const raw = require("node:fs").readFileSync(filePath, "utf8") as string;
    const profile = JSON.parse(raw) as { callPreference?: unknown };
    return getWechatDisplayName(profile.callPreference);
  } catch {
    return "伙伴";
  }
}

function isWechatAsrConfigured(): boolean {
  try {
    const filePath = path.join(app.getPath("userData"), "app-settings.json");
    const raw = require("node:fs").readFileSync(filePath, "utf8") as string;
    const settings = JSON.parse(raw) as {
      asrEngine?: unknown;
      asrAliyunAppKey?: unknown;
      asrAliyunAccessKeyId?: unknown;
      asrAliyunAccessKeySecret?: unknown;
      ttsMosslandKey?: unknown;
      asrMinimaxKey?: unknown;
    };
    if (settings.asrEngine === "local") return true;
    if (settings.asrEngine === "mossland") {
      return Boolean(typeof settings.ttsMosslandKey === "string" && settings.ttsMosslandKey.trim());
    }
    if (settings.asrEngine === "minimax") {
      return Boolean(typeof settings.asrMinimaxKey === "string" && settings.asrMinimaxKey.trim());
    }
    if (settings.asrEngine !== "aliyun") return false;
    return Boolean(
      typeof settings.asrAliyunAppKey === "string" && settings.asrAliyunAppKey.trim()
      && typeof settings.asrAliyunAccessKeyId === "string" && settings.asrAliyunAccessKeyId.trim()
      && typeof settings.asrAliyunAccessKeySecret === "string" && settings.asrAliyunAccessKeySecret.trim(),
    );
  } catch {
    return false;
  }
}
