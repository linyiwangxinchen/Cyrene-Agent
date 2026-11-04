import type { CompanionFollowup, RelationshipState } from "../../shared/companion";
import type { ProactiveTriggerContext } from "./proactive-trigger";

export function followupIdFromScene(sceneId: string): string | undefined {
  return sceneId.startsWith("followup:") ? sceneId.slice("followup:".length) || undefined : undefined;
}

/** 具体事项只在其绑定会话投递，active+到期才成为候选；awaiting_reply 永不自动催促。 */
export function followupOpportunities(items: readonly CompanionFollowup[], relationship: RelationshipState,
  conversationId: string | undefined, ctx: ProactiveTriggerContext) {
  if (!conversationId || relationship.paused || !relationship.proactiveLifeEnabled || !ctx.snapshot.enabled
    || ctx.localHour < 10 || ctx.localHour >= 21) return [];
  return items.filter(item => item.conversationId === conversationId && item.status === "active" && item.nextEligibleAt <= ctx.now)
    .sort((a, b) => a.nextEligibleAt - b.nextEligibleAt)
    .slice(0, 10)
    .map(item => ({ sceneId: `followup:${item.id}`, score: 82, sceneCooldownMs: 24 * 60 * 60_000,
      reason: `用户指定的具体事项「${item.topic}」已到最早跟进时间；只关心一次，不推测进度，仍遵守勿扰与评分设置` }));
}
