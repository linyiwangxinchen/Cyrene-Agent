import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQrCode, ILinkClient, pollQrStatus, SessionExpiredError } from "./ilink-protocol-client";

const credentials = { botToken: " token ", ilinkBotId: "bot", ilinkUserId: "user", baseUrl: "https://ilinkai.weixin.qq.com/" };
function respond(value: unknown) { return vi.fn(async () => new Response(JSON.stringify(value))); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("iLink receive protocol", () => {
  it.each([{ ret: -14 }, { ret: 0, errcode: -14 }, { errcode: -14 }])("recognizes expired sessions in either return code: %j", async body => {
    vi.stubGlobal("fetch", respond(body));
    await expect(new ILinkClient(credentials).getUpdates()).rejects.toBeInstanceOf(SessionExpiredError);
  });
  it("rejects nonzero errcode even when ret is zero", async () => {
    vi.stubGlobal("fetch", respond({ ret: 0, errcode: 401, errmsg: "private token" }));
    await expect(new ILinkClient(credentials).getUpdates()).rejects.toThrow("errcode=401");
    await expect(new ILinkClient(credentials).getUpdates()).rejects.not.toThrow("private token");
  });
  it("accepts responses without ret and keeps the cursor when it is omitted or empty", async () => {
    const fetch = respond({ msgs: [] }); vi.stubGlobal("fetch", fetch);
    const client = new ILinkClient(credentials);
    expect(await client.getUpdates("cursor-1")).toMatchObject({ messages: [], buf: "cursor-1", pollCompleted: true });
    fetch.mockResolvedValueOnce(new Response('{"ret":0,"get_updates_buf":""}'));
    expect((await client.getUpdates("cursor-1")).buf).toBe("cursor-1");
    expect(fetch.mock.calls[0]).toEqual(["https://ilinkai.weixin.qq.com/ilink/bot/getupdates", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }), body: expect.stringContaining('"get_updates_buf":"cursor-1"') })]);
  });
  it("preserves uint64 message IDs and ignores bot echoes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"msgs":[{"message_id":18446744073709551614,"message_type":1,"from_user_id":"user","to_user_id":"bot","context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"hello"}}]},{"message_type":2}],"get_updates_buf":"next"}')));
    const result = await new ILinkClient(credentials).getUpdates();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ msgId: "18446744073709551614", content: "hello", contextToken: "ctx" });
    expect(result.buf).toBe("next");
  });
  it("keeps the cursor on a quiet long-poll timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
    const pending = new ILinkClient(credentials, { longPollTimeoutMs: 40 }).getUpdates("cursor");
    await vi.advanceTimersByTimeAsync(40);
    expect(await pending).toEqual({ messages: [], buf: "cursor", pollCompleted: false });
  });
  it("immediately cancels active and already-cancelled receive requests", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener("abort", () => reject(init.signal.reason)); })));
    const abort = new AbortController();
    const pending = new ILinkClient(credentials).getUpdates("cursor", abort.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); await assertion;
    await expect(new ILinkClient(credentials).getUpdates("cursor", abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds body reads as well as connection establishment", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => ({ ok: true, text: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) })));
    const pending = new ILinkClient(credentials, { requestTimeoutMs: 20 }).sendText("user", "hello", "ctx");
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("超时") });
  });
  it("does not expose response bodies in HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret response", { status: 502 })));
    await expect(new ILinkClient(credentials).getUpdates()).rejects.toThrow("HTTP 502");
    await expect(new ILinkClient(credentials).getUpdates()).rejects.not.toThrow("secret response");
  });
});

describe("iLink QR requests", () => {
  it("bounds QR requests and propagates caller cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
    const pending = fetchQrCode(); const assertion = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(15_000); await assertion;
    const abort = new AbortController(); const cancelled = fetchQrCode(abort.signal);
    const check = expect(cancelled).rejects.toMatchObject({ name: "AbortError" }); abort.abort(); await check;
  });
  it("rejects an invalid QR response", async () => {
    vi.stubGlobal("fetch", respond({ ret: 0 }));
    await expect(fetchQrCode()).rejects.toThrow("有效二维码");
  });
  it("polls the redirected login host with an encoded ticket", async () => {
    const fetch = respond({ status: "confirmed" }); vi.stubGlobal("fetch", fetch);
    await pollQrStatus("ticket&a=1", undefined, "https://ilinkai2.weixin.qq.com/");
    expect(fetch.mock.calls[0][0]).toBe("https://ilinkai2.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=ticket%26a%3D1");
  });
});
