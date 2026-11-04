import type { RelationshipState } from "../../shared/companion";
import type { ProactiveTriggerContext } from "./proactive-trigger";

/** Only explicit user-entered dates/goals; no inferred anniversaries or activity surveillance. */
export function relationshipOpportunities(relationship: RelationshipState, ctx: ProactiveTriggerContext) {
  if (relationship.paused || !relationship.proactiveLifeEnabled || !ctx.snapshot.enabled || ctx.localHour < 10 || ctx.localHour >= 21) return [];
  if (ctx.conversationLastActivity == null || ctx.now - ctx.conversationLastActivity > 7 * 86_400_000) return [];
  const matched = relationship.milestones.some(item => {
    const date = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?=\s|$)/.exec(item)?.[1];
    return date && (date.length === 10 ? date === ctx.localDate : date === ctx.localDate.slice(5));
  });
  const candidates = [];
  if (matched) candidates.push({ sceneId: "relationship_milestone", score: 76, sceneCooldownMs: 24 * 60 * 60_000, reason: "用户指定的重要时刻在今天；是否值得发送仍由模型与勿扰规则判断" });
  if (relationship.sharedGoals.length && ctx.localHour >= 12 && ctx.localHour < 20) candidates.push({ sceneId: "shared_goal_checkin", score: 65, sceneCooldownMs: 3 * 86_400_000, reason: "用户启用了共同目标关怀；只询问近况，不推测进度或催促" });
  return candidates;
}
