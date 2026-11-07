import { describe, expect, it } from "vitest";
import { applyBondEvent, createDefaultBondProgress, normalizeBondProgress } from "./companion-progress";
import { isCompanionEvent } from "./companion-events";

const event = (overrides: Partial<import("./companion-events").CompanionEvent> = {}) => ({
  eventId: "event-1",
  kind: "goal_progressed" as const,
  source: "desktop" as const,
  occurredAt: 1_000,
  summary: "完成了共同目标",
  ...overrides,
});

describe("BondProgress", () => {
  it("is monotonic and changes chapter at durable thresholds", () => {
    const first = applyBondEvent(createDefaultBondProgress(0), event(), 1_000);
    expect(first.state.score).toBe(8);
    expect(first.state.chapter).toBe("prologue");
    let state = first.state;
    for (let i = 1; i < 19; i += 1) {
      state = applyBondEvent(state, event({ eventId: `goal-${i}` }), 1_000 + i).state;
    }
    expect(state.score).toBeGreaterThanOrEqual(150);
    expect(state.chapter).toBe("shared_routines");
    expect(state.unlockedMilestones).toContain("bond.shared_routines");
  });

  it("deduplicates awarded event ids", () => {
    const initial = createDefaultBondProgress(0);
    const first = applyBondEvent(initial, event(), 1_000);
    const retry = applyBondEvent(first.state, event(), 2_000);
    expect(retry.awarded).toBeNull();
    expect(retry.state.score).toBe(first.state.score);
    expect(retry.state.revision).toBe(first.state.revision);
  });

  it("records no score for ordinary turns while still remaining valid", () => {
    const result = applyBondEvent(createDefaultBondProgress(0), event({ kind: "turn_completed" }), 1_000);
    expect(result.awarded).toBeNull();
    expect(result.state.score).toBe(0);
  });

  it("normalizes damaged or legacy data without decreasing valid score", () => {
    const state = normalizeBondProgress({ score: 151, awardedEventIds: ["a", "a"], revision: 3 }, 1_000);
    expect(state.score).toBe(151);
    expect(state.chapter).toBe("shared_routines");
    expect(state.awardedEventIds).toEqual(["a"]);
  });

  it("rejects unknown event kinds and non-scalar payloads at the event boundary", () => {
    expect(isCompanionEvent({ eventId: "x", kind: "__proto__", source: "system", occurredAt: 1, summary: "x" })).toBe(false);
    expect(isCompanionEvent({ eventId: "x", kind: "goal_progressed", source: "system", occurredAt: 1, summary: "x", payload: { nested: {} } })).toBe(false);
  });
});
