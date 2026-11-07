import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelationshipLogStore } from "./relationship-log-core";
import { registerCompanionIpc } from "../persona/companion-ipc";
import { IPC } from "../../shared/ipc-channels";

describe("companion lifecycle and transport", () => {
  let root: string;
  let file: string;
  let store: RelationshipLogStore;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-lifecycle-")); file = path.join(root, "relationship-log.json"); store = new RelationshipLogStore(file); });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
  const turn = { userText: "今天很焦虑", assistantText: "慢一点来", channel: "wechat" as const, cyreneFeeling: "温柔", conversationId: "bound-chat", sourceEventId: "cta-1", runId: "run-1" };

  it("migrates legacy records once and survives restarts without losing user preferences", async () => {
    fs.writeFileSync(file, JSON.stringify({ entries: [{ ...turn, id: "old", date: "2026-01-01", createdAt: 1, userMood: "焦虑", nextCareCue: "legacy", relationshipSignal: "legacy" }], dailySummaries: [] }));
    await store.updatePreferences({ userLabel: "小夏", boundaries: ["不要替我决定"], sharedGoals: ["完成项目"] });
    store = new RelationshipLogStore(file);
    expect((await store.snapshot()).relationship.userLabel).toBe("小夏");
    const context = await store.buildContext("new-chat");
    expect(context).toContain("不要替我决定"); expect(context).toContain("完成项目");
    expect(context).not.toContain("legacy");
    expect(JSON.parse(await store.exportData()).entries).toHaveLength(1);
    expect(fs.existsSync(file.replace(".json", ".sqlite"))).toBe(true);
  });
  it("does not overwrite corrupted legacy data", async () => {
    fs.writeFileSync(file, "{broken");
    await expect(store.snapshot()).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
  });
  it("rejects malformed saved preferences and permissions without silently clearing them", async () => {
    const source = JSON.stringify({ relationshipState: { boundaries: "not an array" }, permissions: { paused: "false" } });
    fs.writeFileSync(file, source);
    await expect(store.snapshot()).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });
  it("rejects stale updates and invalid patches atomically", async () => {
    const first = await store.snapshot();
    await store.command({ type: "preferences", expectedRevision: first.revision, patch: { userLabel: "新称呼" } });
    await expect(store.command({ type: "preferences", expectedRevision: first.revision, patch: { userLabel: "旧窗口" } })).rejects.toThrow("重新加载");
    const current = await store.snapshot();
    await expect(store.command({ type: "preferences", expectedRevision: current.revision, patch: { userLabel: "不应保存", closeness: 100 } })).rejects.toThrow();
    await expect(store.updatePreferences({ trust: 1 } as never)).rejects.toThrow("不允许修改");
    expect(await store.snapshot()).toEqual(current);
  });
  it("keeps 100 turns from escalating the relationship; deduplicates CTA retries", async () => {
    const initial = await store.snapshot();
    for (let i = 0; i < 100; i++) await store.recordTurn({ ...turn, sourceEventId: `cta-${i}`, runId: `run-${i}` });
    const beforeRetry = await store.snapshot();
    await store.recordTurn(turn);
    expect((await store.snapshot()).affect).toMatchObject({ version: beforeRetry.affect.version });
    expect(beforeRetry.relationship.closeness).toBe(initial.relationship.closeness);
    expect(beforeRetry.relationship.trust).toBe(initial.relationship.trust);
    expect(beforeRetry.revision).toBe(initial.revision);
  }, 20_000); // 100 real SQLite checkpoints can exceed 5 seconds on Windows disks.
  it("isolates conversations and refuses group writes/injection", async () => {
    await store.recordTurn(turn);
    expect(await store.buildContext("bound-chat")).toContain("焦虑");
    expect(await store.buildContext("other-chat")).not.toContain("焦虑");
    expect(await store.buildContext("bound-chat", false)).toBe("");
    expect(await store.recordTurn({ ...turn, sourceEventId: "group", privateContext: false })).toBeNull();
    expect(JSON.parse(await store.exportData()).entries).toHaveLength(1);
  });
  it("pause and history consent gate recording and context; decay works without another message", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < 9; i++) await store.recordTurn({ ...turn, sourceEventId: `a-${i}`, runId: `a-${i}` });
    const before = await store.getState();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const after = await new RelationshipLogStore(file).getState();
    expect(after.affectState.concern).toBeLessThan(0.01);
    expect(after.relationshipState.closeness).toBe(before.relationshipState.closeness);
    await store.updatePreferences({ paused: true });
    expect(store.getControls().paused).toBe(true);
    expect(await store.recordTurn({ ...turn, runId: "new", sourceEventId: "new" })).toBeNull();
    expect(await store.buildContext("bound-chat")).toContain("已暂停");
    await store.updatePreferences({ paused: false, recordHistory: false });
    expect(await store.recordTurn({ ...turn, sourceEventId: "new2", runId: "new2" })).toBeNull();
    expect(await store.buildContext("bound-chat")).not.toContain("近期关系线索");
  });
  it("deletion clears derivatives and prevents replay resurrection; reset does not grant tools", async () => {
    await store.recordTurn(turn);
    await store.command({ type: "permissions", expectedRevision: 1, patch: { paused: true, deniedTools: ["run_shell"] } });
    await store.command({ type: "clear_history", expectedRevision: 2 });
    const restored = new RelationshipLogStore(file);
    expect(await restored.recordTurn(turn)).toBeNull();
    expect(JSON.parse(await restored.exportData()).entries).toEqual([]);
    await restored.command({ type: "reset_relationship", expectedRevision: 3 });
    expect((await restored.snapshot()).permissions).toMatchObject({ paused: true, deniedTools: ["run_shell"] });
  });
  it("creates at most one labeled fictional diary per day and does not resurrect deleted notes", async () => {
    await store.updatePreferences({ innerLifeEnabled: true });
    await store.buildContext("a"); await store.buildContext("b");
    let snapshot = await store.snapshot();
    const diaries = snapshot.records.filter(item => item.kind === "diary");
    expect(diaries).toHaveLength(1); expect(diaries[0].text).toContain("虚构");
    await store.command({ type: "delete_record", id: diaries[0].id, expectedRevision: snapshot.revision });
    expect(await store.buildContext("a")).not.toContain("虚构角色小记");
  });
  it("exposes real shared IPC commands with validation, export and restart persistence", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerCompanionIpc({ handle: (id, fn) => { handlers.set(id, fn); }, on() {}, dispose() {}, removeHandler() {} }, store, {
      getWorldSnapshot: () => ({ worldDate: "2026-11-07" } as any),
      queryWorldTimeline: () => [],
      getWorldView: () => ({ state: { worldDate: "2026-11-07" }, timeline: [], diary: [], locations: [] } as any),
    });
    const snapshot = await handlers.get(IPC.COMPANION_GET)!() as Awaited<ReturnType<typeof store.snapshot>>;
    await handlers.get(IPC.COMPANION_UPDATE)!({}, { type: "repair", expectedRevision: snapshot.revision, note: "先回答问题，再关心情绪" });
    expect(await new RelationshipLogStore(file).buildContext("a")).toContain("先回答问题");
    expect(JSON.parse(await handlers.get(IPC.COMPANION_EXPORT)!() as string).format).toBe("cyrene.relationship.v1");
    expect(await handlers.get(IPC.COMPANION_WORLD_GET)!()).toEqual({ state: { worldDate: "2026-11-07" }, timeline: [], diary: [], locations: [] });
    await expect(Promise.resolve(handlers.get(IPC.COMPANION_UPDATE)!({}, { type: "repair", note: "missing revision" }))).rejects.toThrow();
  });
});
