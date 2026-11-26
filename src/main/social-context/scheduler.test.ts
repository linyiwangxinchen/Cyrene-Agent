import { describe, expect, it, vi } from "vitest";
import { createSocialContextScheduler } from "./scheduler";
import { createSocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";
import { setMemoryMode } from "../memory/memory-mode";

function extractionInput(): SocialExtractionInput {
  return {
    conversationId: "chat-a",
    userTurn: { id: "user-1", role: "user", text: "我喜欢海边。" },
    assistantTurn: { id: "assistant-1", role: "assistant", text: "海风确实很舒服。" },
    retrievedAtoms: [],
    now: 100,
  };
}

describe("social context scheduler", () => {
  it("waits for a pre-off job record that resolves after the bulk cancellation", async () => {
    const store = createSocialAtomStore();
    let finishRecord!: (value: string) => void;
    const jobs = {
      record: vi.fn(() => new Promise<string>(resolve => { finishRecord = resolve; })),
      pending: vi.fn(async () => [{ id: "pending-before-off", input: extractionInput() }]),
      complete: vi.fn(async () => undefined),
      discardPending: vi.fn(async () => undefined),
    };
    const generate = vi.fn(async () => '{"operations":[]}');
    const scheduler = createSocialContextScheduler({ store, jobs, generate, enqueue: (_label, task) => task() });
    try {
      const recorded = scheduler.schedule(extractionInput());
      setMemoryMode("off");
      const done = vi.fn();
      const cancellation = scheduler.resumePending().then(done);
      await vi.waitFor(() => expect(jobs.discardPending).toHaveBeenCalledOnce());
      expect(done).not.toHaveBeenCalled();
      finishRecord("late-record");
      await Promise.all([recorded, cancellation]);
      expect(jobs.complete).toHaveBeenCalledWith("late-record");
      expect(jobs.pending).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    } finally { setMemoryMode("vector"); }
  });
  it("does not commit a late extraction after memory is switched off and back on", async () => {
    const store = createSocialAtomStore();
    let finish!: (value: string) => void;
    const generate = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    let queued: Promise<void> | undefined;
    const scheduler = createSocialContextScheduler({ store, generate, enqueue: (_label, task) => queued = task() });
    try {
      scheduler.schedule(extractionInput());
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
      setMemoryMode("off");
      scheduler.schedule(extractionInput());
      setMemoryMode("vector");
      finish(JSON.stringify({ operations: [{ operation: "add", type: "long_term", content: "喜欢海边", evidenceTurnId: "user-1", evidenceQuote: "我喜欢海边" }] }));
      await queued;
      expect(generate).toHaveBeenCalledOnce();
      expect(store.listActive("chat-a", 100)).toEqual([]);
    } finally { setMemoryMode("vector"); }
  });
  it("queues exactly one extraction call when the initial output is valid", async () => {
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      operations: [{
        operation: "add",
        type: "long_term",
        content: "用户喜欢海边",
        evidenceTurnId: "user-1",
        evidenceQuote: "我喜欢海边",
      }],
    }));
    const enqueue = vi.fn((_label: string, task: () => Promise<void>) => task());
    const scheduler = createSocialContextScheduler({ store, generate, enqueue });

    scheduler.schedule(extractionInput());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.listActive("chat-a", 100)).toHaveLength(1);
  });

  it("repairs rejected model output and only persists the fully valid attempt", async () => {
    const invalidRaw = JSON.stringify({
      operations: [
        {
          operation: "add",
          type: "long_term",
          content: "用户喜欢海边",
          evidenceTurnId: "user-1",
          evidenceQuote: "我喜欢海边",
        },
        {
          op: "add",
          type: "long_term",
          content: "错误字段不应被部分写入",
          evidenceTurnId: "user-1",
          evidenceQuote: "我喜欢海边",
        },
      ],
    });
    const validRaw = JSON.stringify({
      operations: [{
        operation: "add",
        type: "long_term",
        content: "用户喜欢海边",
        evidenceTurnId: "user-1",
        evidenceQuote: "我喜欢海边",
      }],
    });
    const store = createSocialAtomStore();
    const generate = vi.fn()
      .mockResolvedValueOnce(invalidRaw)
      .mockResolvedValueOnce(validRaw);
    const recordMetric = vi.fn();
    const enqueue = vi.fn((_label: string, task: () => Promise<void>) => task());
    const scheduler = createSocialContextScheduler({
      store,
      generate,
      enqueue,
      recordMetric,
    });

    scheduler.schedule(extractionInput());
    await vi.waitFor(() => expect(recordMetric).toHaveBeenCalledTimes(1));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[1]).toEqual({
      attempt: 1,
      previousOutput: invalidRaw,
      rejectedCount: 1,
    });
    expect(store.listActive("chat-a", 100)).toHaveLength(1);
    expect(recordMetric).toHaveBeenCalledWith({
      outcome: "success",
      acceptedCount: 1,
      rejectedCount: 0,
      attempts: 2,
      repairCount: 1,
    });
  });

  it("passes after three rejected outputs without persisting partial data", async () => {
    const invalidRaw = JSON.stringify({
      operations: [{
        op: "add",
        type: "long_term",
        content: "用户喜欢海边",
        evidenceTurnId: "user-1",
        evidenceQuote: "我喜欢海边",
      }],
    });
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue(invalidRaw);
    const recordMetric = vi.fn();
    const enqueue = vi.fn((_label: string, task: () => Promise<void>) => task());
    const scheduler = createSocialContextScheduler({
      store,
      generate,
      enqueue,
      recordMetric,
    });

    scheduler.schedule(extractionInput());
    await vi.waitFor(() => expect(recordMetric).toHaveBeenCalledTimes(1));

    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[2]?.[1]).toEqual({
      attempt: 2,
      previousOutput: invalidRaw,
      rejectedCount: 1,
    });
    expect(store.listActive("chat-a", 100)).toEqual([]);
    expect(recordMetric).toHaveBeenCalledWith({
      outcome: "failure",
      acceptedCount: 0,
      rejectedCount: 1,
      attempts: 3,
      repairCount: 2,
    });
  });

  it("does not repair or retry a network failure without model output", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("network"));
    const enqueue = vi.fn((_label: string, task: () => Promise<void>) => task());
    const scheduler = createSocialContextScheduler({
      store: createSocialAtomStore(),
      generate,
      enqueue,
    });

    scheduler.schedule(extractionInput());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
