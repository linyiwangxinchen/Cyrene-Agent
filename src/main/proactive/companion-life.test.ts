import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompanionLifeStore, DEFAULT_COMPANION_LIFE_LIMITS } from "./companion-life";

describe("CompanionLifeStore", () => {
  let root = "";
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("uses the active daily budget while leaving policy guards to the proactive gate", () => {
    expect(DEFAULT_COMPANION_LIFE_LIMITS).toEqual({
      dailyMessages: Number.MAX_SAFE_INTEGER,
      dailyQuestions: 3,
      dailyPluginShares: Number.MAX_SAFE_INTEGER,
    });
  });

  it("deduplicates moments and restores pending state", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-"));
    const store = new CompanionLifeStore(path.join(root, "life.json"), () => 1_000);
    const input = { id: "plugin:item-1", kind: "share" as const, source: "plugin" as const, summary: "发现一段有趣内容", occurredAt: 1_000 };
    expect(store.enqueue(input).id).toBe(input.id);
    expect(store.enqueue(input).summary).toBe(input.summary);
    expect(store.listPending(1_000)).toHaveLength(1);
    expect(store.consume(input.id)).toBe(true);
    expect(store.listPending(1_000)).toHaveLength(0);
  });

  it("creates at most one daily fictional note", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-day-"));
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    const first = store.ensureDailyFictionalMoment({ enabled: true, summary: "【虚构角色小记】今天想整理一张歌单", now: new Date("2026-11-07T10:00:00").getTime() });
    const second = store.ensureDailyFictionalMoment({ enabled: true, summary: "不同内容", now: new Date("2026-11-07T18:00:00").getTime() });
    expect(first?.id).toBe("daily:2026-11-07");
    expect(second?.id).toBe(first?.id);
    expect(store.listPending(new Date("2026-11-07T18:00:00").getTime())[0]?.summary).toContain("歌单");
  });

  it("uses the resolved user date when the host timezone differs", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-timezone-"));
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    const moment = store.ensureDailyFictionalMoment({
      enabled: true,
      summary: "用户时区的每日小记",
      now: new Date("2026-11-06T16:30:00.000Z").getTime(),
      dateKey: "2026-11-07",
    });
    expect(moment?.id).toBe("daily:2026-11-07");
  });

  it("builds a bounded virtual state and creates one low-pressure idle question", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-state-"));
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    const start = new Date("2026-11-07T08:00:00.000Z").getTime();
    store.observeInteraction({ kind: "user_message", now: start, dateKey: "2026-11-07" });
    const idle = store.ensureIdleMoment({ enabled: true, now: start + 8 * 60 * 60_000, dateKey: "2026-11-07", idleSec: 3 * 60 * 60 });
    expect(idle?.kind).toBe("ask");
    expect(store.getNextShareable({ now: start + 8 * 60 * 60_000, dateKey: "2026-11-07" })?.id).toBe(idle?.id);
    expect(store.consume(idle!.id, "consumed", { now: start + 8 * 60 * 60_000, dateKey: "2026-11-07" })).toBe(true);
    expect(store.getState({ now: start + 8 * 60 * 60_000, dateKey: "2026-11-07" }).dailyQuestionCount).toBe(1);
  });

  it("rolls daily counters over without decreasing the virtual state contract", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-rollover-"));
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    const now = new Date("2026-11-07T20:00:00.000Z").getTime();
    store.observeInteraction({ kind: "user_message", now, dateKey: "2026-11-07" });
    const before = store.getState({ now, dateKey: "2026-11-07" });
    const after = store.getState({ now: now + 24 * 60 * 60_000, dateKey: "2026-11-08" });
    expect(after.dateKey).toBe("2026-11-08");
    expect(after.dailyMessageCount).toBe(0);
    expect(after.energy).toBeGreaterThanOrEqual(before.energy);
  });

  it("retains elapsed fractions across minute and hour polling with world energy as authority", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-elapsed-"));
    const start = Date.parse("2026-11-17T08:00:00Z");
    const run = (name: string, interval: number) => {
      const store = new CompanionLifeStore(path.join(root, name));
      store.refreshState({ now: start, dateKey: "2026-11-17", activity: "wait", energy: 42 });
      for (let minute = interval; minute <= 60; minute += interval) store.refreshState({ now: start + minute * 60_000, dateKey: "2026-11-17", energy: 42 });
      return new CompanionLifeStore(path.join(root, name)).getState({ now: start + 3_600_000, dateKey: "2026-11-17" });
    };
    const minute = run("minute.json", 1), hour = run("hour.json", 60);
    expect(minute.boredom).toBeCloseTo(hour.boredom, 10);
    expect(minute.curiosity).toBeCloseTo(hour.curiosity, 10);
    expect(minute.energy).toBe(42);
    expect(minute.boredom).toBeGreaterThan(20);
  });

  it("integrates the previous activity before a change and does not treat sending as social feedback", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-activities-"));
    const start = Date.parse("2026-11-17T08:00:00Z");
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    store.refreshState({ now: start, dateKey: "2026-11-17", activity: "wait", energy: 36 });
    const waiting = store.refreshState({ now: start + 3_600_000, dateKey: "2026-11-17", activity: "study" });
    expect(waiting.boredom).toBe(34);
    const studying = store.refreshState({ now: start + 2 * 3_600_000, dateKey: "2026-11-17" });
    expect(studying.boredom).toBe(24);
    store.enqueue({ id: "note", kind: "share", source: "system", summary: "一点进展", occurredAt: start });
    store.consume("note", "consumed", { now: start + 2 * 3_600_000, dateKey: "2026-11-17" });
    const sent = store.getState({ now: start + 2 * 3_600_000, dateKey: "2026-11-17" });
    expect(sent.boredom).toBe(studying.boredom);
    expect(sent.energy).toBe(36);
  });

  it("allows more than eight shares under the main budget while preserving the question cap", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-budget-"));
    const now = Date.parse("2026-11-17T08:00:00Z");
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    for (let i = 0; i < 10; i++) {
      store.enqueue({ id: `share:${i}`, kind: "share", source: "system", summary: `进展${i}`, occurredAt: now });
      expect(store.getNextShareable({ now, dateKey: "2026-11-17", dailyLimit: 20 })).toBeDefined();
      store.consume(`share:${i}`, "consumed", { now, dateKey: "2026-11-17" });
    }
    for (let i = 0; i < 3; i++) {
      store.enqueue({ id: `ask:${i}`, kind: "ask", source: "system", summary: `问题${i}`, occurredAt: now });
      store.consume(`ask:${i}`, "consumed", { now, dateKey: "2026-11-17" });
    }
    store.enqueue({ id: "last-question", kind: "ask", source: "system", summary: "又一个问题", occurredAt: now });
    expect(store.getNextShareable({ now, dateKey: "2026-11-17", dailyLimit: 20 })).toBeUndefined();
    store.enqueue({ id: "last-share", kind: "share", source: "system", summary: "新进展", occurredAt: now });
    expect(store.getNextShareable({ now, dateKey: "2026-11-17", dailyLimit: 20 })?.id).toBe("last-share");
    expect(store.getNextShareable({ now, dateKey: "2026-11-17", dailyLimit: 13 })).toBeUndefined();
  });

  it("does not let filtered plugin observations hide an eligible daily moment", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-life-filter-"));
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    const now = new Date("2026-11-07T10:00:00.000Z").getTime();
    const daily = store.ensureDailyFictionalMoment({ enabled: true, dateKey: "2026-11-07", now, summary: "今天的虚构小记" });
    store.enqueue({ id: "plugin:new", kind: "share", source: "plugin", occurredAt: now + 1_000, summary: "插件观察" });
    expect(store.getNextShareable({ now: now + 1_000, dateKey: "2026-11-07", allow: item => item.source !== "plugin" })?.id).toBe(daily?.id);
  });

  it.each([
    ["delivery_partial", "failed"],
    ["delivery_unknown", "unknown"],
  ] as const)("moves %s out of automatic retries and resolves it exactly once", (status, deliveryStatus) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), `companion-life-${status}-`));
    const store = new CompanionLifeStore(path.join(root, "life.json"));
    const now = new Date("2026-11-07T10:00:00.000Z").getTime();
    store.enqueue({ id: `moment:${status}`, kind: "share", source: "system", summary: "一条需要复核的心事", occurredAt: now });
    expect(store.markDeliveryReview(`moment:${status}`, status, { deliveryStatus, error: "second_part_unconfirmed", now })).toBe(true);
    expect(store.listPending(now + 1_000)).toHaveLength(0);
    expect(store.listDeliveryReviews()).toMatchObject([{ id: `moment:${status}`, status, deliveryStatus }]);
    expect(store.getState({ now, dateKey: "2026-11-07" }).dailyMessageCount).toBe(0);
    expect(store.resolveDeliveryReview(`moment:${status}`, "consumed", { now: now + 1_000, dateKey: "2026-11-07" })).toBe(true);
    expect(store.resolveDeliveryReview(`moment:${status}`, "consumed", { now: now + 2_000, dateKey: "2026-11-07" })).toBe(false);
    expect(store.getState({ now: now + 2_000, dateKey: "2026-11-07" }).dailyMessageCount).toBe(1);
  });
});
