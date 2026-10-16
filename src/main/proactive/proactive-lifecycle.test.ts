import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../settings/general-settings";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { createDefaultProactiveState } from "./proactive-policy";

const mocks = vi.hoisted(() => ({
  runModel: vi.fn(), broadcast: vi.fn(), loadState: vi.fn(), saveState: vi.fn(),
  powerMonitor: null as unknown as EventEmitter & { getSystemIdleTime: () => number },
  route: { available: false, reason: "channel_offline" } as any,
  sendChannel: vi.fn(), readProjection: vi.fn(), listSessions: vi.fn(),
  modelSettings: { apiKey: "fixture", provider: "fixture", baseUrl: "https://example.test/v1", model: "fixture" } as any,
}));
vi.mock("electron", () => ({ get powerMonitor() { return mocks.powerMonitor; } }));
vi.mock("../chats/chats-store", () => ({
  listSessions: mocks.listSessions, getOrCreateSessionByPurpose: async () => ({ id: "proactive-session" }),
}));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: mocks.broadcast }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({ getProactiveChannelAvailability: () => mocks.route, sendProactiveChannelMessage: mocks.sendChannel }));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: async () => "", buildMemoryInjection: async () => "" }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "昔涟的人格设定" }));
vi.mock("../settings/model-settings", () => ({
  loadModelSettings: () => mocks.modelSettings,
  resolveModelSettingsProfile: (settings: any) => {
    const profile = settings.modelProfiles?.find((item: any) => item.id === settings.defaultModelProfileId) ?? settings.modelProfiles?.[0];
    return profile ? { ...settings, ...profile } : settings;
  },
}));
vi.mock("../settings-store", () => ({ loadUserProfile: () => ({ timezone: "Asia/Shanghai" }) }));
vi.mock("./proactive-state-store", () => ({ loadProactiveState: mocks.loadState, saveProactiveState: mocks.saveState }));
vi.mock("./proactive-model", () => ({ runProactiveModel: mocks.runModel }));
import { createProactiveLifecycle } from "./proactive-lifecycle";

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  mocks.powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 120 });
  let state = createDefaultProactiveState();
  mocks.loadState.mockImplementation(() => structuredClone(state));
  mocks.saveState.mockImplementation(next => { state = structuredClone(next); });
  mocks.runModel.mockResolvedValue({ kind: "send", text: "早上好呀♪" });
  mocks.route = { available: false, reason: "channel_offline" };
  mocks.listSessions.mockResolvedValue([]);
  mocks.readProjection.mockResolvedValue({ messages: [] });
  mocks.modelSettings = { apiKey: "fixture", provider: "fixture", baseUrl: "https://example.test/v1", model: "fixture" };
});
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const settings = { proactiveChatMode: "on", proactiveDeliveryTarget: "local" } as GeneralSettings;
  const appendAssistant = vi.fn(async () => "assistant-entry");
  const appendPresentationNext = vi.fn(async () => undefined);
  const appendDeliveryReceipt = vi.fn(async () => undefined);
  const journal = { createRunSink: () => ({ appendAssistant }), appendPresentationNext, appendDeliveryReceipt, readProjection: mocks.readProjection } as unknown as ConversationJournalService;
  const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings, conversationJournal: journal });
  lifecycle.initializeProactiveChatService();
  const candidate = { sceneId: "morning_greeting", score: 90, sceneCooldownMs: 0 };
  return { settings, lifecycle, appendAssistant, appendPresentationNext, appendDeliveryReceipt, candidate };
}

describe("proactive lifecycle on a headless host", () => {
  it("commits and notifies Web during user daytime even when UTC server time is night", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 9, 1)); // Shanghai 09:00, UTC 01:00
    const ctx = setup();
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(mocks.runModel).toHaveBeenCalledOnce();
    expect(ctx.appendAssistant).toHaveBeenCalledWith(expect.objectContaining({ message: { role: "assistant", content: "早上好呀♪" } }));
    expect(ctx.appendPresentationNext).toHaveBeenCalledOnce();
    expect(mocks.broadcast).toHaveBeenCalledOnce();
    expect(mocks.loadState().unansweredCount).toBe(1);
  });

  it("does not generate during user night or after the saved switch is disabled", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 9, 15)); // Shanghai 23:00, UTC 15:00
    const ctx = setup();
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(mocks.runModel).not.toHaveBeenCalled();
    vi.setSystemTime(Date.UTC(2026, 9, 10, 1));
    ctx.settings.proactiveChatMode = "off";
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(ctx.appendAssistant).not.toHaveBeenCalled();
    expect(mocks.runModel).not.toHaveBeenCalled();
  });

  it("uses the configured default model profile when the compatibility mirror is empty", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 14, 6)); // Shanghai 14:00
    mocks.modelSettings = {
      apiKey: "",
      provider: "旧顶层空壳",
      baseUrl: "",
      model: "",
      defaultModelProfileId: "saved-profile",
      modelProfiles: [{ id: "saved-profile", provider: "ChatGPT（OpenAI）", baseUrl: "https://relay.example/v1", model: "gpt-6.1-sol", apiKey: "profile-key", explicitTransport: "responses" }],
    };
    const ctx = setup();
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(mocks.runModel).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ provider: "ChatGPT（OpenAI）", baseUrl: "https://relay.example/v1", model: "gpt-6.1-sol", apiKey: "profile-key", explicitTransport: "responses" }),
    }));
  });

  it("uses the bound WeChat conversation and journals actual proactive delivery there", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 14, 6)); // Shanghai 14:00
    const ctx = setup(); ctx.settings.proactiveDeliveryTarget = "wechat";
    const recipient = { targetId: "wx-user", sessionId: "channel:wechat:one", conversationId: "bound-chat", updatedAt: Date.now() };
    mocks.route = { available: true, recipient };
    mocks.listSessions.mockResolvedValue([{ id: "unrelated-chat" }, { id: "local-proactive", purpose: "proactive-chat" }]);
    mocks.readProjection.mockImplementation(async id => ({ messages: [{ role: "user", content: id === "bound-chat" ? "我今天在准备考试" : "无关任务", at: Date.now() - 3 * 60 * 60 * 1000 }] }));
    mocks.sendChannel.mockImplementation(async input => {
      expect(input.canContinue()).toBe(true);
      await input.recordDelivery(input.recipient, input.text);
      return { kind: "committed", deliveredParts: 1, totalParts: 1 };
    });
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(mocks.readProjection).toHaveBeenCalledWith("bound-chat");
    expect(mocks.readProjection).not.toHaveBeenCalledWith("unrelated-chat");
    const system = mocks.runModel.mock.calls[0][0].messages[0].content;
    expect(system).toContain("我今天在准备考试"); expect(system).not.toContain("无关任务");
    expect(ctx.appendDeliveryReceipt).toHaveBeenCalledWith("bound-chat", expect.objectContaining({ channel: "wechat", status: "delivered" }));
    expect(ctx.lifecycle.getProactiveStatus()).toMatchObject({ unansweredCount: 1, delivery: { target: "wechat", ready: true }, lastOutcome: { state: "sent" } });
  });

  it("cancels if a binding changes while the model is generating", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 14, 6));
    const ctx = setup(); ctx.settings.proactiveDeliveryTarget = "wechat";
    mocks.route = { available: true, recipient: { targetId: "wx-user", sessionId: "wx", conversationId: "original", updatedAt: Date.now() } };
    mocks.runModel.mockImplementation(async () => {
      mocks.route.recipient.conversationId = "changed";
      return { kind: "send", text: "跟进考试" };
    });
    mocks.sendChannel.mockImplementation(async input => input.canContinue() ? { kind: "committed" } : { kind: "cancelled", reason: "binding_changed" });
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(ctx.appendAssistant).not.toHaveBeenCalled();
    expect(mocks.loadState().unansweredCount).toBe(0);
  });

  it("reports protocol readiness, model failure reasons and user-reply reset", async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 14, 6));
    const ctx = setup(); ctx.settings.proactiveDeliveryTarget = "wechat";
    mocks.route = { available: false, reason: "wechat_context_missing" };
    expect(ctx.lifecycle.getProactiveStatus().delivery).toMatchObject({ ready: false, reason: "wechat_context_missing" });
    ctx.settings.proactiveDeliveryTarget = "local";
    mocks.runModel.mockResolvedValue({ kind: "error", reason: "http_401" });
    await ctx.lifecycle.getProactiveChatService()!.evaluateCandidate(ctx.candidate);
    expect(ctx.lifecycle.getProactiveStatus().lastOutcome).toMatchObject({ state: "failed", reason: "http_401" });
    const state = mocks.loadState(); state.unansweredCount = 2; mocks.saveState(state);
    ctx.lifecycle.proactiveConversationLifecycle.onUserMessage();
    expect(ctx.lifecycle.getProactiveStatus().unansweredCount).toBe(0);
  });
});
