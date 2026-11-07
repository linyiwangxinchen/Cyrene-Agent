import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelationshipLogStore } from "./relationship-log-core";

describe("assistant commitment ledger", () => {
  afterEach(() => vi.useRealTimers());
  it("persists commitments, exposes open promises in context, and records evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-commitments-"));
    const store = new RelationshipLogStore(path.join(root, "relationship-log.json"));
    const created = await store.command({ type: "commitment_save", expectedRevision: 1, promise: "明天把报告整理成 PDF", conversationId: "chat-1", dueAt: Date.now() + 60_000 });
    const item = created.commitments?.[0];
    expect(item).toMatchObject({ promise: "明天把报告整理成 PDF", status: "open", conversationId: "chat-1" });
    expect(await store.buildContext("chat-1")).toContain("助手承诺账本");
    expect(await store.buildContext("chat-2")).not.toContain("报告整理成 PDF");
    const fulfilled = await store.command({ type: "commitment_status", expectedRevision: created.revision, id: item!.id, status: "fulfilled", evidence: "已生成并附在当前会话" });
    expect(fulfilled.commitments?.[0]).toMatchObject({ status: "fulfilled", evidence: "已生成并附在当前会话" });
    expect(await store.buildContext("chat-1")).not.toContain("报告整理成 PDF");
  });

  it("removes conversation commitments when a conversation is forgotten", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-commitments-forget-"));
    const store = new RelationshipLogStore(path.join(root, "relationship-log.json"));
    await store.command({ type: "commitment_save", expectedRevision: 1, promise: "只在这个会话里跟进", conversationId: "chat-1" });
    await store.forgetConversation("chat-1");
    expect((await store.snapshot()).commitments).toEqual([]);
  });

  it("captures explicit assistant promises once and marks overdue commitments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-commitments-auto-"));
    const store = new RelationshipLogStore(path.join(root, "relationship-log.json"));
    const input = { userText: "请继续", assistantText: "我会在明天整理这份报告。", channel: "web" as const, conversationId: "chat-1", sourceEventId: "turn-1" };
    await store.recordTurn(input);
    await store.recordTurn({ ...input, sourceEventId: "turn-2" });
    expect((await store.snapshot()).commitments).toHaveLength(1);
    const current = await store.snapshot();
    vi.useFakeTimers();
    const dueAt = Date.now() + 60_000;
    await store.command({ type: "commitment_save", expectedRevision: current.revision, promise: "今天完成", dueAt });
    vi.setSystemTime(dueAt + 1);
    const due = await store.snapshot();
    expect(due.commitments?.[0]?.status).toBe("overdue");
  });
});
