import { afterEach, describe, expect, it, vi } from "vitest";
import { MiniMaxAsrStream } from "./minimax-asr-engine";
afterEach(() => vi.unstubAllGlobals());

describe("MiniMax ASR protocol", () => {
  it("uploads a WAV to the official CN endpoint and returns the final transcript", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.minimaxi.com/v1/speech_to_text");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-key");
      const form = init.body as FormData; expect(form.get("model")).toBe("asr-1.0"); expect(form.get("response_format")).toBe("json");
      const wav = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF"); expect(wav.readUInt32LE(24)).toBe(16000); expect(wav.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
      return Response.json({ text: " 你好 " });
    }); vi.stubGlobal("fetch", fetchMock);
    const final = vi.fn(), stream = new MiniMaxAsrStream("test-key", final);
    await stream.start(); stream.sendAudio(Buffer.from([1, 0, 2, 0]));
    expect(await stream.stop()).toBe("你好"); expect(await stream.stop()).toBe("你好"); expect(final).toHaveBeenCalledExactlyOnceWith("你好"); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("hangup aborts an in-flight request and suppresses late final callbacks", async () => {
    const final = vi.fn(); vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))));
    const stream = new MiniMaxAsrStream("test-key", final); await stream.start(); stream.sendAudio(Buffer.alloc(640));
    const pending = stream.stop(); stream.cancel(); await expect(pending).rejects.toThrow("cancelled"); expect(final).not.toHaveBeenCalled();
  });
});
