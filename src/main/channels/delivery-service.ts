import type { ChannelManager } from "./manager";
import type { OutgoingMessage, ChannelSendOptions } from "./types";
import { getChannelRecoveryStore, type ChannelOutboxRecord, type ChannelRecoveryStore } from "./recovery-store";

type DeliveryProgress = { operationId?: string; deliveredParts?: number; totalParts?: number };
export type DeliveryResult =
  | ({ ok: true } & DeliveryProgress)
  | ({ ok: false; error: string; status?: "failed" | "unknown" | "cancelled" } & DeliveryProgress);

export interface ChannelDeliveryService {
  send(message: OutgoingMessage, options?: ChannelSendOptions): Promise<DeliveryResult>;
}

const sending = new WeakMap<ChannelRecoveryStore, Map<string, Promise<DeliveryResult>>>();
const progress = (item: ChannelOutboxRecord): DeliveryProgress => ({ operationId: item.id, deliveredParts: item.parts.filter(part => part.status === "sent").length, totalParts: item.parts.length });
export function isChannelOutboxActive(store: ChannelRecoveryStore, id: string): boolean { return sending.get(store)?.has(id) ?? false; }

/** Same process: join an in-flight operation. After restart: unknown parts require review. */
export async function resumeChannelDelivery(
  manager: Pick<ChannelManager, "getAdapter">, store: ChannelRecoveryStore, id: string,
  options?: ChannelSendOptions,
): Promise<DeliveryResult> {
  let active = sending.get(store);
  if (!active) { active = new Map(); sending.set(store, active); }
  const existing = active.get(id);
  if (existing) return existing;
  const run = Promise.resolve().then(async (): Promise<DeliveryResult> => {
    let item = store.get(id);
    if (!item || item.kind !== "outbox") return { ok: false, error: "outbox_not_found", status: "failed" };
    if (item.parts.some(part => part.status === "unknown" || part.status === "sending")) return { ok: false, error: "delivery_unknown_review_required", status: "unknown", ...progress(item) };
    for (let index = 0; index < item.parts.length; index++) {
      // Re-read: disabling a channel / cancelling in UI may have changed the record.
      item = store.get(id) as ChannelOutboxRecord;
      const part = item.parts[index];
      if (part.status === "sent") continue;
      if (part.status === "unknown" || part.status === "sending") return { ok: false, error: "delivery_unknown_review_required", status: "unknown", ...progress(item) };
      if (part.status === "cancelled") return { ok: false, error: "delivery_cancelled", status: "cancelled", ...progress(item) };
      const adapter = manager.getAdapter(item.channel);
      const error = options?.signal?.aborted || (options?.canContinue && !options.canContinue()) ? "delivery_cancelled"
        : !adapter ? "adapter_not_found" : !adapter.getStatus().enabled ? "channel_disabled" : adapter.getStatus().phase !== "running" ? "channel_offline" : null;
      if (error) {
        const cancelled = error === "delivery_cancelled" || error === "channel_disabled";
        if (cancelled) { store.cancel(id); item = store.get(id) as ChannelOutboxRecord; }
        else item = store.setPart(id, index, "failed", error);
        return { ok: false, error, status: cancelled ? "cancelled" : "failed", ...progress(item) };
      }
      store.setPart(id, index, "sending"); // Must be durable BEFORE the external side effect.
      try {
        const result = await adapter!.send({ ...item.message, parts: [item.message.parts[index]] }, options);
        if (!result.ok) {
          const status = result.deliveryState === "failed" ? "failed" : "unknown";
          item = store.setPart(id, index, status, result.error || "send_failed");
          return { ok: false, error: result.error || "send_failed", status, ...progress(item) };
        }
        item = store.setPart(id, index, "sent");
      } catch (error) {
        // Transport failures can happen after remote acceptance. Never guess "not sent".
        const detail = error instanceof Error ? error.message : String(error);
        try { item = store.setPart(id, index, "unknown", detail); } catch { /* durable sending remains conservative after restart */ }
        return { ok: false, error: detail, status: "unknown", ...progress(item) };
      }
    }
    return { ok: true, ...progress(item) };
  });
  active.set(id, run);
  try { return await run; } finally { active.delete(id); }
}

export function createChannelDeliveryService(
  manager: Pick<ChannelManager, "getAdapter">,
  storeOption?: ChannelRecoveryStore,
): ChannelDeliveryService {
  return {
    async send(message, options): Promise<DeliveryResult> {
      const store = storeOption ?? getChannelRecoveryStore();
      if (store) {
        try {
          const item = store.prepareOutbox(message, options);
          return await resumeChannelDelivery(manager, store, item.id, options);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error), status: "failed" };
        }
      }
      if (options?.signal?.aborted || (options?.canContinue && !options.canContinue())) return { ok: false, error: "发送已取消" };
      const adapter = manager.getAdapter(message.channel);
      if (!adapter) {
        return { ok: false, error: "adapter_not_found" };
      }
      if (!adapter.getStatus().enabled) return { ok: false, error: "channel_disabled" };

      try {
        const result = await (options ? adapter.send(message, options) : adapter.send(message));
        if (result.ok) return { ok: true };
        return { ok: false, error: result.error || "send_failed" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
