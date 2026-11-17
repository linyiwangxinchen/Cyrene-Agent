import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InitiativeOpportunityStore, type InitiativeOpportunityInput } from "./initiative-opportunities";
import { createDefaultProactiveState } from "./proactive-policy";
import { createProactiveChatService, type ProactiveChatServiceDeps } from "./proactive-service";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot, ProactiveState } from "./proactive-types";

const NOW = Date.UTC(2026, 10, 17, 6);
const MINUTE = 60_000;

describe("initiative recovery releases abandoned selections", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "initiative-recovery-review-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function setup(overrides: Partial<ProactiveChatServiceDeps> = {}) {
    const store = new InitiativeOpportunityStore(path.join(root, "opportunities.json"), () => 0.999);
    const opportunity: InitiativeOpportunityInput = {
      id: "life:reading", source: "amphoreus", sourceEventId: "reading-finished", evidenceVersion: 1,
      motive: "interesting", summary: "刚刚读到一段想分享的故事", occurredAt: NOW,
      expiresAt: NOW + 6 * 3_600_000, strengthPerHour: 2, replyBurden: "none", score: 76,
    };
    store.select({ now: NOW, opportunities: [opportunity], eligible: true });
    const selected = store.select({ now: NOW + MINUTE, opportunities: [opportunity], eligible: true })!;
    expect(selected.status).toBe("selected");
    const candidate: ProactiveCandidate = {
      sceneId: opportunity.id, score: 76, sceneCooldownMs: 0, opportunityId: selected.key,
      sourceEventId: opportunity.sourceEventId, evidenceVersion: "1", replyBurden: "none",
    };
    let state = createDefaultProactiveState();
    const snapshot: ProactiveRuntimeSnapshot = {
      now: NOW + MINUTE, localHour: 14, idleSec: 0, enabled: true,
      conversationBusy: false, generationBusy: false, screenLocked: false,
    };
    const runModel = vi.fn(async () => ({ kind: "send" as const, text: "刚刚读到了有趣的一页。" }));
    const commitMessage = vi.fn(async () => ({ kind: "committed" as const }));
    const service = createProactiveChatService({
      loadState: () => state,
      saveState: (next: ProactiveState) => { state = structuredClone(next); },
      getSnapshot: () => snapshot,
      buildMessages: async () => [], runModel, commitMessage, getFallback: async () => null,
      getDeliveryTarget: () => "local", requiresDurableIntent: () => true,
      onOpportunityDecision: (item, decision, input) => { store.resolve(item.opportunityId!, decision, input); },
      ...overrides,
    });
    return { store, candidate, service, runModel, commitMessage, state: () => state };
  }

  it("releases a selected source when a failed durable delivery is invalidated by a user message", async () => {
    const commitMessage = vi.fn(async () => { throw new Error("delivery database unavailable"); });
    const ctx = setup({ commitMessage });
    await expect(ctx.service.evaluateCandidate(ctx.candidate)).rejects.toThrow("delivery database unavailable");
    expect(ctx.state().pendingCommitIntent).toBeDefined();
    expect(ctx.store.find(ctx.candidate.opportunityId!)?.status).toBe("selected");

    ctx.service.invalidateForUserMessage();
    await ctx.service.evaluateCandidate(ctx.candidate);

    expect(ctx.state().pendingCommitIntent).toBeUndefined();
    expect(ctx.store.find(ctx.candidate.opportunityId!)?.status).not.toBe("selected");
    expect(ctx.runModel).toHaveBeenCalledOnce();
    expect(commitMessage).toHaveBeenCalledOnce();
  });

  it("holds a selection when gathering its source context fails before the model request", async () => {
    const ctx = setup({ buildMessages: async () => { throw new Error("source context unavailable"); } });
    await expect(ctx.service.evaluateCandidate(ctx.candidate)).rejects.toThrow("source context unavailable");
    expect(ctx.store.find(ctx.candidate.opportunityId!)?.status).toBe("held");
    expect(ctx.state().pendingCommitIntent).toBeUndefined();
    expect(ctx.runModel).not.toHaveBeenCalled();
    expect(ctx.commitMessage).not.toHaveBeenCalled();
  });

  it("holds a selection when the model adapter throws unexpectedly", async () => {
    const ctx = setup({ runModel: async () => { throw new Error("model adapter interrupted"); } });
    await expect(ctx.service.evaluateCandidate(ctx.candidate)).rejects.toThrow("model adapter interrupted");
    expect(ctx.store.find(ctx.candidate.opportunityId!)?.status).toBe("held");
    expect(ctx.state().pendingCommitIntent).toBeUndefined();
    expect(ctx.commitMessage).not.toHaveBeenCalled();
  });
});
