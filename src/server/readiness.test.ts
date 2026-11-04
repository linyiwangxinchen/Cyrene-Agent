import { describe, expect, it, vi } from "vitest";
import { createReadinessProbe } from "./readiness";

describe("readiness", () => {
  it("coalesces concurrent probes and returns failure when core/database rejects", async () => {
    let now = 0;
    const check = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("SQLITE_CLOSED"));
    const probe = createReadinessProbe(check, () => now);
    expect(await Promise.all([probe(), probe(), probe()])).toEqual([true, true, true]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(await probe()).toBe(true);
    now = 1_001;
    expect(await probe()).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
