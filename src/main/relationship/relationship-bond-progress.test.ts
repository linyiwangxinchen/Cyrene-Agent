import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelationshipLogStore } from "./relationship-log-core";

describe("RelationshipLogStore bond progress", () => {
  let root = "";
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("persists one award across retries and restart", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bond-progress-"));
    const file = path.join(root, "relationship-log.json");
    const event = {
      eventId: "goal-1",
      kind: "goal_progressed" as const,
      source: "desktop" as const,
      occurredAt: Date.now(),
      summary: "完成共同目标",
    };
    const store = new RelationshipLogStore(file);
    const first = await store.recordCompanionEvent(event);
    const retry = await store.recordCompanionEvent(event);
    expect(first.bondProgress?.score).toBe(8);
    expect(retry.bondProgress?.score).toBe(8);

    const restarted = new RelationshipLogStore(file);
    expect((await restarted.snapshot()).bondProgress?.score).toBe(8);
  });

  it("supports explicit reset without changing permissions", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bond-progress-reset-"));
    const store = new RelationshipLogStore(path.join(root, "relationship-log.json"));
    await store.recordCompanionEvent({
      eventId: "repair-1", kind: "repair_acknowledged", source: "desktop",
      occurredAt: Date.now(), summary: "完成一次修复",
    });
    const before = await store.snapshot();
    const reset = await store.command({ type: "reset_bond_progress", expectedRevision: before.revision });
    expect(reset.bondProgress?.score).toBe(0);
    expect(reset.permissions).toEqual(before.permissions);
  });

  it("awards explicit shared goals once without rewarding ordinary preference saves", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bond-progress-preferences-"));
    const store = new RelationshipLogStore(path.join(root, "relationship-log.json"));
    const initial = await store.snapshot();
    const first = await store.command({
      type: "preferences",
      expectedRevision: initial.revision,
      patch: { sharedGoals: ["一起完成一个小项目"] },
    });
    expect(first.bondProgress?.score).toBe(8);
    const repeated = await store.command({
      type: "preferences",
      expectedRevision: first.revision,
      patch: { sharedGoals: ["一起完成一个小项目"] },
    });
    expect(repeated.bondProgress?.score).toBe(8);
  });
});
