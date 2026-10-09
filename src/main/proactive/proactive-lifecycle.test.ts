import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../settings/general-settings";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { createDefaultProactiveState } from "./proactive-policy";

const mocks = vi.hoisted(() => ({
  runModel: vi.fn(), broadcast: vi.fn(), loadState: vi.fn(), saveState: vi.fn(),
  powerMonitor: null as unknown as EventEmitter & { getSystemIdleTime: () => number },
}));
vi.mock("electron", () => ({ get powerMonitor() { return mocks.powerMonitor; } }));
vi.mock("../chats/chats-store", () => ({
  listSessions: async () => [], getOrCreateSessionByPurpose: async () => ({ id: "proactive-session" }),
}));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: mocks.broadcast }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: {} }));
vi.mock("../channels/proactive-delivery", () => ({ canStartProactiveChannelDelivery: () => false, sendProactiveChannelMessage: vi.fn() }));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: async () => "", buildMemoryInjection: async () => "" }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "昔涟的人格设定" }));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: () => ({ apiKey: "fixture", model: "fixture" }) }));
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
});
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const settings = { proactiveChatMode: "on", proactiveDeliveryTarget: "local" } as GeneralSettings;
  const appendAssistant = vi.fn(async () => "assistant-entry");
  const appendPresentationNext = vi.fn(async () => undefined);
  const journal = { createRunSink: () => ({ appendAssistant }), appendPresentationNext } as unknown as ConversationJournalService;
  const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings, conversationJournal: journal });
  lifecycle.initializeProactiveChatService();
  const candidate = { sceneId: "morning_greeting", score: 90, sceneCooldownMs: 0 };
  return { settings, lifecycle, appendAssistant, appendPresentationNext, candidate };
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
});
