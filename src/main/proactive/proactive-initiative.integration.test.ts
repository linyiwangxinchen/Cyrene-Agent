import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../settings/general-settings";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import type { ProactiveLifecycle } from "./proactive-lifecycle";
import type { ProactiveTriggerController, ProactiveTriggerDependencies } from "./proactive-trigger";
import type { InitiativeOpportunity } from "./initiative-opportunities";
import type { AmphoreusView } from "../../shared/amphoreus-world";
import type { ChatMessageChannelSource } from "../../shared/chat-types";
import { createDefaultProactiveState } from "./proactive-policy";
import { amphoreusView, createAmphoreusState } from "../amphoreus-world/engine";

const mocks = vi.hoisted(() => ({
  root: "", loadState: vi.fn(), saveState: vi.fn(), runModel: vi.fn(),
  power: null as unknown as EventEmitter,
  paused: false, world: null as unknown as AmphoreusView,
  deps: null as unknown as ProactiveTriggerDependencies,
  controller: null as unknown as ProactiveTriggerController,
  route: { available: false, reason: "channel_offline" } as any,
  history: [] as Array<{ role: "user" | "model"; at: number; content: string; channelSource?: ChatMessageChannelSource }>,
}));
vi.mock("electron", () => ({ app: { getPath: () => mocks.root }, get powerMonitor() { return mocks.power; } }));
vi.mock("../chats/chats-store", () => ({ listSessions: async () => [], getSessionRecord: async () => null, getOrCreateSessionByPurpose: async () => ({ id: "fixture-proactive" }) }));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({ getProactiveChannelAvailability: () => mocks.route, sendProactiveChannelMessage: vi.fn() }));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: async () => "", buildMemoryInjection: async () => "" }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "" }));
vi.mock("../persona/persona-spec", () => ({ buildPersonaContractPrompt: () => "测试人格" }));
vi.mock("../relationship/relationship-log", () => ({
  getRelationshipStore: () => ({ getControls: () => ({ revision: 1, paused: mocks.paused }),
    snapshot: async () => ({ revision: 1, relationship: { paused: mocks.paused, innerLifeEnabled: true, proactiveLifeEnabled: true,
      sharedGoals: [], milestones: [] }, followups: [] }) }),
  buildRelationshipContext: async () => "", recordCompanionEvent: async () => undefined,
}));
vi.mock("../settings/model-settings", async original => ({
  ...await original<typeof import("../settings/model-settings")>(),
  loadModelSettings: () => ({ apiKey: "fixture-key", provider: "fixture", baseUrl: "https://example.test/v1", model: "fixture-model" }),
}));
vi.mock("../settings-store", () => ({ loadUserProfile: () => ({ timezone: "Asia/Shanghai" }) }));
vi.mock("../xilian-world/world-store", () => ({ getSharedXilianWorldStore: () => ({
  advance: () => ({ worldDate: "2026-11-17", seasonId: "翁法罗斯", activeArcId: "fixture" }),
  queryTimeline: () => [], worldView: () => ({ amphoreus: mocks.world }),
}) }));
vi.mock("../amphoreus-world/runtime", () => ({ createAmphoreusRuntime: () => ({ start: vi.fn(), stop: vi.fn(), setNarrativeEnabled: vi.fn() }) }));
vi.mock("./proactive-state-store", () => ({ loadProactiveState: mocks.loadState, saveProactiveState: mocks.saveState }));
vi.mock("./proactive-model", () => ({ runProactiveModel: mocks.runModel }));
vi.mock("./proactive-trigger", async original => {
  const actual = await original<typeof import("./proactive-trigger")>();
  return { ...actual, createProactiveTrigger: (deps: ProactiveTriggerDependencies) => {
    mocks.deps = deps; mocks.controller = actual.createProactiveTrigger(deps); return mocks.controller;
  } };
});
import { createProactiveLifecycle } from "./proactive-lifecycle";
import { InitiativeOpportunityStore } from "./initiative-opportunities";
import { relatedConversationOpportunity } from "./world-initiative";
import { normalizePluginObservation } from "./plugin-observation";
import { buildCapabilityTextParts } from "../channels/capability-text";
import { pluginPromptRegistry } from "../../plugins/prompts";
import { getConversationDatabase } from "../storage/conversation-database-client";
import type { SocialAtom } from "../social-context/types";
import { memoryFollowupOpportunities } from "./memory-initiative";

const NOW = Date.UTC(2026, 10, 17, 2);
const minute = 60_000;
const appendAssistant = vi.fn(async () => "assistant-fixture");
const appendPresentationNext = vi.fn(async () => undefined);
let lifecycle: ProactiveLifecycle;
let random: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-initiative-integration-"));
  mocks.power = new EventEmitter(); mocks.paused = false;
  mocks.world = amphoreusView(createAmphoreusState(NOW), NOW, "Asia/Shanghai");
  mocks.world.personal!.currentActivity = { residentId: "cyrene", activity: "study", title: "专心阅读手头的记录",
    startsAt: NOW - minute, endsAt: NOW + 6 * 3_600_000, source: "routine", eventId: "study:one", locationId: "okhema" };
  let state = createDefaultProactiveState();
  mocks.loadState.mockImplementation(() => structuredClone(state));
  mocks.saveState.mockImplementation(next => { state = structuredClone(next); });
  mocks.runModel.mockResolvedValue({ kind: "hold", resumeOn: "evidence_change" });
  mocks.route = { available: false, reason: "channel_offline" };
  mocks.history = [];
  random = vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  pluginPromptRegistry.clear();
  lifecycle?.stopProactiveTrigger(); vi.clearAllTimers(); vi.useRealTimers(); random.mockRestore();
  fs.rmSync(mocks.root, { recursive: true, force: true });
});
function setup(patch: Partial<GeneralSettings> = {}, listPersonMemory?: () => SocialAtom[]) {
  const settings = { proactiveChatMode: "on", proactiveDeliveryTarget: "local", proactiveDailyLimit: 20,
    proactiveDensity: "active", proactiveTargetScore: 60, ...patch } as GeneralSettings;
  lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings, listPersonMemory,
    conversationJournal: {
      readProjection: async (id: string) => ({ messages: id === "bound" ? mocks.history : [] }),
      createRunSink: () => ({ appendAssistant }),
      appendPresentationNext,
    } as unknown as ConversationJournalService });
  lifecycle.initializeProactiveChatService(); lifecycle.initializeProactiveTrigger();
  return settings;
}
function addKnownStory(at = NOW) {
  const change = { id: "knowledge:cyrene:story:1", eventId: "story", version: 1, residentId: "cyrene", kind: "experienced" as const,
    occurredAt: at, knownAt: at, text: "整理书页时找到一张旧书签", source: "事件结算", locationId: "okhema" };
  mocks.world.personal!.changes = [change];
  mocks.world.personal!.experiences = [{ id: "memory:story", eventId: change.eventId, at: NOW, kind: change.kind,
    text: change.text, source: change.source, locationId: change.locationId }];
}
function entries(): InitiativeOpportunity[] {
  const file = path.join(mocks.root, "initiative-opportunities.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).entries : [];
}
async function tick(now: number) { vi.setSystemTime(now); await mocks.controller.evaluateNow("integration"); }

describe("Bilibili video shares in the shared lifecycle", () => {
  const bvid = "BV1TqCMBGExu";
  const run = "4f823177-8290-459e-a6e7-b6307f872adb";
  const source = "https://www.bilibili.com/video/" + bvid;
  const title = "一段字幕剪辑";
  const summary = "剪辑把字幕从一行拆成两行。";
  const clip = { text: "这句停一下再出下一行。", from: 30 };

  it.each(["current", "legacy"] as const)("composes and persists the canonical link for a %s queued video", async mode => {
    random.mockReturnValue(0.99);
    setup({ companionPluginSharingEnabled: true });
    if (mode === "legacy") {
      lifecycle.enqueueCompanionMoment({ id: "plugin:bili-garden:" + run + ":" + bvid, kind: "share", source: "plugin",
        pluginId: "bili-garden", occurredAt: NOW, summary: [title, summary, source].join("\n") });
    } else {
      const moment = normalizePluginObservation("bili-garden", "interesting-item", { eventId: run + ":" + bvid, occurredAt: NOW, bvid, title, summary, clip });
      expect(moment).not.toBeNull();
      lifecycle.enqueueCompanionMoment(moment!);
    }
    const plan = "聊聊字幕那处停顿，原片链接还没核实";
    const prose = "它卡着停顿才弹出下一行字幕，有点俏皮♪";
    mocks.runModel
      .mockResolvedValueOnce({ kind: "send", text: plan })
      .mockResolvedValueOnce({ kind: "send", text: prose + "，原片链接还没核实。" });
    for (let minuteIndex = 0; minuteIndex <= 5 && mocks.runModel.mock.calls.length < 2; minuteIndex++) {
      await tick(NOW + minuteIndex * minute);
    }
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.runModel.mock.calls) {
      const messages = JSON.stringify(call.messages);
      expect(messages).toContain(source);
      expect(messages).toContain(summary);
      expect(messages).not.toContain("链接还没核实");
      if (mode === "current") expect(messages).toContain(clip.text);
    }
    const sent = prose + "\n\n" + source;
    expect(appendAssistant).toHaveBeenCalledOnce();
    expect(appendAssistant).toHaveBeenCalledWith({ message: { role: "assistant", content: sent }, roundId: "proactive" });
    expect(appendPresentationNext.mock.calls[0]).toContainEqual(expect.objectContaining({ content: sent }));
    expect(buildCapabilityTextParts(sent, 2048, "natural")).toEqual([
      { kind: "text", text: prose }, { kind: "text", text: source },
    ]);
  });

  it("does not compose or send a source link when the planning model drops the video", async () => {
    random.mockReturnValue(0.99);
    setup({ companionPluginSharingEnabled: true });
    lifecycle.enqueueCompanionMoment(normalizePluginObservation("bili-garden", "interesting-item", {
      eventId: run + ":" + bvid, occurredAt: NOW, bvid, title, summary,
    })!);
    mocks.runModel.mockResolvedValueOnce({ kind: "drop" });
    for (let minuteIndex = 0; minuteIndex <= 5 && !mocks.runModel.mock.calls.length; minuteIndex++) {
      await tick(NOW + minuteIndex * minute);
    }
    expect(mocks.runModel).toHaveBeenCalledOnce();
    expect(appendAssistant).not.toHaveBeenCalled();
  });

  it("does not send a bare source link when the composer returns only a link disclaimer", async () => {
    random.mockReturnValue(0.99);
    setup({ companionPluginSharingEnabled: true });
    lifecycle.enqueueCompanionMoment(normalizePluginObservation("bili-garden", "interesting-item", {
      eventId: run + ":" + bvid, occurredAt: NOW, bvid, title, summary,
    })!);
    mocks.runModel
      .mockResolvedValueOnce({ kind: "send", text: "聊聊字幕那处停顿" })
      .mockResolvedValueOnce({ kind: "send", text: "原片链接还没核实。" });
    for (let minuteIndex = 0; minuteIndex <= 5 && mocks.runModel.mock.calls.length < 2; minuteIndex++) {
      await tick(NOW + minuteIndex * minute);
    }
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    expect(appendAssistant).not.toHaveBeenCalled();
  });

  it.each(["disabled", "allowed", "revoked"] as const)("handles a %s expression source in the actual proactive pipeline", async mode => {
    random.mockReturnValue(0.99);
    const settings = setup({ companionPluginSharingEnabled: true, proactiveExpressionSources: mode === "disabled" ? [] : ["bili-garden"] });
    pluginPromptRegistry.register("bili-garden", {
      id: "expressions",
      provide: () => "",
      listExpressionEvidence: () => [bvid, "BV1xx411c7mD"].map((id, index) => ({
        id: `sample-${index}`, at: NOW, quote: ["先听你说完", "先说说这次进展"][index],
        strategy: "acknowledge",
        source: { kind: "video_subtitle", id: `${id}:subtitle:${index}`, unit: id, url: `https://www.bilibili.com/video/${id}` },
      })),
    }, new AbortController().signal, "builtin");
    lifecycle.enqueueCompanionMoment(normalizePluginObservation("bili-garden", "interesting-item", {
      eventId: run + ":" + bvid, occurredAt: NOW, bvid, title, summary,
    })!);
    mocks.runModel.mockResolvedValueOnce({ kind: "send", text: "聊聊字幕那处停顿" })
      .mockImplementationOnce(async () => {
        if (mode === "revoked") settings.proactiveExpressionSources = [];
        return { kind: "send", text: "它停了一下，字幕才接上♪" };
      });
    for (let index = 0; index <= 5 && mocks.runModel.mock.calls.length < 2; index++) {
      await tick(NOW + index * minute);
    }
    const hint = "先接住对方表达的感受或进展";
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.runModel.mock.calls[0][0].messages)).not.toContain(hint);
    expect(JSON.stringify(mocks.runModel.mock.calls[1][0].messages).includes(hint)).toBe(mode !== "disabled");
    expect(appendAssistant).toHaveBeenCalledTimes(mode === "revoked" ? 0 : 1);
  });
});

describe("world initiative in the shared lifecycle", () => {
  const recipientScope = `peer:${"a".repeat(64)}`;
  const channelSource = { channel: "wechat", chatType: "private", recipientScope } as const;
  const boundChannel = () => ({ available: true, recipient: { conversationId: "bound", sessionId: "channel:wechat:fixture", targetId: "fixture", updatedAt: NOW, recipientScope, bindingUpdatedAt: NOW } });

  it("does not journal or deliver a memory follow-up withdrawn during composition", async () => {
    mocks.route = boundChannel();
    const atom: SocialAtom = {
      id: "pending-care", type: "open_loop", status: "active", conversationId: "bound", memoryScope: recipientScope,
      content: "今天要去看一场展览", evidenceQuote: "今天要去看一场展览", evidenceTurnId: "care-turn",
      sourceEntryId: "channel:care-turn", createdAt: NOW - (12 * 60 + 1) * minute,
    };
    setup({ proactiveDeliveryTarget: "wechat" }, () => [atom]);
    const database = getConversationDatabase(mocks.root);
    try {
      await database.call("transcript.append", atom.conversationId, { id: atom.sourceEntryId, kind: "user", turnId: atom.evidenceTurnId,
        revision: 1, at: atom.createdAt, payload: { text: atom.evidenceQuote } });
      const opportunities = memoryFollowupOpportunities([atom], NOW, atom.conversationId);
      const store = new InitiativeOpportunityStore(path.join(mocks.root, "initiative-opportunities.json"), () => 0.99);
      store.select({ now: NOW, opportunities, eligible: true });
      const selected = store.select({ now: NOW + minute, opportunities, eligible: true })!;
      vi.setSystemTime(NOW + minute);
      mocks.runModel.mockResolvedValueOnce({ kind: "send", text: "问问展览怎么样" })
        .mockImplementationOnce(async () => {
          await database.call("transcript.append", atom.conversationId, { id: "withdraw-care-turn", kind: "turn_tombstone", at: Date.now(),
            payload: { targetUserTurnId: atom.evidenceTurnId, reason: "pending_withdrawn" } });
          return { kind: "send", text: "今天的展览看得怎么样？" };
        });

      await lifecycle.getProactiveChatService()!.evaluateCandidate({ sceneId: selected.sceneId!, score: selected.score!, sceneCooldownMs: 0,
        opportunityId: selected.key, sourceEventId: selected.sourceEventId, evidenceVersion: String(selected.evidenceVersion),
        replyBurden: selected.replyBurden, momentSummary: selected.summary });
      expect(mocks.runModel).toHaveBeenCalledTimes(2);
      expect(appendAssistant).not.toHaveBeenCalled();
      expect(lifecycle.getProactiveStatus().lastOutcome).toMatchObject({ state: "blocked", reason: "memory_resolved" });
    } finally {
      await database.close();
    }
  });

  it("takes care from the private conversation and chooses it before equally ready world news", async () => {
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: NOW, content: "我今天有点累", channelSource }];
    random.mockReturnValue(0.99);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(NOW);
    await tick(NOW + 19 * minute);
    expect(mocks.runModel).not.toHaveBeenCalled();
    addKnownStory(NOW + 20 * minute);
    await tick(NOW + 20 * minute);
    await tick(NOW + 21 * minute);
    expect(mocks.runModel).toHaveBeenCalledOnce();
    expect(entries().find(entry => entry.source === "user_care")).toMatchObject({ conversationId: "bound", status: "held", occurredAt: NOW });
    expect(entries().find(entry => entry.source === "amphoreus")).toMatchObject({ status: "pending" });
  });

  it("stays quiet for group history and does not revive a disclosure after a newer reply", async () => {
    mocks.route = boundChannel();
    const report = { role: "user" as const, at: NOW, content: "我今天有点累", channelSource };
    mocks.history = [{ ...report, channelSource: { channel: "wechat", chatType: "group" } }];
    random.mockReturnValue(0.99);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(NOW);
    expect(entries()).toEqual([]);
    mocks.history = [report];
    await tick(NOW + minute);
    expect(entries().find(entry => entry.source === "user_care")).toMatchObject({ status: "pending" });
    mocks.history.push({ role: "user", at: NOW + 19 * minute, content: "现在好多了", channelSource });
    lifecycle.proactiveConversationLifecycle.onUserMessage();
    await tick(NOW + 20 * minute);
    await tick(NOW + 21 * minute);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("considers a low-pressure check-in once the private chat has been quiet for thirty minutes", async () => {
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: NOW - 30 * minute, content: "我刚冲了杯咖啡", channelSource }];
    random.mockReturnValue(0.9999);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(NOW - minute);
    expect(entries()).toEqual([]);
    await tick(NOW);
    expect(entries().find(entry => entry.source === "standalone_care")).toMatchObject({ status: "pending" });
    expect(mocks.runModel).not.toHaveBeenCalled();
    await tick(NOW + minute);

    const checkIn = entries().find(entry => entry.source === "standalone_care");
    expect(checkIn).toMatchObject({ conversationId: "bound", sceneId: "standalone_care", replyBurden: "none", status: "held" });
    expect(String(checkIn?.evidenceVersion)).toContain("2026-11-17");
    expect(mocks.runModel).toHaveBeenCalledOnce();
    const messages = mocks.runModel.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages.find(message => message.role === "system")?.content).toContain("[本轮日常关心]");
    expect(messages.some(message => String(message.content).includes("我刚冲了杯咖啡"))).toBe(false);
  });

  it("keeps private context out of both phases of an everyday check-in and declines a question", async () => {
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: NOW - 30 * minute, content: "本轮私人内容：厨房里留着半杯咖啡", channelSource }];
    mocks.runModel.mockResolvedValueOnce({ kind: "send", text: "发一句轻松问候" })
      .mockResolvedValueOnce({ kind: "send", text: "你忙完了吗？请回复我。" });
    random.mockReturnValue(0.9999);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(NOW);
    await tick(NOW + minute);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.runModel.mock.calls) expect(JSON.stringify(request.messages)).not.toContain("半杯咖啡");
    expect(entries().find(entry => entry.source === "standalone_care")?.status).toBe("held");
    expect(mocks.loadState().pendingCommitIntent).toBeUndefined();
  });

  it("uses only the destination's channel history and drops the draft when the binding changes between phases", async () => {
    mocks.route = boundChannel();
    mocks.history = [
      { role: "user", at: NOW - 3 * minute, content: "同一会话的桌面私聊原文", channelSource: undefined },
      { role: "user", at: NOW - 2 * minute, content: "同一会话的另一位联系人原文", channelSource: { ...channelSource, recipientScope: `peer:${"b".repeat(64)}` } },
      { role: "user", at: NOW - minute, content: "可用的本接收人普通对话", channelSource },
    ];
    mocks.runModel.mockImplementationOnce(async () => {
      mocks.route.recipient = { ...mocks.route.recipient, bindingUpdatedAt: NOW + 1 };
      return { kind: "send", text: "起草一句问候" };
    });
    setup({ proactiveDeliveryTarget: "wechat" });
    await lifecycle.getProactiveChatService()!.evaluateCandidate({ sceneId: "fixture", score: 100, sceneCooldownMs: 0 });
    expect(mocks.runModel).toHaveBeenCalledOnce();
    const first = JSON.stringify(mocks.runModel.mock.calls[0][0].messages);
    expect(first).toContain("可用的本接收人普通对话");
    expect(first).not.toMatch(/桌面私聊原文|另一位联系人原文/u);
    expect(mocks.loadState().pendingCommitIntent).toBeUndefined();
  });

  it("keeps the previous evening's opportunity across midnight without requiring recent night activity", async () => {
    const beforeMidnight = Date.UTC(2026, 10, 17, 15, 59); // 用户当地 11 月 17 日 23:59
    vi.setSystemTime(beforeMidnight);
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: beforeMidnight - 30 * minute, content: "刚把桌子收拾好", channelSource }];
    random.mockReturnValue(0.9999);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(beforeMidnight);
    await tick(beforeMidnight + minute);

    const checkIns = entries().filter(entry => entry.source === "standalone_care");
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0]).toMatchObject({ evidenceVersion: "2026-11-17", status: "held" });
    expect(mocks.runModel).toHaveBeenCalledOnce();
    const messages = mocks.runModel.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages.find(message => message.role === "user")?.content).toContain("2026-11-18 00:00");
  });

  it("keeps overnight check-ins quiet when the configured quiet window crosses midnight", async () => {
    const beforeMidnight = Date.UTC(2026, 10, 17, 15, 59);
    vi.setSystemTime(beforeMidnight);
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: beforeMidnight - 30 * minute, content: "刚把桌子收拾好", channelSource }];
    random.mockReturnValue(0.9999);
    setup({ proactiveDeliveryTarget: "wechat", proactiveQuietStartMinute: 23 * 60, proactiveQuietEndMinute: 2 * 60 });
    await tick(beforeMidnight);
    await tick(beforeMidnight + minute);
    await tick(beforeMidnight + 2 * minute);

    expect(entries().some(entry => entry.source === "standalone_care" && entry.wasEligible)).toBe(false);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("does not generate an overnight check-in once local time reaches five", async () => {
    const beforeClosing = Date.UTC(2026, 10, 17, 20, 59); // 用户当地 11 月 18 日 04:59
    vi.setSystemTime(beforeClosing);
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: beforeClosing - 30 * minute, content: "刚把桌子收拾好", channelSource }];
    random.mockReturnValue(0.9999);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(beforeClosing);
    expect(entries().find(entry => entry.source === "standalone_care")).toMatchObject({ evidenceVersion: "2026-11-17", status: "pending" });
    await tick(beforeClosing + minute);

    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it.each(["group", "unanswered"] as const)("does not start an everyday check-in with %s context", async scenario => {
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: NOW - 3 * 60 * minute, content: "我刚冲了杯咖啡",
      channelSource: scenario === "group" ? { channel: "wechat", chatType: "group" } : channelSource }];
    if (scenario === "unanswered") {
      mocks.saveState({ ...mocks.loadState(), unansweredCount: 1, lastProactiveAt: NOW - 60 * minute });
    }
    random.mockReturnValue(0.9999);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(NOW);
    await tick(NOW + minute);
    expect(entries().some(entry => entry.source === "standalone_care")).toBe(false);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("has no standalone check-in at thirty minutes without a private conversation", async () => {
    setup(); lifecycle.proactiveConversationLifecycle.onUserMessage();
    lifecycle.proactiveConversationLifecycle.onConversationStarted(); lifecycle.proactiveConversationLifecycle.onConversationEnded();
    for (const elapsed of [29, 30, 31]) await tick(NOW + elapsed * minute);
    expect(mocks.deps.useEventOpportunitiesOnly).toBe(true);
    expect(mocks.runModel).not.toHaveBeenCalled(); expect(entries()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
  });

  it("does not consume opportunity randomness through world/UI refreshes", async () => {
    addKnownStory(); setup();
    for (let index = 0; index < 5; index++) { lifecycle.getWorldSnapshot(); lifecycle.getWorldView(); }
    expect(entries()).toEqual([]); expect(random).not.toHaveBeenCalled();
    await tick(NOW);
    expect(random).toHaveBeenCalledOnce();
    const threshold = entries()[0].threshold;
    for (let index = 0; index < 5; index++) { lifecycle.getWorldView(); lifecycle.getWorldSnapshot(); }
    expect(random).toHaveBeenCalledOnce(); expect(entries()[0].threshold).toBe(threshold);
  });

  it("rejects a selected source that is no longer personally known before generation", async () => {
    random.mockReturnValue(0.99); addKnownStory(); setup();
    await tick(NOW);
    vi.setSystemTime(NOW + minute);
    const snapshot = mocks.deps.getRuntimeSnapshot();
    const selected = await mocks.deps.getAdditionalCandidates!({ now: Date.now(), timezone: "Asia/Shanghai", localDate: "2026-11-17",
      localHour: 10, localMinute: 1, snapshot, state: mocks.loadState(), weather: null, previousIdleSec: null,
      activeSessionStartedAt: null, conversationLastActivity: null });
    expect(selected).toHaveLength(1);
    mocks.world.personal!.changes = [];
    await lifecycle.getProactiveChatService()!.evaluateCandidate(selected[0]);
    expect(mocks.runModel).not.toHaveBeenCalled();
    expect(entries()[0].status).toBe("dropped");
  });

  it("revalidates a shared-interest association if her activity changes before generation", async () => {
    mocks.world.personal!.currentActivity!.title = "读书时整理页边笔记";
    setup();
    const opportunity = relatedConversationOpportunity(mocks.world, { content: "我最近在读书", at: NOW }, NOW)!;
    const store = new InitiativeOpportunityStore(path.join(mocks.root, "initiative-opportunities.json"), () => 0.99);
    store.select({ now: NOW, opportunities: [opportunity], eligible: true });
    const selected = store.select({ now: NOW + minute, opportunities: [opportunity], eligible: true })!;
    vi.setSystemTime(NOW + minute);
    mocks.world.personal!.currentActivity = { ...mocks.world.personal!.currentActivity!, eventId: "meal:now", title: "坐下来吃午饭", activity: "meal" };
    await lifecycle.getProactiveChatService()!.evaluateCandidate({ sceneId: selected.sceneId!, score: selected.score!, sceneCooldownMs: 0,
      opportunityId: selected.key, sourceEventId: selected.sourceEventId, evidenceVersion: String(selected.evidenceVersion),
      replyBurden: selected.replyBurden, momentSummary: selected.summary });
    expect(mocks.runModel).not.toHaveBeenCalled(); expect(entries()[0].status).toBe("dropped");
  });

  it.each(["disabled", "paused"] as const)("does not accumulate eligible time while %s", async reason => {
    addKnownStory(); const settings = setup(); await tick(NOW); await tick(NOW + minute);
    const accumulated = entries()[0].accumulated;
    if (reason === "disabled") settings.proactiveChatMode = "off"; else mocks.paused = true;
    await tick(NOW + 2 * minute);
    expect(entries()[0].wasEligible).toBe(false);
    if (reason === "disabled") settings.proactiveChatMode = "on"; else mocks.paused = false;
    await tick(NOW + 4 * minute);
    expect(entries()[0].accumulated).toBe(accumulated);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("does not accumulate disconnected route time or send to a missing recipient", async () => {
    addKnownStory(); mocks.route = { available: true, recipient: { conversationId: "bound", sessionId: "channel:wechat:fixture", targetId: "fixture", updatedAt: NOW } };
    setup({ proactiveDeliveryTarget: "wechat" }); await tick(NOW); await tick(NOW + minute);
    const accumulated = entries().find(entry => entry.conversationId === "bound")!.accumulated;
    mocks.route = { available: false, reason: "channel_offline" }; await tick(NOW + 2 * minute);
    mocks.route = { available: true, recipient: { conversationId: "bound", sessionId: "channel:wechat:fixture", targetId: "fixture", updatedAt: NOW } };
    await tick(NOW + 4 * minute);
    expect(entries().find(entry => entry.conversationId === "bound")!.accumulated).toBe(accumulated);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("suspends immediately when stopping or locking, even if no polling tick observes the interruption", async () => {
    addKnownStory(); setup(); await tick(NOW); await tick(NOW + minute);
    const accumulated = entries()[0].accumulated;
    vi.setSystemTime(NOW + 2 * minute); lifecycle.stopProactiveTrigger();
    vi.setSystemTime(NOW + 3 * minute); lifecycle.initializeProactiveTrigger();
    await tick(NOW + 4 * minute);
    expect(entries()[0].accumulated).toBe(accumulated);
    vi.setSystemTime(NOW + 4.5 * minute); mocks.power.emit("lock-screen");
    vi.setSystemTime(NOW + 5 * minute); mocks.power.emit("unlock-screen");
    await tick(NOW + 6 * minute);
    expect(entries()[0].accumulated).toBe(accumulated);
  });

  it("can naturally become bored during an unoccupied rest activity and quietly drop the same mood episode", async () => {
    mocks.world.personal!.energy = 80;
    mocks.world.personal!.currentActivity = { residentId: "cyrene", activity: "rest", title: "手头的事忙完，坐着放空一会儿",
      startsAt: NOW, endsAt: NOW + 4 * 3_600_000, source: "routine", eventId: "rest:long", locationId: "okhema" };
    random.mockReturnValue(0.99); mocks.runModel.mockResolvedValue({ kind: "drop" });
    setup();
    for (let elapsed = 0; elapsed <= 120; elapsed++) await tick(NOW + elapsed * minute);
    expect(mocks.runModel).toHaveBeenCalledOnce();
    const thought = entries().find(entry => entry.motive === "boredom");
    expect(thought).toMatchObject({ sourceEventId: "rest:long", status: "dropped" });
    for (let elapsed = 121; elapsed <= 150; elapsed++) await tick(NOW + elapsed * minute);
    expect(mocks.runModel).toHaveBeenCalledOnce();
    const life = JSON.parse(fs.readFileSync(path.join(mocks.root, "companion-life.json"), "utf8"));
    expect(life.state.lastInteractionAt).toBeNull(); // no user-absence clock is required
    expect(life.state.boredom).toBeGreaterThanOrEqual(35);
  });
});
