import { describe, expect, it, vi } from "vitest";
import { tryAcquireConversationRun, withConversationRun } from "./conversation-run-guard";

describe("shared conversation run boundary", () => {
  it("serializes the same conversation while unrelated conversations continue", async () => {
    const release = tryAcquireConversationRun("shared")!;
    const task = vi.fn(async () => "queued");
    const queued = withConversationRun("shared", task);
    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();
    expect(tryAcquireConversationRun("shared")).toBeNull();
    await expect(withConversationRun("other", async () => "independent")).resolves.toBe("independent");
    release();
    await expect(queued).resolves.toBe("queued");
    const next = tryAcquireConversationRun("shared");
    expect(next).not.toBeNull();
    next!();
  });

  it("cancels a queued task without executing it, and releases a failed active task", async () => {
    const release = tryAcquireConversationRun("cancel")!;
    const abort = new AbortController();
    const task = vi.fn(async () => undefined);
    const cancelled = withConversationRun("cancel", task, abort.signal);
    const assertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await assertion;
    release();
    expect(task).not.toHaveBeenCalled();
    await expect(withConversationRun("cancel", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    await expect(withConversationRun("cancel", async () => "recovered")).resolves.toBe("recovered");
  });
});
