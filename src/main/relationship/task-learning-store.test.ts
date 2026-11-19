import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompanionTaskMethod } from "../../shared/companion";
import { RelationshipLogStore } from "./relationship-log-core";

describe("workspace task experience", () => {
  let directory: string;
  let file: string;
  let store: RelationshipLogStore;
  const workspace = "workspace-a";
  const task = "read-document";
  const method = "read-direct";
  const lessons = () => store.getTaskLessons(workspace, task);

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-methods-"));
    file = path.join(directory, "relationship-log.json");
    store = new RelationshipLogStore(file);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function observe(userTurnId: string, overrides: Partial<Parameters<RelationshipLogStore["recordTaskObservation"]>[0]> = {}) {
    store.recordTaskObservation({
      workspaceKey: workspace, conversationId: "first-chat", userTurnId, task, method, outcome: "worked",
      revision: store.getTaskLearningRevision() ?? 0, ...overrides,
    });
  }

  function confirm(withMethod: CompanionTaskMethod = method, workspaceKey = workspace) {
    for (const turn of ["1", "2"]) observe(`${withMethod}-${turn}`, { method: withMethod, workspaceKey });
  }

  it("deduplicates a replay, transfers between chats in one workspace, and persists only bounded evidence fields", async () => {
    observe("first-turn");
    observe("first-turn");
    expect(lessons()).toEqual([]);
    const observation = {
      workspaceKey: workspace, conversationId: "second-chat", userTurnId: "first-turn", task, method,
      outcome: "worked" as const, revision: store.getTaskLearningRevision()!, output: "不应保存的工具输出",
    };
    store.recordTaskObservation(observation);

    store = new RelationshipLogStore(file);
    expect(lessons()).toMatchObject([{ workspaceKey: workspace, task, method, confirmations: 2 }]);
    expect(store.getTaskLessons("workspace-b", task)).toEqual([]);
    expect(store.getTaskLessons(workspace, "find-content")).toEqual([]);
    expect(await store.exportData()).not.toContain(observation.output);
  });

  it("ranks the latest method first on a tie and revises it after a miss", () => {
    confirm();
    confirm("list-then-read");
    expect(lessons().map(lesson => lesson.method)).toEqual(["list-then-read", method]);

    observe("miss", { method: "list-then-read", outcome: "missed" });
    expect(lessons().map(lesson => lesson.method)).toEqual([method]);
    observe("retry", { method: "list-then-read" });
    expect(lessons().map(lesson => lesson.method)).toEqual(["list-then-read", method]);
  });

  it("does not record or use experience while disabled and rejects stale runs after settings changes", async () => {
    confirm();
    const initialRevision = store.getTaskLearningRevision();
    await store.updatePreferences({ learnConversationStyle: false });
    expect(store.getTaskLearningRevision()).toBe(initialRevision);
    await store.updatePreferences({ learnTaskMethods: false });
    expect(store.getTaskLearningRevision()).toBeUndefined();
    expect(lessons()).toEqual([]);
    expect((await store.snapshot()).taskLessons).toMatchObject([{ confirmations: 2 }]);
    observe("disabled", { revision: initialRevision });
    await store.updatePreferences({ learnTaskMethods: true });
    observe("stale", { revision: initialRevision });
    expect(lessons()).toMatchObject([{ confirmations: 2 }]);

    await store.updatePreferences({ recordHistory: false });
    expect(store.getTaskLearningRevision()).toBeUndefined();
    await store.updatePreferences({ recordHistory: true, paused: true });
    expect(store.getTaskLearningRevision()).toBeUndefined();
  });

  it("forgets a method without reviving pending evidence from an earlier run", async () => {
    confirm();
    confirm("list-then-read");
    confirm(method, "workspace-b");
    const previousLearningRevision = store.getTaskLearningRevision();
    const { revision } = await store.snapshot();
    await store.command({ type: "forget_task_method", expectedRevision: revision, workspaceKey: workspace, task, method });
    observe("stale", { revision: previousLearningRevision });
    observe("new-turn");

    expect(lessons()).toMatchObject([{ method: "list-then-read", confirmations: 2 }]);
    expect(store.getTaskLessons("workspace-b", task)).toMatchObject([{ method, confirmations: 2 }]);
  });

  it("recalculates experience when a source turn is edited or a source chat is deleted", async () => {
    observe("first");
    observe("edited");
    observe("deleted", { conversationId: "deleted-chat" });
    const previousLearningRevision = store.getTaskLearningRevision();
    store.retainCompanionFeedbackTurns("first-chat", new Set(["first"]));
    observe("stale", { revision: previousLearningRevision });
    expect(lessons()).toMatchObject([{ confirmations: 2 }]);
    await store.forgetConversation("deleted-chat");
    expect(lessons()).toEqual([]);

    observe("new");
    const { revision } = await store.snapshot();
    await store.command({ type: "clear_history", expectedRevision: revision });
    observe("after-clear");
    expect(lessons()).toEqual([]);
  });
});
