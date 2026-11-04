import type { IpcScope } from "../application/ipc-scope";
import type { ChannelRecoveryItem } from "../../shared/channel-recovery";
import { IPC } from "../../shared/ipc-channels";
import { channelManager } from "./manager";
import { getDurableChannelInbox } from "./durable-inbox";
import { isChannelOutboxActive, resumeChannelDelivery } from "./delivery-service";
import { getChannelRecoveryStore, type ChannelCorruptRecord, type ChannelOutboxRecord, type ChannelRecoveryRecord } from "./recovery-store";

let receiptWriter: ((record: ChannelOutboxRecord) => Promise<void>) | undefined;
export function setChannelRecoveryReceiptWriter(writer: typeof receiptWriter): void { receiptWriter = writer; }
function store() { const value = getChannelRecoveryStore(); if (!value) throw new Error("channel_recovery_not_initialized"); return value; }
function input(value: unknown): { id: string; confirmed?: boolean; index?: number; outcome?: string } {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || value.id.length > 2048) throw new Error("invalid_recovery_request");
  return value as ReturnType<typeof input>;
}
function active(record: ChannelRecoveryRecord): boolean {
  return record.kind === "inbox" ? getDurableChannelInbox()?.isActive(record.id) ?? false : isChannelOutboxActive(store(), record.id);
}
function publicRecord(record: ChannelRecoveryRecord): ChannelRecoveryItem {
  const common = { id: record.id, kind: record.kind, channel: record.channel, createdAt: record.createdAt, updatedAt: record.updatedAt, active: active(record) };
  if (record.kind === "inbox") return { ...common, status: record.status === "cancelled" && common.active ? "cancelling" : record.status, conversationId: record.context.boundConversationId || record.context.sessionId,
    targetId: record.message.chatId, preview: record.message.text.slice(0, 240), error: record.error, parts: [] };
  return { ...common, status: record.parts.every(part => part.status === "sent") ? "completed" : record.parts.some(part => part.status === "unknown" || part.status === "sending") ? "unknown" : record.parts.every(part => part.status === "sent" || part.status === "cancelled") ? "cancelled" : "pending",
    conversationId: record.conversationId, targetId: record.message.targetId,
    preview: record.message.parts.filter(part => part.kind === "text").map(part => part.text).join("").slice(0, 240),
    parts: record.parts.map((part, index) => ({ index, kind: record.message.parts[index].kind, status: part.status, error: part.error })) };
}
function publicCorrupt(record: ChannelCorruptRecord): ChannelRecoveryItem {
  return { id: record.id, kind: "corrupt", channel: record.channel, createdAt: record.createdAt, updatedAt: record.updatedAt,
    active: false, status: "corrupt", targetId: "", preview: `恢复记录损坏：${record.fileName}`, error: record.error, parts: [] };
}

/** Register through the host IPC scope: Web uses the same authenticated transport. */
export function registerChannelRecoveryIpc(ipc: IpcScope): void {
  ipc.handle(IPC.CHANNELS_RECOVERY_LIST, () => {
    const records = store().list().reverse().map(publicRecord);
    const corrupt = store().listCorrupt().map(publicCorrupt);
    // Do not let newer successful traffic hide an older unresolved delivery.
    return [...corrupt, ...records.filter(record => !["completed", "cancelled"].includes(record.status)),
      ...records.filter(record => ["completed", "cancelled"].includes(record.status)).slice(0, 200)];
  });
  ipc.handle(IPC.CHANNELS_RECOVERY_RETRY, async (_event, value: unknown) => {
    const request = input(value);
    const record = store().get(request.id);
    if (!record) throw new Error("recovery_record_not_found");
    if (active(record)) throw new Error("recovery_already_running");
    if (request.confirmed !== true) throw new Error("recovery_confirmation_required");
    if (record.kind === "inbox") {
      const inbox = getDurableChannelInbox(); if (!inbox) throw new Error("inbox_not_initialized");
      await inbox.retry(record.id, true); return { ok: true };
    }
    if (record.parts.some(part => part.status === "unknown" || part.status === "sending")) throw new Error("resolve_unknown_parts_before_retry");
    const result = await resumeChannelDelivery(channelManager, store(), record.id);
    await receiptWriter?.(store().get(record.id) as ChannelOutboxRecord);
    return result;
  });
  ipc.handle(IPC.CHANNELS_RECOVERY_RESOLVE, async (_event, value: unknown) => {
    const request = input(value);
    const record = store().get(request.id);
    if (!record || record.kind !== "outbox") throw new Error("outbox_not_found");
    if (active(record)) throw new Error("recovery_already_running");
    if (request.confirmed !== true || !Number.isInteger(request.index) || !["sent", "not_sent"].includes(request.outcome ?? "")) throw new Error("invalid_part_confirmation");
    if (record.parts[request.index!]?.status !== "unknown") throw new Error("part_is_not_unknown");
    const updated = store().setPart(record.id, request.index!, request.outcome === "sent" ? "sent" : "failed", `user_confirmed_${request.outcome}`);
    await receiptWriter?.(updated);
    return { ok: true };
  });
  ipc.handle(IPC.CHANNELS_RECOVERY_CANCEL, (_event, value: unknown) => {
    const request = input(value); const record = store().get(request.id);
    if (!record) throw new Error("recovery_record_not_found");
    if (record.kind === "inbox" && active(record)) throw new Error("inbox_is_running");
    store().cancel(record.id); return { ok: true };
  });
}
