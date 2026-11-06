import { describe, expect, it } from "vitest";
import { isCacheDiagnostic } from "./cache-diagnostic";

const valid = {
  runId: "run-1",
  cacheEpoch: 1,
  round: 0,
  stablePromptFingerprint: "a".repeat(64),
  toolSchemaFingerprint: "b".repeat(64),
  messagePrefixFingerprint: "c".repeat(64),
  messageCount: 2,
};

describe("cache diagnostic shape", () => {
  it("accepts hash-only diagnostics", () => {
    expect(isCacheDiagnostic(valid)).toBe(true);
  });

  it("rejects malformed hashes and negative counts", () => {
    expect(isCacheDiagnostic({ ...valid, stablePromptFingerprint: "prompt text" })).toBe(false);
    expect(isCacheDiagnostic({ ...valid, messageCount: -1 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isCacheDiagnostic(null)).toBe(false);
    expect(isCacheDiagnostic("diagnostic")).toBe(false);
  });
});
