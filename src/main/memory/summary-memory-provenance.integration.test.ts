import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord, SummaryMemoryPendingTurn } from "../../shared/chat-types";
import { getConversationDatabase } from "../storage/conversation-database-client";
import { summarizeMemory } from "./summary-memory-llm";
import { loadSummaryMemoryContext } from "./summary-memory-context";
import { resolveSummaryMemoryPaths } from "./summary-memory-paths";
import { readSummaryFile, writeSummaryFileAtomic } from "./summary-memory-store";
import { disposeSummaryMemoryScheduler, initializeSummaryMemoryScheduler } from "./summary-memory-scheduler";
import { memorySourceKey } from "./memory-source-policy";

const fixture = vi.hoisted(() => ({ forgotten: [] as string[] }));
vi.mock("./memory-mode", () => ({ isSummaryMemoryEnabled: () => true }));
vi.mock("./summary-memory-llm", () => ({ summarizeMemory: vi.fn() }));
vi.mock("./memory-store", () => ({ memoryStore: {
  load: async () => ({ forgetting: { sourceKeys: fixture.forgotten } }),
} }));

describe("source-backed summary memory", () => {
  let root: string;
  let pending: Map<string, SummaryMemoryPendingTurn[]>;
  let mode: "chat" | "work";
  const sessions = {
    getSessionRecord: async (id: string) => ({
      id, mode, ...(mode === "work" ? { workspaceBinding: { workspaceRoot: path.join(root, "workspace") } } : {}),
    } as ChatSessionRecord),
    getSummaryMemoryProgress: (id: string) => ({ pendingTurns: pending.get(id) ?? [] }),
    appendSummaryMemoryTurn: (id: string, turn: SummaryMemoryPendingTurn) => {
      pending.set(id, [...pending.get(id) ?? [], turn]);
      return true;
    },
    markSummaryMemoryProcessed: (id: string) => { pending.delete(id); return true; },
    listSessions: () => [],
  };
  function startScheduler() {
    const scheduler = initializeSummaryMemoryScheduler({ userDataRoot: root, sessions });
    scheduler.setEnabled(true);
    return scheduler;
  }
  async function context(id: string) {
    return loadSummaryMemoryContext({ conversationId: id, userDataRoot: root, getSessionRecord: sessions.getSessionRecord });
  }
  async function record(id: string, userTurnId: string, userText: string) {
    const db = getConversationDatabase(root);
    const userEntryId = `user:v1:${userTurnId}:r1`;
    const assistantEntryId = `answer:${userTurnId}`;
    const assistantText = "已收到";
    await db.call("transcript.append", id, { id: userEntryId, kind: "user", turnId: userTurnId, revision: 1, at: 1, payload: { text: userText } });
    await db.call("transcript.append", id, { id: assistantEntryId, kind: "assistant", turnId: `reply:${userTurnId}`, at: 2,
      payload: { role: "assistant", content: assistantText } });
    return { conversationId: id, userTurnId, userEntryId, assistantEntryId, userText, assistantText };
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-summary-provenance-"));
    await fs.mkdir(path.join(root, "workspace"));
    pending = new Map();
    mode = "chat";
    fixture.forgotten = [];
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await disposeSummaryMemoryScheduler();
    await getConversationDatabase(root).close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["regenerate", "edit", "withdraw", "forget"] as const)("suppresses %s sources across worker reopen and rebuilds from an active turn", async action => {
    const scheduler = startScheduler();
    const old = await record("chat", "old", "旧活动在周一");
    await scheduler.scheduleSummaryTurn(old);
    vi.mocked(summarizeMemory).mockResolvedValueOnce({ sessionSummary: old.userText, workspaceSummary: "" });
    await scheduler.flushSummary("chat");
    const original = await context("chat");
    expect(original.runtimeContext).toContain(old.userText);
    expect((await readSummaryFile(original.sessionPath, 800, root)).sources).toEqual([{
      conversationId: old.conversationId, userTurnId: old.userTurnId, userEntryId: old.userEntryId, assistantEntryId: old.assistantEntryId,
    }]);
    const db = getConversationDatabase(root);
    if (action === "regenerate") {
      await db.call("transcript.append", "chat", { id: "regenerate-old", kind: "turn_rewind", at: 3,
        payload: { anchorUserTurnId: old.userTurnId, disposition: "keep_user", reason: "regenerate" } });
    } else if (action === "edit") {
      await db.call("transcript.append", "chat", { id: "run-edit:rewind:old", kind: "turn_rewind", at: 3, turnId: old.userTurnId, revision: 2,
        payload: { anchorUserTurnId: old.userTurnId, disposition: "replace_user", reason: "edit", replacementUser: { text: "新活动在周四" } } });
    } else if (action === "withdraw") {
      await db.call("transcript.append", "chat", { id: "withdraw-old", kind: "turn_tombstone", at: 3,
        payload: { targetUserTurnId: old.userTurnId, reason: "pending_withdrawn" } });
    } else {
      fixture.forgotten = [memorySourceKey({ conversationId: "chat", messageId: old.userEntryId })];
    }
    await db.close();
    const hidden = await context("chat");
    expect(hidden.runtimeContext).not.toContain(old.userText);
    expect(hidden.runtimeContext).not.toContain(original.sessionPath);
    expect(await fs.readFile(original.sessionPath, "utf8")).toContain(old.userText);

    const fresh = action === "edit"
      ? { ...old, userEntryId: "run-edit:rewind:old", assistantEntryId: "answer:edited", userText: "新活动在周四" }
      : await record("chat", "fresh", "新活动在周四");
    if (action === "edit") await db.call("transcript.append", "chat", { id: fresh.assistantEntryId, kind: "assistant", turnId: "reply:edited", at: 4,
      payload: { role: "assistant", content: fresh.assistantText } });
    const restarted = startScheduler();
    await restarted.scheduleSummaryTurn(fresh);
    vi.mocked(summarizeMemory).mockResolvedValueOnce({ sessionSummary: fresh.userText, workspaceSummary: "" });
    await restarted.flushSummary("chat");
    expect(summarizeMemory).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionSummary: "", turns: [{ userText: fresh.userText, assistantText: fresh.assistantText }],
    }));
    expect((await context("chat")).runtimeContext).toContain(fresh.userText);
  });

  it("tracks inputs carried from a shared workspace to a different session", async () => {
    mode = "work";
    const scheduler = startScheduler();
    const a = await record("a", "a", "来自会话甲的旧会议决定");
    const b = await record("b", "b", "来自会话乙的行动细节");
    await scheduler.scheduleSummaryTurn(a);
    vi.mocked(summarizeMemory).mockResolvedValueOnce({ sessionSummary: a.userText, workspaceSummary: a.userText });
    await scheduler.flushSummary("a");
    await scheduler.scheduleSummaryTurn(b);
    vi.mocked(summarizeMemory).mockImplementationOnce(async ({ workspaceSummary }) => ({
      sessionSummary: workspaceSummary + b.userText, workspaceSummary,
    }));
    await scheduler.flushSummary("b");
    expect((await context("b")).sessionContent).toContain(a.userText);
    await getConversationDatabase(root).call("transcript.append", "a", { id: "rewind-a", kind: "turn_rewind", at: 3,
      payload: { anchorUserTurnId: "a", disposition: "keep_user", reason: "regenerate" } });
    const bContext = await context("b");
    expect(bContext.sessionContent).toBe("");
    expect(bContext.workspaceContent).toBe("");
    expect(bContext.runtimeContext).not.toContain(a.userText);
  });

  it("keeps a valid pending batch retryable when an inherited source is withdrawn during generation", async () => {
    mode = "work";
    const scheduler = startScheduler();
    const a = await record("a", "a", "旧共享范围");
    const b = await record("b", "b", "新来源仍有效");
    await scheduler.scheduleSummaryTurn(a);
    vi.mocked(summarizeMemory).mockResolvedValueOnce({ sessionSummary: a.userText, workspaceSummary: a.userText });
    await scheduler.flushSummary("a");
    await scheduler.scheduleSummaryTurn(b);
    const response = Promise.withResolvers<{ sessionSummary: string; workspaceSummary: string }>();
    vi.mocked(summarizeMemory).mockReturnValueOnce(response.promise);
    const generation = scheduler.flushSummary("b");
    await vi.waitFor(() => expect(summarizeMemory).toHaveBeenCalledTimes(2));
    await getConversationDatabase(root).call("transcript.append", "a", { id: "withdraw-a", kind: "turn_tombstone", at: 4,
      payload: { targetUserTurnId: "a", reason: "pending_withdrawn" } });
    response.resolve({ sessionSummary: a.userText + b.userText, workspaceSummary: a.userText + b.userText });
    await generation;
    expect((await context("b")).sessionContent).toBe("");
    expect(pending.get("b")).toHaveLength(1);
    vi.mocked(summarizeMemory).mockResolvedValueOnce({ sessionSummary: b.userText, workspaceSummary: b.userText });
    await scheduler.flushSummary("b");
    expect(summarizeMemory).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceSummary: "" }));
    expect((await context("b")).workspaceContent).toBe(b.userText);
  });

  it("keeps legacy Markdown compatible and suppresses unrecognised provenance", async () => {
    const { sessionPath } = resolveSummaryMemoryPaths({ conversationId: "legacy", userDataRoot: root });
    const legacy = "已有的手工 Markdown 摘要";
    await writeSummaryFileAtomic(sessionPath, legacy, 800, root);
    expect((await context("legacy")).sessionContent).toBe(legacy);
    await fs.writeFile(sessionPath, `\uFEFF<!-- cyrene-summary-sources-v2:unreadable -->\n${legacy}`);
    expect((await context("legacy")).runtimeContext).not.toContain(legacy);
  });
});
