import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import qr from "qr-image";
import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type EventName,
  type LarkChannel,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import {
  fetchQrCode,
  ILinkClient,
  pollQrStatus,
  type Credentials,
  type WeixinMessage,
} from "../main/channels/adapters/wechat/ilink-protocol-client";
import {
  OneBotReverseWsServer,
  resolveQqListenAuthRequirement,
  type OneBotListeningInfo,
} from "../main/channels/adapters/qq/onebot-reverse-ws";
import { oneBotId, type OneBotEvent, type OneBotMessageEvent } from "../main/channels/adapters/qq/onebot-types";
import { QqBotApiClient } from "../main/channels/adapters/qqbot/qqbot-api-client";
import { QqBotWsClient, type QqBotEventType } from "../main/channels/adapters/qqbot/qqbot-ws-client";
import type {
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  OutgoingPart,
} from "../main/channels/types";

export interface WebChannelConfig {
  channels: Record<string, unknown>;
  getChannels?: () => Promise<Record<string, unknown>>;
  patchChannels(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface WebChannelLogEntry {
  at: string;
  dir: "incoming" | "outgoing" | "error";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  hasAttachments?: boolean;
}

export interface WebExternalChat {
  sessionId: string;
  channel: string;
  chatId: string;
  chatType: "private" | "group";
  senderName?: string;
  lastAt: number;
}

export interface WebBinding {
  sessionId: string;
  conversationId: string;
  updatedAt: number;
}

interface PersistedState {
  logs: WebChannelLogEntry[];
  externalChats: WebExternalChat[];
  bindings: WebBinding[];
}

const EMPTY_STATE: PersistedState = { logs: [], externalChats: [], bindings: [] };
const CAPABILITIES: Record<string, ChannelCapability> = {
  wechat: { text: true, image: true, audio: false, file: true, video: true, markdown: false, card: false, sticker: true, maxTextLength: 2048 },
  feishu: { text: true, image: true, audio: true, file: true, video: true, markdown: true, card: true, sticker: true, maxTextLength: 4000 },
  qq: { text: true, image: true, audio: true, file: true, video: true, markdown: false, card: false, sticker: true, maxTextLength: 1500 },
  qqbot: { text: true, image: false, audio: false, file: false, video: false, markdown: true, card: true, sticker: false, maxTextLength: 2000 },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string { return typeof value === "string" ? value : ""; }

function channelSessionId(channel: string, chatId: string): string {
  return `channel:${channel}:${createHash("sha256").update(`${channel}:${chatId}`).digest("hex").slice(0, 16)}`;
}

function qrDataUrl(content: string): string {
  const image = qr.imageSync(content, { type: "png", ec_level: "M", margin: 2, size: 8 });
  return `data:image/png;base64,${image.toString("base64")}`;
}

function logText(parts: OutgoingPart[]): string {
  return parts.map((part) => {
    if (part.kind === "text") return part.text;
    if (part.kind === "card") return [part.title, part.markdown, ...(part.fields ?? []).map((field) => `${field.key}: ${field.value}`)].filter(Boolean).join("\n");
    return `[${part.kind}]`;
  }).join("\n").slice(0, 4000);
}

function isOneBotMessage(value: unknown): value is OneBotMessageEvent {
  const item = asRecord(value);
  return (item.post_type === "message" || item.post_type === "message_sent")
    && (item.message_type === "private" || item.message_type === "group")
    && Array.isArray(item.message);
}

function oneBotText(event: OneBotMessageEvent, selfId: string): string {
  const parts: string[] = [];
  for (const segment of event.message) {
    if (!segment || typeof segment !== "object") continue;
    const type = textValue((segment as { type?: unknown }).type);
    const data = asRecord((segment as { data?: unknown }).data);
    if (type === "text" || type === "markdown") parts.push(textValue(data.text ?? data.markdown ?? data.content));
    else if (type === "at") {
      const id = oneBotId(data.qq);
      if (id && id !== selfId) parts.push(` @${id} `);
    } else if (["image", "record", "file", "video", "mface", "face"].includes(type)) parts.push(`[${type === "record" ? "语音" : type}]`);
    else if (type === "reply") continue;
    else if (type) parts.push(`[未支持的消息类型:${type}]`);
  }
  return parts.join("").trim() || textValue(event.raw_message).trim() || "[空消息]";
}

function safeConfig(value: unknown): Record<string, unknown> { return asRecord(value); }

export class WebChannelRuntime {
  private state: PersistedState = structuredClone(EMPTY_STATE);
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly statuses: Record<string, ChannelStatus> = {
    wechat: { enabled: false, phase: "offline", message: "未启用" },
    feishu: { enabled: false, phase: "offline", message: "未启用" },
    qq: { enabled: false, phase: "offline", message: "未启用" },
    qqbot: { enabled: false, phase: "offline", message: "未启用" },
  };
  private feishu: LarkChannel | null = null;
  private feishuRetry: NodeJS.Timeout | null = null;
  private wechat: ILinkClient | null = null;
  private wechatAbort: AbortController | null = null;
  private wechatCredentials: Credentials | null = null;
  private wechatPoll: Promise<void> | null = null;
  private wechatLoginAbort: AbortController | null = null;
  private wechatReplyContext = new Map<string, string>();
  private qq: OneBotReverseWsServer | null = null;
  private qqClient: { call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> } | null = null;
  private qqSelfId = "";
  private qqInfo: OneBotListeningInfo | null = null;
  private qqbotApi: QqBotApiClient | null = null;
  private qqbotWs: QqBotWsClient | null = null;
  private qqbotReplyContext = new Map<string, { messageId: string; chatType: "private" | "group"; seq: number; at: number }>();
  private onMessage: ((message: IncomingMessage) => Promise<OutgoingMessage | null>) | null = null;
  private onEvent: ((event: Record<string, unknown>) => void) | null = null;

  constructor(private readonly dataDir: string, private readonly config: WebChannelConfig) {}

  setMessageHandler(handler: (message: IncomingMessage) => Promise<OutgoingMessage | null>): void { this.onMessage = handler; }
  setEventHandler(handler: (event: Record<string, unknown>) => void): void { this.onEvent = handler; }

  private statePath(): string { return path.join(this.dataDir, "web-channel-state.json"); }
  private credentialsPath(): string { return path.join(this.dataDir, "weixin", "credentials.json"); }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.statePath(), "utf8")) as Partial<PersistedState>;
      this.state = {
        logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-200) : [],
        externalChats: Array.isArray(parsed.externalChats) ? parsed.externalChats.slice(0, 200) : [],
        bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
      };
    } catch {
      this.state = structuredClone(EMPTY_STATE);
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(`${this.statePath()}.${process.pid}.tmp`, `${snapshot}\n`, { mode: 0o600 });
      const { rename } = await import("node:fs/promises");
      await rename(`${this.statePath()}.${process.pid}.tmp`, this.statePath());
    });
    await this.saveChain;
  }

  async start(): Promise<void> {
    await this.load();
    const settings = await this.configValue();
    await Promise.allSettled([
      this.startWechat(safeConfig(settings.wechat)),
      this.startFeishu(safeConfig(settings.feishu)),
      this.startQq(safeConfig(settings.qq)),
      this.startQqBot(safeConfig(settings.qqbot)),
    ]);
    this.emitStatus();
  }

  async stop(): Promise<void> {
    if (this.feishuRetry) clearTimeout(this.feishuRetry);
    this.feishuRetry = null;
    this.wechatAbort?.abort();
    this.wechatLoginAbort?.abort();
    this.wechatAbort = null;
    this.wechatPoll = null;
    this.wechat = null;
    this.wechatCredentials = null;
    this.wechatReplyContext.clear();
    if (this.feishu) await this.feishu.disconnect().catch(() => undefined);
    this.feishu = null;
    await this.qq?.stop().catch(() => undefined);
    this.qq = null;
    this.qqClient = null;
    this.qqSelfId = "";
    this.qqInfo = null;
    await this.qqbotWs?.stop().catch(() => undefined);
    this.qqbotWs = null;
    this.qqbotApi = null;
    this.qqbotReplyContext.clear();
    for (const id of ["wechat", "feishu", "qq", "qqbot"]) this.statuses[id] = { enabled: false, phase: "offline", message: "已停止" };
    this.emitStatus();
  }

  async restart(): Promise<void> { await this.stop(); await this.start(); }

  getStatuses(): Record<string, ChannelStatus> { return structuredClone(this.statuses); }
  getAuthRequirement(input: { listenMode?: unknown; customHost?: unknown }): unknown { return resolveQqListenAuthRequirement(input); }

  async test(channel: string): Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }> {
    if (channel === "feishu") {
      const settings = safeConfig((await this.configValue()).feishu);
      if (!textValue(settings.appId) || !this.secret(settings.appSecret)) return { ok: false, error: "飞书 App ID / App Secret 未配置" };
      if (!this.feishu) return { ok: false, error: this.statuses.feishu.message ?? "飞书长连接未建立" };
      try { await this.feishu.disconnect(); await this.startFeishu(settings); return this.statuses.feishu.phase === "running" ? { ok: true, detail: this.statuses.feishu.detail } : { ok: false, error: this.statuses.feishu.message }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (channel === "qq") {
      if (!this.qqClient || !this.qqSelfId) return { ok: false, error: "NapCat 尚未连接，请先启动 NapCat 反向 WebSocket" };
      try { const status = await this.qqClient.call("get_status"); return { ok: true, detail: { ...this.statuses.qq.detail, protocolStatus: status } }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (channel === "wechat") return this.wechat ? { ok: true, detail: { botId: this.wechatCredentials?.ilinkBotId } } : { ok: false, error: "微信尚未登录" };
    if (channel === "qqbot") {
      const settings = safeConfig((await this.configValue()).qqbot);
      if (!textValue(settings.appId) || !textValue(settings.appSecret)) return { ok: false, error: "QQ Bot AppID / AppSecret 未配置" };
      if (!this.qqbotApi) return { ok: false, error: this.statuses.qqbot.message ?? "QQ Bot 尚未连接" };
      try { const gateway = await this.qqbotApi.getGatewayUrl(); return { ok: true, detail: { gatewayUrl: gateway, ready: this.qqbotWs?.isReady === true } }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    return { ok: false, error: "未知渠道" };
  }

  async startWechatLogin(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (this.wechatLoginAbort) return { ok: false, error: "微信登录流程已在进行中" };
    try {
      const qrCode = await fetchQrCode();
      this.onEvent?.({ type: "CHANNELS_WECHAT_QR", dataUrl: qrDataUrl(qrCode.qrcode_img_content) });
      const controller = new AbortController();
      this.wechatLoginAbort = controller;
      void (async () => {
        try {
          while (!controller.signal.aborted) {
            const status = await pollQrStatus(qrCode.qrcode, controller.signal);
            if (status.status === "confirmed") {
              if (!status.bot_token || !status.ilink_bot_id) throw new Error("微信扫码确认结果缺少凭据");
              const credentials: Credentials = { botToken: status.bot_token, ilinkBotId: status.ilink_bot_id, baseUrl: status.baseurl ?? "https://ilinkai.weixin.qq.com", ilinkUserId: status.ilink_user_id ?? "" };
              await mkdir(path.dirname(this.credentialsPath()), { recursive: true, mode: 0o700 });
              await writeFile(this.credentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
              this.wechatLoginAbort = null;
              await this.stopWechat();
              await this.startWechat({ enabled: true });
              this.onEvent?.({ type: "CHANNELS_WECHAT_LOGIN_DONE", result: { ok: true, botId: credentials.ilinkBotId } });
              return;
            }
            if (status.status === "expired") throw new Error("二维码已过期，请重新扫码");
          }
        } catch (error) {
          this.wechatLoginAbort = null;
          if (!controller.signal.aborted) this.onEvent?.({ type: "CHANNELS_WECHAT_LOGIN_DONE", result: { ok: false, error: error instanceof Error ? error.message : String(error) } });
        }
      })();
      return { ok: true, hint: "请扫描二维码" };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async logoutWechat(): Promise<{ ok: boolean }> {
    await this.stopWechat();
    await unlink(this.credentialsPath()).catch(() => undefined);
    return { ok: true };
  }

  async getLogs(limit = 100): Promise<WebChannelLogEntry[]> { await this.load(); return this.state.logs.slice(-Math.max(1, Math.min(200, limit))).reverse(); }
  async clearLogs(): Promise<void> { await this.load(); this.state.logs = []; await this.persist(); }

  async getContext(conversations: Array<{ id: string; title: string; mode?: string; updatedAt: number }>): Promise<{ externalChats: WebExternalChat[]; bindings: WebBinding[]; conversations: Array<{ id: string; title: string; mode: string; updatedAt: number }> }> {
    await this.load();
    return { externalChats: structuredClone(this.state.externalChats), bindings: structuredClone(this.state.bindings), conversations: conversations.map((item) => ({ id: item.id, title: item.title, mode: item.mode ?? "work", updatedAt: item.updatedAt })) };
  }

  async bindContext(sessionId: string, conversationId: string, exists: (id: string) => Promise<boolean>): Promise<{ ok: boolean; error?: string }> {
    await this.load();
    if (!this.state.externalChats.some((item) => item.sessionId === sessionId)) return { ok: false, error: "外部聊天不存在" };
    if (!await exists(conversationId)) return { ok: false, error: "桌面对话不存在" };
    this.state.bindings = [...this.state.bindings.filter((item) => item.sessionId !== sessionId), { sessionId, conversationId, updatedAt: Date.now() }];
    await this.persist(); return { ok: true };
  }

  async unbindContext(sessionId: string): Promise<{ ok: boolean }> { await this.load(); this.state.bindings = this.state.bindings.filter((item) => item.sessionId !== sessionId); await this.persist(); return { ok: true }; }

  async resolveContext(sessionId: string): Promise<string | null> { await this.load(); return this.state.bindings.find((item) => item.sessionId === sessionId)?.conversationId ?? null; }

  async rememberIncoming(message: IncomingMessage): Promise<string> {
    await this.load();
    const sessionId = channelSessionId(message.channel, message.chatId);
    this.state.externalChats = [{ sessionId, channel: message.channel, chatId: message.chatId, chatType: message.chatType ?? "private", ...(message.senderName ? { senderName: message.senderName } : {}), lastAt: Date.now() }, ...this.state.externalChats.filter((item) => item.sessionId !== sessionId)].slice(0, 200);
    this.state.logs.push({ at: new Date().toISOString(), dir: "incoming", channel: message.channel, senderId: message.senderId, ...(message.senderName ? { senderName: message.senderName } : {}), chatId: message.chatId, text: message.text, hasAttachments: Boolean(message.attachments?.length) });
    this.state.logs = this.state.logs.slice(-200);
    await this.persist();
    return sessionId;
  }

  async rememberOutgoing(message: OutgoingMessage, senderId = message.targetId): Promise<void> {
    await this.load();
    this.state.logs.push({ at: new Date().toISOString(), dir: "outgoing", channel: message.channel, senderId, chatId: message.targetId, text: logText(message.parts), hasAttachments: message.parts.some((part) => part.kind !== "text" && part.kind !== "card") });
    this.state.logs = this.state.logs.slice(-200);
    await this.persist();
  }

  private async configValue(): Promise<Record<string, unknown>> { return await this.config.getChannels?.() ?? this.config.channels; }
  private secret(value: unknown): string { return textValue(value); }
  private emitStatus(): void { this.onEvent?.({ type: "CHANNELS_STATUS_CHANGED", status: this.getStatuses() }); }
  private setStatus(id: string, status: ChannelStatus): void { this.statuses[id] = status; this.emitStatus(); }

  private async startWechat(settings: Record<string, unknown>): Promise<void> {
    if (settings.enabled === false) { this.setStatus("wechat", { enabled: false, phase: "offline", message: "未启用" }); return; }
    let credentials: Credentials | null = null;
    try { credentials = JSON.parse(await readFile(this.credentialsPath(), "utf8")) as Credentials; } catch { /* no credentials */ }
    if (!credentials?.botToken || !credentials.ilinkBotId) { this.setStatus("wechat", { enabled: true, phase: "config_missing", message: "未登录，请先扫码" }); return; }
    this.setStatus("wechat", { enabled: true, phase: "starting", message: "正在连接微信" });
    this.wechatCredentials = credentials;
    this.wechat = new ILinkClient(credentials);
    this.wechatAbort = new AbortController();
    const signal = this.wechatAbort.signal;
    this.wechatPoll = this.pollWechat(signal);
    this.setStatus("wechat", { enabled: true, phase: "running", message: "微信已连接", detail: { botId: credentials.ilinkBotId } });
  }

  private async stopWechat(): Promise<void> { this.wechatAbort?.abort(); await this.wechatPoll?.catch(() => undefined); this.wechatAbort = null; this.wechatPoll = null; this.wechat = null; this.wechatCredentials = null; this.setStatus("wechat", { enabled: false, phase: "offline", message: "已停止" }); }

  private async pollWechat(signal: AbortSignal): Promise<void> {
    let buf = "";
    while (!signal.aborted && this.wechat) {
      try {
        const result = await this.wechat.getUpdates(buf, signal); buf = result.buf;
        for (const message of result.messages) await this.handleWechat(message);
      } catch (error) {
        if (signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus("wechat", { enabled: true, phase: "error", message });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async handleWechat(message: WeixinMessage): Promise<void> {
    const incoming: IncomingMessage = { channel: "wechat", chatType: "private", messageId: message.msgId, senderId: message.fromUserId, chatId: message.fromUserId, text: message.content || "[微信消息]", at: new Date(message.createTimeMs ?? Date.now()), _raw: message };
    this.wechatReplyContext.set(message.fromUserId, message.contextToken);
    const response = await this.onMessage?.(incoming);
    if (response) await this.sendWechat(response);
  }

  private async sendWechat(message: OutgoingMessage): Promise<void> {
    if (!this.wechat) return;
    const contextToken = this.wechatReplyContext.get(message.targetId);
    if (!contextToken) return;
    for (const part of message.parts) if (part.kind === "text") await this.wechat.sendText(message.targetId, part.text, contextToken);
  }

  private async startFeishu(settings: Record<string, unknown>): Promise<void> {
    if (settings.enabled === false) { this.setStatus("feishu", { enabled: false, phase: "offline", message: "未启用" }); return; }
    const appId = textValue(settings.appId); const appSecret = this.secret(settings.appSecret);
    if (!appId || !appSecret) { this.setStatus("feishu", { enabled: true, phase: "config_missing", message: "App ID / App Secret 缺失" }); return; }
    this.setStatus("feishu", { enabled: true, phase: "starting", message: "正在建立飞书长连接" });
    const channel = createLarkChannel({ appId, appSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.warn, transport: "websocket" });
    channel.on("message" as EventName, async (message: NormalizedMessage) => {
      if (message.chatType !== "p2p") return;
      let content = message.content || `[${message.rawContentType}]`;
      if (message.rawContentType === "text") {
        try { content = textValue((JSON.parse(message.content) as { text?: unknown }).text) || content; } catch { /* SDK may already return plain text */ }
      }
      const incoming: IncomingMessage = { channel: "feishu", chatType: "private", messageId: message.messageId, senderId: message.senderId, senderName: message.senderName, chatId: message.chatId, threadId: message.threadId, text: content, at: new Date(message.createTime || Date.now()), _raw: message };
      const response = await this.onMessage?.(incoming);
      if (response) await this.sendFeishu(response);
    });
    channel.on("error" as EventName, (error: unknown) => this.setStatus("feishu", { enabled: true, phase: "error", message: error instanceof Error ? error.message : String(error) }));
    channel.on("reconnecting" as EventName, () => this.setStatus("feishu", { enabled: true, phase: "starting", message: "重新连接中" }));
    channel.on("reconnected" as EventName, () => this.setStatus("feishu", { enabled: true, phase: "running", message: "已连接" }));
    this.feishu = channel;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        channel.connect(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("飞书 WSS 握手超时（15 秒）")), 15_000); }),
      ]);
      this.setStatus("feishu", { enabled: true, phase: "running", message: "飞书长连接已建立" });
    }
    catch (error) { await channel.disconnect().catch(() => undefined); this.feishu = null; const message = error instanceof Error ? error.message : String(error); this.setStatus("feishu", { enabled: true, phase: "error", message }); }
    finally { if (timeout) clearTimeout(timeout); }
  }

  private async sendFeishu(message: OutgoingMessage): Promise<void> {
    if (!this.feishu) return;
    for (const part of message.parts) {
      try {
        if (part.kind === "text") await this.feishu.send(message.targetId, { text: part.text });
        else if (part.kind === "card") await this.feishu.send(message.targetId, { card: { schema: "2.0", header: { title: { tag: "plain_text", content: part.title } }, elements: [{ tag: "div", text: { tag: "lark_md", content: part.markdown ?? "" } }] } } as never);
      } catch (error) { this.state.logs.push({ at: new Date().toISOString(), dir: "error", channel: "feishu", senderId: message.targetId, chatId: message.targetId, text: error instanceof Error ? error.message : String(error) }); }
    }
  }

  private async startQq(settings: Record<string, unknown>): Promise<void> {
    if (settings.enabled === false) { this.setStatus("qq", { enabled: false, phase: "offline", message: "未启用" }); return; }
    const mode = textValue(settings.listenMode) || "auto"; const port = Number(settings.port) || 6200; const accessToken = textValue(settings.accessToken);
    this.setStatus("qq", { enabled: true, phase: "starting", message: "正在启动 OneBot 监听" });
    const server = new OneBotReverseWsServer({ listenMode: mode as never, customHost: textValue(settings.customHost) || undefined, port, accessToken, onEvent: (event, client) => this.handleQqEvent(event, client), onClientConnected: (client, info) => this.handleQqConnected(client, info.headerSelfId), onClientDisconnected: () => { this.qqClient = null; this.qqSelfId = ""; this.setStatus("qq", { enabled: true, phase: "starting", message: "监听中，等待 NapCat 连接", detail: this.qqDetail() }); }, onError: (error) => this.setStatus("qq", { enabled: true, phase: "error", message: error.message, detail: this.qqDetail() }) });
    try { this.qqInfo = await server.start(); this.qq = server; this.setStatus("qq", { enabled: true, phase: "starting", message: "监听中，等待 NapCat 连接", detail: this.qqDetail() }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); this.setStatus("qq", { enabled: true, phase: "error", message }); }
  }

  private async startQqBot(settings: Record<string, unknown>): Promise<void> {
    if (settings.enabled === false) { this.setStatus("qqbot", { enabled: false, phase: "offline", message: "未启用" }); return; }
    const appId = textValue(settings.appId); const appSecret = textValue(settings.appSecret);
    if (!appId || !appSecret) { this.setStatus("qqbot", { enabled: true, phase: "config_missing", message: "缺少 AppID / AppSecret，请到 QQ 开放平台创建机器人" }); return; }
    this.setStatus("qqbot", { enabled: true, phase: "starting", message: "正在连接 QQ 开放平台网关" });
    const api = new QqBotApiClient({ appId, clientSecret: appSecret });
    this.qqbotApi = api;
    try {
      const gatewayUrl = await Promise.race([
        api.getGatewayUrl(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("QQ Bot 网关查询超时（15 秒）")), 15_000)),
      ]);
      const ws = new QqBotWsClient({
        gatewayUrl,
        getAccessToken: () => api.getAccessToken(),
        onDispatch: (type, data) => this.handleQqBotDispatch(type, data),
        onReadyChange: (ready) => this.setStatus("qqbot", { enabled: true, phase: ready ? "running" : "starting", message: ready ? "QQ Bot 网关已连接" : "QQ Bot 网关重连中", detail: { gatewayUrl, ready } }),
        onError: (error) => this.setStatus("qqbot", { enabled: true, phase: this.qqbotWs?.isReady ? "running" : "error", message: error.message, detail: { gatewayUrl } }),
      });
      this.qqbotWs = ws;
      await ws.start();
    } catch (error) {
      await this.qqbotWs?.stop().catch(() => undefined);
      this.qqbotWs = null;
      this.qqbotApi = null;
      this.setStatus("qqbot", { enabled: true, phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleQqBotDispatch(type: QqBotEventType, data: Record<string, unknown>): Promise<void> {
    if (type !== "C2C_MESSAGE_CREATE" && type !== "GROUP_AT_MESSAGE_CREATE" && type !== "GROUP_MESSAGE_CREATE") return;
    const author = asRecord(data.author); const group = type !== "C2C_MESSAGE_CREATE";
    const senderId = textValue(author[group ? "member_openid" : "user_openid"]); const chatId = group ? textValue(data.group_openid) : senderId;
    const messageId = textValue(data.id); if (!senderId || !chatId || !messageId) return;
    const settings = safeConfig((await this.configValue()).qqbot);
    const users = Array.isArray(settings.allowedUserOpenids) ? settings.allowedUserOpenids.map(String) : [];
    const groups = Array.isArray(settings.allowedGroupOpenids) ? settings.allowedGroupOpenids.map(String) : [];
    if ((!group && settings.allowAnyPrivate !== true && !users.includes(senderId)) || (group && !groups.includes(chatId))) return;
    const content = textValue(data.content).trim();
    if (!content) return;
    const incoming: IncomingMessage = { channel: "qqbot", chatType: group ? "group" : "private", messageId, senderId, senderName: textValue(author.username) || undefined, chatId, text: content, at: new Date(Date.parse(textValue(data.timestamp)) || Date.now()), _raw: data };
    this.qqbotReplyContext.set(chatId, { messageId, chatType: incoming.chatType!, seq: 0, at: Date.now() });
    const response = await this.onMessage?.(incoming);
    if (response) await this.sendQqBot(response);
  }

  private async sendQqBot(message: OutgoingMessage): Promise<void> {
    if (!this.qqbotApi) return;
    const context = this.qqbotReplyContext.get(message.targetId);
    if (!context || Date.now() - context.at > (context.chatType === "group" ? 5 : 60) * 60_000) return;
    for (const part of message.parts) {
      if (part.kind !== "text") continue;
      context.seq += 1;
      if (context.seq > (context.chatType === "group" ? 5 : 4)) break;
      await this.qqbotApi.sendText({ openid: message.targetId, chatType: context.chatType }, part.text, { msgId: context.messageId, msgSeq: context.seq });
    }
  }

  private async handleQqConnected(client: { call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> }, headerSelfId?: string): Promise<void> {
    const login = await client.call<{ user_id: string | number; nickname?: string }>("get_login_info");
    const version = await client.call<{ app_version?: string }>("get_version_info");
    this.qqClient = client; this.qqSelfId = oneBotId(login.user_id);
    if (!this.qqSelfId || (headerSelfId && this.qqSelfId !== headerSelfId)) throw new Error("NapCat 登录信息与 X-Self-ID 不一致");
    this.setStatus("qq", { enabled: true, phase: "running", message: "NapCat 已连接", detail: { ...this.qqDetail(), nickname: login.nickname, appVersion: version.app_version } });
  }

  private async handleQqEvent(value: OneBotEvent, client: { call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> }): Promise<void> {
    if (!isOneBotMessage(value)) return;
    const event = value; const selfId = this.qqSelfId;
    if (!selfId || oneBotId(event.self_id) !== selfId || oneBotId(event.user_id) === selfId) return;
    const senderId = oneBotId(event.user_id); const groupId = oneBotId(event.group_id); const chatId = event.message_type === "group" ? groupId : senderId;
    if (!chatId) return;
    const settings = safeConfig((await this.configValue()).qq); const privateAllow = Array.isArray(settings.allowedPrivateUserIds) ? settings.allowedPrivateUserIds.map(String) : []; const groupAllow = Array.isArray(settings.allowedGroupIds) ? settings.allowedGroupIds.map(String) : [];
    if (event.message_type === "private" && !privateAllow.includes(senderId)) return;
    if (event.message_type === "group" && (!groupAllow.includes(groupId) || (settings.groupRequireMention !== false && !event.message.some((segment) => segment.type === "at" && oneBotId(segment.data.qq) === selfId)))) return;
    const incoming: IncomingMessage = { channel: "qq", chatType: event.message_type, messageId: oneBotId(event.message_id), senderId, senderName: textValue(event.sender?.card || event.sender?.nickname) || undefined, chatId, text: oneBotText(event, selfId), at: new Date((Number(event.time) || Math.floor(Date.now() / 1000)) * 1000), _raw: event };
    const response = await this.onMessage?.(incoming);
    if (response) await this.sendQq(response, client);
  }

  private async sendQq(message: OutgoingMessage, client: { call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> }): Promise<void> {
    const payload = message.parts.map((part) => ({ type: "text", data: { text: part.kind === "text" ? part.text : logText([part]) } }));
    if (message.chatType === "group") await client.call("send_group_msg", { group_id: message.targetId, message: payload });
    else await client.call("send_private_msg", { user_id: message.targetId, message: payload });
  }

  private qqDetail(): Record<string, unknown> { return { listenUrl: this.qqInfo?.url, listenHost: this.qqInfo?.host, listenMode: this.qqInfo?.mode, selfId: this.qqSelfId || undefined }; }
}
