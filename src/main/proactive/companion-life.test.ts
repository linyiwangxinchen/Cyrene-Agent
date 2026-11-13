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
      dailyMessages: 8,
      dailyQuestions: 3,
      dailyPluginShares: 6,
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
