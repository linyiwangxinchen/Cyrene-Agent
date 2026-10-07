import { describe, expect, it, vi } from "vitest";
import { installRandomUuidFallback } from "./crypto-compat";

describe("HTTP browser UUID compatibility", () => {
  it("uses cryptographic bytes with UUID v4 version and variant bits", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(255));
    const cryptoApi = { getRandomValues } as unknown as Crypto;
    installRandomUuidFallback(cryptoApi);
    expect(cryptoApi.randomUUID()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it("requests fresh randomness per call and can be installed repeatedly", () => {
    let seed = 0;
    const cryptoApi = { getRandomValues: (bytes: Uint8Array) => bytes.fill(seed++) } as unknown as Crypto;
    installRandomUuidFallback(cryptoApi);
    const installed = cryptoApi.randomUUID;
    installRandomUuidFallback(cryptoApi);
    expect(cryptoApi.randomUUID).toBe(installed);
    expect(cryptoApi.randomUUID()).toBe("00000000-0000-4000-8000-000000000000");
    expect(cryptoApi.randomUUID()).toBe("01010101-0101-4101-8101-010101010101");
  });

  it("preserves the browser native implementation", () => {
    const native = vi.fn(() => "native");
    const cryptoApi = { randomUUID: native } as unknown as Crypto;
    installRandomUuidFallback(cryptoApi);
    expect(cryptoApi.randomUUID).toBe(native);
  });
});
