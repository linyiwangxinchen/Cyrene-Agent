import { promises as fs } from "node:fs";
import path from "node:path";
import { channelManager } from "../../channels/manager";
import { getChannelConversationBindingStore } from "../../channels/conversation-binding-store";
import { createChannelDeliveryService } from "../../channels/delivery-service";
import { appendLog } from "../../channels/message-log";
import type { ChannelId, OutgoingMessage, OutgoingPart } from "../../channels/types";
import { WECHAT_MEDIA_MAX_BYTES } from "../../channels/adapters/wechat/wechat-media-upload";
import { resolveFileAccessPath } from "./file-access";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDefinition, ToolRegistry } from "./registry/tool-registry";

const CHANNELS: ChannelId[] = ["wechat", "feishu", "qq", "qqbot"];
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

/** Target IDs are host-owned; the model may select a channel, never a recipient. */
function resolveTarget(channel: unknown, ctx?: ToolContext): ToolContext["channelContext"] {
  const selected = typeof channel === "string" && channel ? channel : ctx?.channelContext?.channel;
  if (selected && !CHANNELS.includes(selected as ChannelId)) return undefined;
  if (ctx?.channelContext) {
    return !selected || selected === ctx.channelContext.channel ? ctx.channelContext : undefined;
  }
  if (!ctx?.conversationId || !selected) return undefined;
  const snapshot = getChannelConversationBindingStore().list();
  const sessions = new Set(snapshot.bindings.filter(item => item.conversationId === ctx.conversationId).map(item => item.sessionId));
  const matches = snapshot.externalChats.filter(item => sessions.has(item.sessionId) && item.channel === selected && item.chatType === "private");
  if (matches.length !== 1) return undefined;
  const chat = matches[0];
  return { channel: selected as ChannelId, targetId: chat.chatId, chatType: chat.chatType, sessionId: chat.sessionId };
}

export const channelFileTool: ToolDefinition = {
  id: "channel_send_file",
  name: "发送渠道附件",
  description: "将已经存在的本地文件真正发送为微信/飞书/QQ附件。用户要求把生成、下载或收到的文件发过来时，先取得真实文件路径，再调用本工具，不能只回复路径或声称无法发送。当前渠道会话自动回复当前用户；Web/桌面会话必须指定 channel 且已在连接手机中绑定唯一的对应私聊。不能指定任意收件人。仅在用户要求发送时调用，成功结果表示渠道接口已接收，失败时如实说明原因，不要声称已发送。",
  catalogHint: "把本地文档、图片、视频真正发送到当前或已绑定的手机私聊",
  enabled: true,
  risk: "network",
  effectKind: "external_side_effect",
  verificationPolicy: "none",
  needsContext: true,
  modes: ["chat", "work", "code", "learn"],
  chatBuiltin: true,
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "已有文件的绝对路径，或相对于可信工作区的路径；先生成/下载文件" },
      channel: { type: "string", enum: CHANNELS, description: "当前渠道内可省略；Web/桌面发送时指定已绑定的渠道" },
      kind: { type: "string", enum: ["auto", "file", "image", "video"], description: "默认 auto 按扩展名选图片/视频/文件；file 强制以文件附件发送（音频也可作为文件）" },
      name: { type: "string", description: "文件附件的显示文件名，可选" },
    },
    required: ["filePath"],
  },
  async execute(args, ctx) {
    const fail = (error: string) => JSON.stringify({ success: false, error, retryable: false });
    if (ctx?.readOnly) return fail("当前子任务只允许读取，不允许发送附件");
    if (ctx?.signal?.aborted) return fail("发送已取消");
    const target = resolveTarget(args.channel, ctx);
    if (!target) return fail("没有唯一的渠道收件目标。请在对应手机私聊中请求发送，或在连接手机中将该私聊绑定到当前会话后指定 channel");
    if (target.chatType === "group") return fail("附件工具目前仅支持私聊，不能向整个群聊发送文件");
    const adapter = channelManager.getAdapter(target.channel);
    if (!adapter?.getStatus().enabled || adapter.getStatus().phase !== "running") return fail("渠道未连接，请先启用并连接对应渠道");
    const raw = typeof args.filePath === "string" ? args.filePath.trim() : "";
    if (!raw || (!path.isAbsolute(raw) && !ctx?.resolvedWorkspaceRoot)) return fail("请提供已有文件的绝对路径，或当前工作区内的相对路径");
    const access = resolveFileAccessPath(path.resolve(ctx?.resolvedWorkspaceRoot ?? "", raw), "read", ctx);
    if (!access.ok) return fail(access.message);
    const kind = args.kind ?? "auto";
    if (!["auto", "file", "image", "video"].includes(String(kind))) return fail("kind 必须是 auto/file/image/video");
    const ext = path.extname(access.path).toLowerCase();
    const mediaKind = kind === "auto" ? IMAGE_EXTS.has(ext) ? "image" : VIDEO_EXTS.has(ext) ? "video" : "file" : kind as "file" | "image" | "video";
    if (!adapter.capability[mediaKind]) return fail(`当前渠道不支持 ${mediaKind} 附件`);
    let size: number;
    try {
      const stat = await fs.stat(access.path);
      if (!stat.isFile()) return fail("目标不是普通文件");
      size = stat.size;
      if (size === 0) return fail("文件为空，请先生成完整文件");
      if (target.channel === "wechat" && size > WECHAT_MEDIA_MAX_BYTES) return fail("微信附件超过本程序的 64 MiB 传输上限，请压缩或拆分后发送");
    } catch (error) { return fail(`文件不存在或无法读取：${error instanceof Error ? error.message : String(error)}`); }
    const name = path.basename(typeof args.name === "string" && args.name.trim() ? args.name.trim() : access.path).replace(/[\r\n\0]/g, "");
    const part: OutgoingPart = mediaKind === "image" ? { kind: "image", filePath: access.path } : { kind: mediaKind, filePath: access.path, name };
    const message: OutgoingMessage = { channel: target.channel, targetId: target.targetId, chatType: "private", threadId: target.threadId, parts: [part] };
    const result = await createChannelDeliveryService(channelManager).send(message, { signal: ctx?.signal });
    try { appendLog({ dir: result.ok ? "outgoing" : "error", channel: target.channel, senderId: target.targetId, chatId: target.targetId, text: result.ok ? `[附件] ${name}` : `[附件发送失败] ${name}: ${result.error}`, hasAttachments: true }); } catch { /* logging cannot change a delivery result */ }
    return result.ok ? JSON.stringify({ success: true, channel: target.channel, name, size, kind: mediaKind, status: "accepted", message: "渠道接口已接受附件发送" }) : fail(result.error);
  },
};

export function registerChannelFileTool(registry: ToolRegistry): void { registry.register(channelFileTool); }
