import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { closeConversationDatabases } from "../storage/conversation-database-client";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { ConversationJournalService } from "./conversation-journal-service";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import { executeUpdateTodo } from "./harness/builtin-tools";
import { validateTaskContinuity, buildTaskContinuityContext, type TaskContinuity } from "./harness/task-continuity";
import { materializeHarnessStartTranscript } from "./harness/adapter/prompt-builder";
import type { AgentState } from "./harness/types";
import { validateLoadedTranscriptEntry } from "./conversation-transcript-validation";

const notes: TaskContinuity = { goal: "整理报告并通过微信发给用户", constraints: ["先核对原图，不凭空造图"], artifacts: ["/storage/report.pdf：文件存在，尚未确认发送"], openQuestions: ["收件端是否已经收到？"], nextStep: "先查询投递记录，不重复发送未知结果的附件" };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-continuity-"));
  onTestFinished(async () => { await closeConversationDatabases(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new ConversationTranscriptStore(root);
  const journal = new ConversationJournalService(store);
  return { root, store, journal };
}

async function appendTask(journal: ConversationJournalService, conversationId: string, runId: string, continuity?: TaskContinuity) {
  const sink = journal.createRunSink({ conversationId, runId, assistantTurnId: `${runId}-assistant` });
  const assistantEntryId = await sink.appendAssistant({ message: { role: "assistant", content: "工作记录", toolCalls: [{ id: "todo", name: "update_todo", arguments: "{}" }] } });
  await sink.appendTaskState!({ assistantEntryId, toolCallId: "todo", items: [{ id: "check", content: "检查发送结果", status: "pending" }], ...(continuity ? { continuity } : {}) });
  await sink.appendToolResult({ assistantEntryId, message: { role: "tool", toolCallId: "todo", content: "工作记录已更新" }, outcome: "success" });
}

describe("task continuity using canonical task_state", () => {
  it("validates persisted task_state and checkpoint notes while accepting old rows", () => {
    const rows = [
      { id: "task", seq: 1, at: 1, kind: "task_state", payload: { assistantEntryId: "assistant", toolCallId: "todo", items: [] } },
      { id: "checkpoint", seq: 1, at: 1, kind: "compaction_checkpoint", payload: { baseThroughSeq: 0, sourceThroughSeq: 0, sourceDigest: "digest", trigger: "manual", replacement: { role: "assistant", content: "summary" }, recoveryState: { uncertainEffects: [] } } },
    ];
    for (const row of rows) {
      expect(() => validateLoadedTranscriptEntry(row)).not.toThrow();
      const set = (continuity: unknown) => row.kind === "task_state" ? { ...row, payload: { ...row.payload, continuity } }
        : { ...row, payload: { ...row.payload, recoveryState: { uncertainEffects: [], continuity } } };
      expect(() => validateLoadedTranscriptEntry(set(notes))).not.toThrow();
      for (const invalid of [null, {}, { ...notes, goal: null }, { ...notes, nextStep: "x".repeat(1001) }, { ...notes, artifacts: [5] }]) {
        expect(() => validateLoadedTranscriptEntry(set(invalid))).toThrow("TRANSCRIPT_CORRUPT_ROW");
      }
    }
  });
  it("validates bounded notes, preserves omitted notes, and rolls back a failed durable mutation", async () => {
    const state: AgentState = { todoItems: [], uncertainEffects: [], continuity: notes };
    const persist = vi.fn(async () => undefined);
    const call = (args: object) => ({ id: "todo", name: "update_todo", arguments: JSON.stringify(args) });
    await executeUpdateTodo(call({ todos: [] }), state, undefined, persist);
    expect(state.continuity).toEqual(notes);
    expect(persist).toHaveBeenCalledWith([], notes);
    const previousItems = state.todoItems;
    await expect(executeUpdateTodo(call({ todos: [{ id: "new", content: "new", status: "pending" }], continuity: { goal: "新目标" } }), state, undefined,
      async () => { throw new Error("disk unavailable"); })).rejects.toThrow("disk unavailable");
    expect(state.todoItems).toBe(previousItems);
    expect(state.continuity).toBe(notes);
    const invalid = await executeUpdateTodo(call({ todos: [], continuity: { nextStep: "x".repeat(1001) } }), state);
    expect(invalid.outcome).toBe("failure");
    expect(state.continuity).toBe(notes);
    expect(() => validateTaskContinuity({ permissionMode: "allow_all" })).toThrow("未知字段");
  });

  it("keeps notes across compaction, database restart and an old-format todo-only update", async () => {
    const { root, store, journal } = fixture();
    await journal.appendUser("channel", { turnId: "initial", text: "长期任务原文".repeat(150) });
    await appendTask(journal, "channel", "first", notes);
    await journal.appendUser("channel", { turnId: "continue", text: "继续处理" });
    await appendTask(journal, "channel", "todo-only");
    await journal.appendUser("channel", { turnId: "current", text: "下一步" });
    await new ConversationTranscriptCompactor({ store, summarize: async () => "报告已准备，发送状态待核对" }).compact({ conversationId: "channel", trigger: "manual", retainTokens: 1 });
    await closeConversationDatabases();
    const reopened = new ConversationJournalService(new ConversationTranscriptStore(root));
    const context = await reopened.buildModelContext("channel");
    expect(context.continuity).toEqual(notes);
    expect(JSON.stringify(context.messages)).not.toContain("长期任务原文");
    const messages = materializeHarnessStartTranscript({ messages: context.messages, runId: "resume", kind: "recovery", initialState: { todoItems: context.todoItems ?? [], uncertainEffects: context.uncertainEffects, continuity: context.continuity } });
    expect(messages.at(-1)?.content).toContain(notes.nextStep);
    expect(messages.at(-1)?.content).toContain('authorization="none"');
    expect(buildTaskContinuityContext(context.continuity)).toContain("权限仍由运行时决定");
    expect((await reopened.buildModelContext("different-conversation")).continuity).toBeUndefined();
  });

  it("does not inherit notes from a rewound branch and supports explicit clearing", async () => {
    const { journal } = fixture();
    await journal.appendUser("branch", { turnId: "first", text: "任务一" });
    await appendTask(journal, "branch", "base", notes);
    await journal.appendUser("branch", { turnId: "branch-start", text: "换一个任务" });
    await appendTask(journal, "branch", "discarded", { ...notes, goal: "被撤销的分支" });
    await journal.appendRewind("branch", { anchorUserTurnId: "branch-start", disposition: "keep_user", runId: "rewind" });
    expect((await journal.buildModelContext("branch")).continuity).toEqual(notes);
    await appendTask(journal, "branch", "clear", validateTaskContinuity({}));
    expect((await journal.buildModelContext("branch")).continuity?.goal).toBe("");
    expect((await journal.buildModelContext("branch")).continuity?.artifacts).toEqual([]);
  });
});
