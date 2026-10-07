import { describe, expect, it } from "vitest";
import { reviveWebBinary } from "../web-binary";
import { pcmAudioBytes } from "./pcm-audio";

describe("audio transport compatibility", () => {
  it("accepts HTTP revived buffers and legacy/WebSocket binary markers", () => {
    const bytes = Buffer.from([0, 1, 254, 255]);
    const wire = { __cyreneBinary: "base64", data: bytes.toString("base64") };
    expect(pcmAudioBytes(wire)).toEqual(bytes);
    expect(pcmAudioBytes(reviveWebBinary(wire))).toEqual(bytes);
  });
  it("uses exact view boundaries without surrounding bytes", () => {
    const bytes = new Uint8Array([8, 0, 1, 254, 255, 9]);
    expect(pcmAudioBytes(bytes.subarray(1, 5))).toEqual(Buffer.from([0, 1, 254, 255]));
    expect(pcmAudioBytes(new DataView(bytes.buffer, 1, 4))).toEqual(Buffer.from([0, 1, 254, 255]));
  });
  it.each([null, {}, { __cyreneBinary: "base64", data: "!!!!" }, { __cyreneBinary: "base64", data: "AA=" }, new ArrayBuffer(0), new ArrayBuffer(1)])("rejects malformed or incomplete samples: %j", value => {
    expect(() => pcmAudioBytes(value)).toThrow("INVALID_PCM_AUDIO");
  });
  it("bounds decoded bytes for every transport", () => {
    const maximum = Buffer.alloc(3_840_000);
    expect(pcmAudioBytes(maximum).length).toBe(maximum.length);
    for (const value of [new ArrayBuffer(maximum.length + 2), { __cyreneBinary: "base64", data: Buffer.alloc(maximum.length + 2).toString("base64") }]) {
      expect(() => pcmAudioBytes(value)).toThrow("INVALID_PCM_AUDIO");
    }
  });
});
