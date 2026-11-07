import { describe, expect, it } from "vitest";
import { createDefaultXilianWorldData } from "../../shared/xilian-world";
import { buildXilianLifeSnapshot, buildXilianPromptFingerprint, buildXilianSelfiePrompt, formatXilianLifeContext, isXilianSelfieRequest } from "./life-context";

describe("xilian life context", () => {
  it("only classifies explicit Xilian selfie requests as selfie context", () => {
    expect(isXilianSelfieRequest("给我一张昔涟自拍")).toBe(true);
    expect(isXilianSelfieRequest("画一只猫")).toBe(false);
    expect(isXilianSelfieRequest("帮我生成一张风景图")).toBe(false);
  });

  it("builds a traceable snapshot and selfie prompt from an event", () => {
    const now = new Date("2026-11-07T18:00:00.000Z").getTime();
    const data = createDefaultXilianWorldData("2026-11-07", now);
    const schedule = {
      ...data.state,
      currentActivity: {
        id: "xilian:2026-11-07:dusk",
        dateKey: "2026-11-07",
        slotId: "dusk",
        occurredAt: now,
        locationId: "star-furnace",
        activityKind: "maintenance" as const,
        activityTitle: "在星炉台维护一盏小灯",
        summary: "光线稳定了一点",
        mood: "有一点疲惫，但在慢慢恢复",
        energyAfter: 58,
        goalId: "light-maintenance",
        status: "active" as const,
        visibility: "private" as const,
        source: "simulated_world" as const,
      },
    };
    const snapshot = buildXilianLifeSnapshot({ state: schedule, timeline: [schedule.currentActivity], now, timezone: "UTC", energy: 58 });
    expect(snapshot.location).toBe("星炉台");
    expect(snapshot.currentActivity).toContain("维护");
    expect(snapshot.sourceEventId).toBe("xilian:2026-11-07:dusk");
    expect(buildXilianSelfiePrompt(snapshot)).toContain("拍摄原因");
    expect(formatXilianLifeContext(snapshot)).toContain("虚构世界");
    expect(buildXilianPromptFingerprint(snapshot)).toMatch(/^[0-9a-f]+$/);
  });
});
