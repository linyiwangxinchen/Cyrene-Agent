// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => import("./core-transport"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); });

class TestSocket {
  static OPEN = 1; static CONNECTING = 0; readyState = 1;
  static latest: TestSocket;
  onmessage?: (message: { data: string }) => void;
  constructor() { TestSocket.latest = this; queueMicrotask(() => this.receive({ type: "ready", clientToken: "test-client" })); }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.readyState = 3; }
}
async function runtime() {
  // resetModules refreshes the transport; refresh its Electron mock too so
  // preload subscriptions and test dispatch use the same transport instance.
  vi.doMock("electron", () => import("./core-transport"));
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  const module = await import("./web-runtime");
  await module.installWebRuntimeGlobals();
  return window as any;
}
it("loads the shared preload bridge on HTTP origins without native randomUUID", async () => {
  const originalCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
  const api = await runtime();
  expect(api.chatStore).toBeDefined();
  expect(globalThis.crypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
it("only refreshes conversations and sidebar for their own original IPC events", async () => {
  const api = await runtime(), { dispatch } = await import("./core-transport");
  const sessions = vi.fn(), sidebar = vi.fn();
  const off = api.chatStore.onChanged(sessions); api.chatStore.onSidebarOrganizationChanged(sidebar);
  for (const channel of ["model-config:changed", "agui:event", "browser-panel:state-changed", "stickers:changed"]) dispatch(channel, {});
  expect(sessions).not.toHaveBeenCalled(); expect(sidebar).not.toHaveBeenCalled();
  dispatch("chats:changed"); expect(sessions).toHaveBeenCalledTimes(1); expect(sidebar).not.toHaveBeenCalled();
  dispatch("chats:sidebar-organization:changed", {}); expect(sidebar).toHaveBeenCalledTimes(1);
  off(); dispatch("chats:changed"); expect(sessions).toHaveBeenCalledTimes(1);
});
it("passes the original run contract and waits for authoritative streamed events", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, runId: "slow-model" }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const api = await runtime(), events: unknown[] = [];
  api.agui.onEvent((event: unknown) => events.push(event));
  const input = { sessionId: "session", assistantTurnId: "answer", currentUser: { text: "hello" } };
  await api.agui.run(input); await vi.advanceTimersByTimeAsync(2500);
  expect(events).toEqual([]);
  TestSocket.latest.receive({ type: "CORE_EVENT", channel: "agui:event", args: [{ type: "TEXT_MESSAGE_CONTENT", runId: "slow-model", messageId: "answer", delta: "Actual answer" }] });
  TestSocket.latest.receive({ type: "CORE_EVENT", channel: "agui:event", args: [{ type: "RUN_FINISHED", runId: "slow-model", status: "success" }] });
  expect(events).toHaveLength(2); expect(events[0]).toMatchObject({ delta: "Actual answer" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe("/api/core/invoke"); expect(JSON.parse(String(call[1].body))).toEqual({ channel: "agui:run", args: [input] });
  expect(call[1].headers).toMatchObject({ "X-Cyrene-Client": "test-client" });
});

it("opens the bound server workspace without invoking a native desktop app", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, request: RequestInit) => {
    const call = JSON.parse(String(request.body)); calls.push(call);
    return new Response(JSON.stringify(call.channel === "chats:get"
      ? { workspaceBinding: { workspaceRoot: "/srv/fixture" } } : { ok: true }), { headers: { "content-type": "application/json" } });
  }));
  const api = await runtime();
  expect(await api.openInApp.listApps("session")).toEqual({ ok: true, apps: [] });
  expect(await api.openInApp.open("session", "explorer")).toEqual({ ok: true });
  expect(calls).toEqual([{ channel: "chats:get", args: ["session"] }, { channel: "chats:open-workspace", args: ["/srv/fixture"] }]);
});

it("preserves PCM bytes and serializes audio before turn-end", async () => {
  vi.useFakeTimers(); const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { calls.push(JSON.parse(init.body)); return new Response("null"); }));
  const api = await runtime();
  api.call.start(); api.call.sendAudioFrame(new Uint8Array([1, 0, 2, 0]).buffer); api.call.turnEnd();
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.map(call => call.channel)).toEqual(["call:start", "call:audio-frame", "call:turn-end"]);
  expect(calls[1].args).toEqual([{ __cyreneBinary: "base64", data: "AQACAA==" }]);
});
it("hangup bypasses an in-flight turn and discards queued microphone frames", async () => {
  vi.useFakeTimers(); const calls: any[] = []; let finish!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    if (call.channel === "call:turn-end") await new Promise<void>(resolve => { finish = resolve; });
    return new Response("null");
  }));
  const api = await runtime(); api.call.turnEnd(); await vi.advanceTimersByTimeAsync(1);
  api.call.sendAudioFrame(new Uint8Array([1, 0]).buffer); api.call.stop(); await vi.advanceTimersByTimeAsync(100);
  expect(calls.map(call => call.channel)).toEqual(["call:turn-end", "call:stop"]);
  finish(); await vi.advanceTimersByTimeAsync(1);
});
it("opens issue mail on the visiting computer without an asynchronous server hop", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const api = await runtime(), mail = "mailto:test@example.invalid?subject=fixture";
  const result = api.system.openExternal(mail);
  expect(open).toHaveBeenCalledWith(mail, "_self");
  expect(await result).toEqual({ ok: true }); expect(fetchMock).not.toHaveBeenCalled();
});
it("isolates external HTTP pages and rejects executable or file links", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const api = await runtime();
  expect(await api.system.openExternal("https://github.com/Playa-Cyrene/Cyrene-Agent/issues")).toEqual({ ok: true });
  expect(open).toHaveBeenCalledWith("https://github.com/Playa-Cyrene/Cyrene-Agent/issues", "_blank", "noopener,noreferrer");
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,unsafe", "not a URL"]) expect(await api.system.openExternal(url)).toMatchObject({ ok: false });
  expect(open).toHaveBeenCalledTimes(1);
});
