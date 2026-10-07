import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets: MockSocket[] = [];
class MockSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
  constructor(readonly url: string) { super(); sockets.push(this); }
  message(name: string, result?: string) { this.emit("message", Buffer.from(JSON.stringify({ header: { name, status: 20000000 }, payload: { result } }))); }
}
vi.mock("ws", () => ({ WebSocket: Object.assign(vi.fn(function (url: string) { return new MockSocket(url); }), { OPEN: 1 }) }));
import { AliyunAsrStream, buildAliyunTokenUrl } from "./aliyun-asr-engine";

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Token: { Id: "fixture-token" } }))));
});
afterEach(() => vi.unstubAllGlobals());
async function open(stream: AliyunAsrStream) {
  const started = stream.start("app-key", "access-key", "secret", "zh");
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0]; socket.emit("open");
  return { socket, started };
}

describe("Aliyun ASR protocol", () => {
  it("matches the official HMAC-SHA1 signature example", () => {
    const url = new URL(buildAliyunTokenUrl("my_access_key_id", "my_access_key_secret", "b924c8c3-6d03-4c5d-ad36-d984d3116788", "2019-04-18T08:32:31Z"));
    expect(url.searchParams.get("SignatureMethod")).toBe("HMAC-SHA1");
    expect(url.searchParams.get("Signature")).toBe("hHq4yNsPitlfDJ2L0nQPdugdEzM=");
  });
  it("waits for the start acknowledgement and sends buffered PCM only afterward", async () => {
    const stream = new AliyunAsrStream(vi.fn(), vi.fn());
    const { socket, started } = await open(stream);
    expect(socket.url).toBe("wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=fixture-token");
    const done = vi.fn(); started.then(done);
    stream.sendAudio(Buffer.alloc(6400));
    expect(socket.send).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.calls[0][0]).header.name).toBe("StartTranscription");
    socket.message("TranscriptionStarted"); await started;
    expect(socket.send).toHaveBeenLastCalledWith(Buffer.alloc(6400), { binary: true }); stream.cancel();
  });
  it("waits for TranscriptionCompleted and preserves all final sentences", async () => {
    const partial = vi.fn(), final = vi.fn(), stream = new AliyunAsrStream(partial, final);
    const { socket, started } = await open(stream); socket.message("TranscriptionStarted"); await started;
    stream.sendAudio(Buffer.from([1, 0])); socket.message("SentenceEnd", "你好。");
    const stopped = stream.stop(); const completed = vi.fn(); stopped.then(completed);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).header.name).toBe("StopTranscription");
    socket.message("TranscriptionResultChanged", "昔涟"); socket.message("SentenceEnd", "昔涟。");
    await Promise.resolve(); expect(completed).not.toHaveBeenCalled();
    expect(partial).toHaveBeenLastCalledWith("你好。昔涟"); expect(final).toHaveBeenLastCalledWith("你好。昔涟。");
    socket.message("TranscriptionCompleted"); expect(await stopped).toBe("你好。昔涟。"); expect(stream.stop()).toBe(stopped);
  });
  it("rejects premature close and suppresses results after cancellation", async () => {
    const final = vi.fn(), stream = new AliyunAsrStream(vi.fn(), final);
    const { socket, started } = await open(stream); socket.message("TranscriptionStarted"); await started;
    const stopped = stream.stop(); const rejection = expect(stopped).rejects.toThrow("完成前关闭"); socket.emit("close"); await rejection;
    socket.message("SentenceEnd", "迟到的结果"); expect(final).not.toHaveBeenCalled();
    const cancelled = new AliyunAsrStream(vi.fn(), final), pending = cancelled.start("app", "key", "secret", "zh");
    await vi.waitFor(() => expect(sockets).toHaveLength(2)); const rejects = expect(pending).rejects.toThrow("取消"); cancelled.cancel(); await rejects;
    sockets[1].message("SentenceEnd", "迟到的结果"); expect(final).not.toHaveBeenCalled();
  });
});
