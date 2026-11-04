import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: mocked.fork }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
import { SharedCoreClient } from "./shared-core-client";

class FixtureChild extends EventEmitter {
  connected = true; exitCode: number | null = null;
  stdout = new EventEmitter(); stderr = new EventEmitter();
  respond = true;
  send = vi.fn((message: { type: string; requestId: string }, callback?: (error: Error | null) => void) => {
    callback?.(null);
    if (message.type === "readiness" && this.respond) queueMicrotask(() => this.emit("message", { type: "response", requestId: message.requestId, value: { ready: true } }));
  });
  kill = vi.fn(() => this.exit());
  exit() { this.connected = false; this.exitCode = 0; this.emit("exit", 0); }
}
afterEach(() => { vi.useRealTimers(); mocked.fork.mockReset(); });
async function started() {
  const child = new FixtureChild(); mocked.fork.mockReturnValue(child);
  const client = new SharedCoreClient("fixture-data", "fixture-root", { info() {}, warn() {}, error() {} });
  const boot = client.start(); child.emit("message", { type: "ready" }); await boot;
  return { client, child };
}
describe("shared-core readiness lifecycle", () => {
  it("stays unready until startup and becomes unready immediately when the core exits", async () => {
    const stopped = new SharedCoreClient("fixture", "fixture"); expect(await stopped.isReady()).toBe(false); expect(mocked.fork).not.toHaveBeenCalled();
    const { client, child } = await started(); expect(await client.isReady()).toBe(true);
    child.exit(); expect(await client.isReady()).toBe(false);
    expect(child.send).toHaveBeenCalledOnce();
  });
  it("reports false while shutting down even before the child has exited", async () => {
    const { client, child } = await started(); expect(await client.isReady()).toBe(true);
    const close = client.close(); expect(await client.isReady()).toBe(false);
    expect(child.send).toHaveBeenLastCalledWith({ type: "shutdown" }); child.exit(); await close;
  });
  it("can make one fresh controlled start after the previous core exits", async () => {
    const first = new FixtureChild(); const second = new FixtureChild();
    mocked.fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new SharedCoreClient("fixture-data", "fixture-root", { info() {}, warn() {}, error() {} });
    const boot = client.start(); first.emit("message", { type: "ready" }); await boot;
    first.exit();
    const retry = client.start(); second.emit("message", { type: "ready" }); await retry;
    expect(mocked.fork).toHaveBeenCalledTimes(2);
    expect(await client.isReady()).toBe(true);
    second.exit();
    await client.close();
  });
  it("fails the readiness request after its bounded RPC timeout", async () => {
    vi.useFakeTimers(); const { client, child } = await started(); child.respond = false;
    const pending = client.isReady(); await vi.advanceTimersByTimeAsync(3001); expect(await pending).toBe(false); child.exit();
  });
});
