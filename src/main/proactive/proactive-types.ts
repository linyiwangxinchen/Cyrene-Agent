export interface ProactiveRuntimeSnapshot {
  now: number;
  localHour: number;
  localMinute?: number;
  localDate?: string;
  timezone?: string;
  /** User-configured quiet window in local minutes. Omit to use legacy policy. */
  quietStartMinute?: number;
  quietEndMinute?: number;
  dailyLimit?: number;
  idleSec: number;
  enabled: boolean;
  conversationBusy: boolean;
  generationBusy: boolean;
  screenLocked: boolean;
}

export interface ProactiveCandidate {
  sceneId: string;
  score: number;
  sceneCooldownMs: number;
  /** Optional durable life moment selected by the proactive trigger. */
  momentId?: string;
  momentSummary?: string;
  opportunityId?: string;
  sourceEventId?: string;
  evidenceVersion?: string;
  replyBurden?: "none" | "light" | "question";
}

/** Fields shared by initial delivery and recovery. Trigger explanations are transient. */
export function normalizeDurableCandidate(value: Partial<Record<keyof ProactiveCandidate, unknown>>): ProactiveCandidate | undefined {
  if (typeof value.sceneId !== "string"
    || typeof value.score !== "number" || !Number.isFinite(value.score)
    || typeof value.sceneCooldownMs !== "number" || !Number.isFinite(value.sceneCooldownMs)) return undefined;
  return {
    sceneId: value.sceneId,
    score: value.score,
    sceneCooldownMs: value.sceneCooldownMs,
    ...(typeof value.momentId === "string" ? { momentId: value.momentId.slice(0, 200) } : {}),
    ...(typeof value.momentSummary === "string" ? { momentSummary: value.momentSummary.slice(0, 1000) } : {}),
    ...(typeof value.opportunityId === "string" ? { opportunityId: value.opportunityId.slice(0, 300) } : {}),
    ...(typeof value.sourceEventId === "string" ? { sourceEventId: value.sourceEventId.slice(0, 300) } : {}),
    ...(typeof value.evidenceVersion === "string" ? { evidenceVersion: value.evidenceVersion.slice(0, 100) } : {}),
    ...((value.replyBurden === "none" || value.replyBurden === "light" || value.replyBurden === "question") ? { replyBurden: value.replyBurden } : {}),
  };
}

export type ProactiveEvaluationState = "candidate" | "no_candidate" | "suppressed" | "backoff";

/** Runtime snapshot shown in preferences; it is intentionally not persisted. */
export interface ProactiveEvaluationStatus {
  candidateScore: number | null;
  targetScore: number;
  sceneId: string | null;
  evaluatedAt: number | null;
  state: ProactiveEvaluationState;
  reason?: string;
  explanation?: string;
  lastOutcome?: { state: "blocked" | "silent" | "failed" | "sent"; reason?: string; at: number; sceneId: string | null };
  delivery?: { target: "local" | "wechat" | "feishu"; ready: boolean; reason?: string };
  unansweredCount?: number;
  lastProactiveAt?: number | null;
}

/** Durable intent captured before delivery; retries must replay this exact payload. */
export interface ProactiveDeliveryContext {
  relationshipRevision: number;
  memoryMode?: string;
  composedAt?: number;
  timezone?: string;
  conversationId?: string;
  sessionId?: string;
  targetId?: string;
  threadId?: string;
  recipientScope?: string;
  bindingUpdatedAt?: number;
  expression?: { query: string; evidenceKey: string };
  followupId?: string;
}
export interface ProactiveCommitIntent {
  intentId: string;
  sequence: number;
  candidate: ProactiveCandidate;
  generationEpoch: number;
  intentAt: number;
  localDate?: string;
  text: string;
  /** 随消息一起发出的已落盘图片（主动自拍）。 */
  attachments?: import("../../shared/generated-image").GeneratedImageAttachment[];
  source: "model" | "fallback";
  fallbackPayload?: unknown;
  deliveryTarget?: "local" | "wechat" | "feishu";
  deliveryContext?: ProactiveDeliveryContext;
}

export interface ProactiveState {
  proactiveEpoch: number;
  unansweredCount: 0 | 1 | 2;
  lastProactiveAt: number | null;
  lastProactiveScene: string | null;
  lastNormalConversationEndedAt: number | null;
  globalDesire: number;
  affinity: Record<string, number>;
  lastFiredAt: Record<string, number | null>;
  /** Counter scoped to the user's local date, used for a durable daily budget. */
  dailyMessageDate?: string;
  dailyMessageCount?: number;
  dailyQuestionCount?: number;
  /** At most one durable commit can be awaiting delivery completion. */
  pendingCommitIntent?: ProactiveCommitIntent;
  /** Monotonic durable identity source; absent in legacy state files. */
  proactiveCommitSequence?: number;
  /** Rolling cap survives restarts; this counts business intents, not bubbles. */
  recentProactiveAt?: number[];
  lastProactiveSourceEventId?: string;
}

export type ProactiveBlockReason =
  | "allowed"
  | "disabled"
  | "screen_locked"
  | "conversation_busy"
  | "generation_busy"
  | "night_inactive"
  | "custom_quiet_period"
  | "daily_limit"
  | "daily_question_limit"
  | "hourly_limit"
  | "normal_quiet_period"
  | "global_cooldown"
  | "scene_cooldown"
  | "unanswered_limit"
  | "followup_cooldown"
  | "followup_same_scene"
  | "followup_score_too_low"
  | "followup_requires_new_content"
  | "stale_epoch";

export interface ProactiveCommitDecision {
  allowed: boolean;
  reason: ProactiveBlockReason;
}
