import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelRecoveryStore, setChannelRecoveryStore, type ChannelInboxRecord, type ChannelOutboxRecord } from "./recovery-store";
import { createChannelDeliveryService, resumeChannelDelivery } from "./delivery-service";
import { DurableChannelInbox } from "./durable-inbox";
import type { IncomingMessage, OutgoingMessage } from "./types";

const directories: string[] = [];
function temporary() { const dir = mkdtempSync(path.join(os.tmpdir(), "cyrene-channel-recovery-")); directories.push(dir); return dir; }
afterEach(() => { setChannelRecoveryStore(undefined); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage { return { channel: "wechat", senderId: "sender", chatId: "private", messageId: "platform-1", text: "继续报告", at: new Date(1), ...overrides }; }
const context = { sessionId: "external-session", boundConversationId: "original-chat" };
const outgoing: OutgoingMessage = { channel: "wechat", targetId: "private", parts: [{ kind: "text", text: "报告如下" }, { kind: "text", text: "正文" }] };
function manager(send = vi.fn(async () => ({ ok: true }))) { return { getAdapter: () => ({ getStatus: () => ({ enabled: true, phase: "running" }), send }) as never }; }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

describe("durable channel transport", () => {
  it("quarantines one corrupt record without blocking healthy recovery records", () => {
    const directory = temporary();
    const corrupt = path.join(directory, `${"a".repeat(64)}.json`);
    writeFileSync(corrupt, "{not-json", "utf8");
    const store = new ChannelRecoveryStore(directory);
    expect(store.list()).toEqual([]);
    expect(existsSync(path.join(directory, "quarantine"))).toBe(true);
    expect(readdirSync(path.join(directory, "quarantine"))).toHaveLength(1);
    const healthy = store.accept(incoming({ messageId: "healthy-after-corruption" }), context);
    expect(store.get(healthy.record.id)).toMatchObject({ id: healthy.record.id, status: "queued" });
    expect(store.listCorrupt()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "corrupt", error: "JSON 或记录结构损坏" })]));
  });

  it("recovers accepted queued messages with their original binding and suppresses platform replay after restart", async () => {
    const directory = temporary();
    const first = new ChannelRecoveryStore(directory);
    const accepted = first.accept(incoming({ _raw: { token: "must-not-persist" } }), context);
    expect(readFileSync(path.join(directory, (await import("node:fs")).readdirSync(directory)[0]), "utf8")).not.toContain("must-not-persist");
    const restarted = new ChannelRecoveryStore(directory); restarted.recoverInterrupted();
    const process = vi.fn(async () => null);
    const inbox = new DurableChannelInbox({ store: restarted, captureContext: async () => ({ ...context, boundConversationId: "new-binding" }), process, isEnabled: () => true });
    await inbox.recoverQueued(); await settle();
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ messageId: "platform-1", at: new Date(1) }), context, expect.any(Function), expect.any(Function));
    expect((restarted.get(accepted.record.id) as ChannelInboxRecord).status).toBe("completed");
    await inbox.handleIncoming(incoming()); expect(process).toHaveBeenCalledOnce();
  });

  it("does not automatically rerun an interrupted agent with unknown tool effects", async () => {
    const directory = temporary(); const original = new ChannelRecoveryStore(directory);
    const { record } = original.accept(incoming(), context); original.setInboxStatus(record.id, "running");
    const restarted = new ChannelRecoveryStore(directory); restarted.recoverInterrupted();
    const process = vi.fn(async () => null);
    const inbox = new DurableChannelInbox({ store: restarted, captureContext: async () => context, process, isEnabled: () => true });
    await inbox.recoverQueued(); await inbox.handleIncoming(incoming());
    expect(process).not.toHaveBeenCalled(); expect((restarted.get(record.id) as ChannelInboxRecord).status).toBe("unknown");
    await expect(inbox.retry(record.id, false)).rejects.toThrow("confirm_previous_tool_effects");
    await inbox.retry(record.id, true); await settle(); expect(process).toHaveBeenCalledOnce();
  });

  it("acknowledges durable receipt without waiting for the model and deduplicates concurrent platform delivery", async () => {
    const store = new ChannelRecoveryStore(temporary()); let release!: () => void;
    const process = vi.fn(() => new Promise<null>(resolve => { release = () => resolve(null); }));
    const inbox = new DurableChannelInbox({ store, captureContext: async () => context, process, isEnabled: () => true });
    await Promise.all([inbox.accept(incoming()), inbox.accept(incoming())]);
    expect(store.list()).toHaveLength(1); expect(process).toHaveBeenCalledOnce();
    release(); await settle(); expect((store.list()[0] as ChannelInboxRecord).status).toBe("completed");
  });

  it("retains agent failure for review instead of reporting the receipt as completed", async () => {
    const store = new ChannelRecoveryStore(temporary());
    const inbox = new DurableChannelInbox({ store, captureContext: async () => context, isEnabled: () => true,
      process: async (_message, _context, onFailure) => { onFailure("summary_model_unavailable"); return null; } });
    await inbox.handleIncoming(incoming());
    expect(store.list()[0]).toMatchObject({ status: "failed", error: "summary_model_unavailable" });
  });

  it("cancels queued work when a channel is disabled and does not revive it on restart", async () => {
    const directory = temporary(); const store = new ChannelRecoveryStore(directory);
    store.accept(incoming(), context); store.cancelQueuedChannel("wechat");
    const process = vi.fn(async () => null);
    const inbox = new DurableChannelInbox({ store: new ChannelRecoveryStore(directory), captureContext: async () => context, process, isEnabled: () => true });
    await inbox.recoverQueued(); expect(process).not.toHaveBeenCalled();
    expect(store.list()[0]).toMatchObject({ status: "cancelled" });
  });

  it("does not revive an in-flight reply when a channel is disabled then enabled before the model finishes", async () => {
    const store = new ChannelRecoveryStore(temporary()); let finish!: () => void; let mayDeliver: (() => boolean) | undefined;
    const inbox = new DurableChannelInbox({ store, captureContext: async () => context, isEnabled: () => true,
      process: async (_message, _context, _failure, canContinue) => { mayDeliver = canContinue; await new Promise<void>(resolve => { finish = resolve; }); return null; } });
    await inbox.accept(incoming()); expect(mayDeliver?.()).toBe(true);
    store.cancelQueuedChannel("wechat"); expect(mayDeliver?.()).toBe(false);
    finish(); await settle(); expect(store.list()[0]).toMatchObject({ status: "cancelled" });
  });

  it("snapshots a temporary attachment and resumes only the failed part after restart", async () => {
    const directory = temporary(); const file = path.join(directory, "tts.tmp.wav"); writeFileSync(file, "audio");
    const store = new ChannelRecoveryStore(path.join(directory, "records"));
    const send = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "upload rejected", deliveryState: "failed" });
    const result = await createChannelDeliveryService(manager(send), store).send({ ...outgoing, parts: [outgoing.parts[0], { kind: "audio", filePath: file, mime: "audio/wav" }] }, { operationId: "run-1", conversationId: "chat" });
    expect(result).toMatchObject({ ok: false, status: "failed", deliveredParts: 1 });
    rmSync(file); const restarted = new ChannelRecoveryStore(store.directory); restarted.recoverInterrupted();
    const resumeSend = vi.fn(async (message: OutgoingMessage) => {
      expect(message.parts).toHaveLength(1); expect(message.parts[0].kind).toBe("audio");
      expect(readFileSync((message.parts[0] as { filePath: string }).filePath, "utf8")).toBe("audio"); return { ok: true };
    });
    expect(await resumeChannelDelivery(manager(resumeSend), restarted, "run-1")).toMatchObject({ ok: true, deliveredParts: 2 });
    expect(resumeSend).toHaveBeenCalledOnce();
    expect(await resumeChannelDelivery(manager(resumeSend), restarted, "run-1")).toMatchObject({ ok: true });
    expect(resumeSend).toHaveBeenCalledOnce();
  });

  it("preserves the original user-visible file name in an attachment snapshot", () => {
    const directory = temporary(); const file = path.join(directory, "实验报告.pdf"); writeFileSync(file, "pdf");
    const store = new ChannelRecoveryStore(path.join(directory, "records"));
    const record = store.prepareOutbox({ channel: "wechat", targetId: "target", parts: [{ kind: "file", filePath: file }] });
    expect(record.message.parts[0]).toMatchObject({ name: "实验报告.pdf" });
    expect((record.message.parts[0] as { filePath: string }).filePath).not.toBe(file);
  });

  it("marks crash-during-send unknown and will not resend until an explicit remote-result resolution", async () => {
    const directory = temporary(); const store = new ChannelRecoveryStore(directory);
    store.prepareOutbox(outgoing, { operationId: "crash" }); store.setPart("crash", 0, "sent"); store.setPart("crash", 1, "sending");
    const restarted = new ChannelRecoveryStore(directory); restarted.recoverInterrupted(); const send = vi.fn(async () => ({ ok: true }));
    expect(await resumeChannelDelivery(manager(send), restarted, "crash")).toMatchObject({ ok: false, status: "unknown", deliveredParts: 1 });
    expect(send).not.toHaveBeenCalled();
    restarted.setPart("crash", 1, "sent", "user_confirmed_sent");
    expect(await resumeChannelDelivery(manager(send), restarted, "crash")).toMatchObject({ ok: true }); expect(send).not.toHaveBeenCalled();
  });

  it("preserves transport timeouts as unknown and stops subsequent attachments", async () => {
    const store = new ChannelRecoveryStore(temporary()); const send = vi.fn(async () => { throw new Error("connection reset after request body"); });
    const result = await createChannelDeliveryService(manager(send), store).send(outgoing, { operationId: "timeout" });
    expect(result).toMatchObject({ ok: false, status: "unknown", deliveredParts: 0 });
    expect((store.get("timeout") as ChannelOutboxRecord).parts.map(part => part.status)).toEqual(["unknown", "pending"]);
    await createChannelDeliveryService(manager(send), store).send(outgoing, { operationId: "timeout" }); expect(send).toHaveBeenCalledOnce();
  });

  it("coalesces simultaneous sends of the same operation and rejects changed payloads", async () => {
    const store = new ChannelRecoveryStore(temporary()); let release!: () => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true }); })).mockResolvedValue({ ok: true });
    const service = createChannelDeliveryService(manager(send), store);
    const first = service.send(outgoing, { operationId: "same" }); const second = service.send(outgoing, { operationId: "same" });
    await settle(); expect(send).toHaveBeenCalledOnce(); release(); await Promise.all([first, second]); expect(send).toHaveBeenCalledTimes(2);
    expect(await service.send({ ...outgoing, targetId: "other-user" }, { operationId: "same" })).toMatchObject({ ok: false, error: "outbox_operation_id_conflict" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops remaining parts when disabling a channel during an external send", async () => {
    const store = new ChannelRecoveryStore(temporary());
    const send = vi.fn(async () => { store.cancelQueuedChannel("wechat"); return { ok: true }; });
    const result = await createChannelDeliveryService(manager(send), store).send(outgoing, { operationId: "disable" });
    expect(result).toMatchObject({ ok: false, status: "cancelled", deliveredParts: 1 }); expect(send).toHaveBeenCalledOnce();
    expect((store.get("disable") as ChannelOutboxRecord).parts.map(part => part.status)).toEqual(["sent", "cancelled"]);
  });

  it("does not send if persisting the send intent fails", async () => {
    const store = new ChannelRecoveryStore(temporary()); const send = vi.fn(async () => ({ ok: true }));
    const original = store.setPart.bind(store); vi.spyOn(store, "setPart").mockImplementation((id, index, status, error) => {
      if (status === "sending") throw new Error("disk full"); return original(id, index, status, error);
    });
    expect(await createChannelDeliveryService(manager(send), store).send(outgoing)).toMatchObject({ ok: false, status: "failed", error: "disk full" });
    expect(send).not.toHaveBeenCalled();
  });
});
