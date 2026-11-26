import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { XilianWorldStore } from "../xilian-world/world-store";
import { AgentRuntimeError } from "../orchestrator/agent-runtime-error";
import { createAmphoreusService } from "./service";
import { parseDailyPlan } from "./narrative";
import { plan, resolutionOutput, reviewOutput } from "./test-fixtures";

let root: string, now: number, store: XilianWorldStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "amphoreus-recovery-"));
  now = Date.parse("2026-11-10T08:00:00Z");
  store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now);
  store.advance({ now, timezone: "UTC" });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
const state = () => store.readDataSnapshot().amphoreus!;
function failed(count = 3) {
  store.updateAmphoreus((world) => {
    world.attempts = [{ key: "plan:2026-11-10", purpose: "plan", date: "2026-11-10", timezone: "UTC", count, status: "failed", error: "request_failed", attemptedAt: now - 61_000, retryAt: now + 1_800_000 }];
    return true;
  });
}
function service(generate = vi.fn(async () => JSON.stringify(plan()))) {
  return createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate });
}

it("recovers an exhausted automatic plan manually without resetting its charged attempts", async () => {
  failed();
  const generate = vi.fn(async () => JSON.stringify(plan())), runtime = service(generate);
  expect(store.worldView().amphoreus!.narrativeRecovery).toEqual({ canRetry: true, blockedBy: "attempt_limit" });
  await runtime.tick(); expect(generate).not.toHaveBeenCalled();
  runtime.retryNarrative(); runtime.retryNarrative(); await runtime.tick();
  expect(generate).toHaveBeenCalledTimes(1);
  expect(store.worldView().amphoreus!).toMatchObject({ narrative: { count: 4, status: "success" }, budget: { used: 4, limit: 8 } });
  expect(state().days).toHaveLength(1);
  store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now);
  expect(state().attempts[0]).toMatchObject({ count: 4, status: "success" });
  runtime.stop();
});

it.each(["cooldown", "budget", "disabled"])("enforces %s on the manual endpoint as well as in the view", async (kind) => {
  failed(kind === "budget" ? 8 : 3);
  store.updateAmphoreus((world) => {
    if (kind === "cooldown") world.attempts[0].attemptedAt = now;
    if (kind === "disabled") world.narrativeEnabled = false;
    return true;
  });
  const generate = vi.fn(), runtime = service(generate);
  expect(store.worldView().amphoreus!.narrativeRecovery.canRetry).toBe(false);
  runtime.retryNarrative(); await runtime.tick();
  expect(generate).not.toHaveBeenCalled();
  expect(state().attempts[0].count).toBe(kind === "budget" ? 8 : 3);
  runtime.stop();
});

it("persists only safe classified failure fields and keeps the fourth failure capped across restart", async () => {
  failed();
  const generate = vi.fn(async () => { throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "secret-body-and-url", {
    modelFailure: { provider: "chatgpt", model: "model", category: "AUTH", status: 401, vendorCode: "secret-vendor-code", requestId: "secret-request-id" },
  }); });
  const runtime = service(generate); runtime.retryNarrative(); await runtime.tick(); runtime.stop();
  store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now);
  expect(state().attempts[0]).toMatchObject({ count: 4, failure: { category: "AUTH", status: 401 } });
  const saved = fs.readFileSync(path.join(root, "amphoreus-world.json"), "utf8");
  expect(saved).not.toContain("secret-");
  now += 31 * 60_000;
  const restarted = service(generate); await restarted.tick();
  expect(generate).toHaveBeenCalledTimes(1);
  restarted.stop();
});

it("honors a provider retry-after for automatic and manual rate-limit recovery", async () => {
  const generate = vi.fn(async () => { throw new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "rate limit", {
    modelFailure: { provider: "chatgpt", model: "model", category: "RATE_LIMIT", status: 429 }, retryAfterMs: 7_200_000,
  }); });
  const runtime = service(generate); await runtime.tick();
  const retryAt = now + 7_200_000;
  expect(state().attempts[0].retryAt).toBe(retryAt);
  now += 31 * 60_000;
  expect(store.worldView().amphoreus!.narrativeRecovery).toMatchObject({ canRetry: false, automaticRetryAt: retryAt });
  runtime.retryNarrative(); await runtime.tick();
  expect(generate).toHaveBeenCalledTimes(1);
  now = retryAt; runtime.retryNarrative(); await runtime.tick();
  expect(generate).toHaveBeenCalledTimes(2);
  runtime.stop();
});

it("gives settlement and review separate deadlines while retaining the cross-runtime lease", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const value = plan(); value.events[0].severity = "major";
  store.updateAmphoreus((world) => { world.days.push(parseDailyPlan(JSON.stringify(value), value.date, "UTC", now, world)); return true; });
  now = Date.parse("2026-11-10T10:30:00Z"); store.advance({ now, timezone: "UTC" });
  let resolveResult!: (value: string) => void, resolveReview!: (value: string) => void;
  const generate = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { resolveResult = resolve; }))
    .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveReview = resolve; }));
  const runtime = service(generate), pending = runtime.tick();
  now += 140_000; await vi.advanceTimersByTimeAsync(140_000);
  const second = service(generate); await second.tick();
  expect(generate).toHaveBeenCalledTimes(1);
  resolveResult(resolutionOutput(state())); await vi.advanceTimersByTimeAsync(0);
  expect(generate).toHaveBeenCalledTimes(2);
  now += 140_000; await vi.advanceTimersByTimeAsync(140_000);
  resolveReview(reviewOutput(generate.mock.calls[1][0][1].content));
  await pending;
  expect(state().days[0].events[0].status).toBe("completed");
  expect(store.worldView().amphoreus!).toMatchObject({ narrative: { status: "success", count: 1 }, budget: { used: 2 } });
  runtime.stop(); second.stop();
});
