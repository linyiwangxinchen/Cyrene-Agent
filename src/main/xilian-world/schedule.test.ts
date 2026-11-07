import { describe, expect, it } from "vitest";
import { createDefaultXilianWorldData } from "../../shared/xilian-world";
import { getXilianDateKey, reconcileXilianWorld, xilianStableHash } from "./schedule";

describe("xilian schedule", () => {
  it("uses the configured timezone for the world date", () => {
    const instant = new Date("2026-11-06T16:30:00.000Z");
    expect(getXilianDateKey(instant, "Asia/Shanghai")).toBe("2026-11-07");
    expect(getXilianDateKey(instant, "America/Los_Angeles")).toBe("2026-11-06");
  });

  it("produces a deterministic set of events for the same day", () => {
    const now = new Date("2026-11-07T10:00:00.000Z").getTime();
    const initial = createDefaultXilianWorldData("2026-11-07", now);
    const first = reconcileXilianWorld({ state: initial.state, timeline: [], now, timezone: "UTC" });
    const second = reconcileXilianWorld({ state: initial.state, timeline: [], now, timezone: "UTC" });
    expect(first.events).toEqual(second.events);
    expect(first.state.currentActivity?.id).toBe("xilian:2026-11-07:morning");
    expect(first.state.nextPlannedEvent?.status).toBe("planned");
    expect(first.events.find(event => event.status === "completed")?.diaryText).toBeTruthy();
    expect(first.events.some(event => event.summary.includes("暂时还没有答案") || event.summary.includes("准备之后再确认"))).toBe(false);
    expect(xilianStableHash("same-seed")).toBe(xilianStableHash("same-seed"));
  });

  it("is idempotent after persisting the generated events", () => {
    const now = new Date("2026-11-07T18:00:00.000Z").getTime();
    const initial = createDefaultXilianWorldData("2026-11-07", now);
    const first = reconcileXilianWorld({ state: initial.state, timeline: [], now, timezone: "UTC" });
    const persisted = [...first.events];
    const second = reconcileXilianWorld({ state: first.state, timeline: persisted, now, timezone: "UTC" });
    expect(second.events).toEqual([]);
    expect(second.changed).toBe(false);
  });

  it("moves to a new world day and keeps prior events", () => {
    const dayOne = new Date("2026-11-07T20:00:00.000Z").getTime();
    const initial = createDefaultXilianWorldData("2026-11-07", dayOne);
    const first = reconcileXilianWorld({ state: initial.state, timeline: [], now: dayOne, timezone: "UTC" });
    const dayTwo = new Date("2026-11-08T09:00:00.000Z").getTime();
    const second = reconcileXilianWorld({ state: first.state, timeline: first.events, now: dayTwo, timezone: "UTC" });
    expect(second.state.worldDate).toBe("2026-11-08");
    expect(second.state.dayIndex).toBe(2);
    expect(second.events.some((event) => event.dateKey === "2026-11-07" && event.status === "completed")).toBe(true);
    expect(second.events.some((event) => event.dateKey === "2026-11-08")).toBe(true);
    expect(second.state.recentEventIds).toEqual(expect.arrayContaining(first.events.map((event) => event.id)));
  });

  it("keeps the next morning visible after the night block", () => {
    const now = new Date("2026-11-07T23:30:00.000Z").getTime();
    const initial = createDefaultXilianWorldData("2026-11-07", now);
    const result = reconcileXilianWorld({ state: initial.state, timeline: [], now, timezone: "UTC" });
    expect(result.state.currentActivity?.slotId).toBe("night");
    expect(result.state.nextPlannedEvent).toMatchObject({ dateKey: "2026-11-08", slotId: "dawn", status: "planned" });
    expect(result.state.nextPlannedEvent!.occurredAt).toBe(new Date("2026-11-08T06:00:00.000Z").getTime());
  });
});
