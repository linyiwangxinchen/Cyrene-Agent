import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root, getAppPath: () => process.cwd(), isReady: () => true }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock("./settings-store", () => ({ loadChannelsSettings: () => ({ wechat: { enabled: true } }) }));
import { ILinkBotAdapter } from "./adapters/wechat/ilink-bot-adapter";
import { ChannelDispatcher } from "./dispatcher";
import { createChannelContext } from "./channel-context";
import { createKeyedQueue } from "./keyed-queue";
import { createChannelRateLimiter } from "./rate-limiter";
import { createChannelDeliveryService } from "./delivery-service";
import { createOutgoingComposer } from "./outgoing-composer";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { ConversationTranscriptCompactor } from "../orchestrator/conversation-transcript-compactor";
import { closeConversationDatabases } from "../storage/conversation-database-client";

let adapter: ILinkBotAdapter | undefined;
afterEach(async () => {
  await adapter?.stop(); adapter = undefined;
  await closeConversationDatabases(); vi.unstubAllGlobals();
  if (fixture.root) fs.rmSync(fixture.root, { recursive: true, force: true });
});

it("微信绑定会话压缩并重启后能连续续接，旧消息重投不会触发模型或重复发送", async () => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wechat-compact-"));
  fs.mkdirSync(path.join(fixture.root, "weixin"));
  fs.writeFileSync(path.join(fixture.root, "weixin/credentials.json"), JSON.stringify({ ilinkBotId: "test-bot", botToken: "fixture-only", baseUrl: "https://ilinkai.weixin.qq.com", ilinkUserId: "owner" }));
  const sent: any[] = [];
  let feedPoll: ((messages: unknown[]) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (String(url).endsWith("/sendmessage")) {
      sent.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response('{"ret":0}'));
    }
    if (String(url).endsWith("/getupdates")) return new Promise<Response>((resolve, reject) => {
      const feed = (msgs: unknown[]) => {
        if (feedPoll === feed) feedPoll = undefined;
        resolve(new Response(JSON.stringify({ ret: 0, msgs, get_updates_buf: String(Date.now()) })));
      };
      feedPoll = feed;
      init.signal?.addEventListener("abort", () => { if (feedPoll === feed) feedPoll = undefined; reject(init.signal!.reason); }, { once: true });
    });
    throw new Error("Unexpected network destination in fixture");
  }));
  let store = new ConversationTranscriptStore(fixture.root);
  let journal = new ConversationJournalService(store);
  const processed: string[] = [];
  let failedAttempts = 0;
  const pending: Promise<unknown>[] = [];
  const start = async () => {
    adapter = new ILinkBotAdapter();
    const dispatcher = new ChannelDispatcher({
      queue: createKeyedQueue(), limiter: createChannelRateLimiter({ limits: { perUser: 100, perChannel: 100 } }),
      context: createChannelContext({ resolveBoundConversationId: () => "bound-chat", migrateHistory: () => {} }),
      journal, composer: createOutgoingComposer({ resolveStickerImagePath: () => null }),
      delivery: createChannelDeliveryService({ getAdapter: () => adapter } as any),
      loadSettings: () => ({ ttsEnabled: false, stickerEnabled: false, mirrorToDesktop: false, rateLimitPerUser: 100, rateLimitPerChannel: 100 }) as any,
      loadGeneralSettings: () => ({ mobileMessageSegmentation: "off" }),
      buildAndRunAgent: async (msg, input) => {
        if (msg.messageId === "unanswered") { failedAttempts++; throw new Error("fixture previous model failure"); }
        expect(input.modelContext.messages.at(-1)?.content).toBe(msg.text);
        if (processed.length > 0) expect(JSON.stringify(input.modelContext.messages)).toContain("TASK_ROOT");
        processed.push(msg.text);
        const text = `已按原任务处理：${msg.text}`;
        await input.transcriptSink.appendAssistant({ message: { role: "assistant", content: text } });
        return { text, sticker: null };
      },
    });
    adapter.onMessage = msg => { const task = dispatcher.handleIncoming(msg); pending.push(task); return task; };
    await adapter.start();
  };
  const receive = async (id: string, text: string) => {
    await vi.waitFor(() => expect(feedPoll).toBeTypeOf("function"));
    feedPoll!([{ message_id: id, from_user_id: "owner", to_user_id: "test-bot", message_type: 1, context_token: `context-${id}`,
      item_list: [{ type: 1, text_item: { text } }] }]);
  };
  await start();
  await receive("unanswered", "这条旧消息当时生成失败");
  await vi.waitFor(() => expect(failedAttempts).toBe(1));
  await pending.at(-1);
  const original = "TASK_ROOT：继续写报告，保留实验结果和原来的约束。".repeat(12);
  await receive("one", original);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  await Promise.all(pending);
  await new ConversationTranscriptCompactor({ store, summarize: async () => "TASK_ROOT：继续报告，保留实验结果与用户约束" }).compact({ conversationId: "bound-chat", trigger: "manual", retainTokens: 1 });
  await adapter!.stop();
  await closeConversationDatabases();
  store = new ConversationTranscriptStore(fixture.root); journal = new ConversationJournalService(store);
  await start();
  const beforeStale = pending.length;
  await receive("unanswered", "这条旧消息当时生成失败");
  await vi.waitFor(() => expect(pending.length).toBe(beforeStale + 1));
  await pending.at(-1);
  expect(failedAttempts).toBe(1);
  const previousPending = pending.length;
  await receive("one", original); // Same platform message, new receive time, archived user entry.
  await vi.waitFor(() => expect(pending.length).toBe(previousPending + 1));
  await pending.at(-1);
  expect(processed).toHaveLength(1);
  expect(sent).toHaveLength(1);
  for (const [id, text] of [["two", "继续第二步"], ["three", "按原来的要求给出结论"]]) {
    await receive(id!, text!);
    await vi.waitFor(() => expect(processed).toContain(text));
    await pending.at(-1);
    expect(sent.at(-1).msg).toMatchObject({ to_user_id: "owner", context_token: `context-${id}` });
  }
  expect(sent).toHaveLength(3);
  expect((await journal.buildModelContext("bound-chat")).messages.at(-1)?.content).toContain("按原来的要求给出结论");
});
