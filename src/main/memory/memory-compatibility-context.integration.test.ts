import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as chatsStore from "../chats/chats-store";
import { getConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import { getConversationDatabase } from "../storage/conversation-database-client";
import { buildMemoryCompatibilityContext } from "./memory-compatibility-context";
import { setMemoryMode, type MemoryMode } from "./memory-mode";
import { memorySourceKey } from "./memory-source-policy";
import { memoryStore } from "./memory-store";
import { readMemoryEpisodes } from "./memory-episode-recall";
import { buildRecallQueryPlan } from "./recall-query-plan";
import { loadSummaryMemoryContext } from "./summary-memory-context";
import { resolveSummaryMemorySources } from "./summary-memory-sources";
import { resolveSummaryMemoryPaths } from "./summary-memory-paths";
import { writeSummaryFileAtomic } from "./summary-memory-store";
import { initializeWikiMemoryScheduler } from "./wiki-memory-scheduler";
import { workspaceScope } from "./wiki-paths";
import { createWikiChatSourceReader } from "./wiki-source";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("./obsidian-exporter", () => ({ notifyMemoryChanged: vi.fn() }));

it("reads each previous store after a mode switch and rejects stale, forgotten, channel and unrelated workspace sources", async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-memory-mode-switch-"));
  const transcript = getConversationTranscriptStore(fixture.root);
  const { store } = initializeWikiMemoryScheduler({
    userDataRoot: fixture.root,
    sourceReader: createWikiChatSourceReader({
      transcriptStore: transcript,
      listSessions: chatsStore.listSessions,
      ensureConversationMigrated: async id => chatsStore.getSessionRecord(id),
    }),
  });
  const record = async (title: string, userText: string, userEntryId = `user:v1:${title}:r1`, at = 1, historySources?: Array<{
    conversationId: string; userTurnId: string; userEntryId: string; assistantEntryId: string;
  }>) => {
    const { id: conversationId } = await chatsStore.createSession({ title, mode: "chat" });
    const userTurnId = `turn-${title}`;
    const assistantEntryId = `assistant-${title}`;
    await transcript.append(conversationId, { id: userEntryId, kind: "user", at, turnId: userTurnId, revision: 1, payload: { text: userText } });
    await transcript.append(conversationId, { id: assistantEntryId, kind: "assistant", at: at + 1, turnId: `answer-${title}`,
      ...(historySources ? { historySources } : {}),
      payload: { role: "assistant", content: `已记下：${userText}` } });
    return { conversationId, userTurnId, userEntryId, assistantEntryId };
  };
  try {
    const current = await chatsStore.createSession({ mode: "chat" });
    const vector = await record("向量", "露营睡袋是红色");
    await memoryStore.addL2Memory({ content: "露营睡袋是红色", triggerText: "露营睡袋", sourceConversationId: vector.conversationId,
      sourceMessageIds: [vector.userEntryId], isPinned: false, isSummary: false });
    const summary = await record("露营规划", "露营地点改为松林");
    const legacy = await record("露营旧笔记", "露营旧资料无可验证出处");
    const writeSummary = (id: string, text: string, sources?: [typeof summary]) => writeSummaryFileAtomic(
      resolveSummaryMemoryPaths({ conversationId: id, userDataRoot: fixture.root }).sessionPath, text, 800, fixture.root, undefined, sources);
    await writeSummary(summary.conversationId, "露营地点改为松林", [summary]);
    await writeSummary(legacy.conversationId, "露营旧资料无可验证出处");
    const wiki = await record("维基", "露营炉使用异丁烷");
    const channel = await record("渠道", "露营会泄漏渠道秘密", "channel:inbox:private");
    const privateProject = path.join(fixture.root, "workspace");
    await store.applyClaims([
      { subject: "露营", predicate: "装备", value: "露营炉使用异丁烷", scope: { kind: "global" }, statementKind: "assertion",
        sourceText: "露营炉使用异丁烷", source: { kind: "chat", conversationId: wiki.conversationId, messageId: wiki.userEntryId, revision: "1", assertedAt: 1 } },
      { subject: "露营", predicate: "渠道", value: "露营会泄漏渠道秘密", scope: { kind: "global" }, statementKind: "assertion",
        sourceText: "露营会泄漏渠道秘密", source: { kind: "chat", conversationId: channel.conversationId, messageId: channel.userEntryId, revision: "1", assertedAt: 1 } },
      { subject: "露营", predicate: "项目", value: "露营相关另一个工作区秘密", scope: workspaceScope(privateProject), statementKind: "assertion",
        sourceText: "露营炉使用异丁烷", source: { kind: "chat", conversationId: wiki.conversationId, messageId: wiki.userEntryId, revision: "1", assertedAt: 1 } },
      { subject: "露营", predicate: "地点", value: "旧营地位于松木林地", scope: { kind: "global" }, statementKind: "assertion",
        sourceText: "露营地点改为松林", source: { kind: "chat", conversationId: summary.conversationId, messageId: summary.userEntryId, revision: "1", assertedAt: 1 } },
    ]);
    const context = (mode: MemoryMode) => {
      setMemoryMode(mode);
      return buildMemoryCompatibilityContext({ mode, conversationId: current.id, query: "露营装备和露营地点" });
    };
    const vectorRequest = await context("vector");
    expect(vectorRequest).toContain("露营炉使用异丁烷");
    expect(vectorRequest).toContain("露营地点改为松林");
    expect(vectorRequest).not.toMatch(/旧资料|渠道秘密|工作区秘密/);
    const summaryRequest = await context("summary");
    expect(summaryRequest).toContain("露营睡袋是红色");
    expect(summaryRequest).toContain("露营炉使用异丁烷");
    const wikiRequest = await context("wiki");
    expect(wikiRequest).toContain("露营睡袋是红色");
    expect(wikiRequest).toContain("露营地点改为松林");
    expect(wikiRequest).toContain("露营炉使用异丁烷");
    expect(wikiRequest).toContain("旧营地位于松木林地");

    const spokenAt = Date.parse("2026-11-26T09:30:00+08:00");
    const exactDay = "高山远足在2026年11月20日听到了山鹑。";
    const anotherDay = "高山远足在2026年11月23日看到了狐狸。";
    const undated = "高山远足时背的是一顶蓝帐篷。";
    const datedSource = await record("高山远足", exactDay, undefined, spokenAt);
    const secondDatedSource = await record("第二次高山远足", anotherDay, undefined, spokenAt);
    const undatedSource = await record("高山帐篷", undated, undefined, spokenAt);
    const derived = await record("旧会话引用", "帮我回看旧话题", undefined, spokenAt, [datedSource]);
    const detail = exactDay + "途中停下来听了片刻，远处有风。".repeat(18);
    for (const [source, text, content, eventDate] of [
      [datedSource, exactDay, detail, "2026-11-20"], [undatedSource, undated, undated, "2026-11-20"],
      [secondDatedSource, anotherDay, anotherDay, "2026-11-23"],
    ] as const) {
      await memoryStore.addL2Memory({
        content, sourceQuote: text, triggerText: "高山远足", gist: text, eventDate,
        sourceConversationId: source.conversationId, sourceMessageIds: [source.userEntryId], isPinned: false, isSummary: false,
      });
    }
    await writeSummary(datedSource.conversationId, `${exactDay}\n\n另有一份独立求职简历。`, [datedSource]);
    await writeSummary(secondDatedSource.conversationId, anotherDay, [secondDatedSource]);
    await writeSummary(undatedSource.conversationId, undated, [undatedSource]);
    await writeSummary(derived.conversationId, "高山远足回执衍生事实", [derived]);
    expect(await resolveSummaryMemorySources(fixture.root, [datedSource, derived])).toEqual([datedSource, undefined]);
    await store.applyClaims([
      { subject: "高山远足", predicate: "物种", value: exactDay, scope: { kind: "global" }, statementKind: "assertion",
        sourceText: exactDay, source: { kind: "chat", conversationId: datedSource.conversationId, messageId: datedSource.userEntryId, revision: "1", assertedAt: spokenAt } },
      { subject: "高山远足", predicate: "另一行程的物种", value: anotherDay, scope: { kind: "global" }, statementKind: "assertion",
        sourceText: anotherDay, source: { kind: "chat", conversationId: secondDatedSource.conversationId, messageId: secondDatedSource.userEntryId, revision: "1", assertedAt: spokenAt } },
      { subject: "高山远足", predicate: "装备", value: undated, scope: { kind: "global" }, statementKind: "assertion",
        sourceText: undated, source: { kind: "chat", conversationId: undatedSource.conversationId, messageId: undatedSource.userEntryId, revision: "1", assertedAt: spokenAt } },
      { subject: "高山远足", predicate: "历史回执", value: "高山远足回执衍生事实", scope: { kind: "global" }, statementKind: "assertion",
        sourceText: "已记下：帮我回看旧话题", source: { kind: "chat", conversationId: derived.conversationId, messageId: derived.assistantEntryId, revision: "1", assertedAt: spokenAt } },
    ]);
    const contextFor = (query: string) => buildMemoryCompatibilityContext({ mode: "wiki", conversationId: current.id, query });
    const eventQuery = "2026年11月20日 高山远足";
    const eventContext = JSON.parse((await contextFor(eventQuery)).split("\n").at(-1)!);
    expect(eventContext.事件记忆.join()).toContain("途中停下来听了片刻");
    expect(eventContext.对话摘要.join()).toContain(exactDay);
    expect(eventContext.维基事实.join()).toContain("山鹑");
    expect(JSON.stringify(eventContext)).not.toMatch(/简历|蓝帐篷|回执衍生|狐狸/);
    expect(await contextFor("2026年11月26日 高山远足")).toBe("");
    const conversationContext = await contextFor("2026年11月26日聊过 高山远足");
    expect(conversationContext).toContain("蓝帐篷");
    expect(conversationContext).not.toContain("回执衍生");
    expect(await contextFor("2026年11月20日高山远足和2026年11月26日高山远足")).toBe("");
    const multiContext = JSON.parse((await contextFor("2026年11月20日高山远足；2026年11月23日高山远足")).split("\n").at(-1)!);
    for (const records of [multiContext.事件记忆, multiContext.对话摘要, multiContext.维基事实] as string[][]) {
      expect(records.join()).toMatch(/【事件日 2026-11-20】[^,]*山鹑/u);
      expect(records.join()).toMatch(/【事件日 2026-11-23】[^,]*狐狸/u);
      expect(records.join()).not.toMatch(/蓝帐篷|回执衍生/u);
    }
    expect(await contextFor("嗯嗯")).toBe("");
    const currentPlan = buildRecallQueryPlan({ query: eventQuery, recentVisible: [exactDay] });
    expect(await readMemoryEpisodes({ query: eventQuery, plan: currentPlan })).toEqual([]);
    const nativeSummary = await loadSummaryMemoryContext({
      conversationId: datedSource.conversationId, userDataRoot: fixture.root,
      getSessionRecord: chatsStore.getSessionRecord, recallPlan: buildRecallQueryPlan({ query: eventQuery }),
    });
    expect(nativeSummary.runtimeContext).toContain(exactDay);
    expect(nativeSummary.runtimeContext).not.toContain(nativeSummary.sessionPath);
    expect(nativeSummary.runtimeContext).not.toContain("简历");

    await memoryStore.retractFact({ conversationId: summary.conversationId, messageId: summary.userEntryId }, "露营地点改为松林");
    const afterCorrection = await context("wiki");
    expect(afterCorrection).not.toMatch(/露营地点改为松林|旧营地位于松木林地/);
    expect(afterCorrection).toContain("露营炉使用异丁烷");

    await transcript.append(wiki.conversationId, { id: "old-wiki-rewind", kind: "turn_rewind", at: 3,
      payload: { anchorUserTurnId: wiki.userTurnId, disposition: "keep_user", reason: "regenerate" } });
    const state = structuredClone(await memoryStore.load());
    const forgetting = state.forgetting ??= { memoryIds: [], wikiClaimKeys: [], sourceKeys: [] };
    forgetting.sourceKeys.push(memorySourceKey({ conversationId: vector.conversationId, messageId: vector.userEntryId }));
    await memoryStore.save(state);
    const disk = JSON.parse(await fs.readFile(path.join(fixture.root, "memory.json"), "utf8"));
    expect(disk.forgetting.derivedSourceKeys).toContain(memorySourceKey({ conversationId: summary.conversationId, messageId: summary.userEntryId }));
    await store.close();
    await getConversationDatabase(fixture.root).close();
    expect(await context("summary")).toBe("");
    expect(await context("off")).toBe("");
    setMemoryMode("vector");
    const inFlight = buildMemoryCompatibilityContext({ mode: "vector", conversationId: current.id, query: "露营" });
    setMemoryMode("off");
    expect(await inFlight).toBe("");
  } finally {
    await store.close();
    await getConversationDatabase(fixture.root).close();
    await fs.rm(fixture.root, { recursive: true, force: true });
    setMemoryMode("vector");
  }
});
