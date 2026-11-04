import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelRecoveryStore, setChannelRecoveryStore, type ChannelOutboxRecord } from "./recovery-store";
import { registerChannelRecoveryIpc, setChannelRecoveryReceiptWriter } from "./recovery-ipc";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
const mock = vi.hoisted(() => ({ send: vi.fn(async () => ({ ok: true })), enabled: true }));
vi.mock("./manager", () => ({ channelManager: { getAdapter: () => ({ send: mock.send, getStatus: () => ({ enabled: mock.enabled, phase: mock.enabled ? "running" : "offline" }) }) } }));
const directories: string[] = [];
afterEach(() => { setChannelRecoveryStore(undefined); setChannelRecoveryReceiptWriter(undefined); mock.send.mockClear(); mock.enabled = true; for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cyrene-recovery-ipc-")); directories.push(directory);
  const store = new ChannelRecoveryStore(directory); setChannelRecoveryStore(store);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerChannelRecoveryIpc({ handle: (key, handler) => handlers.set(key, handler) } as IpcScope);
  const names = { list: IPC.CHANNELS_RECOVERY_LIST, retry: IPC.CHANNELS_RECOVERY_RETRY, resolve: IPC.CHANNELS_RECOVERY_RESOLVE, cancel: IPC.CHANNELS_RECOVERY_CANCEL };
  const call = (key: keyof typeof names, value?: unknown) => handlers.get(names[key])!(undefined, value);
  store.prepareOutbox({ channel: "wechat", targetId: "target", parts: [{ kind: "text", text: "已送达片段" }, { kind: "text", text: "结果未知片段" }] }, { operationId: "operation", conversationId: "chat", assistantTurnId: "assistant", runId: "run" });
  store.setPart("operation", 0, "sent"); store.setPart("operation", 1, "unknown", "transport_timeout");
  return { store, call };
}
describe("channel recovery UI boundary", () => {
  it("requires explicit unknown-part confirmation before resuming and updates canonical receipts", async () => {
    const { store, call } = setup(); const receipt = vi.fn(async () => undefined); setChannelRecoveryReceiptWriter(receipt);
    await expect(call("retry", { id: "operation", confirmed: true })).rejects.toThrow("resolve_unknown_parts");
    await expect(call("resolve", { id: "operation", index: 1, outcome: "not_sent" })).rejects.toThrow("invalid_part_confirmation");
    expect(mock.send).not.toHaveBeenCalled();
    await call("resolve", { id: "operation", index: 1, outcome: "not_sent", confirmed: true });
    await expect(call("retry", { id: "operation", confirmed: true })).resolves.toMatchObject({ ok: true, deliveredParts: 2 });
    expect(mock.send).toHaveBeenCalledOnce(); expect(mock.send.mock.calls[0][0]).toMatchObject({ parts: [{ text: "结果未知片段" }] });
    expect(receipt).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: "chat", assistantTurnId: "assistant", parts: expect.arrayContaining([expect.objectContaining({ status: "sent" })]) }));
    expect((store.get("operation") as ChannelOutboxRecord).parts.every(part => part.status === "sent")).toBe(true);
  });
  it("does not send when confirming an already-delivered unknown part", async () => {
    const { call } = setup();
    await call("resolve", { id: "operation", index: 1, outcome: "sent", confirmed: true });
    await call("retry", { id: "operation", confirmed: true }); expect(mock.send).not.toHaveBeenCalled();
    expect(call("list")).toEqual([expect.objectContaining({ status: "completed", preview: "已送达片段结果未知片段" })]);
  });
  it("does not override the channel enabled switch from recovery UI", async () => {
    const { call } = setup(); await call("resolve", { id: "operation", index: 1, outcome: "not_sent", confirmed: true });
    mock.enabled = false;
    await expect(call("retry", { id: "operation", confirmed: true })).resolves.toMatchObject({ ok: false, status: "cancelled", error: "channel_disabled" });
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("keeps unknown evidence when cancelling unsent remaining work", async () => {
    const { store, call } = setup(); call("cancel", { id: "operation" });
    expect((store.get("operation") as ChannelOutboxRecord).parts.map(part => part.status)).toEqual(["sent", "unknown"]);
    await expect(call("retry", { id: "operation", confirmed: true })).rejects.toThrow("resolve_unknown_parts");
  });
});
