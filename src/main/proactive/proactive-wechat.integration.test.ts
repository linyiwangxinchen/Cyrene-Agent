import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({ directory: "", adapter: undefined as any }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.directory }, powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 172800 }) }));
vi.mock("../chats/chats-store", () => ({ listSessions: async () => [{ id: "unrelated" }] }));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: { getAdapter: () => fixture.adapter } }));
vi.mock("../channels/settings-store", () => ({ loadChannelsSettings: () => ({ wechat: { enabled: true } }) }));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: async () => "", buildMemoryInjection: async () => "" }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "你是昔涟，自然地关心用户。" }));
vi.mock("../settings-store", () => ({ loadUserProfile: () => ({ timezone: "Asia/Shanghai" }) }));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: () => ({ provider: "ChatGPT（OpenAI）", explicitTransport: "responses", apiKey: "fixture-model-key", baseUrl: "https://fixture-model.invalid/v1", model: "gpt-6.1-sol", reasoning: { mode: "on", effort: "high" } }) }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { Wechat: "wechat" } }));
vi.mock("../token-usage-store", () => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));

import { ILinkBotAdapter } from "../channels/adapters/wechat/ilink-bot-adapter";
import { WechatReplyContextStore } from "../channels/adapters/wechat/reply-context-store";
import { getChannelConversationBindingStore } from "../channels/conversation-binding-store";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { createProactiveLifecycle } from "./proactive-lifecycle";
import type { GeneralSettings } from "../settings/general-settings";

afterEach(async () => {
  await fixture.adapter?.stop();
  await closeConversationDatabases();
  vi.unstubAllGlobals(); vi.useRealTimers();
  if (fixture.directory) fs.rmSync(fixture.directory, { recursive: true, force: true });
});

describe("assembled proactive WeChat delivery", () => {
  it("restores credentials/context, generates from the bound SQLite chat, sends iLink and journals the accepted text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 9, 14, 6)); // user 14:00
    fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-proactive-wechat-"));
    const credentials = { ilinkBotId: "fixture-bot", botToken: "fixture-bot-token", baseUrl: "https://ilinkai.weixin.qq.com", ilinkUserId: "owner" };
    fs.mkdirSync(path.join(fixture.directory, "weixin"));
    fs.writeFileSync(path.join(fixture.directory, "weixin", "credentials.json"), JSON.stringify(credentials));
    new WechatReplyContextStore(path.join(fixture.directory, "weixin", "reply-context.json")).remember(credentials, "wx-owner", "restored-context");
    const bindings = getChannelConversationBindingStore();
    bindings.observe({ sessionId: "wx-session", channel: "wechat", chatId: "wx-owner", chatType: "private", lastAt: Date.now() - 3 * 60 * 60 * 1000 });
    bindings.bind("wx-session", "bound-local-chat");
    const journal = new ConversationJournalService(new ConversationTranscriptStore(fixture.directory));
    await journal.appendUser("bound-local-chat", { turnId: "question", text: "我今天准备考试，有一点紧张", at: Date.now() - 3 * 60 * 60 * 1000 });
    const sent: any[] = []; const modelRequests: any[] = []; let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/getupdates")) {
        if (polls++ === 0) return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" }));
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      }
      if (String(url).endsWith("/sendmessage")) { sent.push(JSON.parse(String(init.body))); return new Response('{"ret":0}'); }
      if (String(url).includes("fixture-model.invalid")) {
        modelRequests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "fixture-response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"decision":"send","text":"考试准备得怎么样啦？紧张的话，我们可以一起理一理♪"}' }] }], usage: { input_tokens: 100, output_tokens: 30 } }));
      }
      throw new Error("Unexpected network destination");
    }));
    fixture.adapter = new ILinkBotAdapter(); await fixture.adapter.start();
    await vi.waitFor(() => expect(fixture.adapter.getStatus().phase).toBe("running"));
    const settings = { proactiveChatMode: "on", proactiveDeliveryTarget: "wechat", proactiveTargetScore: 60, mobileMessageSegmentation: "off" } as GeneralSettings;
    const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings, conversationJournal: journal });
    lifecycle.initializeProactiveChatService();
    expect(lifecycle.getProactiveStatus().delivery?.ready).toBe(true);
    const candidate = { sceneId: "conversation_followup", score: 80, sceneCooldownMs: 24 * 60 * 60 * 1000 };
    await lifecycle.getProactiveChatService()!.evaluateCandidate(candidate);
    expect(modelRequests).toHaveLength(1);
    expect(JSON.stringify(modelRequests[0])).toContain("我今天准备考试");
    expect(modelRequests[0].max_output_tokens).toBe(4096);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toMatchObject({ to_user_id: "wx-owner", context_token: "restored-context" });
    const projection = await journal.readProjection("bound-local-chat");
    expect(projection.messages.map(message => message.content)).toEqual(["我今天准备考试，有一点紧张", "考试准备得怎么样啦？紧张的话，我们可以一起理一理♪"]);
    expect((await journal.readProjection("unrelated")).messages).toHaveLength(0);
    expect(lifecycle.getProactiveStatus()).toMatchObject({ unansweredCount: 1, lastOutcome: { state: "sent" } });
    await lifecycle.getProactiveChatService()!.evaluateCandidate(candidate);
    expect(sent).toHaveLength(1); expect(modelRequests).toHaveLength(1);
    lifecycle.proactiveConversationLifecycle.onUserMessage();
    expect(lifecycle.getProactiveStatus().unansweredCount).toBe(0);
  });
});
