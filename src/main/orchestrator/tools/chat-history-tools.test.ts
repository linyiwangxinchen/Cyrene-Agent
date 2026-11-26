import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getChannelConversationBindingStore } from "../../channels/conversation-binding-store";
import { createSession, deleteSession, renameSession, syncSessionStats } from "../../chats/chats-store";
import { loadConversationReference } from "../../chats/conversation-reference";
import { filterCurrentHistorySourcePointers } from "../../chats/history-source-references";
import { getMemoryModeVersion, setMemoryMode } from "../../memory/memory-mode";
import { memoryStore } from "../../memory/memory-store";
import { getConversationDatabase } from "../../storage/conversation-database-client";
import { withConversationDatabase } from "../../../test-utils/conversation-storage";
import { getConversationTranscriptStore } from "../conversation-transcript-store";
import { createChatHistoryTools } from "./chat-history-tools";
import type { ToolContext } from "./registry/tool-context";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("../../memory/obsidian-exporter", () => ({ notifyMemoryChanged: vi.fn() }));

const [search, read] = createChatHistoryTools();
let destination: string;

function context(overrides?: Partial<ToolContext>): ToolContext {
  return { userQuery: "还记得以前聊过的吗？", mode: "chat", conversationId: destination,
    memoryScope: "owner", memoryModeVersion: getMemoryModeVersion(), ...overrides };
}

beforeAll(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-chat-history-tools-"));
  const directory = path.join(fixture.root, "cyrene-chats", "sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "never-opened.json"), JSON.stringify({
    id: "never-opened", schemaVersion: 1, title: "未打开的归档记录", mode: "chat", identityId: null, createdAt: 1, updatedAt: 2,
    messages: [{ id: "legacy-closed-u", role: "user", at: 1, content: "禾木冬季旅行安排" },
      { id: "legacy-closed-a", role: "model", at: 2, content: "滑雪安排先预约" }],
  }));
  destination = (await createSession({ mode: "chat" })).id;
});

afterAll(async () => {
  setMemoryMode("vector");
  await getConversationDatabase(fixture.root).close();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

async function createHistory(title: string, mode: "chat" | "work" = "chat") {
  return createSession({ title, mode });
}

async function addTurn(id: string, key: string, question: string, reply: string, at = 1) {
  const transcript = getConversationTranscriptStore(fixture.root);
  const user = await transcript.append(id, { id: `user:v1:${key}:r1`, kind: "user", turnId: key, revision: 1, at,
    payload: { text: question } });
  await transcript.append(id, { id: `assistant-${key}`, kind: "assistant", turnId: `answer-${key}`, at: at + 1,
    payload: { role: "assistant", content: reply } });
  await syncSessionStats(id, 2);
  return user;
}

it("finds never-opened schema-one sessions and avoids creating a record from a fabricated conversation ID", async () => {
  const imported = () => withConversationDatabase(fixture.root, db =>
    db.prepare("SELECT transcript_imported FROM conversations WHERE id = 'never-opened'").get()?.transcript_imported);
  expect(imported()).toBe(0);
  expect(JSON.parse(await search.execute({ query: "禾木冬季" }, context())).items[0]).toMatchObject({ conversationId: "never-opened" });
  expect(imported()).toBe(1);
  expect(await read.execute({ conversationId: "never-opened" }, context())).toContain("滑雪安排先预约");
  expect(JSON.parse(await read.execute({ conversationId: "fabricated-by-model" }, context()))).toHaveProperty("error");
  expect(withConversationDatabase(fixture.root, db =>
    db.prepare("SELECT id FROM conversations WHERE id = 'fabricated-by-model'").get())).toBeUndefined();
});

it("finds old SQLite chat by title and body in all enabled modes, and pages through visible text", async () => {
  const source = await createSession({ mode: "chat", title: "很早的露营回顾", initialMessages: [
    { id: "legacy-u", role: "user", at: 11, content: "legacy question about 星轨计划", modelContext: "private hidden context" },
    { id: "legacy-a", role: "model", at: 12, content: "legacy reply 约在松林", reasoning: "private hidden reasoning" },
  ] });
  await addTurn(source.id, "later", "第二次出发", "后来换了车");
  for (const mode of ["summary", "wiki", "vector"] as const) {
    setMemoryMode(mode);
    expect(JSON.parse(await search.execute({ query: "legacy question" }, context())).items[0]).toMatchObject({ conversationId: source.id });
    expect(JSON.parse(await search.execute({ query: "很早的露营" }, context())).items[0]).toMatchObject({ conversationId: source.id });
  }
  expect(JSON.parse(await search.execute({ query: "private hidden context" }, context())).items).toEqual([]);
  const newer = JSON.parse(await read.execute({ conversationId: source.id, limit: 2 }, context()));
  expect(newer).toMatchObject({ messages: [{ text: "第二次出发" }, { text: "后来换了车" }], nextBefore: 2 });
  const older = await read.execute({ conversationId: source.id, before: newer.nextBefore }, context());
  expect(JSON.parse(older)).toMatchObject({ messages: [{ role: "user", text: "legacy question about 星轨计划" },
    { role: "assistant", text: "legacy reply 约在松林" }], nextBefore: null });
  expect(older).not.toMatch(/private hidden/);
});

it("withholds revised, forgotten, unfinished and non-chat content from both tools", async () => {
  const source = await createHistory("退休的机密标题");
  const transcript = getConversationTranscriptStore(fixture.root);
  const forgotten = await addTurn(source.id, "forgotten", "退回之前的机密预算", "机密预算是 6100");
  await memoryStore.retractFact({ conversationId: source.id, messageId: forgotten.id }, "不同措辞的机密预算");
  await addTurn(source.id, "edit", "旧色票蓝紫", "旧色票同意");
  await transcript.append(source.id, { id: "rewind-history-tools", kind: "turn_rewind", turnId: "edit", revision: 2, at: 3,
    payload: { disposition: "replace_user", anchorUserTurnId: "edit", reason: "edit", replacementUser: { text: "新色票浅绿" } } });
  await transcript.append(source.id, { id: "tool-only-assistant", kind: "assistant", turnId: "new-answer", at: 4,
    payload: { role: "assistant", content: "工具中间输出不可见", visibility: "internal" } });
  await transcript.append(source.id, { id: "final-assistant", kind: "assistant", turnId: "new-answer", at: 5,
    payload: { role: "assistant", content: "采用浅绿色票" } });
  await getConversationDatabase(fixture.root).call("runs.create", { conversationId: source.id, runId: "unfinished-history-run" });
  await transcript.append(source.id, { id: "user:v1:unfinished:r1", kind: "user", turnId: "unfinished", revision: 1, at: 6, runId: "unfinished-history-run",
    payload: { text: "排队消息尚未回答" } });
  const work = await createHistory("私有项目隔离", "work");
  await addTurn(work.id, "work", "不要把工作区机密读出", "项目秘密");
  const captured = await read.execute({ conversationId: source.id }, context());
  expect(JSON.parse(captured)).toMatchObject({ title: "旧会话", messages: [{ text: "新色票浅绿" }, { text: "采用浅绿色票" }] });
  expect(captured).not.toMatch(/机密|旧色票|排队消息|中间输出/);
  expect(JSON.parse(await search.execute({ query: "机密" }, context())).items).toEqual([]);
  expect(JSON.parse(await read.execute({ conversationId: work.id }, context()))).toHaveProperty("error");
  await deleteSession(source.id);
  expect(JSON.parse(await read.execute({ conversationId: source.id }, context()))).toHaveProperty("error");
});

it("fails closed for peer scope, a blocked source, and in-flight memory changes", async () => {
  const source = await createHistory("外部绑定专用");
  await addTurn(source.id, "bound", "外部不得披露这个暗号", "外部暗号");
  const external = getChannelConversationBindingStore();
  external.observe({ sessionId: "external-channel", channel: "wechat", chatType: "group", chatId: "room", lastAt: 1 });
  external.bind("external-channel", source.id);
  expect(JSON.parse(await read.execute({ conversationId: source.id }, context()))).toHaveProperty("error");
  const { executeToolDefinition } = await import("./registry/tool-executor");
  await expect(executeToolDefinition(read, { conversationId: source.id }, context())).resolves.toMatchObject({
    status: "failed", errorCode: "history_unavailable", retryable: false,
  });
  expect(JSON.parse(await search.execute({ query: "外部不得披露" }, context())).items).toEqual([]);
  expect(JSON.parse(await search.execute({ query: "legacy" }, context({ memoryScope: "peer:abcdefgh" })))).toHaveProperty("error");
  expect(JSON.parse(await search.execute({ query: "legacy" }, context({ mode: "work" })))).toHaveProperty("error");
  expect(JSON.parse(await read.execute({ conversationId: destination }, context()))).toHaveProperty("error");
  setMemoryMode("vector");
  const pending = search.execute({ query: "legacy" }, context());
  setMemoryMode("summary");
  expect(JSON.parse(await pending)).toHaveProperty("error");
  setMemoryMode("off");
  expect(JSON.parse(await search.execute({ query: "legacy" }, context()))).toHaveProperty("error");
});

it("paginates by the actual serialized UTF-8 budget with repeated control characters", async () => {
  setMemoryMode("vector");
  const source = await createHistory("较长消息");
  const text = "🫖\u0001".repeat(600);
  for (let i = 0; i < 6; i++) await addTurn(source.id, `large-${i}`, `${i}-question ${text}`, `${i}-reply ${text}`);
  let before: number | undefined;
  const found: string[] = [];
  do {
    const wire = await read.execute({ conversationId: source.id, limit: 12, before }, context());
    const result = JSON.parse(wire);
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThan(10_000);
    expect(result.messages.length).toBeGreaterThan(0);
    found.unshift(...result.messages.map((message: { text: string }) => message.text.split(" ")[0]));
    before = result.nextBefore ?? undefined;
  } while (before !== undefined);
  expect(found).toEqual(Array.from({ length: 6 }, (_, i) => [`${i}-question`, `${i}-reply`]).flat());
});

it("lists recent chats without a query and can continue keyword search beyond the first body page", async () => {
  const old = await createHistory("较久的泛用标题");
  await addTurn(old.id, "deep-search", "正文有独角兽标记", "确认为深夜星图");
  for (let i = 0; i < 65; i++) {
    const recent = await createHistory(`较新的标题 ${i}`);
    await addTurn(recent.id, `recent-${i}`, "这里有别的安排", "我们再商量");
  }
  const recent = JSON.parse(await search.execute({ limit: 2 }, context()));
  expect(recent.items).toHaveLength(2);
  expect(recent.items.every((item: { title: string }) => item.title.startsWith("较新的标题"))).toBe(true);
  expect(recent.nextOffset).toBe(2);
  const running = context({ runId: "deep-history-search" });
  const first = JSON.parse(await search.execute({ query: "独角兽标记" }, running));
  expect(first.items).toEqual([]);
  expect(first).toMatchObject({ coverageStatus: "partial", nextCursor: expect.any(String) });
  const older = JSON.parse(await search.execute({ searchCursor: first.nextCursor }, running));
  expect(older.items[0]).toMatchObject({ conversationId: old.id, title: "较久的泛用标题" });
  expect(older.nextCursor).toBeNull();
  expect(older.coverageStatus).toBe("complete");
});

it("requires whole Latin matches, supports CJK short words, and filters verified conversation dates", async () => {
  const first = await createHistory("两个会话的第一个");
  const second = await createHistory("两个会话的第二个");
  await addTurn(first.id, "index-short-word", "Cat 在松林吃饭。", "它在棚子下面。", 1_741_478_400_000);
  await addTurn(second.id, "index-negative-word", "Concatenate logs in 松林。", "收集这些日志。", 1_741_564_800_000);
  const running = context({ runId: "history-short-terms", historyTimeZone: "Asia/Shanghai" });
  const ids = async (query: string, historyTimeZone = "Asia/Shanghai") => JSON.parse(await search.execute({ query }, { ...running, historyTimeZone })).items.map((item: { conversationId: string }) => item.conversationId);
  expect(await ids("cat")).toEqual([first.id]);
  expect(await ids("松林")).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(await ids("松")).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(await ids("2025-03-09 松林")).toEqual([first.id]);
  expect(await ids("2025-03-10 松林")).toEqual([second.id]);
  expect(await ids("2025-03-08 松林", "America/Los_Angeles")).toEqual([first.id]);
  expect(await ids("2025-03-09 松林", "America/Los_Angeles")).toEqual([second.id]);
  expect(await ids("松林 预算")).toEqual([]);
  expect(JSON.parse(await search.execute({ query: "2025-02-31 松林" }, running))).toHaveProperty("errorCode", "history_time_ambiguous");
});

it("does not expose path-dependent cursor state or repeat a source after live history changes", async () => {
  const first = await createHistory("游标来源示例");
  await addTurn(first.id, "cursor-one", "已撤回的前页", "不应影响后面的分页锚点。");
  await addTurn(first.id, "cursor-two", "游标独特对象", "稳定翻页第二轮。");
  await addTurn(first.id, "cursor-three", "最后一个问题", "稳定翻页第三轮。");
  const running = context({ runId: "cursor-fixed-run" });
  const result = JSON.parse(await search.execute({ query: "游标独特对象" }, running));
  const sourceRef = result.items[0].sourceRef;
  expect(sourceRef).toMatch(/^ctx_/u);
  const exact = JSON.parse(await read.execute({ sourceRef, limit: 1 }, running));
  expect(exact.messages).toMatchObject([{ text: "游标独特对象" }]);
  expect(JSON.parse(await read.execute({ sourceRef }, context({ runId: "cursor-foreign-run" })))).toHaveProperty("errorCode", "history_cursor_stale");
  const latest = JSON.parse(await read.execute({ conversationId: first.id, limit: 2 }, running));
  await memoryStore.retractFact({ conversationId: first.id, messageId: "user:v1:cursor-one:r1" }, "已撤回的前页");
  const previous = JSON.parse(await read.execute({ beforeCursor: latest.nextBeforeCursor, limit: 2 }, running));
  expect(previous).toMatchObject({ messages: [{ text: "游标独特对象" }, { text: "稳定翻页第二轮。" }], nextBeforeCursor: null });
  const transcript = getConversationTranscriptStore(fixture.root);
  await transcript.append(first.id, { id: "cursor-version-patch", kind: "presentation_patch", at: 3,
    payload: { messageId: "user:v1:cursor-two:r1", patchRevision: 1, patch: { content: "仍然是不同版本" } } });
  expect(JSON.parse(await read.execute({ sourceRef }, running))).toHaveProperty("errorCode", "history_cursor_stale");

  const recent = JSON.parse(await search.execute({ limit: 1 }, running));
  const inserted = await createHistory("分页中创建的会话");
  await addTurn(inserted.id, "stable-recent-insert", "新会话", "不得插入已创建的分页。");
  const pageTwo = JSON.parse(await search.execute({ searchCursor: recent.nextCursor, limit: 8 }, running));
  expect(pageTwo.items.map((item: { conversationId: string }) => item.conversationId)).not.toContain(recent.items[0].conversationId);
  expect(pageTwo.items.map((item: { conversationId: string }) => item.conversationId)).not.toContain(inserted.id);
});

it("limits source callbacks to visible evidence and rejects a quotation after the original is withdrawn", async () => {
  const original = await createHistory("证据源主记录");
  await addTurn(original.id, "recall-origin", "请记住原始落日松子信号", "独立原始证据。");
  const observed = vi.fn();
  const running = context({ runId: "history-provenance", onHistorySourcesRead: observed });
  const items = JSON.parse(await search.execute({ query: "落日松子信号" }, running)).items;
  expect(items[0].conversationId).toBe(original.id);
  expect(observed).toHaveBeenCalledWith([expect.objectContaining({ conversationId: original.id })], "search");
  await read.execute({ sourceRef: items[0].sourceRef, limit: 2 }, running);
  const pointers = observed.mock.calls.find(call => call[1] === "read")?.[0];
  expect(pointers).toEqual([{ conversationId: original.id, userTurnId: "recall-origin", userEntryId: "user:v1:recall-origin:r1",
    assistantEntryId: "assistant-recall-origin", revision: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
  expect(await filterCurrentHistorySourcePointers(pointers)).toEqual(pointers);

  const quote = await createHistory("复述记录");
  const transcript = getConversationTranscriptStore(fixture.root);
  await transcript.append(quote.id, { id: "user:v1:recall-quote:r1", kind: "user", turnId: "recall-quote", revision: 1, at: 1,
    payload: { text: "能复述这件事吗" } });
  await transcript.append(quote.id, { id: "assistant-recall-quote", kind: "assistant", turnId: "answer-recall-quote", at: 2,
    payload: { role: "assistant", content: "复述的落日松子信号" }, historySources: pointers });
  expect(await read.execute({ conversationId: quote.id }, running)).toContain("复述的落日松子信号");
  expect(JSON.parse(await search.execute({ query: "落日松子信号" }, { ...running, conversationId: original.id })).items)
    .toEqual([expect.objectContaining({ conversationId: quote.id })]);
  const binding = getChannelConversationBindingStore();
  binding.observe({ sessionId: "history-quote-external-origin", channel: "wechat", chatType: "group", chatId: "another-room", lastAt: 1 });
  binding.bind("history-quote-external-origin", original.id);
  expect(JSON.parse(await search.execute({ query: "落日松子信号" }, running)).items).toEqual([]);
  expect(JSON.parse(await read.execute({ conversationId: quote.id }, running))).toHaveProperty("errorCode", "history_unavailable");
  binding.unbind("history-quote-external-origin");
  expect(JSON.parse(await search.execute({ query: "落日松子信号" }, running)).items).toHaveLength(2);
  await memoryStore.retractFact({ conversationId: original.id, messageId: "user:v1:recall-origin:r1" }, "请记住原始落日松子信号");
  expect(await filterCurrentHistorySourcePointers(pointers)).toEqual([]);
  expect(JSON.parse(await read.execute({ conversationId: quote.id }, running))).toHaveProperty("errorCode", "history_unavailable");
  expect(JSON.parse(await search.execute({ query: "落日松子信号" }, running)).items).toEqual([]);
  expect(withConversationDatabase(fixture.root, db => db.prepare("SELECT COUNT(*) AS count FROM history_index_docs WHERE conversation_id IN (?,?)").get(original.id, quote.id)?.count)).toBe(0);
});

it.each(["user", "assistant", "title"] as const)("drops derived replies when the visible %s changes under the original entry ID", async (role) => {
  const original = await createHistory("来源修订边界");
  const key = `same-entry-edit-${role}`;
  await addTurn(original.id, key, "用户版确认文本", "昔涟版确认文本");
  const observed = vi.fn();
  const running = context({ runId: key, onHistorySourcesRead: observed });
  await read.execute({ conversationId: original.id }, running);
  const pointers = observed.mock.calls.find(call => call[1] === "read")?.[0];
  expect(pointers).toHaveLength(1);

  const transcript = getConversationTranscriptStore(fixture.root);
  const appendDerived = async (suffix: string, phrase: string, historySources: typeof pointers) => {
    const session = await createHistory("引用版本记录");
    const turnId = `${key}-${suffix}`;
    await transcript.append(session.id, { id: `user:v1:${turnId}:r1`, kind: "user", turnId, revision: 1, at: 1,
      payload: { text: "请复述刚看到的内容" } });
    await transcript.append(session.id, { id: `assistant-${turnId}`, kind: "assistant", turnId: `answer-${turnId}`, at: 2,
      historySources, payload: { role: "assistant", content: phrase } });
    return session.id;
  };
  const phrase = `版本依赖验证 ${role}`;
  const dependent = await appendDerived("dependent", phrase, pointers);
  const { revision: _revision, ...legacyPointer } = pointers[0];
  const legacy = await appendDerived("legacy", "缺少来源内容版本", [legacyPointer]);
  expect(JSON.parse(await search.execute({ query: phrase }, running)).items[0]?.conversationId).toBe(dependent);
  expect(await read.execute({ conversationId: dependent }, running)).toContain(phrase);
  expect(JSON.parse(await read.execute({ conversationId: legacy }, running))).toHaveProperty("errorCode", "history_unavailable");

  const changedText = "同一 ID 上的新可见内容";
  if (role === "title") await renameSession(original.id, changedText);
  else await transcript.append(original.id, { id: `${key}-patch`, kind: "presentation_patch", at: 3,
    payload: { messageId: role === "user" ? `user:v1:${key}:r1` : `assistant-${key}`, patchRevision: 1, patch: { content: changedText } } });
  expect(await read.execute({ conversationId: original.id }, running)).toContain(changedText);
  expect(await filterCurrentHistorySourcePointers(pointers)).toEqual([]);
  expect(JSON.parse(await search.execute({ query: phrase }, running)).items).toEqual([]);
  expect(JSON.parse(await read.execute({ conversationId: dependent }, running))).toHaveProperty("errorCode", "history_unavailable");
});

it("waits for canonical run completion and never covers unknown derived sources", async () => {
  const source = await createHistory("运行终态与来源");
  const transcript = getConversationTranscriptStore(fixture.root);
  const database = getConversationDatabase(fixture.root);
  const runId = "history-in-flight-source";
  await database.call("runs.create", { conversationId: source.id, runId });
  await transcript.append(source.id, { id: "user:v1:history-in-flight-source:r1", kind: "user", turnId: "history-in-flight-source", revision: 1,
    at: 1, runId, payload: { text: "确认成功再展示的云图" } });
  await transcript.append(source.id, { id: "assistant-history-in-flight-source", kind: "assistant", turnId: "answer-history-in-flight", at: 2,
    runId, payload: { role: "assistant", content: "等待事务终态的云图回复" } });
  const query = () => search.execute({ query: "云图回复" }, context()).then(JSON.parse);
  expect((await query()).items).toEqual([]);
  expect(JSON.parse(await read.execute({ conversationId: source.id }, context()))).toHaveProperty("errorCode", "history_unavailable");
  await database.call("runs.terminal", runId, "completed");
  expect((await query()).items[0].conversationId).toBe(source.id);
  await transcript.append(source.id, { id: "user:v1:history-incomplete:r1", kind: "user", turnId: "history-incomplete", revision: 1,
    at: 3, payload: { text: "缺失引用的问答" } });
  await transcript.append(source.id, { id: "assistant-history-incomplete", kind: "assistant", turnId: "answer-history-incomplete", at: 4,
    historySourcesIncomplete: true, payload: { role: "assistant", content: "另一个资料的派生赤铁引述" } });
  expect(await read.execute({ conversationId: source.id }, context())).not.toMatch(/未知|赤铁|缺失引用/u);
  expect(JSON.parse(await search.execute({ query: "赤铁引述" }, context())).items).toEqual([]);
});

it("falls back to verified history if the optional FTS table is damaged and rebuilds after a restart", async () => {
  const source = await createHistory("可重建的索引");
  await addTurn(source.id, "index-recovery", "别名恢复竹林测试", "正文永远从权威轨迹读取。");
  await search.execute({ query: "恢复竹林" }, context());
  const client = getConversationDatabase(fixture.root);
  await client.close();
  withConversationDatabase(fixture.root, db => db.exec("DROP TABLE history_index_fts; CREATE TABLE history_index_fts(tokens TEXT)"));
  const fallback = JSON.parse(await search.execute({ query: "恢复竹林" }, context()));
  expect(fallback).toMatchObject({ coverageStatus: "degraded", items: [expect.objectContaining({ conversationId: source.id })] });
  await client.close();
  withConversationDatabase(fixture.root, db => db.exec("DROP TABLE history_index_fts"));
  const running = context({ runId: "history-index-recovery" });
  let result = JSON.parse(await search.execute({ query: "恢复竹林" }, running));
  expect(result.items[0]).toMatchObject({ conversationId: source.id });
  for (let index = 0; index < 4 && result.nextCursor; index++) {
    result = JSON.parse(await search.execute({ searchCursor: result.nextCursor }, running));
  }
  expect(result.coverageStatus).toBe("complete");
  expect(await read.execute({ conversationId: source.id }, running)).toContain("正文永远从权威轨迹读取。");
});

it("reports incomplete coverage for a corrupt source and retries it on worker restart", async () => {
  const source = await createHistory("读取失败的来源");
  await addTurn(source.id, "temporarily-corrupt-history", "完整性恢复的彗星条目", "源记录修复后可以读取。");
  const entryId = "user:v1:temporarily-corrupt-history:r1";
  const original = withConversationDatabase(fixture.root, db => {
    const value = db.prepare("SELECT entry_json FROM transcript_entries WHERE conversation_id=? AND entry_id=?").get(source.id, entryId)?.entry_json;
    db.prepare("UPDATE transcript_entries SET entry_json=? WHERE conversation_id=? AND entry_id=?").run("{", source.id, entryId);
    return value as string;
  });
  const running = context({ runId: "history-source-recovery" });
  try {
    expect(JSON.parse(await search.execute({ query: "彗星条目" }, running)))
      .toMatchObject({ coverageStatus: "partial", items: [], nextCursor: null });
    expect(JSON.parse(await read.execute({ conversationId: source.id }, running))).toHaveProperty("errorCode", "history_unavailable");
  } finally {
    withConversationDatabase(fixture.root, db => db.prepare("UPDATE transcript_entries SET entry_json=? WHERE conversation_id=? AND entry_id=?")
      .run(original, source.id, entryId));
  }
  await getConversationDatabase(fixture.root).close();
  expect(JSON.parse(await search.execute({ query: "彗星条目" }, running))).toMatchObject({ coverageStatus: "complete",
    items: [expect.objectContaining({ conversationId: source.id })] });
});

it("continues numeric keyword pages through already-ranked matches", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const source = await createHistory(`数字关键词历史 ${i}`);
    ids.push(source.id);
    await addTurn(source.id, `numeric-ranked-${i}`, "数字分页拂晓", "关键词一致的回复");
  }
  const first = JSON.parse(await search.execute({ query: "数字分页拂晓", limit: 5 }, context()));
  expect(first.items).toHaveLength(5);
  expect(first.nextOffset).toBe(5);
  const second = JSON.parse(await search.execute({ query: "数字分页拂晓", offset: first.nextOffset, limit: 5 }, context()));
  expect(second).toMatchObject({ items: [expect.any(Object)], nextOffset: null });
  expect(new Set([...first.items, ...second.items].map(item => item.conversationId))).toEqual(new Set(ids));
});

it("advances the raw numeric recent position past hidden records", async () => {
  const hidden = await createHistory("不完整的最近会话");
  const transcript = getConversationTranscriptStore(fixture.root);
  await getConversationDatabase(fixture.root).call("runs.create", { conversationId: hidden.id, runId: "numeric-recent-active-run" });
  await transcript.append(hidden.id, { id: "user:v1:numeric-recent-hidden:r1", kind: "user", turnId: "numeric-recent-hidden", revision: 1,
    at: 1, runId: "numeric-recent-active-run", payload: { text: "尚未回答的旧问题" } });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const source = await createHistory(`最近分页历史 ${i}`);
    ids.push(source.id);
    await addTurn(source.id, `numeric-recent-${i}`, "可见的旧问题", "可见的旧回答");
  }
  withConversationDatabase(fixture.root, db => {
    const ordered = [hidden.id, ...ids];
    const pinOrder = db.prepare("UPDATE conversations SET record_json=json_set(record_json,'$.updatedAt',?) WHERE id=?");
    for (const [index, id] of ordered.entries()) pinOrder.run(Date.now() + 100_000 - index * 100, id);
  });
  const first = JSON.parse(await search.execute({ limit: 2 }, context()));
  expect(first.nextOffset).toBe(3);
  expect(first.items.map((item: { conversationId: string }) => item.conversationId)).toEqual(ids.slice(0, 2));
  const second = JSON.parse(await search.execute({ limit: 2, offset: first.nextOffset }, context()));
  expect(second.items[0].conversationId).toBe(ids[2]);
  expect(second.items.map((item: { conversationId: string }) => item.conversationId)).not.toContain(ids[1]);
});

it("gives each unopened legacy source its own rebuild batch", async () => {
  const ids = ["index-legacy-unopened-first", "index-legacy-unopened-second"];
  withConversationDatabase(fixture.root, db => {
    const insert = db.prepare("INSERT INTO conversations(id,record_json) VALUES(?,?)");
    for (const [index, id] of ids.entries()) {
      insert.run(id, JSON.stringify({ id, schemaVersion: 1, mode: "chat", title: "冷会话索引夹具", identityId: null,
        createdAt: 1, updatedAt: Date.now() + 200_000 - index * 100,
        messages: [{ id: `${id}-u`, role: "user", at: 1, content: "未知存档规模的苹果夹具" },
          { id: `${id}-a`, role: "model", at: 2, content: "等索引逐批建立" }] }));
    }
  });
  const running = context({ runId: "isolated-legacy-index-budget" });
  const isImported = () => withConversationDatabase(fixture.root, db => db.prepare(
    "SELECT transcript_imported FROM conversations WHERE id IN (?,?) ORDER BY id").all(...ids).map(row => row.transcript_imported));
  const first = JSON.parse(await search.execute({ query: "苹果夹具" }, running));
  expect(first).toMatchObject({ coverageStatus: "partial", items: [{ conversationId: ids[0] }], nextCursor: expect.any(String) });
  expect(isImported()).toEqual([1, 0]);
  const second = JSON.parse(await search.execute({ searchCursor: first.nextCursor }, running));
  expect(second.items).toMatchObject([{ conversationId: ids[1] }]);
  expect(isImported()).toEqual([1, 1]);
});

it("rebuilds a version-eleven index to find standalone user text and preserves its provenance", async () => {
  const source = await createSession({ mode: "chat", title: "只有旧笔记的会话", initialMessages: [
    { id: "legacy-index-only-user", role: "user", at: 7, content: "霜鹭独行的孤立笔记" },
  ] });
  const client = getConversationDatabase(fixture.root);
  await client.close();
  withConversationDatabase(fixture.root, db => {
    db.exec("DELETE FROM schema_migrations WHERE version=12; DROP TRIGGER history_index_pending_dispatch");
    db.prepare("INSERT OR REPLACE INTO history_index_state(conversation_id,dirty) VALUES(?,0)").run(source.id);
  });
  const observed = vi.fn();
  const running = context({ runId: "single-user-index-upgrade", onHistorySourcesRead: observed });
  const found = JSON.parse(await search.execute({ query: "孤立笔记" }, running));
  expect(found.items[0]).toMatchObject({ conversationId: source.id });
  expect(JSON.parse(await read.execute({ sourceRef: found.items[0].sourceRef }, running))).toMatchObject({
    messages: [{ role: "user", text: "霜鹭独行的孤立笔记" }],
  });
  const pointers = observed.mock.calls.find(call => call[1] === "read")?.[0];
  expect(pointers).toEqual([{ conversationId: source.id, userTurnId: "legacy-index-only-user",
    userEntryId: "migration:v2:legacy-index-only-user:canonical", revision: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
  expect(await filterCurrentHistorySourcePointers(pointers)).toEqual(pointers);
  // Old UI locators used the visible ID instead of the canonical entry ID.
  await memoryStore.retractFact({ conversationId: source.id, messageId: "legacy-index-only-user" }, "霜鹭独行的孤立笔记");
  expect(await filterCurrentHistorySourcePointers(pointers)).toEqual([]);
  expect(await loadConversationReference(destination, source.id)).toBeUndefined();
  expect(JSON.parse(await search.execute({ query: "孤立笔记" }, running)).items).toEqual([]);
});

it("can quote and search a settled user's original message after a failed run without replaying the partial reply", async () => {
  const source = await createHistory("失败运行留下的输入");
  const transcript = getConversationTranscriptStore(fixture.root);
  const database = getConversationDatabase(fixture.root);
  const runId = "settled-user-with-failed-answer";
  await database.call("runs.create", { conversationId: source.id, runId });
  await transcript.append(source.id, { id: "user:v1:failed-user:r1", kind: "user", runId, turnId: "failed-user", revision: 1, at: 1,
    payload: { text: "松鼠水钟项目原笔记" } });
  await transcript.append(source.id, { id: "failed-partial-reply", kind: "assistant", runId, turnId: "failed-reply", at: 2,
    payload: { role: "assistant", content: "尚未处理完整的回执" } });
  await transcript.append(source.id, { id: "lagging-failed-reply-view", kind: "presentation_patch", at: 2,
    payload: { messageId: "failed-partial-reply", patchRevision: 1, patch: { runSnapshot: { status: "running", updatedAt: 2 } } } });
  expect(await loadConversationReference(destination, source.id)).toBeUndefined();
  expect(JSON.parse(await read.execute({ conversationId: source.id }, context()))).toHaveProperty("errorCode", "history_unavailable");
  await database.call("runs.terminal", runId, "failed");
  const manualText = (await loadConversationReference(destination, source.id))?.context;
  expect(manualText).toContain("松鼠水钟项目原笔记");
  expect(manualText).not.toContain("尚未处理完整的回执");
  expect(JSON.parse(await search.execute({ query: "水钟项目" }, context())).items[0]).toMatchObject({ conversationId: source.id });
  expect(JSON.parse(await read.execute({ conversationId: source.id }, context())).messages).toMatchObject([{ role: "user", text: "松鼠水钟项目原笔记" }]);
});

it("validates explicit quotes with memory off and blocks revoked or previously mirrored data", async () => {
  const explicit = await createSession({ mode: "chat", title: "可手工引用", initialMessages: [
    { id: "manual-assistant-only-anchor", role: "model", at: 1, content: "原先保留的开场短笺" },
  ] });
  const mirrored = await createHistory("已回退的渠道会话");
  const transcript = getConversationTranscriptStore(fixture.root);
  await transcript.append(mirrored.id, { id: "channel:old-proof", kind: "user", turnId: "external-previous", revision: 1,
    at: 1, payload: { text: "已撤下的渠道记录" } });
  await transcript.append(mirrored.id, { id: "remove-mirrored-active-branch", kind: "turn_tombstone", at: 2,
    payload: { targetUserTurnId: "external-previous", reason: "pending_withdrawn" } });
  await addTurn(mirrored.id, "post-channel-edit", "替换后的本地外观", "看起来和普通会话相同");
  setMemoryMode("off");
  try {
    expect(await loadConversationReference("", explicit.id)).toMatchObject({ context: expect.stringContaining("原先保留的开场短笺") });
    expect(JSON.parse(await read.execute({ conversationId: explicit.id }, context()))).toHaveProperty("errorCode", "history_unavailable");
    expect(await loadConversationReference(destination, mirrored.id)).toBeUndefined();
    await memoryStore.retractFact({ conversationId: explicit.id, messageId: "manual-assistant-only-anchor" }, "原先保留的开场短笺");
    expect(await loadConversationReference(destination, explicit.id)).toBeUndefined();
  } finally { setMemoryMode("vector"); }
});
