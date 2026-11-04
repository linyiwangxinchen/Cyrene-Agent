import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSchedulerStore } from "./scheduler-store";
import { SchedulerEngine } from "./scheduler-engine";
import { createSchedulerRunner } from "./scheduler-runner";
import { tryAcquireConversationRun } from "../orchestrator/conversation-run-guard";

vi.mock("../orchestrator/tools/registry/tool-registry", () => ({ toolRegistry: { getAllTools: () => [] } }));
vi.mock("../orchestrator/cyrene-agent", () => ({ CyreneAgent: class {} }));
vi.mock("../channels/manager", () => ({ channelManager: { getAdapter: () => undefined } }));
vi.mock("../channels/settings-store", () => ({ loadChannelsSettings: () => ({ toolSandbox: "all" }) }));
vi.mock("../channels/history-log", () => ({ appendHistory: vi.fn() }));
vi.mock("../channels/message-log", () => ({ appendLog: vi.fn() }));
const roots: string[] = []; const engines: SchedulerEngine[] = []; const releases: Array<() => void> = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.stop(); for (const release of releases.splice(0)) release(); vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-queue-")); roots.push(root);
  let now = new Date("2026-11-04T00:00:00Z");
  const deps = { tasksFile: path.join(root, "tasks.json"), historyFile: path.join(root, "history.jsonl"), now: () => now, id: () => "task" };
  const store = createSchedulerStore(deps);
  const task = store.addTask({ title: "稍后处理文件", prompt: "处理文件", enabled: true, kind: "agent", mode: "work", toolMode: "allow-list", allowedToolIds: [],
    delivery: { channel: "wechat", targetId: "recipient", sessionId: "external", conversationId: root }, schedule: { kind: "once", runAt: "2026-11-04T00:00:01Z" } });
  const buildOptions = vi.fn(async () => { throw new Error("fixture must not call a model"); });
  const runner = createSchedulerRunner({ buildOptions, getChatWebContents: () => null, recordHistory: entry => store.recordHistory(entry), id: () => "run", now: () => now });
  const runTask = vi.fn(runner.runScheduledTask);
  const engine = new SchedulerEngine({ store, runTask, now: () => now }); engines.push(engine);
  return { deps, store, task, runner, engine, runTask, buildOptions, hold() { const release = tryAcquireConversationRun(root)!; expect(release).toBeTypeOf("function"); releases.push(release); return release; }, advance: (value = "2026-11-04T00:00:01Z") => { now = new Date(value); } };
}
describe("scheduled conversation queue safety", () => {
  it("keeps a once schedule when its durable admission fails, then retries without a busy loop", async () => {
    vi.useFakeTimers(); const f = fixture(); const release = f.hold();
    // A real filesystem failure, not a synthetic rejected agent promise: the
    // history destination is temporarily an existing directory.
    fs.mkdirSync(f.deps.historyFile);
    const prepareTask = vi.fn(f.runner.prepareScheduledTask);
    const engine = new SchedulerEngine({ store: f.store, runTask: f.runTask, prepareTask, now: f.deps.now }); engines.push(engine);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      engine.start(); f.advance(); await vi.advanceTimersByTimeAsync(1001);
      expect(prepareTask).toHaveBeenCalledTimes(1);
      expect(f.store.getTasks()[0]).toMatchObject({ enabled: true, nextFireAt: "2026-11-04T00:00:01.000Z" });
      expect(f.buildOptions).not.toHaveBeenCalled(); expect(f.runTask).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4000); expect(prepareTask).toHaveBeenCalledTimes(1);
      fs.rmdirSync(f.deps.historyFile); f.advance("2026-11-04T00:00:06Z");
      await vi.advanceTimersByTimeAsync(1001);
      expect(prepareTask).toHaveBeenCalledTimes(2);
      expect(f.store.getTasks()[0]).toMatchObject({ enabled: false, nextFireAt: null });
      expect(f.store.getHistory(f.task.id)[0]).toMatchObject({ status: "running", reason: "waiting_for_conversation" });
      engine.stop(); release(); await vi.advanceTimersByTimeAsync(1);
      expect(f.store.getHistory(f.task.id)[0]).toMatchObject({ status: "skipped" });
      expect(f.buildOptions).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
  it("persists a consumed once occurrence before it waits for the foreground conversation", async () => {
    vi.useFakeTimers(); const f = fixture(); const release = f.hold(); f.engine.start(); f.advance(); await vi.advanceTimersByTimeAsync(1001);
    expect(f.store.getTasks()[0]).toMatchObject({ enabled: false, nextFireAt: null });
    expect(f.store.getHistory(f.task.id)[0]).toMatchObject({ id: "run", status: "running", reason: "waiting_for_conversation" });
    expect(f.buildOptions).not.toHaveBeenCalled();
    const restarted = createSchedulerStore(f.deps); restarted.load();
    expect(restarted.getHistory(f.task.id)[0]).toMatchObject({ id: "run", status: "unknown" });
    f.engine.stop(); release(); await f.runTask.mock.results[0].value;
  });
  it.each(["disable", "delete", "stop", "edit"] as const)("%s while queued cancels without executing or leaking the shared lock", async action => {
    const f = fixture(); const release = f.hold(); f.engine.start(); const running = f.engine.fireNow(f.task.id);
    expect(f.store.getHistory(f.task.id)[0]).toMatchObject({ status: "running" });
    if (action === "disable") f.store.updateTask(f.task.id, { enabled: false });
    if (action === "delete") f.store.deleteTask(f.task.id);
    if (action === "edit") f.store.updateTask(f.task.id, { prompt: "新的要求" });
    if (action === "stop") f.engine.stop();
    expect(await running).toMatchObject({ ok: false, reason: expect.stringContaining("未执行") });
    expect(f.buildOptions).not.toHaveBeenCalled(); expect(f.store.getHistory(f.task.id)[0]).toMatchObject({ status: "skipped" });
    release(); const next = tryAcquireConversationRun(f.task.delivery!.conversationId!); expect(next).toBeTypeOf("function"); next!();
  });
  it("does not confuse automatic once consumption or unrelated edits with cancellation, but honours explicit cancellation afterwards", async () => {
    vi.useFakeTimers(); const f = fixture(); const release = f.hold(); f.engine.start(); f.advance(); await vi.advanceTimersByTimeAsync(1001);
    const signal = f.runTask.mock.calls[0][3]!; expect(signal.aborted).toBe(false);
    f.store.addTask({ ...f.task, title: "其他任务", schedule: { kind: "once", runAt: "2026-11-05T00:00:00Z" }, enabled: true });
    expect(signal.aborted).toBe(false);
    // Already auto-disabled once tasks must still accept explicit cancel events.
    f.store.updateTask(f.task.id, { enabled: false }); expect(signal.aborted).toBe(true);
    release(); await f.runTask.mock.results[0].value; expect(f.buildOptions).not.toHaveBeenCalled();
  });
});
