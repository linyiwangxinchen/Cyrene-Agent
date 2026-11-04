import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DispatchContext } from "./channel-context";
import type { ChannelId, IncomingMessage, OutgoingMessage, OutgoingPart } from "./types";

export type InboxStatus = "queued" | "running" | "completed" | "failed" | "unknown" | "cancelled";
export type OutboxPartStatus = "pending" | "sending" | "sent" | "failed" | "unknown" | "cancelled";
export interface ChannelInboxRecord {
  kind: "inbox"; id: string; channel: ChannelId; createdAt: number; updatedAt: number;
  message: Omit<IncomingMessage, "at" | "_raw"> & { at: string };
  context: DispatchContext; status: InboxStatus; error?: string;
}
export interface ChannelOutboxRecord {
  kind: "outbox"; id: string; channel: ChannelId; createdAt: number; updatedAt: number;
  fingerprint: string; message: OutgoingMessage;
  conversationId?: string; assistantTurnId?: string; runId?: string;
  parts: Array<{ status: OutboxPartStatus; error?: string; updatedAt: number }>;
}
export type ChannelRecoveryRecord = ChannelInboxRecord | ChannelOutboxRecord;
export interface ChannelCorruptRecord {
  kind: "corrupt";
  id: string;
  channel: "unknown";
  createdAt: number;
  updatedAt: number;
  fileName: string;
  error: string;
}
export interface OutboxIdentity { operationId?: string; conversationId?: string; assistantTurnId?: string; runId?: string }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Operational receipts only. Conversation text/history continues to be owned by CTA. */
export class ChannelRecoveryStore {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string { return path.join(this.directory, `${hash(id)}.json`); }
  private quarantine(file: string, reason: string): void {
    const quarantineDir = path.join(this.directory, "quarantine");
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const target = path.join(quarantineDir, `${path.basename(file)}.${Date.now()}.${reason}.json`);
    try { renameSync(file, target); } catch { /* Preserve the original evidence if it cannot be moved. */ }
  }
  listCorrupt(): ChannelCorruptRecord[] {
    const directory = path.join(this.directory, "quarantine");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith(".json")).flatMap(fileName => {
      try {
        const at = statSync(path.join(directory, fileName)).mtimeMs;
        return [{ kind: "corrupt" as const, id: `corrupt:${fileName}`, channel: "unknown" as const,
          createdAt: at, updatedAt: at, fileName, error: fileName.includes("id-mismatch") ? "记录编号不一致" : "JSON 或记录结构损坏" }];
      } catch { return []; }
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private readRecord(file: string): ChannelRecoveryRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as ChannelRecoveryRecord;
      if (!value || !["inbox", "outbox"].includes(value.kind) || typeof value.id !== "string") throw new Error("invalid_shape");
      return value;
    } catch (error) {
      this.quarantine(file, "invalid");
      console.warn(`[ChannelRecovery] 已隔离损坏记录 ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  private write(record: ChannelRecoveryRecord): void { this.atomicWrite(this.file(record.id), record); }
  private atomicWrite(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    // Directory fsync is supported on Linux. Windows does not permit opening a directory.
    if (process.platform !== "win32") {
      const dir = openSync(this.directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  }
  get(id: string): ChannelRecoveryRecord | undefined {
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    const value = this.readRecord(file);
    if (!value) return undefined;
    if (value.id !== id) { this.quarantine(file, "id-mismatch"); return undefined; }
    return value;
  }
  list(): ChannelRecoveryRecord[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.readRecord(path.join(this.directory, name))).filter((value): value is ChannelRecoveryRecord => Boolean(value)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  /** Call once at process startup, never when merely restarting a channel connection. */
  recoverInterrupted(): void {
    for (const item of this.list()) {
      if (item.kind === "inbox" && item.status === "running") {
        this.setInboxStatus(item.id, "unknown", "process_interrupted_review_before_retry");
      } else if (item.kind === "outbox" && item.parts.some(part => part.status === "sending")) {
        item.parts = item.parts.map(part => part.status === "sending"
          ? { status: "unknown", error: "process_interrupted_delivery_unknown", updatedAt: Date.now() } : part);
        item.updatedAt = Math.max(Date.now(), item.updatedAt + 1); this.write(item);
      }
    }
  }
  accept(message: IncomingMessage, context: DispatchContext): { record: ChannelInboxRecord; created: boolean } {
    const id = message.messageId
      ? `inbox:${hash(JSON.stringify([message.channel, message.chatId, message.messageId]))}`
      : `inbox:${randomUUID()}`;
    const existing = this.get(id);
    if (existing) {
      if (existing.kind !== "inbox") throw new Error("channel_recovery_id_conflict");
      return { record: existing, created: false };
    }
    const { _raw: _ignored, at, ...safe } = message;
    const now = Date.now();
    const record: ChannelInboxRecord = {
      kind: "inbox", id, channel: message.channel, createdAt: now, updatedAt: now,
      message: { ...safe, messageId: safe.messageId || id, at: at.toISOString() }, context: { ...context }, status: "queued",
    };
    this.write(record);
    return { record, created: true };
  }
  setInboxStatus(id: string, status: InboxStatus, error?: string): ChannelInboxRecord {
    const record = this.get(id);
    if (!record || record.kind !== "inbox") throw new Error("inbox_not_found");
    record.status = status; record.error = error; record.updatedAt = Math.max(Date.now(), record.updatedAt + 1); this.write(record); return record;
  }
  prepareOutbox(message: OutgoingMessage, identity: OutboxIdentity = {}): ChannelOutboxRecord {
    const id = identity.operationId || `outbox:${randomUUID()}`;
    const fingerprint = hash(JSON.stringify(message));
    const existing = this.get(id);
    if (existing) {
      if (existing.kind !== "outbox" || existing.fingerprint !== fingerprint) throw new Error("outbox_operation_id_conflict");
      return existing;
    }
    // Snapshot files before the composer removes transient TTS/generated media.
    const spool = path.join(this.directory, "attachments", hash(id));
    const snapshot = (part: OutgoingPart, index: number): OutgoingPart => {
      const key = "filePath" in part && part.filePath ? "filePath" : "imagePath" in part ? "imagePath" : null;
      if (!key) return { ...part };
      const source = key === "imagePath" ? (part as Extract<OutgoingPart, { kind: "sticker" }>).imagePath : (part as { filePath: string }).filePath;
      mkdirSync(spool, { recursive: true, mode: 0o700 });
      const target = path.join(spool, `${index}${path.extname(source).slice(0, 16)}`);
      copyFileSync(source, target);
      chmodSync(target, 0o600);
      const fd = openSync(target, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
      if (process.platform !== "win32") for (const directory of [spool, path.dirname(spool)]) {
        const dir = openSync(directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      return { ...part, ...((part.kind === "file" || part.kind === "video") ? { name: part.name || path.basename(source) } : {}), [key]: target };
    };
    const now = Date.now();
    const record: ChannelOutboxRecord = {
      kind: "outbox", id, channel: message.channel, fingerprint, createdAt: now, updatedAt: now,
      message: { ...message, parts: message.parts.map(snapshot) },
      conversationId: identity.conversationId, assistantTurnId: identity.assistantTurnId, runId: identity.runId,
      parts: message.parts.map(() => ({ status: "pending", updatedAt: now })),
    };
    this.write(record); return record;
  }
  setPart(id: string, index: number, status: OutboxPartStatus, error?: string): ChannelOutboxRecord {
    const record = this.get(id);
    if (!record || record.kind !== "outbox" || !record.parts[index]) throw new Error("outbox_part_not_found");
    record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
    record.parts[index] = { status, error, updatedAt: record.updatedAt }; this.write(record); return record;
  }
  cancel(id: string): void {
    const record = this.get(id);
    if (!record) throw new Error("recovery_record_not_found");
    if (record.kind === "inbox") { this.setInboxStatus(id, "cancelled", "user_cancelled"); return; }
    record.parts = record.parts.map(part => ["pending", "failed"].includes(part.status)
      ? { status: "cancelled", updatedAt: Date.now(), error: "cancelled" } : part);
    record.updatedAt = Math.max(Date.now(), record.updatedAt + 1); this.write(record);
  }
  cancelQueuedChannel(channel: ChannelId): void {
    for (const item of this.list()) {
      if (item.channel !== channel) continue;
      if (item.kind === "inbox" && (item.status === "queued" || item.status === "running")) this.setInboxStatus(item.id, "cancelled", "channel_disabled");
      if (item.kind === "outbox") this.cancel(item.id);
    }
  }
  getCursor(account: string): string {
    const file = path.join(this.directory, `cursor-${hash(account)}.json`);
    return existsSync(file) ? String(JSON.parse(readFileSync(file, "utf8")).cursor ?? "") : "";
  }
  setCursor(account: string, cursor: string): void {
    this.atomicWrite(path.join(this.directory, `cursor-${hash(account)}.json`), { cursor });
  }
}

let activeStore: ChannelRecoveryStore | undefined;
export function setChannelRecoveryStore(store: ChannelRecoveryStore | undefined): void { activeStore = store; }
export function getChannelRecoveryStore(): ChannelRecoveryStore | undefined { return activeStore; }
