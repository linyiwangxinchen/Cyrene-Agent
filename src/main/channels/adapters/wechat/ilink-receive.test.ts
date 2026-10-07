import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUpdates: vi.fn(), pollQrStatus: vi.fn(), writeFile: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "C:/tmp/cyrene-test-user-data" } }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, promises: { ...fs.promises, readFile: vi.fn(async () => JSON.stringify({ botToken: "token", ilinkBotId: "bot", baseUrl: "https://ilinkai.weixin.qq.com" })), mkdir: vi.fn(), writeFile: mocks.writeFile } };
});
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ wechat: { enabled: true } }) }));
vi.mock("./ilink-protocol-client", async original => ({ ...await original<object>(), ILinkClient: class { getUpdates = mocks.getUpdates; }, pollQrStatus: mocks.pollQrStatus }));
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import { SessionExpiredError } from "./ilink-protocol-client";

let adapter: ILinkBotAdapter;
function pendingPoll(_buf: string, signal: AbortSignal) { return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
beforeEach(() => { vi.clearAllMocks(); mocks.getUpdates.mockImplementation(pendingPoll); adapter = new ILinkBotAdapter(); });
afterEach(async () => { await adapter.stop(); vi.useRealTimers(); });

describe("WeChat receive lifecycle", () => {
  it("aborts polling on disable and does not dispatch the late receive response", async () => {
    let resolve!: (value: unknown) => void;
    mocks.getUpdates.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const handler = vi.fn(async () => null); adapter.onMessage = handler;
    await adapter.start();
    const stopped = adapter.stop();
    expect(adapter.getStatus().enabled).toBe(false);
    expect(mocks.getUpdates.mock.calls[0][1].aborted).toBe(true);
    resolve({ messages: [{ msgId: "late", fromUserId: "user", content: "hello", items: [], contextToken: "ctx" }], buf: "next" });
    await stopped; expect(handler).not.toHaveBeenCalled();
  });
  it("does not claim connected before the first successful receive response", async () => {
    await adapter.start(); expect(adapter.getStatus().phase).toBe("starting");
  });
  it("delivers messages, advances the cursor and publishes receive health", async () => {
    const onMessage = vi.fn(async () => null); adapter.onMessage = onMessage;
    mocks.getUpdates.mockResolvedValueOnce({ messages: [{ msgId: "18446744073709551614", fromUserId: "user", content: "hello", items: [], contextToken: "ctx" }], buf: "next" });
    await adapter.start(); await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage.mock.calls[0][0]).toMatchObject({ channel: "wechat", messageId: "18446744073709551614", text: "hello" });
    expect(adapter.getStatus()).toMatchObject({ phase: "running", detail: { receivedMessages: 1 } });
    expect(mocks.getUpdates).toHaveBeenLastCalledWith("next", expect.any(AbortSignal));
  });
  it("exposes receive failures and recovers after a retry", async () => {
    vi.useFakeTimers(); mocks.getUpdates.mockRejectedValueOnce(new Error("DNS failure")).mockResolvedValueOnce({ messages: [], buf: "ok" });
    await adapter.start(); await vi.advanceTimersByTimeAsync(0);
    expect(adapter.getStatus()).toMatchObject({ phase: "error", detail: { consecutiveFailures: 1 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.getStatus()).toMatchObject({ phase: "running", detail: { consecutiveFailures: 0 } });
  });
  it("marks expired sessions as logged out and stops retrying", async () => {
    mocks.getUpdates.mockRejectedValueOnce(new SessionExpiredError("expired"));
    await adapter.start(); await vi.waitFor(() => expect(adapter.getStatus().phase).toBe("error"));
    expect(adapter.isLoggedIn).toBe(false); expect(mocks.getUpdates).toHaveBeenCalledTimes(1);
  });
  it("stops immediately during exponential backoff", async () => {
    vi.useFakeTimers(); mocks.getUpdates.mockRejectedValueOnce(new Error("offline"));
    await adapter.start(); await vi.advanceTimersByTimeAsync(0); await adapter.stop();
    expect(adapter.getStatus().phase).toBe("offline"); expect(vi.getTimerCount()).toBe(0);
  });
  it("continues processing the rest of a batch after one handler fails", async () => {
    adapter.onMessage = vi.fn().mockRejectedValueOnce(new Error("model failed")).mockResolvedValue(null);
    mocks.getUpdates.mockResolvedValueOnce({ messages: [1, 2].map(n => ({ msgId: String(n), fromUserId: "user", content: "hello", items: [], contextToken: "ctx" })), buf: "next" });
    await adapter.start(); await vi.waitFor(() => expect(adapter.onMessage).toHaveBeenCalledTimes(2));
  });
  it("follows WeChat IDC redirects and saves the confirmed host", async () => {
    mocks.pollQrStatus.mockResolvedValueOnce({ status: "scaned_but_redirect", redirect_host: "ilinkai2.weixin.qq.com" }).mockResolvedValueOnce({ status: "confirmed", bot_token: "new-token", ilink_bot_id: "bot" });
    const result = await adapter.login("ticket"); expect(result.baseUrl).toBe("https://ilinkai2.weixin.qq.com");
    expect(mocks.pollQrStatus).toHaveBeenLastCalledWith("ticket", undefined, "https://ilinkai2.weixin.qq.com");
  });
  it("does not save credentials after the login has been cancelled", async () => {
    const abort = new AbortController();
    mocks.pollQrStatus.mockImplementationOnce(async () => { abort.abort(); return { status: "confirmed", bot_token: "new-token", ilink_bot_id: "bot" }; });
    await expect(adapter.login("ticket", abort.signal)).rejects.toThrow("aborted"); expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
