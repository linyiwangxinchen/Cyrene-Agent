import type {
  ProactiveCandidate,
  ProactiveCommitDecision,
  ProactiveRuntimeSnapshot,
  ProactiveState,
} from "./proactive-types";
import { STANDALONE_CARE_MIN_IDLE_MS, STANDALONE_CARE_SCENE } from "./relationship-opportunities";

// These are anti-flood bounds only. Passing them must never create an opportunity.
// After a chat winds down ("好～", "抱～") a message half an hour later reads
// like a wrap-up of what was just said, so ordinary shares wait longer.
export const NORMAL_QUIET_MS = 45 * 60 * 1000;
export const GLOBAL_PROACTIVE_INTERVAL_MS = 3 * 60 * 1000;
export const FOLLOWUP_INTERVAL_MS = 15 * 60 * 1000;
export const HOURLY_PROACTIVE_LIMIT = 4;
export const NIGHT_ACTIVE_IDLE_LIMIT_SEC = 60;
// A score cannot substitute for a new source and a low response burden.
export const FOLLOWUP_MIN_SCORE = 80;

/**
 * The daily setting is only a cap. Natural pacing is chosen from concrete
 * opportunities; increasing a cap no longer installs a shorter fixed timer.
 */
export function getGlobalProactiveIntervalMs(_dailyLimit?: number): number {
  return GLOBAL_PROACTIVE_INTERVAL_MS;
}

export function getFollowupIntervalMs(_dailyLimit?: number): number {
  return FOLLOWUP_INTERVAL_MS;
}

/** New grounded shares can be adopted; a timed context follow-up is not evidence. */
function followupScoreFloor(candidate: ProactiveCandidate): number {
  return candidate.sourceEventId && candidate.replyBurden === "none"
    ? 60
    : FOLLOWUP_MIN_SCORE;
}

const allow = (): ProactiveCommitDecision => ({ allowed: true, reason: "allowed" });
const block = (reason: ProactiveCommitDecision["reason"]): ProactiveCommitDecision => ({ allowed: false, reason });

export function createDefaultProactiveState(): ProactiveState {
  return {
    proactiveEpoch: 0,
    unansweredCount: 0,
    lastProactiveAt: null,
    lastProactiveScene: null,
    lastNormalConversationEndedAt: null,
    globalDesire: 0,
    affinity: {},
    lastFiredAt: {},
  };
}

function isNight(hour: number): boolean {
  return hour >= 22 || hour < 8;
}

function isWithinQuietWindow(localMinute: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start > end ? localMinute >= start || localMinute < end : localMinute >= start && localMinute < end;
}

export function canStartProactiveGeneration(
  snapshot: ProactiveRuntimeSnapshot,
  state: ProactiveState,
  candidate: ProactiveCandidate,
): ProactiveCommitDecision {
  const standaloneCare = candidate.sceneId === STANDALONE_CARE_SCENE;
  if (!snapshot.enabled) return block("disabled");
  if (snapshot.screenLocked) return block("screen_locked");
  if (snapshot.conversationBusy) return block("conversation_busy");
  if (snapshot.generationBusy) return block("generation_busy");
  if (snapshot.quietStartMinute !== undefined && snapshot.quietEndMinute !== undefined && snapshot.localMinute !== undefined
    && isWithinQuietWindow(snapshot.localHour * 60 + snapshot.localMinute, snapshot.quietStartMinute, snapshot.quietEndMinute)) {
    return block("custom_quiet_period");
  }
  if (!standaloneCare && isNight(snapshot.localHour)
    && snapshot.idleSec >= NIGHT_ACTIVE_IDLE_LIMIT_SEC) return block("night_inactive");
  if (snapshot.dailyLimit === 0) return block("daily_limit");
  if (snapshot.dailyLimit !== undefined && snapshot.localDate && state.dailyMessageDate === snapshot.localDate
    && (state.dailyMessageCount ?? 0) >= snapshot.dailyLimit) return block("daily_limit");
  if (candidate.replyBurden === "question" && snapshot.localDate && state.dailyMessageDate === snapshot.localDate
    && (state.dailyQuestionCount ?? 0) >= 3) return block("daily_question_limit");
  if (state.unansweredCount >= 2) return block("unanswered_limit");
  const recent = state.recentProactiveAt ?? (state.lastProactiveAt === null ? [] : [state.lastProactiveAt]);
  if (recent.filter(at => at > snapshot.now - 3_600_000 && at <= snapshot.now).length >= HOURLY_PROACTIVE_LIMIT) return block("hourly_limit");

  if (
    state.lastNormalConversationEndedAt !== null &&
    snapshot.now - state.lastNormalConversationEndedAt < (standaloneCare ? STANDALONE_CARE_MIN_IDLE_MS : NORMAL_QUIET_MS)
  ) return block("normal_quiet_period");

  if (
    state.lastProactiveAt !== null &&
    snapshot.now - state.lastProactiveAt < getGlobalProactiveIntervalMs(snapshot.dailyLimit)
  ) return block("global_cooldown");

  const sceneLastFiredAt = state.lastFiredAt[candidate.sceneId];
  if (
    typeof sceneLastFiredAt === "number" &&
    snapshot.now - sceneLastFiredAt < candidate.sceneCooldownMs
  ) return block("scene_cooldown");

  if (state.unansweredCount === 1) {
    if (
      state.lastProactiveAt !== null &&
      snapshot.now - state.lastProactiveAt < getFollowupIntervalMs(snapshot.dailyLimit)
    ) return block("followup_cooldown");
    if (!candidate.sourceEventId || candidate.replyBurden !== "none"
      || candidate.sourceEventId === state.lastProactiveSourceEventId) return block("followup_requires_new_content");
    if (state.lastProactiveScene === candidate.sceneId) return block("followup_same_scene");
    if (candidate.score < followupScoreFloor(candidate)) return block("followup_score_too_low");
  }

  return allow();
}

export function canCommitProactiveMessage(
  snapshot: ProactiveRuntimeSnapshot,
  state: ProactiveState,
  candidate: ProactiveCandidate,
  generationEpoch: number,
): ProactiveCommitDecision {
  if (generationEpoch !== state.proactiveEpoch) return block("stale_epoch");
  return canStartProactiveGeneration(snapshot, state, candidate);
}

export function markUserActivity(state: ProactiveState): void {
  state.proactiveEpoch += 1;
  state.unansweredCount = 0;
}

export function markNormalConversationStarted(state: ProactiveState): void {
  state.proactiveEpoch += 1;
}

export function markNormalConversationEnded(state: ProactiveState, now: number): void {
  state.proactiveEpoch += 1;
  state.lastNormalConversationEndedAt = now;
  state.globalDesire = 0;
}

export function markProactiveCommitted(
  state: ProactiveState,
  candidate: ProactiveCandidate,
  now: number,
  localDate?: string,
): void {
  state.unansweredCount = Math.min(2, state.unansweredCount + 1) as 0 | 1 | 2;
  state.lastProactiveAt = now;
  state.lastProactiveScene = candidate.sceneId;
  state.lastProactiveSourceEventId = candidate.sourceEventId;
  state.recentProactiveAt = [...(state.recentProactiveAt ?? []), now].filter(at => at > now - 3_600_000 && at <= now).slice(-HOURLY_PROACTIVE_LIMIT);
  state.lastFiredAt[candidate.sceneId] = now;
  state.globalDesire = 0;
  if (localDate) {
    const previousDate = state.dailyMessageDate;
    state.dailyMessageDate = localDate;
    state.dailyMessageCount = previousDate === localDate ? (state.dailyMessageCount ?? 0) + 1 : 1;
    state.dailyQuestionCount = (previousDate === localDate ? state.dailyQuestionCount ?? 0 : 0) + (candidate.replyBurden === "question" ? 1 : 0);
  }
}
