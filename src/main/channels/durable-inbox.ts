import { createKeyedQueue } from "./keyed-queue";
import type { DispatchContext } from "./channel-context";
import { getChannelRecoveryStore, type ChannelInboxRecord, type ChannelRecoveryStore } from "./recovery-store";
import type { ChannelId, IncomingMessage, OutgoingMessage } from "./types";

export interface DurableChannelInboxDeps {
  store?: ChannelRecoveryStore;
  captureContext(message: IncomingMessage): Promise<DispatchContext>;
  process(message: IncomingMessage, context: DispatchContext, onFailure: (error: string) => void, canContinue: () => boolean): Promise<OutgoingMessage | null>;
  isEnabled(channel: ChannelId): boolean;
}

/** A receipt is persisted before acknowledging a transport; CTA owns the actual turn. */
export class DurableChannelInbox {
  private readonly queue = createKeyedQueue({ maxPendingPerKey: Number.MAX_SAFE_INTEGER });
  private readonly active = new Map<string, Promise<OutgoingMessage | null>>();
  constructor(private readonly deps: DurableChannelInboxDeps) {}
  private get store(): ChannelRecoveryStore {
    const store = this.deps.store ?? getChannelRecoveryStore();
    if (!store) throw new Error("channel_recovery_not_initialized");
    return store;
  }
  private async persist(message: IncomingMessage): Promise<ChannelInboxRecord> {
    if (!this.deps.isEnabled(message.channel)) throw new Error("channel_disabled");
    // Freeze the original binding before queuing. A later rebind must not reroute work.
    const context = await this.deps.captureContext(message);
    return this.store.accept(message, context).record;
  }
  async accept(message: IncomingMessage): Promise<void> {
    const record = await this.persist(message);
    if (record.status === "queued") void this.schedule(record).catch(() => undefined);
  }
  async handleIncoming(message: IncomingMessage): Promise<OutgoingMessage | null> {
    const record = await this.persist(message);
    if (this.active.has(record.id)) return this.active.get(record.id)!;
    return record.status === "queued" ? this.schedule(record) : null;
  }
  isActive(id: string): boolean { return this.active.has(id); }
  async recoverQueued(): Promise<void> {
    // Scheduling is deliberately non-blocking; channel startup must not wait for an LLM.
    for (const record of this.store.list()) {
      if (record.kind !== "inbox" || record.status !== "queued") continue;
      if (!this.deps.isEnabled(record.channel)) { this.store.setInboxStatus(record.id, "cancelled", "channel_disabled"); continue; }
      void this.schedule(record).catch(() => undefined);
    }
  }
  async retry(id: string, confirmed: boolean): Promise<void> {
    const record = this.store.get(id);
    if (!record || record.kind !== "inbox") throw new Error("inbox_not_found");
    if (this.isActive(id)) throw new Error("inbox_is_running");
    if (!this.deps.isEnabled(record.channel)) throw new Error("channel_disabled");
    if (record.status === "completed" || record.status === "cancelled") throw new Error("inbox_not_retryable");
    if (!confirmed) throw new Error("confirm_previous_tool_effects_before_retry");
    this.store.setInboxStatus(id, "queued");
    void this.schedule(record).catch(() => undefined);
  }
  private schedule(record: ChannelInboxRecord): Promise<OutgoingMessage | null> {
    const previous = this.active.get(record.id);
    if (previous) return previous;
    const key = record.context.boundConversationId || record.context.sessionId;
    const scheduled = this.queue.run(key, async () => {
      const current = this.store.get(record.id) as ChannelInboxRecord;
      if (current.status !== "queued") return null;
      if (!this.deps.isEnabled(current.channel)) { this.store.setInboxStatus(current.id, "cancelled", "channel_disabled"); return null; }
      this.store.setInboxStatus(current.id, "running");
      let failure: string | undefined;
      try {
        const result = await this.deps.process({ ...current.message, at: new Date(current.message.at) }, current.context, error => { failure = error; },
          () => this.deps.isEnabled(current.channel) && (this.store.get(current.id) as ChannelInboxRecord)?.status === "running");
        // A user cancellation while running remains cancelled. Sending checks the channel again.
        if ((this.store.get(current.id) as ChannelInboxRecord).status === "running") this.store.setInboxStatus(current.id, failure ? "failed" : "completed", failure);
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if ((this.store.get(current.id) as ChannelInboxRecord)?.status === "running") this.store.setInboxStatus(current.id, "failed", detail);
        console.warn("[ChannelsInbox] processing stopped:", detail);
        return null;
      }
    });
    this.active.set(record.id, scheduled);
    void scheduled.finally(() => this.active.delete(record.id)).catch(() => undefined);
    return scheduled;
  }
}

let activeInbox: DurableChannelInbox | undefined;
export function setDurableChannelInbox(inbox: DurableChannelInbox): void { activeInbox = inbox; }
export function getDurableChannelInbox(): DurableChannelInbox | undefined { return activeInbox; }
