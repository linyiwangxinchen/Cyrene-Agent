import { closeConversationDatabases } from "../storage/conversation-database-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscriptCompactor, createModelBackedConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import { ConversationTranscriptArchive } from "./conversation-transcript-archive";
import { ConversationJournalService } from "./conversation-journal-service";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { ChatMessage } from "./vendors/types";
import { buildCompactionSourceView } from "./conversation-transcript-projection";
import {
  createTranscriptCompactionRequiredError,
  getTranscriptCompactionDisplayMessage,
} from "../../shared/transcript-compaction-error";
import { AgentRuntimeError } from "./agent-runtime-error";

function assertNoOrphanToolPairs(messages: ChatMessage[]): boolean {
  const calls = new Set(messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : []));
  return messages.every((message) => message.role !== "tool" || calls.has(message.toolCallId ?? ""));
}

describe("ConversationTranscriptCompactor", () => {
  const roots: string[] = [];

  function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-transcript-compactor-"));
    roots.push(root);
    const store = new ConversationTranscriptStore(root, { now: () => 1_000 });
    const journal = new ConversationJournalService(store);
    let releaseSummary!: (value: string) => void;
    let shouldReject = false;
    let paused = false;
    // summarize 真正被调用后放行：appendUser 退役投影重算后不再天然慢，
    // 并发追加的用例必须显式等 summary 启动，避免 resume 抢在 summarize 之前。
    let signalSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => { signalSummaryStarted = resolve; });
    const summarize = async () => {
      signalSummaryStarted();
      if (shouldReject) throw new Error("provider down");
      if (!paused) return "保留的摘要";
      return new Promise<string>((resolve, reject) => {
        releaseSummary = resolve;
        void reject;
      });
    };
    const compactor = new ConversationTranscriptCompactor({ store, summarize });
    return {
      store,
      journal,
      compactor,
      pause: () => { paused = true; },
      summaryStarted,
      resume: (summary: string) => releaseSummary(summary),
      reject: () => { shouldReject = true; },
    };
  }

  afterEach(async () => {
  await closeConversationDatabases();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function seed(fixture: ReturnType<typeof createFixture>) {
    await fixture.journal.appendUser("c1", { turnId: "u1", id: "u1", text: "旧任务".repeat(20) });
    const sink = fixture.journal.createRunSink({ conversationId: "c1", runId: "run-1" });
    const assistantEntryId = await sink.appendAssistant({
      message: {
        role: "assistant",
        content: "读取文件",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
      },
    });
    await sink.appendToolResult({
      assistantEntryId,
      message: { role: "tool", toolCallId: "call-1", name: "read_file", content: "文件内容" },
      outcome: "success",
    });
    await fixture.journal.appendUser("c1", { turnId: "u2", id: "u2", text: "最新问题" });
  }

  it("归档及重启后只保留最近一组原图，二次压缩继续保留引用且来源序号一致", async () => {
    const fixture = createFixture();
    const first = path.join(roots.at(-1)!, "first.png");
    const second = path.join(roots.at(-1)!, "second.png");
    await fixture.journal.appendUser("photos", { id: "photo-1", turnId: "photo-turn-1", text: "旧照片".repeat(50),
      attachments: [{ kind: "image", name: "first.png", filePath: first }] });
    await fixture.journal.appendUser("photos", { id: "photo-2", turnId: "photo-turn-2", text: "当前原照片".repeat(50),
      attachments: [{ kind: "image", name: "second.png", filePath: second }] });
    await fixture.journal.appendUser("photos", { id: "request", turnId: "request-turn", text: "按最近照片制作" });
    await fixture.compactor.compact({ conversationId: "photos", trigger: "manual", retainTokens: 1 });
    const snapshot = await fixture.store.read("photos");
    expect(snapshot.entries.some(entry => entry.id === "photo-1" || entry.id === "photo-2")).toBe(false);
    await closeConversationDatabases();
    const reopenedStore = new ConversationTranscriptStore(roots.at(-1)!);
    const reopenedJournal = new ConversationJournalService(reopenedStore);
    const before = await reopenedJournal.buildModelContext("photos");
    expect(before.messages.flatMap(message => message.userAttachments ?? []).map(image => image.filePath)).toEqual([second]);
    const source = buildCompactionSourceView((await reopenedStore.read("photos")).entries, { get: () => null });
    expect(source.messages).toEqual(before.messages);
    expect(source.sourceSeqs).toHaveLength(source.messages.length);
    expect(source.sourceSeqs.every(seq => seq <= source.throughSeq)).toBe(true);
    await reopenedJournal.appendUser("photos", { id: "next", turnId: "next-turn", text: "继续制作".repeat(50) });
    await reopenedJournal.appendUser("photos", { id: "latest", turnId: "latest-turn", text: "现在发给我" });
    await new ConversationTranscriptCompactor({ store: reopenedStore, summarize: async () => "二次摘要" })
      .compact({ conversationId: "photos", trigger: "manual", retainTokens: 1 });
    const after = await reopenedJournal.buildModelContext("photos");
    expect(after.messages.flatMap(message => message.userAttachments ?? []).map(image => image.filePath)).toEqual([second]);
    expect(JSON.stringify((await reopenedStore.read("photos")).entries)).not.toContain("base64");

    await reopenedJournal.appendUser("photos", { id: "new-photo", turnId: "new-photo-turn", text: "换用这张",
      attachments: [{ kind: "image", name: "new.png", filePath: first }] });
    expect((await reopenedJournal.buildModelContext("photos")).messages.flatMap(message => message.userAttachments ?? []).map(image => image.filePath)).toEqual([first]);
  });

  it.each(["turn_tombstone", "turn_rewind"] as const)("归档原图被 %s 移除后不会由检查点恢复", async (kind) => {
    const fixture = createFixture();
    const filePath = path.join(roots.at(-1)!, "removed.png");
    await fixture.journal.appendUser("removed-photo", { id: "removed", turnId: "removed-turn", text: "照片".repeat(100),
      attachments: [{ kind: "image", name: "removed.png", filePath }] });
    await fixture.journal.appendUser("removed-photo", { id: "after", turnId: "after-turn", text: "继续" });
    await fixture.compactor.compact({ conversationId: "removed-photo", trigger: "manual", retainTokens: 1 });
    if (kind === "turn_tombstone") await fixture.store.append("removed-photo", { id: "remove", kind, at: 100,
      payload: { targetUserTurnId: "removed-turn", reason: "pending_withdrawn" } });
    else await fixture.store.append("removed-photo", { id: "replace", kind, at: 100, turnId: "removed-turn", revision: 2,
      payload: { anchorUserTurnId: "removed-turn", disposition: "replace_user", reason: "edit", replacementUser: { text: "不附图片" } } });
    const context = await fixture.journal.buildModelContext("removed-photo");
    expect(context.messages.flatMap(message => message.userAttachments ?? [])).toEqual([]);
    const source = buildCompactionSourceView((await fixture.store.read("removed-photo")).entries, { get: () => null });
    expect(source.messages).toEqual(context.messages);
  });

  it("后台完成结果退役后重建摘要并继续保留归档原图和待投递事件", async () => {
    const fixture = createFixture();
    const conversationId = "photo-shell";
    const original = path.join(roots.at(-1)!, "original.png");
    await fixture.journal.appendUser(conversationId, { id: "photo", turnId: "photo-turn", text: "按这张照片处理".repeat(60),
      attachments: [{ kind: "image", name: "original.png", filePath: original }] });
    const event = await fixture.store.append(conversationId, { id: "shell-completed:old-job", kind: "background_event", at: 100,
      payload: { jobId: "old-job", sourceWorkspace: "/old", sourceToolCallId: "old-call",
        message: { role: "user", visibility: "internal", content: "OBSOLETE_SHELL_OUTPUT".repeat(40) } } });
    await fixture.journal.appendUser(conversationId, { id: "latest", turnId: "latest-turn", text: "继续使用原照片" });
    await fixture.compactor.compact({ conversationId, trigger: "manual", retainTokens: 1 });
    expect((await fixture.journal.buildModelContext(conversationId)).messages
      .flatMap(message => message.userAttachments ?? []).map(attachment => attachment.filePath)).toEqual([original]);
    await fixture.store.append(conversationId, { id: "shell-retired:old-job", kind: "background_event_retired", at: 101,
      payload: { jobId: "old-job", sourceSeq: event.seq } });
    const pending = await fixture.store.append(conversationId, { id: "shell-pending:new-job", kind: "background_event_pending", at: 102,
      payload: { jobId: "new-job", sourceWorkspace: "/new", sourceToolCallId: "new-call",
        message: { role: "user", visibility: "internal", content: "PENDING_SHELL_OUTPUT" } } });
    await fixture.journal.appendUser(conversationId, { id: "next", turnId: "next-turn", text: "请把原照片结果发给我" });
    const summarize = vi.fn(async (history: ChatMessage[]) => {
      expect(JSON.stringify(history)).not.toContain("OBSOLETE_SHELL_OUTPUT");
      expect(JSON.stringify(history)).not.toContain("PENDING_SHELL_OUTPUT");
      return "重新整理的图片处理摘要";
    });
    const result = await new ConversationTranscriptCompactor({ store: fixture.store, summarize })
      .compact({ conversationId, trigger: "automatic", retainTokens: 1 });
    expect(result.checkpointEntryId).toContain(":retired:");
    expect(summarize).toHaveBeenCalledOnce();
    await closeConversationDatabases();
    const restarted = new ConversationJournalService(new ConversationTranscriptStore(roots.at(-1)!));
    const context = await restarted.buildModelContext(conversationId);
    expect(context.messages.flatMap(message => message.userAttachments ?? []).map(attachment => attachment.filePath)).toEqual([original]);
    expect(JSON.stringify(context.messages)).not.toMatch(/OBSOLETE_SHELL_OUTPUT|PENDING_SHELL_OUTPUT/);
    expect((await fixture.store.readAuditEntries(conversationId))).toContainEqual(pending);
  });

  it("压缩边界不切断 assistant tool call 与 tool result", async () => {
    const fixture = createFixture();
    await seed(fixture);

    const result = await fixture.compactor.compact({
      conversationId: "c1",
      trigger: "manual",
      retainTokens: 1,
    });

    expect(assertNoOrphanToolPairs(result.compactedMessages)).toBe(true);
    expect(result.checkpointEntryId).toBeTruthy();
  });

  it.each(["during-summary", "before-checkpoint", "before-archive", "after-archive"])("retires a completion %s without retaining its summary or losing unrelated history", async phase => {
    const fixture = createFixture();
    await seed(fixture);
    const event = await fixture.store.append("c1", { kind: "background_event", id: "shell-completed:A", at: 1_000,
      payload: { jobId: "A", sourceWorkspace: "A", message: { role: "user", visibility: "internal", content: "PRIVATE_A_OUTPUT".repeat(80) } } });
    await fixture.journal.createRunSink({ conversationId: "c1", runId: "unrelated" })
      .appendAssistant({ message: { role: "assistant", content: "independent historical note".repeat(40) } });
    await fixture.journal.appendUser("c1", { turnId: "latest", text: "current question in B" });
    const retire = () => fixture.store.append("c1", { kind: "background_event_retired", id: "shell-retired:A", at: 1_001,
      payload: { jobId: "A", sourceSeq: event.seq } });
    const commit = fixture.store.appendCompactionCheckpoint.bind(fixture.store);
    const checkpointSpy = vi.spyOn(fixture.store, "appendCompactionCheckpoint").mockImplementation(async (id, input) => {
      if (phase === "before-checkpoint") await retire();
      return commit(id, input);
    });
    const archive = new ConversationTranscriptArchive(fixture.store);
    const archiveThrough = archive.archiveThrough.bind(archive);
    const spy = vi.spyOn(archive, "archiveThrough").mockImplementation(async (id, through) => {
      if (phase === "before-archive") await retire();
      await archiveThrough(id, through);
      if (phase === "after-archive") {
        expect((await fixture.store.read(id)).entries.some(entry => entry.id === event.id)).toBe(false);
        await retire();
      }
    });
    const summarize = vi.fn(async () => {
      if (phase === "during-summary") await retire();
      return "STALE_SUMMARY_WITH_A";
    });
    const compactor = new ConversationTranscriptCompactor({ store: fixture.store, summarize, archive });
    try {
      const compacting = compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
      if (phase === "during-summary" || phase === "before-checkpoint") await expect(compacting).rejects.toThrow("TRANSCRIPT_COMPACTION_REQUIRED");
      else expect(JSON.stringify((await compacting).compactedMessages)).not.toContain("STALE_SUMMARY_WITH_A");
    } finally { spy.mockRestore(); checkpointSpy.mockRestore(); }
    await closeConversationDatabases();
    const context = await fixture.journal.buildModelContext("c1");
    expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_A_OUTPUT");
    expect(JSON.stringify(context.messages)).not.toContain("STALE_SUMMARY_WITH_A");
    expect(JSON.stringify(context.messages)).toContain("旧任务");
    expect(JSON.stringify(context.messages)).toContain("independent historical note");
    const audit = await fixture.store.readAuditEntries("c1");
    expect(audit).toContainEqual(event);
    const replacement = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => "CLEAN_SUMMARY" });
    const repaired = await replacement.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    expect(JSON.stringify(repaired.compactedMessages)).toContain("CLEAN_SUMMARY");
    expect(JSON.stringify(repaired.compactedMessages)).not.toContain("STALE_SUMMARY_WITH_A");
    expect((await fixture.journal.buildModelContext("c1")).messages).toEqual(repaired.compactedMessages);
  });

  it("摘要期间的新后缀不进入 sourceThroughSeq 也不丢失", async () => {
    const fixture = createFixture();
    await seed(fixture);
    fixture.pause();
    const pending = fixture.compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    await fixture.summaryStarted;
    await fixture.journal.appendUser("c1", { turnId: "u-new", id: "u-new", text: "arrived during summary" });
    fixture.resume("summary");
    const result = await pending;

    const context = await fixture.journal.buildModelContext("c1");
    expect(context.messages.at(-1)?.content).toBe("arrived during summary");
    expect(result.sourceThroughSeq).toBeLessThan((await fixture.store.read("c1")).throughSeq);
  });

  it("摘要失败时不追加 checkpoint 且旧上下文完整", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;
    fixture.reject();
    const pending = fixture.compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });

    await expect(pending).rejects.toThrow("TRANSCRIPT_COMPACTION_REQUIRED");
    await expect(pending).rejects.toMatchObject({ reason: "model_request_failed", cause: expect.objectContaining({ message: "provider down" }) });
    const entries = (await fixture.store.read("c1")).entries;
    expect(entries).toEqual(original);
    expect(entries.some((entry) => entry.kind === "compaction_checkpoint")).toBe(false);
  });

  it("没有安全切点时显式要求 TRANSCRIPT_COMPACTION_REQUIRED 且不写 checkpoint", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;

    const pending = fixture.compactor.compact({
      conversationId: "c1", trigger: "automatic", retainTokens: 1_000_000,
    });
    await expect(pending).rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "no_safe_boundary" });
    expect((await fixture.store.read("c1")).entries).toEqual(original);
  });

  it("并发 compaction 只允许一个 checkpoint 通过 CAS", async () => {
    const fixture = createFixture();
    await seed(fixture);
    let release!: (summary: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const first = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => gate });
    const second = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => gate });
    const a = first.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    const b = second.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    release("summary");

    const results = await Promise.allSettled([a, b]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toEqual(
      expect.objectContaining({ reason: expect.objectContaining({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "history_changed" }) }),
    );
    expect((await fixture.store.read("c1")).entries.filter((entry) => entry.kind === "compaction_checkpoint")).toHaveLength(1);
  });

  it.each(["", "不会更短".repeat(1_000)])("空白或更大的摘要不写检查点且保留全部历史", async (summary) => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;
    const compactor = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => summary });
    await expect(compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 }))
      .rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "invalid_summary" });
    expect((await fixture.store.read("c1")).entries).toEqual(original);
  });

  it("摘要期间历史撤回会拒绝失效检查点，给出重试原因", async () => {
    const fixture = createFixture();
    await seed(fixture);
    fixture.pause();
    const pending = fixture.compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });
    const rejection = expect(pending).rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "history_changed" });
    await fixture.summaryStarted;
    await fixture.store.append("c1", { id: "withdraw", kind: "turn_tombstone", at: 100,
      payload: { targetUserTurnId: "u1", reason: "pending_withdrawn" } });
    const original = (await fixture.store.read("c1")).entries;
    fixture.resume("新摘要");
    await rejection;
    expect((await fixture.store.read("c1")).entries).toEqual(original);
  });

  it("检查点存储失败会保留历史并区别于摘要模型错误", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;
    vi.spyOn(fixture.store, "appendCompactionCheckpoint").mockRejectedValue(new Error("SQLITE_FULL"));
    await expect(fixture.compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 }))
      .rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "checkpoint_write_failed" });
    expect((await fixture.store.read("c1")).entries).toEqual(original);
  });

  it("未提供当前会话模型时保留具体配置原因，不被外层请求错误覆盖", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const original = (await fixture.store.read("c1")).entries;
    const compactor = createModelBackedConversationTranscriptCompactor({ store: fixture.store });
    await expect(compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 }))
      .rejects.toMatchObject({ message: "TRANSCRIPT_COMPACTION_REQUIRED", reason: "model_unconfigured" });
    expect((await fixture.store.read("c1")).entries).toEqual(original);
  });

  it("按活动分支 source seq 压缩同文本 replace_user，且模型上下文命中 checkpoint", async () => {
    const fixture = createFixture();
    await fixture.store.append("c1", {
      id: "u-old", at: 1, kind: "user", turnId: "turn-1", revision: 1,
      payload: { text: "相同文本".repeat(20) },
    });
    await fixture.store.append("c1", {
      id: "a-old", at: 1, kind: "assistant", payload: { role: "assistant", content: "旧回答".repeat(20) },
    });
    await fixture.store.append("c1", {
      id: "rewind", at: 1, kind: "turn_rewind", turnId: "turn-1", revision: 2,
      payload: {
        anchorUserTurnId: "turn-1", disposition: "replace_user", reason: "edit",
        replacementUser: { text: "相同文本".repeat(20) },
      },
    });
    await fixture.store.append("c1", {
      id: "a-new", at: 1, kind: "assistant", payload: { role: "assistant", content: "新回答".repeat(20) },
    });
    await fixture.store.append("c1", {
      id: "u-latest", at: 1, kind: "user", turnId: "turn-2", revision: 1,
      payload: { text: "最新问题" },
    });

    const branchCompactor = new ConversationTranscriptCompactor({ store: fixture.store, summarize: async () => "x" });
    const result = await branchCompactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 50 });
    expect(result.sourceThroughSeq).toBe(3);
    expect(result.compactedMessages[0]?.content).toContain("<cyrene_compaction_checkpoint>");
    expect((await fixture.journal.buildModelContext("c1")).messages.map((message) => message.content))
      .toEqual([expect.stringContaining("<cyrene_compaction_checkpoint>"), "新回答".repeat(20), "最新问题"]);
  });

  it("checkpoint durable 后 archive IO 失败只隔离归档且压缩仍成功", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const archive = new ConversationTranscriptArchive(fixture.store);
    vi.spyOn(archive, "archiveThrough").mockRejectedValue(new Error("ARCHIVE_IO_FAILURE"));
    const compactor = new ConversationTranscriptCompactor({
      store: fixture.store,
      summarize: async () => "summary",
      archive,
    });
    const result = await compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });
    expect(result.checkpointEntryId).toBeTruthy();
    expect((await fixture.journal.buildModelContext("c1")).messages[0]?.content)
      .toContain("<cyrene_compaction_checkpoint>");
  });

  it("压缩阶段回调成对触发：摘要前 running、结束后 finished", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const phases: Array<{ phase: string; conversationId: string }> = [];
    const compactor = new ConversationTranscriptCompactor({
      store: fixture.store,
      summarize: async () => "summary",
      onPhase: (phase, conversationId) => phases.push({ phase, conversationId }),
    });

    await compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 });

    expect(phases).toEqual([
      { phase: "running", conversationId: "c1" },
      { phase: "finished", conversationId: "c1" },
    ]);
  });

  it("摘要失败时仍补发 finished，呼吸提示不会卡在运行中", async () => {
    const fixture = createFixture();
    await seed(fixture);
    const phases: string[] = [];
    const compactor = new ConversationTranscriptCompactor({
      store: fixture.store,
      summarize: async () => { throw new Error("provider down"); },
      onPhase: (phase) => phases.push(phase),
    });

    await expect(compactor.compact({ conversationId: "c1", trigger: "automatic", retainTokens: 1 }))
      .rejects.toThrow("TRANSCRIPT_COMPACTION_REQUIRED");
    expect(phases).toEqual(["running", "finished"]);
  });

  it("摘要生成期间取消后不提交检查点", async () => {
    const fixture = createFixture();
    await seed(fixture);
    fixture.pause();
    const controller = new AbortController();
    const pending = fixture.compactor.compact({
      conversationId: "c1", trigger: "automatic", retainTokens: 1, signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await fixture.summaryStarted;
    controller.abort();
    fixture.resume("取消后的摘要");
    await rejected;
    expect((await fixture.store.read("c1")).entries.some((entry) => entry.kind === "compaction_checkpoint")).toBe(false);
  });

  it("第一次压缩归档后仍可按热分支完成第二次压缩", async () => {
    const fixture = createFixture();
    await seed(fixture);
    await fixture.compactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });
    await fixture.journal.appendUser("c1", { turnId: "u3", id: "u3", text: "第二轮问题".repeat(30) });
    await fixture.journal.appendUser("c1", { turnId: "u4", id: "u4", text: "第三轮问题".repeat(30) });
    // 记录每次摘要输入，验证二次压缩不会静默丢弃第一次摘要
    const summarizeInputs: string[] = [];
    const recordingCompactor = new ConversationTranscriptCompactor({
      store: fixture.store,
      summarize: async (history) => {
        summarizeInputs.push(history.map((message) => String(message.content ?? "")).join("\n"));
        return "二次摘要";
      },
    });
    const second = await recordingCompactor.compact({ conversationId: "c1", trigger: "manual", retainTokens: 1 });
    expect(second.checkpointEntryId).toBeTruthy();
    // 第二次摘要输入必须包含第一次摘要文本：旧摘要代表的历史不能从模型视图消失
    expect(summarizeInputs.at(-1)).toContain("保留的摘要");
    const finalContext = await fixture.journal.buildModelContext("c1");
    expect(finalContext.messages[0]?.content).toContain("<cyrene_compaction_checkpoint>");
    expect(finalContext.messages[0]?.content).toContain("二次摘要");
  });
});

describe("压缩失败诊断", () => {
  it("重复归一化保留原始失败原因与 cause，界面不显示含密钥的供应商正文", () => {
    const secret = "sk-compaction-test-secret";
    const cause = new AgentRuntimeError("E_MODEL_HTTP_ERROR", `HTTP 401 apiKey=${secret}`, {
      modelFailure: { provider: "relay", model: "fixture", category: "AUTH", status: 401 },
    });
    const error = createTranscriptCompactionRequiredError(cause, "model_request_failed");
    expect(error.message).toBe("TRANSCRIPT_COMPACTION_REQUIRED");
    expect(error.cause).toBe(cause);
    expect(createTranscriptCompactionRequiredError(error)).toBe(error);
    const display = getTranscriptCompactionDisplayMessage(error);
    expect(display).toContain("认证或权限");
    expect(display).toContain("原始会话记录已保留");
    expect(display).not.toContain(secret);
    expect(display).not.toContain("apiKey=");
  });

  it("未知供应商错误与旧版机器码也只显示安全文案", () => {
    const error = createTranscriptCompactionRequiredError(new Error("Authorization: Bearer sk-secret"), "model_request_failed");
    expect(getTranscriptCompactionDisplayMessage(error)).toContain("摘要模型请求失败");
    expect(getTranscriptCompactionDisplayMessage(error)).not.toContain("sk-secret");
    expect(getTranscriptCompactionDisplayMessage(new Error("TRANSCRIPT_COMPACTION_REQUIRED"))).toContain("请重试");
    expect(getTranscriptCompactionDisplayMessage(new Error("other failure"))).toBeUndefined();
  });
});
