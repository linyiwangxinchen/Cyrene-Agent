import { AMPHOREUS_AUTO_ATTEMPT_LIMIT, type AmphoreusState, type NarrativeAttempt, type NarrativeRecovery } from "../../shared/amphoreus-world";
import { isModelFailureInfo } from "../../shared/model-error";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";

const MANUAL_COOLDOWN_MS = 60_000;
export const MAX_NARRATIVE_ATTEMPTS = 24;

function manualRetryAt(attempt: NarrativeAttempt): number {
  return Math.max(attempt.attemptedAt + MANUAL_COOLDOWN_MS, attempt.failure?.category === "RATE_LIMIT" ? attempt.retryAt : 0);
}

export function canStartNarrativeAttempt(attempt: NarrativeAttempt | undefined, now: number, manual = false): boolean {
  if (attempt?.status === "generating" && attempt.retryAt > now) return false;
  if (manual) return !!attempt && ["failed", "cancelled", "unconfigured"].includes(attempt.status)
    && attempt.count < MAX_NARRATIVE_ATTEMPTS && manualRetryAt(attempt) <= now;
  return (attempt?.count ?? 0) < AMPHOREUS_AUTO_ATTEMPT_LIMIT && (!attempt || attempt.retryAt <= now);
}

export function narrativeRecovery(state: AmphoreusState, attempt: NarrativeAttempt | null, now: number, used: number): NarrativeRecovery {
  if (!state.narrativeEnabled) return { canRetry: false, blockedBy: "disabled" };
  const remaining = state.dailyModelBudget - used;
  if (remaining <= 0 || remaining < 2 && state.days.some((day) => day.events.some((event) => event.status === "awaiting_resolution"))) return { canRetry: false, blockedBy: "daily_budget" };
  if (!attempt) return { canRetry: false };
  if (attempt.status === "generating") return { canRetry: false, blockedBy: "generating" };
  if (!["failed", "cancelled", "unconfigured"].includes(attempt.status)) return { canRetry: false };
  const canRetry = canStartNarrativeAttempt(attempt, now, true);
  if (attempt.count >= AMPHOREUS_AUTO_ATTEMPT_LIMIT) return { canRetry, blockedBy: "attempt_limit" };
  return { canRetry, ...(attempt.retryAt > now ? { automaticRetryAt: attempt.retryAt } : {}), ...(!canRetry ? { blockedBy: "cooldown" as const } : {}) };
}

/** Only whitelist category/status; provider text, keys, URLs and response bodies never enter world state. */
export function narrativeFailure(error: unknown): NonNullable<NarrativeAttempt["failure"]> {
  if (error instanceof AgentRuntimeError) {
    if (error.code === "E_MODEL_REQUEST_TIMEOUT") return { category: "TIMEOUT" };
    const failure = error.modelFailure;
    if (isModelFailureInfo(failure)) return { category: failure.category,
      ...(failure.status !== undefined && failure.status >= 100 && failure.status <= 599 ? { status: failure.status } : {}) };
  }
  return { category: "UNKNOWN" };
}
