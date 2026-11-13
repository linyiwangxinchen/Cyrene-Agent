import type {
  ProactiveCandidate,
  ProactiveCommitDecision,
  ProactiveRuntimeSnapshot,
  ProactiveState,
} from "./proactive-types";

export const NORMAL_QUIET_MS = 30 * 60 * 1000;
export const GLOBAL_PROACTIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const FOLLOWUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const NIGHT_ACTIVE_IDLE_LIMIT_SEC = 60;
// Generic scenes keep a high follow-up bar; a conversation follow-up has its
// own lower floor because it carries a concrete recent topic.
export const FOLLOWUP_MIN_SCORE = 80;
const HIGH_FREQUENCY_INTERVAL_MS = 30 * 60 * 1000;
const MEDIUM_FREQUENCY_INTERVAL_MS = 60 * 60 * 1000;
const LIGHT_FREQUENCY_INTERVAL_MS = 90 * 60 * 1000;
const HIGH_FREQUENCY_FOLLOWUP_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MEDIUM_FREQUENCY_FOLLOWUP_INTERVAL_MS = 3 * 60 * 60 * 1000;
const LIGHT_FREQUENCY_FOLLOWUP_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * The daily setting is a cap, but it must also affect pacing. Previously the
 * hard-coded two-hour gate made a value such as 20 almost indistinguishable
 * from the default three-message setting.
 */
export function getGlobalProactiveIntervalMs(dailyLimit?: number): number {
  if (dailyLimit !== undefined && dailyLimit > 10) return HIGH_FREQUENCY_INTERVAL_MS;
  if (dailyLimit !== undefined && dailyLimit > 6) return MEDIUM_FREQUENCY_INTERVAL_MS;
  if (dailyLimit !== undefined && dailyLimit > 3) return LIGHT_FREQUENCY_INTERVAL_MS;
  return GLOBAL_PROACTIVE_INTERVAL_MS;
}

export function getFollowupIntervalMs(dailyLimit?: number): number {
  if (dailyLimit !== undefined && dailyLimit > 10) return HIGH_FREQUENCY_FOLLOWUP_INTERVAL_MS;
  if (dailyLimit !== undefined && dailyLimit > 6) return MEDIUM_FREQUENCY_FOLLOWUP_INTERVAL_MS;
  if (dailyLimit !== undefined && dailyLimit > 3) return LIGHT_FREQUENCY_FOLLOWUP_INTERVAL_MS;
  return FOLLOWUP_INTERVAL_MS;
}

/** Context follow-ups remain deliberately easier to reach than generic scenes. */
function followupScoreFloor(candidate: ProactiveCandidate): number {
  return candidate.sceneId === "conversation_followup" || candidate.sceneId.startsWith("followup:")
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
  if (!snapshot.enabled) return block("disabled");
  if (snapshot.screenLocked) return block("screen_locked");
  if (snapshot.conversationBusy) return block("conversation_busy");
  if (snapshot.generationBusy) return block("generation_busy");
  if (snapshot.quietStartMinute !== undefined && snapshot.quietEndMinute !== undefined && snapshot.localMinute !== undefined
    && isWithinQuietWindow(snapshot.localHour * 60 + snapshot.localMinute, snapshot.quietStartMinute, snapshot.quietEndMinute)) {
    return block("custom_quiet_period");
  }
  if (isNight(snapshot.localHour) && snapshot.idleSec >= NIGHT_ACTIVE_IDLE_LIMIT_SEC) return block("night_inactive");
  if (snapshot.dailyLimit === 0) return block("daily_limit");
  if (snapshot.dailyLimit !== undefined && snapshot.localDate && state.dailyMessageDate === snapshot.localDate
    && (state.dailyMessageCount ?? 0) >= snapshot.dailyLimit) return block("daily_limit");
  if (state.unansweredCount >= 2) return block("unanswered_limit");

  if (
    state.lastNormalConversationEndedAt !== null &&
    snapshot.now - state.lastNormalConversationEndedAt < NORMAL_QUIET_MS
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
  state.lastFiredAt[candidate.sceneId] = now;
  state.globalDesire = 0;
  if (localDate) {
    const previousDate = state.dailyMessageDate;
    state.dailyMessageDate = localDate;
    state.dailyMessageCount = previousDate === localDate ? (state.dailyMessageCount ?? 0) + 1 : 1;
  }
}
