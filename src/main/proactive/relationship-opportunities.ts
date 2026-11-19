import type { RelationshipState } from "../../shared/companion";
import { detectUserMood } from "../relationship/mood-cues";
import type { InitiativeOpportunityInput } from "./initiative-opportunities";
import type { ProactiveTriggerContext } from "./proactive-trigger";

const HOUR_MS = 3_600_000;
const CARE_MIN_AGE_MS = 20 * 60_000;
const CARE_MAX_AGE_MS = 6 * HOUR_MS;
export const STANDALONE_CARE_SCENE = "standalone_care";
export const STANDALONE_CARE_MIN_IDLE_MS = 30 * 60_000;
const STANDALONE_CARE_MAX_IDLE_MS = 7 * 24 * HOUR_MS;
const REQUESTS_SPACE = /(?:别|不要|不用)(?:再)?.{0,6}(?:问|提|发消息|打扰)|(?:想|让我)一个人|先不聊了/u;
const CARE_MOODS = new Set(["疲惫", "焦虑", "低落"]);
const DIRECT_FEELINGS = "累(?!计|积)|困(?!难|扰|境|惑|住)|疲惫|疲倦|没精神|紧张|焦虑|烦躁|担心|心慌|委屈|难过|伤心|失落|想哭|不开心|压力(?:太大|很大|大|山大)";
const TIME_WORDS = "今天|现在|刚才|刚刚|最近|昨晚|昨天|这几天|这会儿";
const FEELING_MODIFIERS = "还是|感觉|觉得|有(?:一)?点|有些|很|好|挺|太|特别|真的|非常|实在";
const SELF_REPORT = new RegExp(`(?:^|[，,。；;！!\n])\\s*(?:${TIME_WORDS})?我(?:${TIME_WORDS}|${FEELING_MODIFIERS}|也|就)*(?:${DIRECT_FEELINGS})`, "u");
const UNSPOKEN_SUBJECT = new RegExp(`^(?:${TIME_WORDS})?(?:${FEELING_MODIFIERS})+(?:${DIRECT_FEELINGS})`, "u");

export function canAskAboutRecentWellbeing(occurredAt: number, now: number, localHour: number): boolean {
  return localHour >= 8 && localHour < 22 && now - occurredAt >= CARE_MIN_AGE_MS && now - occurredAt < CARE_MAX_AGE_MS;
}

/** Use the latest private user turn only. Its text stays in the original transcript. */
export function userCareOpportunity(
  turn: { content: string; at: number } | undefined,
  conversationId: string | undefined,
  now: number,
): InitiativeOpportunityInput | undefined {
  if (!turn || !conversationId || !Number.isFinite(turn.at) || turn.at > now || now - turn.at >= CARE_MAX_AGE_MS) return;
  const text = turn.content.trim();
  const recovered = /(?:已经?|现在)(?:好多了|好些了|好了|没事了|不(?:累|紧张|难过|担心|焦虑)了)/u;
  if (/[？?]$/.test(text) || REQUESTS_SPACE.test(text) || recovered.test(text)) return;
  if ((!SELF_REPORT.test(text) && !UNSPOKEN_SUBJECT.test(text)) || !CARE_MOODS.has(detectUserMood(text))) return;
  return {
    id: `user_care:${turn.at}`, source: "user_care", sourceEventId: "user_care", evidenceVersion: turn.at,
    conversationId, motive: "followup",
    summary: "用户在这段私聊的最近一条消息里提到自己的感受。依据当时说过的话轻轻关心，也可以只留一句体贴的话；不要推测现在仍是同样的状态。",
    occurredAt: turn.at, expiresAt: turn.at + CARE_MAX_AGE_MS, strengthPerHour: 8, decayPerHour: 0.6,
    replyBurden: "question", sceneId: "user_care", score: 85, sceneCooldownMs: 12 * HOUR_MS,
  };
}

/** The hours before 05:00 belong to the previous morning's window. */
export function standaloneCareWindowDate(localDate: string | undefined, localHour: number): string | undefined {
  if (!localDate) return undefined;
  if (localHour >= 9 && localHour < 24) return localDate;
  if (!(localHour >= 0 && localHour < 5)) return undefined;
  const previous = new Date(`${localDate}T00:00:00Z`);
  if (Number.isNaN(previous.getTime())) return undefined;
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/** Private interaction history is used only to choose a suitable time to reach out. */
export function standaloneCareOpportunity(
  turn: { content: string; at: number } | undefined,
  conversationId: string | undefined,
  clock: { now: number; localHour: number; localDate?: string; lastActivity: number | undefined },
): InitiativeOpportunityInput | undefined {
  const windowDate = standaloneCareWindowDate(clock.localDate, clock.localHour);
  if (!turn || !conversationId || !windowDate || REQUESTS_SPACE.test(turn.content)) return;
  const idle = clock.now - Math.max(turn.at, clock.lastActivity ?? turn.at);
  if (!Number.isFinite(idle) || idle < STANDALONE_CARE_MIN_IDLE_MS || idle >= STANDALONE_CARE_MAX_IDLE_MS) return;
  return {
    id: `${STANDALONE_CARE_SCENE}:${windowDate}`, source: STANDALONE_CARE_SCENE, sourceEventId: STANDALONE_CARE_SCENE,
    evidenceVersion: windowDate, conversationId, motive: "connection",
    summary: "想给对方发一句关心。",
    occurredAt: clock.now, expiresAt: clock.now + 24 * HOUR_MS, strengthPerHour: 0.75,
    replyBurden: "none", sceneId: STANDALONE_CARE_SCENE, score: 68, sceneCooldownMs: 24 * HOUR_MS,
  };
}

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
