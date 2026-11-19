import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_INTERVAL_MS,
  GLOBAL_PROACTIVE_INTERVAL_MS,
  NORMAL_QUIET_MS,
  canCommitProactiveMessage,
  canStartProactiveGeneration,
  createDefaultProactiveState,
  getFollowupIntervalMs,
  getGlobalProactiveIntervalMs,
  markNormalConversationEnded,
  markProactiveCommitted,
  markUserActivity,
} from "./proactive-policy";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";
import { getZonedDateParts } from "./proactive-trigger";

const NOW = Date.UTC(2026, 6, 13, 6, 0, 0);

function snapshot(patch: Partial<ProactiveRuntimeSnapshot> = {}): ProactiveRuntimeSnapshot {
  return {
    now: NOW,
    localHour: 14,
    idleSec: 0,
    enabled: true,
    conversationBusy: false,
    generationBusy: false,
    screenLocked: false,
    ...patch,
  };
}

function candidate(patch: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    sceneId: "work_break",
    score: 90,
    sceneCooldownMs: 2 * 60 * 60 * 1000,
    ...patch,
  };
}

describe("proactive hard policy", () => {
  it("uses a short anti-flood bound independently of the daily cap", () => {
    expect(getGlobalProactiveIntervalMs()).toBe(GLOBAL_PROACTIVE_INTERVAL_MS);
    expect(getGlobalProactiveIntervalMs(20)).toBe(3 * 60 * 1000);
    expect(getGlobalProactiveIntervalMs(3)).toBe(getGlobalProactiveIntervalMs(20));
    expect(getFollowupIntervalMs()).toBe(FOLLOWUP_INTERVAL_MS);
    expect(getFollowupIntervalMs(20)).toBe(FOLLOWUP_INTERVAL_MS);
    const state = createDefaultProactiveState();
    state.lastProactiveAt = NOW - 31 * 60 * 1000;
    expect(canStartProactiveGeneration(snapshot({ dailyLimit: 20 }), state, candidate()).allowed).toBe(true);
  });

  it("does not prompt for a reply just because a context follow-up became due", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 1;
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    state.lastProactiveScene = "morning_greeting";
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ sceneId: "conversation_followup", score: 60 })).reason).toBe("followup_requires_new_content");
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ sceneId: "followup:exam", score: 60, replyBurden: "question", sourceEventId: "exam" })).reason).toBe("followup_requires_new_content");
  });
  it("uses user quiet hours when UTC server time is in a different day/night window", () => {
    const state = createDefaultProactiveState();
    for (const [utcHour, expectedHour, allowed] of [[1, 9, true], [15, 23, false]] as const) {
      const now = Date.UTC(2026, 9, 9, utcHour);
      const localHour = getZonedDateParts(new Date(now), "Asia/Shanghai").hour;
      expect(localHour).toBe(expectedHour);
      expect(canStartProactiveGeneration(snapshot({ now, localHour, idleSec: 120 }), state, candidate()).allowed).toBe(allowed);
    }
  });

  it("enforces normal quiet period and global proactive interval", () => {
    const state = createDefaultProactiveState();
    state.lastNormalConversationEndedAt = NOW - NORMAL_QUIET_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("normal_quiet_period");

    state.lastNormalConversationEndedAt = NOW - NORMAL_QUIET_MS;
    state.lastProactiveAt = NOW - GLOBAL_PROACTIVE_INTERVAL_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("global_cooldown");

    state.lastProactiveAt = NOW - GLOBAL_PROACTIVE_INTERVAL_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).allowed).toBe(true);
  });

  it("honors the configured quiet window and daily message budget", () => {
    const state = createDefaultProactiveState();
    const c = candidate();
    expect(canStartProactiveGeneration(snapshot({ localHour: 23, localMinute: 10, quietStartMinute: 22 * 60, quietEndMinute: 8 * 60 }), state, c).reason)
      .toBe("custom_quiet_period");
    const budgeted = { ...state, dailyMessageDate: "2026-11-08", dailyMessageCount: 2 };
    expect(canStartProactiveGeneration(snapshot({ localDate: "2026-11-08", dailyLimit: 2 }), budgeted, c).reason)
      .toBe("daily_limit");
    expect(canStartProactiveGeneration(snapshot({ localDate: "2026-11-09", dailyLimit: 2 }), budgeted, c).allowed).toBe(true);
    markProactiveCommitted(state, c, NOW, "2026-11-08");
    markProactiveCommitted(state, c, NOW + 1, "2026-11-08");
    expect(state.dailyMessageCount).toBe(2);
    markProactiveCommitted(state, c, NOW + 2, "2026-11-09");
    expect(state.dailyMessageDate).toBe("2026-11-09");
    expect(state.dailyMessageCount).toBe(1);
  });

  it("blocks inactive nights but allows a recently active night", () => {
    const state = createDefaultProactiveState();
    expect(canStartProactiveGeneration(snapshot({ localHour: 23, idleSec: 60 }), state, candidate()).reason)
      .toBe("night_inactive");
    expect(canStartProactiveGeneration(snapshot({ localHour: 7, idleSec: 59 }), state, candidate()).allowed)
      .toBe(true);
  });

  it("allows overnight care only once the private reply has had thirty minutes to rest", () => {
    const state = { ...createDefaultProactiveState(), lastNormalConversationEndedAt: NOW - 30 * 60_000 };
    const clock = snapshot({ localHour: 2, localMinute: 0, idleSec: 30 * 60 });
    const care = { ...candidate(), sceneId: "standalone_care" };
    expect(canCommitProactiveMessage(clock, state, care, 0).allowed).toBe(true);
    expect(canCommitProactiveMessage(clock, { ...state, lastNormalConversationEndedAt: NOW - 30 * 60_000 + 1 }, care, 0).reason)
      .toBe("normal_quiet_period");
  });

  it("blocks disabled, locked, busy, and overlapping generation states", () => {
    const state = createDefaultProactiveState();
    expect(canStartProactiveGeneration(snapshot({ enabled: false }), state, candidate()).reason).toBe("disabled");
    expect(canStartProactiveGeneration(snapshot({ screenLocked: true }), state, candidate()).reason).toBe("screen_locked");
    expect(canStartProactiveGeneration(snapshot({ conversationBusy: true }), state, candidate()).reason).toBe("conversation_busy");
    expect(canStartProactiveGeneration(snapshot({ generationBusy: true }), state, candidate()).reason).toBe("generation_busy");
  });

  it("requires genuinely new low-burden content and a stricter score for the second message", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 1;
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS + 1;
    state.lastProactiveScene = "work_break";

    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("followup_cooldown");
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("followup_requires_new_content");
    const newContent = { sourceEventId: "new-event", replyBurden: "none" as const };
    expect(canStartProactiveGeneration(snapshot(), state, candidate(newContent)).reason).toBe("followup_same_scene");
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ ...newContent, sceneId: "rainy_day", score: 59 })).reason)
      .toBe("followup_score_too_low");
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ ...newContent, sceneId: "rainy_day", score: 60 })).allowed)
      .toBe(true);
    state.lastProactiveSourceEventId = "new-event";
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ ...newContent, sceneId: "another-title", score: 95 })).reason).toBe("followup_requires_new_content");
  });

  it("keeps the rolling hourly cap across user replies and allows dense independent moments", () => {
    const state = createDefaultProactiveState();
    for (let index = 0; index < 4; index++) {
      const now = NOW + index * 4 * 60_000;
      const c = candidate({ sceneId: `moment:${index}`, sourceEventId: `source:${index}` });
      expect(canStartProactiveGeneration(snapshot({ now, dailyLimit: 20 }), state, c).allowed).toBe(true);
      markProactiveCommitted(state, c, now);
      markUserActivity(state);
    }
    expect(canStartProactiveGeneration(snapshot({ now: NOW + 16 * 60_000 }), state, candidate()).reason).toBe("hourly_limit");
    expect(canStartProactiveGeneration(snapshot({ now: NOW + 60 * 60_000 }), state, candidate()).allowed).toBe(true);
  });

  it("caps all question opportunities using the shared durable daily budget", () => {
    const state = createDefaultProactiveState();
    const question = candidate({ sceneId: "boredom", replyBurden: "question" });
    for (let index = 0; index < 3; index++) {
      markProactiveCommitted(state, question, NOW + index * 20 * 60_000, "2026-11-17");
      markUserActivity(state);
    }
    expect(state.dailyQuestionCount).toBe(3);
    const next = snapshot({ now: NOW + 60 * 60_000, localDate: "2026-11-17", dailyLimit: 20 });
    expect(canStartProactiveGeneration(next, state, question).reason).toBe("daily_question_limit");
    expect(canStartProactiveGeneration(next, state, candidate({ replyBurden: "none" })).allowed).toBe(true);
    expect(canStartProactiveGeneration({ ...next, now: NOW + 86_400_000, localDate: "2026-11-18" }, state, question).allowed).toBe(true);
    markProactiveCommitted(state, question, NOW + 86_400_000, "2026-11-18");
    expect(state.dailyQuestionCount).toBe(1);
  });

  it("hard-blocks a third unanswered proactive message", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 2;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("unanswered_limit");
  });

  it("enforces scene cooldown independently from desire", () => {
    const state = createDefaultProactiveState();
    state.globalDesire = 100;
    state.lastFiredAt.work_break = NOW - candidate().sceneCooldownMs + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("scene_cooldown");
  });

  it("rejects a stale generation epoch at commit time", () => {
    const state = createDefaultProactiveState();
    state.proactiveEpoch = 4;
    expect(canCommitProactiveMessage(snapshot(), state, candidate(), 3).reason).toBe("stale_epoch");
    expect(canCommitProactiveMessage(snapshot(), state, candidate(), 4).allowed).toBe(true);
  });

  it("user activity invalidates generation and resets only anti-harassment state", () => {
    const state = createDefaultProactiveState();
    state.proactiveEpoch = 2;
    state.unansweredCount = 1;
    state.affinity.rainy_day = 1.4;

    markUserActivity(state);

    expect(state.proactiveEpoch).toBe(3);
    expect(state.unansweredCount).toBe(0);
    expect(state.affinity.rainy_day).toBe(1.4);
  });

  it("normal conversation end resets desire and starts quiet period", () => {
    const state = createDefaultProactiveState();
    state.globalDesire = 88;
    markNormalConversationEnded(state, NOW);
    expect(state.globalDesire).toBe(0);
    expect(state.lastNormalConversationEndedAt).toBe(NOW);
    expect(state.proactiveEpoch).toBe(1);
  });

  it("committing records scene and increments unanswered count", () => {
    const state = createDefaultProactiveState();
    markProactiveCommitted(state, candidate(), NOW);
    expect(state.unansweredCount).toBe(1);
    expect(state.lastProactiveAt).toBe(NOW);
    expect(state.lastProactiveScene).toBe("work_break");
    expect(state.lastFiredAt.work_break).toBe(NOW);
  });
});
