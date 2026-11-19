import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({
  directory: "",
  timezone: "Asia/Shanghai",
  adapter: undefined as ILinkBotAdapter | undefined,
  bindings: undefined as ChannelConversationBindingStore | undefined,
}));
vi.mock("electron", () => ({ app: { getPath: () => fixture.directory }, powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 172800 }) }));
vi.mock("../chats/chats-store", () => ({ listSessions: async () => [{ id: "unrelated" }] }));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("../channels/init", () => ({ setChannelsConversationLifecycle: vi.fn() }));
vi.mock("../channels/manager", () => ({ channelManager: { getAdapter: () => fixture.adapter } }));
vi.mock("../channels/settings-store", () => ({ loadChannelsSettings: () => ({ wechat: { enabled: true } }) }));
vi.mock("../channels/conversation-binding-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../channels/conversation-binding-store")>(),
  getChannelConversationBindingStore: () => fixture.bindings!,
}));
vi.mock("../orchestrator", () => ({ buildAlwaysOnContext: async () => "", buildMemoryInjection: async () => "" }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: (name: string) => name === "canon_quotes.md" ? "CANON_QUOTE_FIXTURE" : "你是昔涟，自然地关心用户。" }));
vi.mock("../settings-store", () => ({ loadUserProfile: () => ({ timezone: fixture.timezone }) }));
vi.mock("../settings/model-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings/model-settings")>(),
  loadModelSettings: () => ({
    // Web 迁移后顶层镜像可能为空；真实 resolver 必须恢复已保存的默认档案。
    provider: "旧顶层空壳", baseUrl: "", model: "", apiKey: "",
    defaultModelProfileId: "saved-default",
    modelProfiles: [
      { id: "other-profile", provider: "ChatGPT（OpenAI）", baseUrl: "https://wrong-profile.invalid/v1", model: "wrong-model", apiKey: "wrong-key" },
      { id: "saved-default", provider: "ChatGPT（OpenAI）", explicitTransport: "responses", apiKey: "fixture-model-key", baseUrl: "https://fixture-model.invalid/v1", model: "gpt-6.1-sol", reasoning: { mode: "on", effort: "high" } },
    ],
  }),
}));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, LogTag: { Wechat: "wechat" } }));
vi.mock("../token-usage-store", () => ({ recordRequest: vi.fn(), recordUsage: vi.fn() }));

import { ILinkBotAdapter } from "../channels/adapters/wechat/ilink-bot-adapter";
import { WechatReplyContextStore } from "../channels/adapters/wechat/reply-context-store";
import { ChannelConversationBindingStore } from "../channels/conversation-binding-store";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { createProactiveLifecycle } from "./proactive-lifecycle";
import { loadProactiveState } from "./proactive-state-store";
import type { GeneralSettings } from "../settings/general-settings";

afterEach(async () => {
  await fixture.adapter?.stop();
  await closeConversationDatabases();
  vi.unstubAllGlobals(); vi.useRealTimers();
  if (fixture.directory) fs.rmSync(fixture.directory, { recursive: true, force: true });
  fixture.directory = "";
  fixture.timezone = "Asia/Shanghai";
  fixture.adapter = undefined;
  fixture.bindings = undefined;
});

function createBoundWechatJournal(lastAt: number): ConversationJournalService {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-proactive-wechat-"));
  const credentials = { ilinkBotId: "fixture-bot", botToken: "fixture-bot-token", baseUrl: "https://ilinkai.weixin.qq.com", ilinkUserId: "owner" };
  fs.mkdirSync(path.join(fixture.directory, "weixin"));
  fs.writeFileSync(path.join(fixture.directory, "weixin", "credentials.json"), JSON.stringify(credentials));
  new WechatReplyContextStore(path.join(fixture.directory, "weixin", "reply-context.json")).remember(credentials, "wx-owner", "restored-context");
  fixture.bindings = new ChannelConversationBindingStore(path.join(fixture.directory, "channels", "context-bindings.json"));
  fixture.bindings.observe({ sessionId: "wx-session", channel: "wechat", chatId: "wx-owner", chatType: "private", lastAt });
  fixture.bindings.bind("wx-session", "bound-local-chat");
  return new ConversationJournalService(new ConversationTranscriptStore(fixture.directory));
}

async function startWechat(journal: ConversationJournalService, reply: (requestIndex: number) => string) {
  const sent: Array<{ msg: unknown }> = [];
  const modelRequests: Array<Record<string, unknown>> = [];
  let polls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/getupdates")) {
      if (polls++ === 0) return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" }));
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    }
    if (String(url).endsWith("/sendmessage")) {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{"ret":0}');
    }
    if (String(url).includes("fixture-model.invalid")) {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-model-key");
      const requestIndex = modelRequests.push(JSON.parse(String(init.body))) - 1;
      return new Response(JSON.stringify({
        id: "fixture-response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ decision: "send", text: reply(requestIndex) }) }] }],
        usage: { input_tokens: 100, output_tokens: 30 },
      }));
    }
    throw new Error("Unexpected network destination");
  }));
  fixture.adapter = new ILinkBotAdapter();
  await fixture.adapter.start();
  await vi.waitFor(() => expect(fixture.adapter?.getStatus().phase).toBe("running"));
  const settings = {
    proactiveChatMode: "on", proactiveDeliveryTarget: "wechat", proactiveTargetScore: 60,
    proactiveQuietStartMinute: 120, proactiveQuietEndMinute: 480, mobileMessageSegmentation: "off",
  } as GeneralSettings;
  const lifecycle = createProactiveLifecycle({ loadGeneralSettings: () => settings, conversationJournal: journal });
  lifecycle.initializeProactiveChatService();
  expect(lifecycle.getProactiveStatus().delivery?.ready).toBe(true);
  return { sent, modelRequests, lifecycle, service: lifecycle.getProactiveChatService()! };
}

describe("assembled proactive WeChat delivery", () => {
  it("uses the saved model and bound chat, drops a repeated world update, and sends new details through iLink", async () => {
    const now = Date.UTC(2026, 9, 14, 6); // user 14:00
    const priorAt = now - 3 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(priorAt);
    const journal = createBoundWechatJournal(priorAt);
    const userText = "我今天准备考试，有一点紧张";
    const priorText = "今天人家整理收到的故事时，有一小段还没想明白，就先留一点空白，等下次再接着试……♪";
    const repeatedText = "今天在村边散步时，我又把那条没想明白的问题写进手记了。先留一点空白，等下次有了新线索再继续写♪";
    const freshText = "刚刚翻旧书，掉出来一张晒干的银杏叶。夹在那一页太久，连叶脉都印在纸上了。";
    await journal.appendUser("bound-local-chat", { turnId: "question", text: userText, at: priorAt });
    async function appendDeliveredProactive(conversationId: string, runId: string, content: string) {
      const assistantTurnId = `${runId}:assistant`;
      const sink = journal.createRunSink({ conversationId, runId, assistantTurnId });
      const messageId = await sink.appendAssistant({ message: { role: "assistant", content }, roundId: "proactive" });
      await journal.appendPresentationNext(conversationId, messageId, `${runId}:presentation`, {
        content, channelSource: { channel: "wechat", chatType: "private" },
        runSnapshot: { runId, status: "terminal", updatedAt: priorAt },
      });
      await journal.appendDeliveryReceipt(conversationId, { assistantTurnId, channel: "wechat", runId, status: "delivered" });
    }
    await appendDeliveredProactive("bound-local-chat", "proactive-intent-90", priorText);
    await appendDeliveredProactive("unrelated", "proactive-intent-91", freshText);
    vi.setSystemTime(now);

    const { sent, modelRequests, lifecycle, service } = await startWechat(journal, index => index === 0 ? repeatedText : freshText);
    const worldCandidate = { score: 80, sceneCooldownMs: 0 };
    await service.evaluateCandidate({
      sceneId: "world:walk", ...worldCandidate, sourceEventId: "world-walk", evidenceVersion: "1", replyBurden: "none",
      momentSummary: "昔涟去村边散了步。",
    });

    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0].model).toBe("gpt-6.1-sol");
    expect(modelRequests[0].max_output_tokens).toBe(4096);
    const firstPrompt = JSON.stringify(modelRequests[0]);
    expect(firstPrompt).toContain(userText);
    expect(firstPrompt).toContain(priorText);
    expect(firstPrompt).not.toContain(freshText);
    expect(firstPrompt).not.toContain("昔涟虚拟生活快照");
    expect(firstPrompt).not.toContain("CANON_QUOTE_FIXTURE");
    expect(sent).toHaveLength(0);
    expect(loadProactiveState().pendingCommitIntent).toBeUndefined();
    expect((await journal.readProjection("bound-local-chat")).messages.map(message => message.content)).toEqual([userText, priorText]);
    expect(lifecycle.getProactiveStatus()).toMatchObject({ unansweredCount: 0, lastOutcome: { state: "silent" } });

    const candidate = {
      sceneId: "world:leaf", ...worldCandidate, sourceEventId: "world-leaf", evidenceVersion: "1", replyBurden: "none" as const,
      momentSummary: "昔涟从旧书里翻出一张干银杏叶，叶脉印在纸上了。",
      reason: "候选评估说明",
    };
    await service.evaluateCandidate(candidate);
    expect(modelRequests).toHaveLength(2);
    expect(JSON.stringify(modelRequests[1])).toContain(candidate.momentSummary);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toMatchObject({ to_user_id: "wx-owner", context_token: "restored-context", item_list: [{ text_item: { text: freshText } }] });
    const projection = await journal.readProjection("bound-local-chat");
    expect(projection.messages.map(message => message.content)).toEqual([userText, priorText, freshText]);
    expect((await journal.readProjection("unrelated")).messages.map(message => message.content)).toEqual([freshText]);
    expect(lifecycle.getProactiveStatus()).toMatchObject({ unansweredCount: 1, lastOutcome: { state: "sent" } });
    await service.evaluateCandidate(candidate);
    expect(sent).toHaveLength(1); expect(modelRequests).toHaveLength(2);
    lifecycle.proactiveConversationLifecycle.onUserMessage();
    expect(lifecycle.getProactiveStatus().unansweredCount).toBe(0);
  });

  it("grounds a care check-in in the user's local calendar and discards a draft across midnight", async () => {
    fixture.timezone = "Pacific/Kiritimati";
    const priorAt = Date.UTC(2026, 10, 19, 5, 30); // Nov 19, 19:30 at UTC+14
    const beforeMidnight = Date.UTC(2026, 10, 19, 9, 59, 59);
    const afterMidnight = beforeMidnight + 2_000; // Nov 20 locally; UTC is still Nov 19
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(priorAt);
    const journal = createBoundWechatJournal(priorAt);
    const userText = "我今天准备考试，有一点紧张";
    await journal.appendUser("bound-local-chat", { turnId: "exam", text: userText, at: priorAt });
    vi.setSystemTime(beforeMidnight);

    const freshText = "想到你说准备考试的时候有点紧张。现在感觉好一点了吗？";
    const { sent, modelRequests, lifecycle, service } = await startWechat(journal, index => {
      if (index !== 0) return freshText;
      vi.setSystemTime(afterMidnight);
      return "今天准备考试的时候，你说有点紧张。现在感觉好一点了吗？";
    });
    // Recent activity keeps the independent night-idle rule open on both sides of midnight.
    lifecycle.proactiveConversationLifecycle.onUserMessage();
    const candidate = {
      sceneId: "care:exam", score: 90, sceneCooldownMs: 0, sourceEventId: "exam",
      replyBurden: "question" as const, momentSummary: "用户提到准备考试时有点紧张，可以轻声关心近况。",
    };
    await service.evaluateCandidate(candidate);

    expect(modelRequests).toHaveLength(1);
    const firstPrompt = JSON.stringify(modelRequests[0]);
    expect(firstPrompt).toContain("用户当地时间：2026-11-19 23:59（星期四，Pacific/Kiritimati");
    expect(firstPrompt).toContain(`[2026-11-19 19:30] user: ${userText}`);
    expect(sent).toHaveLength(0);
    expect(loadProactiveState()).toMatchObject({ unansweredCount: 0, dailyMessageCount: 0 });
    expect(loadProactiveState().pendingCommitIntent).toBeUndefined();
    expect((await journal.readProjection("bound-local-chat")).messages.map(message => message.content)).toEqual([userText]);

    await service.evaluateCandidate(candidate);

    expect(modelRequests).toHaveLength(2);
    const freshPrompt = JSON.stringify(modelRequests[1]);
    expect(freshPrompt).toContain("用户当地时间：2026-11-20 00:00（星期五，Pacific/Kiritimati");
    expect(freshPrompt).toContain(`[2026-11-19 19:30] user: ${userText}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toMatchObject({ to_user_id: "wx-owner", item_list: [{ text_item: { text: freshText } }] });
    expect(loadProactiveState()).toMatchObject({ unansweredCount: 1, dailyMessageDate: "2026-11-20", dailyMessageCount: 1 });
    expect((await journal.readProjection("bound-local-chat")).messages.map(message => message.content)).toEqual([userText, freshText]);
  });
});
