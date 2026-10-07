import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAsrStream } from "./local-asr-engine";
afterEach(() => vi.unstubAllGlobals());
const config = { engine: "local" as const, endpointUrl: "http://127.0.0.1:8000/v1/audio/transcriptions", model: "whisper-1", apiKey: "secret" };
describe("self-hosted ASR", () => {
  it("uploads PCM as WAV with authentication and invokes the final callback once", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("model")).toBe("whisper-1");
      const audio = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
      expect(audio.toString("ascii", 0, 4)).toBe("RIFF");
      expect(audio.readUInt32LE(24)).toBe(16000);
      expect(audio.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
      expect(init.headers).toEqual({ Authorization: "Bearer secret" });
      return new Response(JSON.stringify({ text: " 转写结果 " }));
    }); vi.stubGlobal("fetch", fetchMock);
    const final = vi.fn(), stream = new LocalAsrStream(config, final);
    await stream.start(); stream.sendAudio(Buffer.from([1, 0, 2, 0]));
    expect(await stream.stop()).toBe("转写结果"); expect(await stream.stop()).toBe("转写结果");
    expect(final).toHaveBeenCalledExactlyOnceWith("转写结果"); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("cancel discards buffered audio without uploading", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const stream = new LocalAsrStream(config, vi.fn()); await stream.start(); stream.sendAudio(Buffer.alloc(640)); stream.cancel();
    await expect(stream.stop()).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cancel aborts an in-flight transcription and suppresses final callbacks", async () => {
    const final = vi.fn(); vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))));
    const stream = new LocalAsrStream(config, final); await stream.start(); stream.sendAudio(Buffer.alloc(640));
    const pending = stream.stop(); stream.cancel(); await expect(pending).rejects.toThrow("aborted"); expect(final).not.toHaveBeenCalled();
  });
});
