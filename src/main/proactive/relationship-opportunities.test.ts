import { describe, expect, it } from "vitest";
import { relationshipOpportunities } from "./relationship-opportunities";
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
