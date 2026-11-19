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
import { createDefaultProactiveState } from "./proactive-policy";
import { amphoreusView, createAmphoreusState } from "../amphoreus-world/engine";

const mocks = vi.hoisted(() => ({
  root: "", loadState: vi.fn(), saveState: vi.fn(), runModel: vi.fn(),
  power: null as unknown as EventEmitter,
  paused: false, world: null as unknown as AmphoreusView,
  deps: null as unknown as ProactiveTriggerDependencies,
  controller: null as unknown as ProactiveTriggerController,
  route: { available: false, reason: "channel_offline" } as any,
  history: [] as Array<{ role: "user" | "model"; at: number; content: string; channelSource?: { chatType: "group" } }>,
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

const NOW = Date.UTC(2026, 10, 17, 2);
const minute = 60_000;
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
  lifecycle?.stopProactiveTrigger(); vi.clearAllTimers(); vi.useRealTimers(); random.mockRestore();
  fs.rmSync(mocks.root, { recursive: true, force: true });
});
function setup(patch: Partial<GeneralSettings> = {}) {
  const settings = { proactiveChatMode: "on", proactiveDeliveryTarget: "local", proactiveDailyLimit: 20,
    proactiveDensity: "active", proactiveTargetScore: 60, ...patch } as GeneralSettings;
  lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings,
    conversationJournal: { readProjection: async (id: string) => ({ messages: id === "bound" ? mocks.history : [] }) } as unknown as ConversationJournalService });
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

describe("world initiative in the shared lifecycle", () => {
  const boundChannel = () => ({ available: true, recipient: { conversationId: "bound", sessionId: "channel:wechat:fixture", targetId: "fixture", updatedAt: NOW } });

  it("takes care from the private conversation and chooses it before equally ready world news", async () => {
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: NOW, content: "我今天有点累" }];
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
    const report = { role: "user" as const, at: NOW, content: "我今天有点累" };
    mocks.history = [{ ...report, channelSource: { chatType: "group" } }];
    random.mockReturnValue(0.99);
    setup({ proactiveDeliveryTarget: "wechat" });
    await tick(NOW);
    expect(entries()).toEqual([]);
    mocks.history = [report];
    await tick(NOW + minute);
    expect(entries().find(entry => entry.source === "user_care")).toMatchObject({ status: "pending" });
    mocks.history.push({ role: "user", at: NOW + 19 * minute, content: "现在好多了" });
    lifecycle.proactiveConversationLifecycle.onUserMessage();
    await tick(NOW + 20 * minute);
    await tick(NOW + 21 * minute);
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("considers a low-pressure check-in once the private chat has been quiet for thirty minutes", async () => {
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: NOW - 30 * minute, content: "我刚冲了杯咖啡" }];
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

  it("keeps the previous evening's opportunity across midnight without requiring recent night activity", async () => {
    const beforeMidnight = Date.UTC(2026, 10, 17, 15, 59); // 用户当地 11 月 17 日 23:59
    vi.setSystemTime(beforeMidnight);
    mocks.route = boundChannel();
    mocks.history = [{ role: "user", at: beforeMidnight - 30 * minute, content: "刚把桌子收拾好" }];
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
    mocks.history = [{ role: "user", at: beforeMidnight - 30 * minute, content: "刚把桌子收拾好" }];
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
    mocks.history = [{ role: "user", at: beforeClosing - 30 * minute, content: "刚把桌子收拾好" }];
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
      ...(scenario === "group" ? { channelSource: { chatType: "group" } } : {}) }];
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
