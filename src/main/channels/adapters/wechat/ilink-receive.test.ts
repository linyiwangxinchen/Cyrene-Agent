import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getUpdates: vi.fn(), pollQrStatus: vi.fn(), writeFile: vi.fn(), loadContexts: vi.fn(() => [] as Array<{ targetId: string; token: string; at: number }>), rememberContext: vi.fn(), clearContexts: vi.fn() }));
vi.mock("./reply-context-store", () => ({ WechatReplyContextStore: class { load = mocks.loadContexts; remember = mocks.rememberContext; clear = mocks.clearContexts; } }));
vi.mock("electron", () => ({ app: { getPath: () => "C:/tmp/cyrene-test-user-data" } }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, promises: { ...fs.promises, readFile: vi.fn(async () => JSON.stringify({ botToken: "token", ilinkBotId: "bot", baseUrl: "https://ilinkai.weixin.qq.com" })), mkdir: vi.fn(), writeFile: mocks.writeFile } };
});
vi.mock("../../settings-store", () => ({ loadChannelsSettings: () => ({ wechat: { enabled: true } }) }));
vi.mock("./ilink-protocol-client", async original => ({ ...await original<object>(), ILinkClient: class { getUpdates = mocks.getUpdates; }, pollQrStatus: mocks.pollQrStatus }));
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import { SessionExpiredError } from "./ilink-protocol-client";
import { promises as fs } from "node:fs";

let adapter: ILinkBotAdapter;
function pendingPoll(_buf: string, signal: AbortSignal) { return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
beforeEach(() => { vi.clearAllMocks(); mocks.loadContexts.mockReturnValue([]); mocks.getUpdates.mockImplementation(pendingPoll); adapter = new ILinkBotAdapter(); });
afterEach(async () => { await adapter.stop(); vi.useRealTimers(); });

describe("WeChat receive lifecycle", () => {
  it("restores reply context before polling without clearing it on first startup", async () => {
    mocks.loadContexts.mockReturnValue([{ targetId: "user", token: "restored-context", at: Date.now() }]);
    mocks.getUpdates.mockResolvedValueOnce({ messages: [], buf: "next" });
    await adapter.start(); await vi.waitFor(() => expect(adapter.getStatus().phase).toBe("running"));
    expect((adapter as any).replyContextByTarget.get("user")).toBe("restored-context");
    expect(mocks.clearContexts).not.toHaveBeenCalled();
    expect(adapter.getProactiveAvailability("user")).toEqual({ available: true });
    expect(adapter.getProactiveAvailability("unknown")).toMatchObject({ available: false, reason: "wechat_context_missing" });
    await adapter.stop(); expect(mocks.clearContexts).not.toHaveBeenCalled();
  });
  it("does not resurrect polling when credentials finish loading after stop", async () => {
    let complete!: (value: string) => void;
    vi.mocked(fs.readFile).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }) as any);
    const starting = adapter.start();
    await adapter.stop();
    complete(JSON.stringify({ botToken: "token", ilinkBotId: "bot", baseUrl: "https://ilinkai.weixin.qq.com" }));
    await starting;
    expect(mocks.getUpdates).not.toHaveBeenCalled();
    expect(adapter.getStatus().enabled).toBe(false);
  });
  it("clears recipient tokens and pending inbound media on logout", async () => {
    (adapter as any).replyContextByTarget.set("user", "old-context");
    (adapter as any).pendingSaveIntentByTarget.set("user", Date.now());
    (adapter as any).pendingUnsupportedMediaByTarget.set("user", {});
    await adapter.logout();
    expect((adapter as any).replyContextByTarget.size).toBe(0);
    expect((adapter as any).pendingSaveIntentByTarget.size).toBe(0);
    expect((adapter as any).pendingUnsupportedMediaByTarget.size).toBe(0);
    expect(mocks.clearContexts).toHaveBeenCalled();
  });
  it("aborts a pending attachment download when the channel is disabled", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn(async () => null); adapter.onMessage = handler;
    mocks.getUpdates.mockResolvedValueOnce({ messages: [{ msgId: "file", fromUserId: "user", content: "看看附件", items: [{ type: 4, file_item: { file_name: "report.txt", media: { encrypt_query_param: "download", aes_key: "00112233445566778899aabbccddeeff" } } }], contextToken: "ctx" }], buf: "next" });
    try {
      await adapter.start();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await adapter.stop();
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
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
    expect(mocks.rememberContext).toHaveBeenCalledWith(expect.objectContaining({ ilinkBotId: "bot" }), "user", "ctx");
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
