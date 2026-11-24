import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RelationshipLogStore } from "./relationship-log-core";
import { createDailyRecaps } from "./daily-recap";
import type { ExpressionSample } from "../../shared/memory-graph";
import type { XilianDiaryEntry } from "../../shared/xilian-world";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "daily-recap-test-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T12:59:00Z"));
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const store = new RelationshipLogStore(join(root, "relationship-log.json"));
  const world: XilianDiaryEntry[] = [];
  const expressions: ExpressionSample[] = [];
  const write = vi.fn(async () => "今天聊到了排练，也记下了新说法。");
  const deps = { material: () => store.dailyRecapMaterial(), save: store.saveDailyRecap.bind(store),
    worldDiary: () => world, expressions: () => expressions, write, timezone: () => "Asia/Shanghai", configured: () => true };
  async function chat(scope: string, conversationId: string, text: string) {
    return store.recordTurn({ conversationId, speechScope: scope, privateContext: true, companionTurnId: "turn1",
      userText: text, assistantText: "好，我记下了。", channel: "web", cyreneFeeling: "开心" });
  }
  return { store, world, expressions, write, deps, chat, service: createDailyRecaps(deps) };
}

it("writes one grounded entry at local night, includes learned sources, and invalidates a forgotten chat", async () => {
  const f = fixture();
  await f.store.updatePreferences({ learnPrivateExpressions: true });
  await f.chat("owner", "private", "我们把排练叫做合唱时间。");
  await f.chat("session:other", "other", "不属于主人的对话");
  f.expressions.push({ id: "bili:x", source: "https://www.bilibili.com/video/BV1", quote: "开麦", scene: "唱歌", at: Date.now() },
    { id: "tieba:y", source: "https://tieba.baidu.com/p/1", quote: "出片", scene: "拍照", at: Date.now() });
  f.world.push({ id: "diary:1", eventId: "1", dateKey: "2026-11-24", writtenAt: Date.now(), title: "散步", text: "在广场走了一圈。",
    mood: "平静", source: "life_event", locationId: "okhema", visibility: "shareable" });
  await f.service.tick();
  expect(f.write).not.toHaveBeenCalled();
  const [draft] = f.service.list();
  expect(draft.status).toBe("collecting");
  expect(draft.sources.map(row => row.kind)).toEqual(["chat", "expression", "expression", "expression", "world"]);
  expect(JSON.stringify(draft)).not.toContain("不属于主人的对话");
  vi.advanceTimersByTime(60_000);
  await Promise.all([f.service.tick(), f.service.tick()]);
  await createDailyRecaps(f.deps).tick();
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.service.list()[0].status).toBe("written");
  vi.advanceTimersByTime(1000);
  await f.chat("owner", "later", "后来我又翻了一页");
  expect(f.service.list()[0]).toMatchObject({ status: "pending", text: "今天聊到了排练，也记下了新说法。" });
  await f.store.forgetConversation("private");
  expect(f.service.list()[0].text).toBeUndefined();
  expect(f.store.dailyRecapMaterial().saved).toEqual([]);
});

it("backs off after failure and discards a result whose source was removed in flight", async () => {
  const f = fixture();
  await f.chat("owner", "private", "我本周要排练");
  vi.advanceTimersByTime(120_000);
  f.write.mockRejectedValueOnce(Error("403"));
  await f.service.tick();
  await f.service.tick();
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.service.list()[0].status).toBe("retry");
  vi.advanceTimersByTime(3_600_000);
  let resolve!: (text: string) => void;
  f.write.mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }));
  const pending = f.service.tick();
  await f.store.forgetConversation("private");
  resolve("已经删除的素材");
  await pending;
  expect(f.service.list()).toEqual([]);
  expect(f.store.dailyRecapMaterial().saved).toEqual([]);
});

it("catches up a previous day after restart and withdraws an archived entry on rewind", async () => {
  const f = fixture();
  await f.chat("owner", "private", "昨天借了乐谱");
  vi.advanceTimersByTime(24 * 3_600_000);
  await f.service.tick();
  const archived = createDailyRecaps({ ...f.deps, material: () => ({ ...f.deps.material(), turns: [] }) });
  expect(archived.list()[0]).toMatchObject({ date: "2026-11-24", status: "written" });
  f.store.retainCompanionFeedbackTurns("private", new Set());
  expect(archived.list()).toEqual([]);
});
