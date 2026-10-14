import { normalizeMobileMessageSegmentationMode, type MobileMessageSegmentationMode } from "../../shared/preferences";
import { splitTextBySentenceBreaks } from "../../shared/message-segmentation";
import type { ChannelManager } from "./manager";
import {
  createChannelDeliveryService,
  type ChannelDeliveryService,
} from "./delivery-service";
import { appendHistory as appendChannelHistory } from "./history-log";
import { appendLog as appendChannelLog, type LogEntry } from "./message-log";
import type { ChannelId, IncomingMessage, OutgoingMessage } from "./types";
import { getChannelConversationBindingStore, type ChannelConversationBindingSnapshot } from "./conversation-binding-store";

export type ProactiveMobileChannel = Extract<ChannelId, "wechat" | "feishu">;

// Unbound recipients remain process-local. A persisted explicit private binding
// can survive a restart when the adapter also has usable reply context.

export interface RecentProactiveChannelRecipient {
  targetId: string;
  threadId?: string;
  sessionId: string;
  updatedAt: number;
  conversationId?: string;
}

export interface ProactiveChannelRecipientRegistry {
  remember(message: IncomingMessage, sessionId: string): void;
  get(channel: ProactiveMobileChannel): RecentProactiveChannelRecipient | null;
}

export function createProactiveChannelRecipientRegistry(): ProactiveChannelRecipientRegistry {
  const recipients = new Map<ProactiveMobileChannel, RecentProactiveChannelRecipient>();
  return {
    remember(message, sessionId): void {
      if (message.channel !== "wechat" && message.channel !== "feishu") return;
      if (message.chatType === "group") return;
      const targetId = message.chatId.trim();
      if (!targetId || !sessionId) return;
      recipients.set(message.channel, {
        targetId,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        sessionId,
        updatedAt: message.at.getTime(),
      });
    },
    get(channel): RecentProactiveChannelRecipient | null {
      return recipients.get(channel) ?? null;
    },
  };
}

const defaultRecipientRegistry = createProactiveChannelRecipientRegistry();

export function rememberProactiveChannelRecipient(message: IncomingMessage, sessionId: string): void {
  defaultRecipientRegistry.remember(message, sessionId);
}

export type ProactiveChannelAvailability =
  | { available: true; recipient: RecentProactiveChannelRecipient }
  | { available: false; reason: string };

/** Explicit private bindings take precedence over an incidental recent sender. */
export function getProactiveChannelAvailability(
  channel: ProactiveMobileChannel,
  manager: Pick<ChannelManager, "getAdapter">,
  recipientRegistry: ProactiveChannelRecipientRegistry = defaultRecipientRegistry,
  bindings: ChannelConversationBindingSnapshot = getChannelConversationBindingStore().list(),
): ProactiveChannelAvailability {
  const adapter = manager.getAdapter(channel);
  if (!adapter?.getStatus().enabled || adapter.getStatus().phase !== "running") return { available: false, reason: "channel_offline" };
  const candidates = bindings.bindings.flatMap(binding => {
    const chat = bindings.externalChats.find(item => item.sessionId === binding.sessionId && item.channel === channel && item.chatType === "private");
    return chat ? [{ targetId: chat.chatId, sessionId: chat.sessionId, conversationId: binding.conversationId, updatedAt: chat.lastAt }] : [];
  });
  if (candidates.length > 1) return { available: false, reason: "recipient_ambiguous" };
  const recent = recipientRegistry.get(channel);
  const recipient = candidates[0] ?? (recent ? { ...recent, conversationId: recent.sessionId } : null);
  if (!recipient) return { available: false, reason: "recipient_unavailable" };
  const protocol = adapter.getProactiveAvailability?.(recipient.targetId);
  if (protocol && !protocol.available) return { available: false, reason: protocol.reason || "delivery_unavailable" };
  return { available: true, recipient };
}

export function canStartProactiveChannelDelivery(
  channel: ProactiveMobileChannel,
  manager: Pick<ChannelManager, "getAdapter">,
  recipientRegistry: ProactiveChannelRecipientRegistry = defaultRecipientRegistry,
): boolean {
  return getProactiveChannelAvailability(channel, manager, recipientRegistry).available;
}

export type ProactiveChannelDeliveryResult =
  | { kind: "committed"; deliveredParts: number; totalParts: number }
  | { kind: "cancelled"; reason: string };

interface ProactiveChannelDeliveryInput {
  channel: ProactiveMobileChannel;
  text: string;
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  manager: Pick<ChannelManager, "getAdapter">;
  delivery?: ChannelDeliveryService;
  recipientRegistry?: ProactiveChannelRecipientRegistry;
  appendHistory?: typeof appendChannelHistory;
  appendLog?: (entry: Omit<LogEntry, "at">) => void;
  canContinue?: () => boolean;
  /** A target frozen with the model context; never resolve another recipient mid-turn. */
  recipient?: RecentProactiveChannelRecipient;
  recordDelivery?: (recipient: RecentProactiveChannelRecipient, text: string) => Promise<void>;
}

export async function sendProactiveChannelMessage(
  input: ProactiveChannelDeliveryInput,
): Promise<ProactiveChannelDeliveryResult> {
  const adapter = input.manager.getAdapter(input.channel);
  if (!adapter?.getStatus().enabled || adapter.getStatus().phase !== "running") {
    return { kind: "cancelled", reason: "channel_offline" };
  }

  const recipient = input.recipient ?? (input.recipientRegistry ?? defaultRecipientRegistry).get(input.channel);
  if (!recipient) return { kind: "cancelled", reason: "recipient_unavailable" };
  const delivery = input.delivery ?? createChannelDeliveryService(input.manager);

  const mode = normalizeMobileMessageSegmentationMode(input.mobileMessageSegmentation);
  const texts = mode === "on" ? splitTextBySentenceBreaks(input.text) : [input.text.trim()].filter(Boolean);
  if (texts.length === 0) return { kind: "cancelled", reason: "empty_text" };

  const deliveredTexts: string[] = [];
  let failureReason = "send_failed";
  for (const text of texts) {
    if (input.canContinue && !input.canContinue()) break;
    if (adapter.getStatus().phase !== "running") break;
    const message: OutgoingMessage = {
      channel: input.channel,
      targetId: recipient.targetId,
      ...(recipient.threadId ? { threadId: recipient.threadId } : {}),
      parts: [{ kind: "text", text }],
    };
    const result = await delivery.send(message);
    if (!result.ok) { failureReason = result.error; break; }
    deliveredTexts.push(text);
  }

  if (deliveredTexts.length === 0) return { kind: "cancelled", reason: failureReason };

  const deliveredText = deliveredTexts.join("");
  // Delivery already happened: a derived history/log failure must not trigger a resend.
  try {
    if (input.recordDelivery) await input.recordDelivery(recipient, deliveredText);
    else (input.appendHistory ?? appendChannelHistory)(recipient.sessionId, "assistant", deliveredText);
  } catch { console.warn("[Proactive] delivered message history write failed"); }
  try {
    (input.appendLog ?? appendChannelLog)({
      dir: "outgoing",
      channel: input.channel,
      senderId: recipient.targetId,
      chatId: recipient.targetId,
      text: deliveredText,
      hasAttachments: false,
    });
  } catch { console.warn("[Proactive] delivered message audit write failed"); }

  return {
    kind: "committed",
    deliveredParts: deliveredTexts.length,
    totalParts: texts.length,
  };
}
