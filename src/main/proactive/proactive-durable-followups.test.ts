import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProactiveChatServiceDeps, ProactiveCommitInput } from "./proactive-service";
import type { RelationshipLogStore } from "../relationship/relationship-log-core";

const mocks = vi.hoisted(() => ({ deps: null as ProactiveChatServiceDeps | null, store: null as RelationshipLogStore | null,
  send: vi.fn(), status: "committed", state: undefined as unknown,
  route: { available: true, recipient: { targetId: "recipient", sessionId: "external", conversationId: "bound", updatedAt: 1 } },
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" }, powerMonitor: { on: vi.fn(), getSystemIdleTime: () => 600 } }));
vi.mock("../chats/chats-store", () => ({ listSessions: async () => [], getSessionRecord: async (id: string) => ({ id }), getOrCreateSessionByPurpose: async () => ({ id: "proactive-local" }) }));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({ getProactiveChannelAvailability: () => mocks.route, sendProactiveChannelMessage: mocks.send }));
vi.mock("../relationship/relationship-log", () => ({ getRelationshipStore: () => mocks.store, buildRelationshipContext: async () => "" }));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: async () => "", buildMemoryInjection: async () => "" }));
vi.mock("../settings-store", () => ({ loadUserProfile: () => ({ timezone: "UTC" }) }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "" }));
vi.mock("./proactive-state-store", () => ({ loadProactiveState: () => mocks.state, saveProactiveState: vi.fn() }));
vi.mock("./proactive-trigger", () => ({ createProactiveTrigger: vi.fn(), getZonedDateParts: () => ({ year: 2026, month: 11, day: 4, hour: 14, minute: 0 }) }));
vi.mock("./proactive-service", () => ({ createProactiveChatService: (deps: ProactiveChatServiceDeps) => { mocks.deps = deps; return {}; } }));

import { createProactiveLifecycle } from "./proactive-lifecycle";
import { createDefaultProactiveState } from "./proactive-policy";
import { RelationshipLogStore as Store } from "../relationship/relationship-log-core";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-durable-followup-"));
  onTestFinished(async () => { await closeConversationDatabases(); fs.rmSync(root, { recursive: true, force: true }); });
  const journal = new ConversationJournalService(new ConversationTranscriptStore(root));
  mocks.store = new Store(path.join(root, "relationship.json"));
  await mocks.store.updatePreferences({ proactiveLifeEnabled: true });
  const snapshot = await mocks.store.command({ type: "followup_save", expectedRevision: 2, topic: "论文答辩", conversationId: "bound", nextEligibleAt: Date.now() + 60_000 });
  mocks.state = createDefaultProactiveState();
  const input: ProactiveCommitInput = { intentId: "stable-intent", intentAt: Date.now(), candidate: { sceneId: `followup:${snapshot.followups![0].id}`, score: 90, sceneCooldownMs: 0 },
    text: "论文答辩准备得怎么样了？", source: "model", generationEpoch: 0, deliveryTarget: "wechat",
    deliveryContext: { relationshipRevision: snapshot.revision, conversationId: "bound", sessionId: "external", targetId: "recipient", followupId: snapshot.followups![0].id } };
  const settings = { proactiveDeliveryTarget: "wechat", proactiveChatMode: "on", mobileMessageSegmentation: "on" } as const;
  createProactiveLifecycle({ loadGeneralSettings: () => settings as never, conversationJournal: journal }).initializeProactiveChatService();
  mocks.send.mockReset();
  return { journal, input };
}

describe("proactive canonical commit and concrete followups", () => {
  it("writes CTA before channel send, reuses stable intent, and settles once without repeated asking", async () => {
    const { journal, input } = await fixture();
    mocks.send.mockImplementation(async (message) => {
      const projection = await journal.readProjection("bound");
      expect(projection.messages.some(item => item.content === input.text)).toBe(true);
      expect(message).toMatchObject({ operationId: "proactive:stable-intent", runId: "stable-intent", assistantTurnId: "stable-intent:assistant" });
      expect(message.canContinue()).toBe(true);
      return { kind: "committed", deliveredParts: 1, totalParts: 1 };
    });
    expect(await mocks.deps!.commitMessage(input)).toEqual({ kind: "committed" });
    expect((await mocks.store!.snapshot()).followups![0].status).toBe("awaiting_reply");
    expect(await mocks.deps!.commitMessage(input)).toEqual({ kind: "committed" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await journal.readProjection("bound")).messages.filter(item => item.role === "model")).toHaveLength(1);
  });

  it("keeps failed generation in CTA and pauses an unknown delivery for explicit review", async () => {
    const { journal, input } = await fixture();
    mocks.send.mockResolvedValue({ kind: "cancelled", reason: "connection_lost", deliveryStatus: "unknown" });
    expect((await mocks.deps!.commitMessage(input)).kind).toBe("cancelled");
    expect((await mocks.store!.snapshot()).followups![0].status).toBe("paused");
    await journal.appendUser("bound", { turnId: "next-user", text: "刚才怎么了" });
    expect(JSON.stringify((await journal.buildModelContext("bound")).messages)).toContain("DELIVERY_UNCONFIRMED");
    await mocks.deps!.commitMessage(input);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale relationship revision before adding a reply or sending", async () => {
    const { journal, input } = await fixture();
    await mocks.store!.updatePreferences({ paused: true });
    expect((await mocks.deps!.commitMessage(input)).kind).toBe("cancelled");
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await journal.readProjection("bound")).messages).toHaveLength(0);
  });

  it.each(["unknown", "failed"] as const)("pauses a partially delivered followup when the next part is %s without pretending it was fully asked", async deliveryStatus => {
    const { journal, input } = await fixture();
    mocks.send.mockResolvedValue({ kind: "committed", deliveredParts: 1, totalParts: 2, deliveryStatus, error: "second_part_unconfirmed" });
    expect(await mocks.deps!.commitMessage(input)).toEqual({ kind: "committed", deliveryStatus, reason: "second_part_unconfirmed" });
    const item = (await mocks.store!.snapshot()).followups![0];
    expect(item.status).toBe("paused");
    expect(item.lastAskedAt).toBeUndefined();
    expect(item.resolutionReason).toContain(deliveryStatus === "unknown" ? "未知" : "部分");
    await journal.appendUser("bound", { turnId: "after-partial", text: "刚才只收到一部分" });
    expect(JSON.stringify((await journal.buildModelContext("bound")).messages)).toContain(deliveryStatus === "unknown" ? "DELIVERY_UNCONFIRMED" : "PARTIAL_DELIVERY");
    expect((await mocks.deps!.commitMessage(input)).kind).toBe("cancelled");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
