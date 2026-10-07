import { describe, expect, it } from "vitest";
import { reviveWebBinary } from "./web-binary";

describe("Web binary arguments", () => {
  it("restores nested image and audio bytes with exact buffer bounds", () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const result = reviveWebBinary({ args: [{ images: [{ bytes: { __cyreneBinary: "base64", data: bytes.toString("base64") } }] }] });
    expect(result.args[0].images[0].bytes).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(result.args[0].images[0].bytes)).toEqual(bytes);
    expect(reviveWebBinary({ __cyreneBinary: "base64", data: "" }).byteLength).toBe(0);
  });
  it.each(["!!!!", "QQ=", "A", "QU JD", 42])("rejects malformed binary payloads: %s", data => {
    expect(() => reviveWebBinary({ __cyreneBinary: "base64", data })).toThrow("INVALID_BINARY_PAYLOAD");
  });
  it("preserves ordinary settings and resource references", () => {
    const input = { args: [null, false, { enabled: true, bytes: { __cyreneMomentUpload: "upload-id" } }] };
    expect(reviveWebBinary(input)).toEqual(input);
  });
});
