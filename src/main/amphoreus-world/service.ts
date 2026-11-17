import type { XilianWorldStore } from "../xilian-world/world-store";
import type { AmphoreusState, NarrativeAttempt } from "../../shared/amphoreus-world";
import { worldClock } from "./clock";
import { InvalidNarrative, narrativeMessages, parseDailyPlan, parsePersonalPlans, parseResolutions, resolutionMessages, reviewMessages } from "./narrative";
import { reviewAccepted } from "./canon-guard";
import { applyResolutions, modelBudgetUsed } from "./engine";
import type { WorldMessages } from "./prompts";
import { AMPHOREUS_REQUEST_TIMEOUT_MS } from "../../shared/amphoreus-world";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { canStartNarrativeAttempt, narrativeFailure } from "./narrative-recovery";

export interface AmphoreusServiceOptions {
  store: Pick<XilianWorldStore, "advance" | "readDataSnapshot" | "updateAmphoreus">;
  timezone(): string;
  configured(): boolean;
  generate(messages: WorldMessages, signal: AbortSignal): Promise<string>;
  now?: () => number;
}
const RETRY_MS = 30 * 60_000, LEASE_MS = AMPHOREUS_REQUEST_TIMEOUT_MS * 2 + 30_000;
export function createAmphoreusService(options: AmphoreusServiceOptions) {
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined, controller: AbortController | undefined, pending: Promise<void> | undefined;
  let stopped = false;
  const put = (state: AmphoreusState, attempt: NarrativeAttempt) => {
    state.attempts = [...state.attempts.filter((old) => (old.key ?? `plan:${old.date}`) !== attempt.key), attempt].sort((a, b) => a.attemptedAt - b.attemptedAt).slice(-1200);
  };
  async function request(messages: WorldMessages, requestController: AbortController): Promise<string> {
    if (requestController.signal.aborted) throw requestController.signal.reason;
    let listener: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { listener = () => reject(requestController.signal.reason); requestController.signal.addEventListener("abort", listener, { once: true }); });
    const timeout = setTimeout(() => requestController.abort(new AgentRuntimeError("E_MODEL_REQUEST_TIMEOUT", "World model request timed out")), AMPHOREUS_REQUEST_TIMEOUT_MS);
    try { return await Promise.race([options.generate(messages, requestController.signal), cancelled]); }
    finally { clearTimeout(timeout); requestController.signal.removeEventListener("abort", listener); }
  }
  async function advance(manual = false): Promise<void> {
    const started = now(), clock = worldClock(started, options.timezone());
    options.store.advance({ now: started, timezone: clock.timezone });
    options.store.updateAmphoreus((state) => {
      let changed = false;
      for (const attempt of state.attempts) if (attempt.status === "generating" && attempt.retryAt <= started) { attempt.status = "cancelled"; attempt.error = "interrupted"; attempt.retryAt = 0; changed = true; }
      return changed;
    });
    let state = options.store.readDataSnapshot().amphoreus;
    if (!state || stopped || !state.narrativeEnabled || modelBudgetUsed(state, clock.date) >= state.dailyModelBudget) return;
    const due = state.days.flatMap((day) => day.events).filter((event) => event.status === "awaiting_resolution").sort((a, b) => a.endsAt - b.endsAt).slice(0, 6);
    // Every resolution can propose an access change. Keep a review slot before paying
    // for a result that would otherwise have to be discarded unreviewed.
    if (due.length && state.dailyModelBudget - modelBudgetUsed(state, clock.date) < 2) return;
    const purpose = due.length ? "resolve" : "plan";
    if (purpose === "plan" && state.days.some((day) => day.date >= clock.date)) return;
    const key = purpose === "plan" ? `plan:${clock.date}` : `resolve:${clock.date}:${due.map((event) => `${event.id}@${event.version}`).join(",")}`;
    const previous = state.attempts.find((attempt) => (attempt.key ?? `plan:${attempt.date}`) === key);
    if (!canStartNarrativeAttempt(previous, started, manual)) return;
    if (!options.configured()) {
      if (previous?.status !== "unconfigured") options.store.updateAmphoreus((world) => { put(world, { key, purpose, date: clock.date, timezone: clock.timezone, count: previous?.count ?? 0, status: "unconfigured", attemptedAt: started, retryAt: 0 }); return true; });
      return;
    }
    const attempt: NarrativeAttempt = { key, purpose, date: clock.date, timezone: clock.timezone, count: (previous?.count ?? 0) + 1, status: "generating", attemptedAt: started, retryAt: started + LEASE_MS, ...(due.length ? { eventIds: due.map((event) => event.id) } : {}) };
    let claimed = false;
    options.store.updateAmphoreus((world) => {
      const latest = world.attempts.find((a) => a.key === key);
      if (!world.narrativeEnabled || modelBudgetUsed(world, clock.date) >= world.dailyModelBudget || !canStartNarrativeAttempt(latest, started, manual)) return false;
      put(world, attempt); claimed = true; return true;
    });
    if (!claimed) return;
    state = options.store.readDataSnapshot().amphoreus!;
    const expectedRevision = state.revision;
    const requestController = controller = new AbortController();
    let next: NarrativeAttempt = attempt;
    const valid = () => { const current = worldClock(now(), options.timezone()); return !requestController.signal.aborted && !stopped && current.date === clock.date && current.timezone === clock.timezone; };
    try {
      const output = await request(purpose === "plan" ? narrativeMessages(state, started, clock.timezone) : resolutionMessages(state, due, started), requestController);
      if (!valid()) { next = { ...attempt, status: "cancelled", error: "interrupted", retryAt: now() + RETRY_MS }; return; }
      const plan = purpose === "plan" ? parseDailyPlan(output, clock.date, clock.timezone, now(), state) : undefined;
      const personalPlans = plan ? parsePersonalPlans(output, state, clock.date, clock.timezone, now(), plan.events) : undefined;
      const resolutions = purpose === "resolve" ? parseResolutions(output, due, state) : undefined;
      if (resolutions && (due.some((event) => event.severity === "major") || resolutions.some((r) => r.effects.some((effect) => effect.kind === "access")))) {
        const reviewKey = `review:${started}:${attempt.count}`;
        let reviewClaimed = false;
        options.store.updateAmphoreus((world) => {
          if (!world.narrativeEnabled || modelBudgetUsed(world, clock.date) >= world.dailyModelBudget) return false;
          put(world, { ...attempt, key: reviewKey, count: 1 }); reviewClaimed = true; return true;
        });
        if (!reviewClaimed) throw new InvalidNarrative();
        let accepted = false;
        let reviewFailure: NarrativeAttempt["failure"];
        try { accepted = reviewAccepted(await request(reviewMessages(resolutions), requestController)); }
        catch (error) { reviewFailure = narrativeFailure(error); throw error; }
        finally { options.store.updateAmphoreus((world) => { const review = world.attempts.find((a) => a.key === reviewKey); if (!review) return false; review.status = accepted ? "success" : "failed"; review.error = accepted ? undefined : reviewFailure ? "request_failed" : "invalid_output"; review.failure = reviewFailure; review.retryAt = 0; return true; }); }
        if (!accepted) throw new InvalidNarrative();
      }
      if (!valid()) { next = { ...attempt, status: "cancelled", error: "interrupted", retryAt: now() + RETRY_MS }; return; }
      let committed = false;
      options.store.updateAmphoreus((world) => {
        const lease = world.attempts.find((a) => a.key === key);
        if (!world.narrativeEnabled || lease?.attemptedAt !== started || lease.count !== attempt.count || world.revision !== expectedRevision) return false;
        if (plan) {
          if (world.days.some((day) => day.date === clock.date)) return false;
          world.days = [...world.days, plan].sort((a, b) => a.date.localeCompare(b.date)); world.revision++;
          if (personalPlans !== undefined) {
            world.personalActions = world.personalActions.filter((action) => action.status !== "planned" || action.origin === "user_suggestion" || action.startsAt < started || worldClock(action.startsAt, clock.timezone).date !== clock.date);
            world.personalActions.push(...personalPlans.filter((action) => !world.personalActions.some((existing) => existing.startsAt < action.endsAt && existing.endsAt > action.startsAt && existing.status !== "interrupted")));
          }
        } else if (!resolutions || !applyResolutions(world, resolutions, now(), expectedRevision)) return false;
        next = { ...attempt, status: "success", retryAt: 0 }; put(world, next); committed = true; return true;
      });
      if (!committed) next = { ...attempt, status: "cancelled", error: "interrupted", retryAt: now() + RETRY_MS };
      options.store.advance({ now: now(), timezone: clock.timezone });
    } catch (error) {
      const current = worldClock(now(), options.timezone());
      const timedOut = requestController.signal.reason instanceof AgentRuntimeError && requestController.signal.reason.code === "E_MODEL_REQUEST_TIMEOUT";
      const cancelled = stopped || (!timedOut && requestController.signal.aborted) || current.date !== clock.date || current.timezone !== clock.timezone;
      const failure = !cancelled && !(error instanceof InvalidNarrative) ? narrativeFailure(error) : undefined;
      const retryAfterMs = error instanceof AgentRuntimeError && Number.isFinite(error.retryAfterMs) ? Math.min(86_400_000, Math.max(0, error.retryAfterMs!)) : 0;
      next = { ...attempt, status: cancelled ? "cancelled" : "failed", error: cancelled ? "interrupted" : error instanceof InvalidNarrative ? "invalid_output" : "request_failed", ...(failure ? { failure } : {}), retryAt: now() + Math.max(RETRY_MS, retryAfterMs) };
      if (failure) console.warn("[Amphoreus] model request failed", { purpose, category: failure.category, ...(failure.status ? { status: failure.status } : {}) });
    } finally {
      if (controller === requestController) controller = undefined;
      if (next.status !== "success") options.store.updateAmphoreus((world) => { const lease = world.attempts.find((a) => a.key === key); if (lease?.attemptedAt !== started || lease.count !== attempt.count || lease.status === "success") return false; put(world, next); return true; });
    }
  }
  function tick(manual = false): Promise<void> {
    if (stopped) return Promise.resolve(); if (pending) return pending;
    pending = advance(manual).finally(() => { pending = undefined; }); return pending;
  }
  function backgroundTick() { void tick().catch(() => { console.warn("[Amphoreus] world reconciliation unavailable; existing data retained"); }); }
  return {
    tick,
    retryNarrative() { void tick(true).catch(() => { console.warn("[Amphoreus] world retry unavailable; existing data retained"); }); },
    start() { if (timer) return; stopped = false; timer = setInterval(backgroundTick, 60_000); timer.unref?.(); backgroundTick(); },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; controller?.abort(); },
    setNarrativeEnabled(enabled: boolean) {
      options.store.updateAmphoreus((world) => { if (world.narrativeEnabled === enabled) return false; world.narrativeEnabled = enabled; return true; });
      if (!enabled) controller?.abort(); else if (!stopped) backgroundTick();
    },
  };
}
