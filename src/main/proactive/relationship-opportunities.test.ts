import { describe, expect, it } from "vitest";
import { canAskAboutRecentWellbeing, relationshipOpportunities, standaloneCareOpportunity, userCareOpportunity } from "./relationship-opportunities";
import { createDefaultRelationshipState } from "../persona/persona-spec";
import { createDefaultProactiveState, canStartProactiveGeneration } from "./proactive-policy";
import type { ProactiveTriggerContext } from "./proactive-trigger";

const now = Date.UTC(2026, 10, 4, 4);
const context: ProactiveTriggerContext = { now, timezone: "Asia/Shanghai", localDate: "2026-11-04", localHour: 12, localMinute: 0, snapshot: { now, localHour: 12, idleSec: 5000, enabled: true, conversationBusy: false, generationBusy: false, screenLocked: false }, state: createDefaultProactiveState(), previousIdleSec: null, activeSessionStartedAt: null, weather: null, conversationLastActivity: now - 3 * 3_600_000 };
describe("explicit shared life opportunities", () => {
  const relationship = { ...createDefaultRelationshipState(), milestones: ["11-04 一起完成项目"], sharedGoals: ["学习"], proactiveLifeEnabled: true };
  it("requires separate consent and never creates night or long absence prompts", () => {
    expect(relationshipOpportunities({ ...relationship, proactiveLifeEnabled: false }, context)).toEqual([]);
    expect(relationshipOpportunities({ ...relationship, paused: true }, context)).toEqual([]);
    expect(relationshipOpportunities(relationship, { ...context, localHour: 22 })).toEqual([]);
    expect(relationshipOpportunities(relationship, { ...context, conversationLastActivity: now - 9 * 86_400_000 })).toEqual([]);
  });
  it("uses explicit dates and is still bounded by existing cooldown/response policy", () => {
    const candidates = relationshipOpportunities(relationship, context);
    expect(candidates.map(c => c.sceneId)).toEqual(["relationship_milestone", "shared_goal_checkin"]);
    for (const candidate of candidates) expect(canStartProactiveGeneration(context.snapshot, { ...context.state, unansweredCount: 2 }, candidate).allowed).toBe(false);
    expect(relationshipOpportunities({ ...relationship, milestones: ["2025-11-04 旧日期"] }, context).some(c => c.sceneId === "relationship_milestone")).toBe(false);
    expect(relationshipOpportunities({ ...relationship, milestones: ["明天生日"] }, context).some(c => c.sceneId === "relationship_milestone")).toBe(false);
  });
});

describe("care based on a recent private user turn", () => {
  it.each(["我今天有点累", "今天有点难过", "还是有点紧张", "昨天我真的很累。", "同事走了，我好委屈。"])("captures a direct personal disclosure: %s", content => {
    const at = now - 35 * 60_000;
    const opportunity = userCareOpportunity({ content, at }, "private-chat", now);
    expect(opportunity).toMatchObject({ source: "user_care", conversationId: "private-chat", evidenceVersion: at, occurredAt: at });
    expect(opportunity?.summary).not.toContain(content);
  });

  it.each(["我同事今天很累", "我在解释焦虑这个词", "我很开心，他有点难过", "我今天不累", "假如我今天有点焦虑", "我很累但别再问了", "我昨天挺累，现在好多了", "“我今天很累”是一句台词", "还是有点喘不过气", "今天要改一段代码"])("does not turn ambiguous text into a check-in: %s", content => {
    expect(userCareOpportunity({ content, at: now }, "private-chat", now)).toBeUndefined();
  });

  it("waits after the actual report, honors local hours, and expires exactly six hours later", () => {
    const content = "我今天有点累";
    expect(userCareOpportunity({ content, at: now + 1 }, "private-chat", now)).toBeUndefined();
    expect(userCareOpportunity({ content, at: now }, undefined, now)).toBeUndefined();
    expect(canAskAboutRecentWellbeing(now, now + 19 * 60_000, 10)).toBe(false);
    expect(canAskAboutRecentWellbeing(now, now + 20 * 60_000, 8)).toBe(true);
    expect(canAskAboutRecentWellbeing(now, now + 20 * 60_000, 22)).toBe(false);
    expect(canAskAboutRecentWellbeing(now, now + 6 * 3_600_000, 19)).toBe(false);
    expect(userCareOpportunity({ content, at: now - 6 * 3_600_000 }, "private-chat", now)).toBeUndefined();
  });
});

it("allows a greeting after 30 minutes and keeps the same opportunity across midnight", () => {
  const hour = 3_600_000;
  const turn = { content: "刚换了张壁纸", at: now - 3 * hour };
  const clock = { now, localHour: 9, localDate: "2026-11-04", lastActivity: now - hour / 2 };
  expect(standaloneCareOpportunity(turn, "private-chat", clock)).toMatchObject({
    source: "standalone_care", evidenceVersion: clock.localDate, occurredAt: now, replyBurden: "none",
  });
  const overnight = { ...clock, localDate: "2026-11-05", localHour: 4 };
  expect(standaloneCareOpportunity(turn, "private-chat", overnight)?.evidenceVersion).toBe(clock.localDate);
  expect(standaloneCareOpportunity(turn, "private-chat", { ...clock, lastActivity: clock.lastActivity + 1 })).toBeUndefined();
  expect(standaloneCareOpportunity(turn, "private-chat", { ...overnight, localHour: 5 })).toBeUndefined();
  expect(standaloneCareOpportunity(turn, "private-chat", { ...overnight, localHour: 8 })).toBeUndefined();
  expect(standaloneCareOpportunity({ ...turn, content: "这几天先别打扰我" }, "private-chat", clock)).toBeUndefined();
});
