import type { ChannelChatType, ChannelId, IncomingMessage, OutgoingMessage } from "./types";

export type ChannelControlCommand = "stop" | "status" | "help";

/** 只识别明确的渠道控制命令，普通文本不会被调度器截断。 */
export function parseChannelControlCommand(text: string): ChannelControlCommand | null {
  const value = text.trim().toLocaleLowerCase();
  if (!value) return null;
  if (/^\/(?:stop|cancel|取消|停止)(?:\s+.*)?$/u.test(value)) return "stop";
  if (/^\/(?:status|状态|进度)(?:\s+.*)?$/u.test(value)) return "status";
  if (/^\/(?:help|帮助)(?:\s+.*)?$/u.test(value)) return "help";
  return null;
}

export function makeChannelTextMessage(
  incoming: Pick<IncomingMessage, "channel" | "chatType" | "chatId" | "threadId" | "messageId" | "senderId">,
  text: string,
): OutgoingMessage {
  const chatType: ChannelChatType = incoming.chatType ?? "private";
  return {
    channel: incoming.channel,
    chatType,
    targetId: incoming.chatId,
    ...(incoming.threadId ? { threadId: incoming.threadId } : {}),
    ...(chatType === "group" && incoming.messageId
      ? { replyContext: { messageId: incoming.messageId, mentionUserId: incoming.senderId } }
      : {}),
    parts: [{ kind: "text", text }],
  };
}

export function formatChannelRunId(runId: string): string {
  return runId.length > 12 ? runId.slice(0, 12) : runId;
}

export function formatChannelControlHelp(channel: ChannelId): string {
  return `渠道控制（${channel}）：/status 查看当前任务，/stop 停止当前任务，/help 查看此帮助。`;
}
