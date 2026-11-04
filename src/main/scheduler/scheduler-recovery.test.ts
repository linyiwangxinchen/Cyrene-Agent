import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createSchedulerStore } from "./scheduler-store";
import { SchedulerEngine } from "./scheduler-engine";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-recovery-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = new Date("2026-11-04T08:00:00Z");
  const deps = { tasksFile: path.join(root, "tasks.json"), historyFile: path.join(root, "history.jsonl"), now: () => now, id: () => "task" };
  const store = createSchedulerStore(deps);
  const input = { title: "延时处理", prompt: "查询并回复", kind: "agent" as const, mode: "work" as const,
    schedule: { kind: "once" as const, runAt: "2026-11-04T08:01:00Z" },
    toolMode: "allow-list" as const, allowedToolIds: ["read_file"], permissionMode: "normal" as const,
    delivery: { channel: "wechat" as const, targetId: "recipient", sessionId: "external-session", conversationId: "bound-session" } };
  return { deps, store, input, advance: (value: string) => { now = new Date(value); } };
}

describe("durable delayed task recovery", () => {
  it("preserves frozen agent tools and bound conversation while keeping legacy reminders harmless", () => {
    const { deps, store, input } = fixture();
    store.addTask({ ...input, missedPolicy: "run-within-grace", missedGraceMinutes: 30 });
    store.addTask({ ...input, kind: undefined, allowedToolIds: [] });
    const reloaded = createSchedulerStore(deps);
    reloaded.load();
    expect(reloaded.getTasks()[0]).toMatchObject({ kind: "agent", mode: "work", toolMode: "allow-list", allowedToolIds: ["read_file"], delivery: { conversationId: "bound-session" }, missedGraceMinutes: 30 });
    expect(reloaded.getTasks()[1]).toMatchObject({ kind: "reminder", mode: "chat", allowedToolIds: [] });
    expect(() => store.updateTask("task", { missedGraceMinutes: 0 })).toThrow("1-1440");
  });

  it("turns interrupted runs into visible unknown and disables recurrence instead of repeating side effects", () => {
    const { deps, store, input } = fixture();
    const task = store.addTask(input);
    store.recordHistory({ id: "run", taskId: task.id, taskTitle: task.title, firedAt: deps.now().toISOString(), status: "running", effectiveToolIds: ["send_file"] });
    const reloaded = createSchedulerStore(deps);
    reloaded.load();
    expect(reloaded.getHistory(task.id)[0]).toMatchObject({ status: "unknown", errorMessage: expect.stringContaining("不会自动重试") });
    expect(reloaded.getTasks()[0]).toMatchObject({ enabled: false, nextFireAt: null });
    reloaded.load();
    expect(reloaded.getHistory(task.id)).toHaveLength(1);
  });

  it.each([["skip", 2, 0], ["run-within-grace", 2, 1], ["run-within-grace", 20, 0]] as const)("%s with %s minute delay performs %s runs", async (missedPolicy, minute, expected) => {
    vi.useFakeTimers();
    try {
      const { deps, store, input, advance } = fixture();
      store.addTask({ ...input, missedPolicy, missedGraceMinutes: 15 });
      advance(`2026-11-04T08:${String(minute).padStart(2, "0")}:00Z`);
      const runTask = vi.fn(async () => ({ ok: true, historyId: "run", effectiveToolIds: [] }));
      const engine = new SchedulerEngine({ store, runTask, now: deps.now });
      engine.start();
      await vi.advanceTimersByTimeAsync(1);
      engine.stop();
      expect(runTask).toHaveBeenCalledTimes(expected);
      expect(store.getTasks()[0].enabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
