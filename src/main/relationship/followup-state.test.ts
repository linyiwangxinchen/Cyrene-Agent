import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { RelationshipLogStore } from "./relationship-log-core";
import { resolveExplicitFollowupReply } from "./followup-state";
import { followupOpportunities } from "../proactive/followup-opportunities";
import { createDefaultProactiveState } from "../proactive/proactive-policy";
import type { ProactiveTriggerContext } from "../proactive/proactive-trigger";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "followups-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "relationship.json");
  return { file, store: new RelationshipLogStore(file) };
}
const context = (now: number): ProactiveTriggerContext => ({ now, timezone: "UTC", localDate: "2026-11-04", localHour: 14, localMinute: 0,
  snapshot: { now, localHour: 14, enabled: true, screenLocked: false, conversationBusy: false, generationBusy: false, idleSec: 600 },
  state: createDefaultProactiveState(), previousIdleSec: null, activeSessionStartedAt: null, weather: null, conversationLastActivity: now });

describe("explicit companion followups", () => {
  it("migrates empty, persists edits/status after restart, and rejects stale commands", async () => {
    const { file, store } = fixture();
    expect((await store.snapshot()).followups).toEqual([]);
    const first = await store.command({ type: "followup_save", expectedRevision: 1, topic: "论文答辩", conversationId: "bound", nextEligibleAt: Date.now() + 60_000 });
    const item = first.followups![0];
    expect(item.status).toBe("active");
    await expect(store.command({ type: "followup_status", expectedRevision: first.revision - 1, id: item.id, conversationId: "bound", status: "completed" })).rejects.toThrow("重新加载");
    await expect(store.command({ type: "followup_status", expectedRevision: first.revision, id: item.id, conversationId: "other", status: "completed" })).rejects.toThrow("跟进事项不存在");
    const paused = await store.command({ type: "followup_status", expectedRevision: first.revision, id: item.id, conversationId: "bound", status: "paused" });
    const reopened = new RelationshipLogStore(file);
    expect((await reopened.snapshot()).followups?.[0].status).toBe("paused");
    await expect(reopened.command({ type: "followup_status", expectedRevision: paused.revision, id: item.id, conversationId: "bound", status: "active" })).rejects.toThrow("未来时间");
    await reopened.command({ type: "followup_status", expectedRevision: paused.revision, id: item.id, conversationId: "bound", status: "active", nextEligibleAt: Date.now() + 120_000 });
    expect((await reopened.snapshot()).followups?.[0].status).toBe("active");
  });

  it("only considers enabled, due active items for the destination and asks at most once until rearmed", async () => {
    const { store } = fixture();
    await store.updatePreferences({ proactiveLifeEnabled: true });
    const snapshot = await store.command({ type: "followup_save", expectedRevision: 2, topic: "论文答辩", conversationId: "bound", nextEligibleAt: Date.now() + 60_000 });
    const item = snapshot.followups![0];
    const ctx = context(item.nextEligibleAt + 1);
    expect(followupOpportunities(snapshot.followups!, snapshot.relationship, "other", ctx)).toEqual([]);
    expect(followupOpportunities(snapshot.followups!, { ...snapshot.relationship, proactiveLifeEnabled: false }, "bound", ctx)).toEqual([]);
    expect(followupOpportunities(snapshot.followups!, snapshot.relationship, "bound", context(item.nextEligibleAt - 1))).toEqual([]);
    expect(followupOpportunities(snapshot.followups!, snapshot.relationship, "bound", ctx)).toHaveLength(1);
    await store.settleFollowup(item.id, "bound", "intent-1", ctx.now, "asked");
    const asked = await store.snapshot();
    expect(asked.followups![0]).toMatchObject({ status: "awaiting_reply", lastAskedAt: ctx.now });
    expect(followupOpportunities(asked.followups!, asked.relationship, "bound", context(ctx.now + 7 * 86_400_000))).toEqual([]);
    await store.settleFollowup(item.id, "bound", "intent-1", ctx.now + 10, "asked");
    expect((await store.snapshot()).revision).toBe(asked.revision);
  });

  it("only closes explicit statements in the bound private conversation", async () => {
    const { store } = fixture();
    const initial = await store.command({ type: "followup_save", expectedRevision: 1, topic: "论文答辩", conversationId: "bound", nextEligibleAt: Date.now() + 60_000 });
    const input = { userText: "论文答辩已完成", assistantText: "收到", channel: "wechat" as const, cyreneFeeling: "平静" };
    await store.recordTurn({ ...input, conversationId: "other" });
    await store.recordTurn({ ...input, conversationId: "bound", privateContext: false });
    expect((await store.snapshot()).followups![0].status).toBe("active");
    await store.recordTurn({ ...input, conversationId: "bound" });
    expect((await store.snapshot()).followups![0]).toMatchObject({ id: initial.followups![0].id, status: "completed", resolutionReason: expect.stringContaining("明确") });
  });

  it("pauses unknown delivery and does not infer ambiguous or quoted completion", async () => {
    const { store } = fixture();
    const snapshot = await store.command({ type: "followup_save", expectedRevision: 1, topic: "论文答辩", conversationId: "bound", nextEligibleAt: Date.now() + 60_000 });
    await store.settleFollowup(snapshot.followups![0].id, "bound", "unknown-intent", Date.now(), "unknown");
    expect((await store.snapshot()).followups![0].status).toBe("paused");
    for (const text of ["已经完成了", "论文答辩没完成", "论文答辩完成了吗", "他说论文答辩完成了", "“论文答辩已完成”是标题"]) expect(resolveExplicitFollowupReply("论文答辩", text)).toBeUndefined();
    expect(resolveExplicitFollowupReply("论文答辩", "论文答辩不要再问了")).toBe("cancelled");
    expect(resolveExplicitFollowupReply("论文答辩", "不要再问论文答辩")).toBe("cancelled");
  });
});
