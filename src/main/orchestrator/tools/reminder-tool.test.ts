import { describe, expect, it } from "vitest";
import { buildSchedule } from "./reminder-tool";

describe("channel delayed task schedule parsing", () => {
  it("supports relative one-shot delays", () => {
    const before = Date.now() + 29 * 60_000;
    const schedule = buildSchedule({ delayMinutes: 30 });
    expect(schedule.kind).toBe("once");
    expect(new Date(schedule.runAt).getTime()).toBeGreaterThan(before);
  });

  it.each([
    ["daily", { timeOfDay: "12:00" }],
    ["weekdays", { timeOfDay: "09:30" }],
    ["weekly", { dayOfWeek: 1, timeOfDay: "09:30" }],
    ["monthly", { dayOfMonth: 1, timeOfDay: "09:30" }],
    ["yearly", { month: 10, dayOfMonth: 1, timeOfDay: "09:30" }],
    ["interval", { every: 2, unit: "hours" }],
  ])("supports %s schedules", (scheduleKind, fields) => {
    expect(buildSchedule({ scheduleKind, ...fields })).toMatchObject({ kind: scheduleKind, ...fields });
  });
});

