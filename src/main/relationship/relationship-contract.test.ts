import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelationshipLogStore } from "./relationship-log-core";

describe("relationship contract and event bridge", () => {
  let root = "";
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function makeStore() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "relationship-contract-"));
    return new RelationshipLogStore(path.join(root, "relationship-log.json"));
  }

  it("keeps the selected relationship mode explicit and permission independent", async () => {
    const store = makeStore();
    const initial = await store.snapshot();
    const next = await store.command({
      type: "preferences",
      expectedRevision: initial.revision,
      patch: { relationshipMode: "partner", affection: true },
    });
    expect(next.relationship.relationshipMode).toBe("partner");
    expect(next.permissions).toEqual(initial.permissions);
    expect(await store.buildContext()).toContain("关系契约：partner");
  });

  it("tracks a repair from acknowledgement through resolution", async () => {
    const store = makeStore();
    const initial = await store.snapshot();
    const created = await store.command({
      type: "repair",
      expectedRevision: initial.revision,
      note: "先回答问题，再询问感受",
      conversationId: "chat-1",
    });
    expect(created.repairCases?.[0]).toMatchObject({ status: "acknowledged", note: "先回答问题，再询问感受" });
    const caseId = created.repairCases?.[0]?.id;
    if (!caseId) throw new Error("repair id missing");
    const resolved = await store.command({
      type: "repair_status",
      expectedRevision: created.revision,
      id: caseId,
      status: "resolved",
      resolutionNote: "已经按约定调整",
    });
    expect(resolved.repairCases?.[0]).toMatchObject({ status: "resolved", resolutionNote: "已经按约定调整" });
    expect(await store.buildContext("chat-1")).not.toContain("当前修复事项");
  });

  it("bridges explicit goal and milestone mentions into affect and bond events", async () => {
    const store = makeStore();
    const initial = await store.snapshot();
    const configured = await store.command({
      type: "preferences",
      expectedRevision: initial.revision,
      patch: { sharedGoals: ["一起完成小项目"], milestones: ["第一次发布"] },
    });
    const before = configured.affect;
    await store.recordTurn({
      userText: "我们一起完成小项目了，第一次发布也顺利完成！",
      assistantText: "记下这个共同的进展。",
      cyreneFeeling: "开心",
      channel: "desktop",
      conversationId: "chat-1",
    });
    const after = await store.snapshot();
    expect(after.bondProgress?.score).toBeGreaterThan(configured.bondProgress?.score ?? 0);
    expect(after.affect.valence).toBeGreaterThan(before.valence);
    expect(after.affect.warmth).toBeGreaterThan(before.warmth);
  });
});
