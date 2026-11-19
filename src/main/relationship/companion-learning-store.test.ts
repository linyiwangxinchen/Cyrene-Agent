import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelationshipLogStore } from "./relationship-log-core";

describe("learning how to reply in a private chat", () => {
  let directory: string;
  let file: string;
  let store: RelationshipLogStore;
  let sequence: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-style-"));
    file = path.join(directory, "relationship-log.json");
    store = new RelationshipLogStore(file);
    sequence = 0;
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function turn(text: string, userTurnId: string, options: { revision?: number; privateContext?: boolean; conversationId?: string } = {}) {
    return store.recordTurn({
      userText: "聊天记录里的内容", assistantText: "好。", cyreneFeeling: "平静", channel: "desktop",
      conversationId: options.conversationId ?? "private-one", privateContext: options.privateContext,
      runId: `run-${++sequence}`,
      companionFeedback: { text, userTurnId, revision: options.revision ?? store.getControls().learningRevision },
    });
  }

  const lesson = "【这段私聊的表达习惯】";
  const style = (id = "private-one", current = "嗯嗯") => store.buildContext(id, true, current, true);

  it("requires two separate reactions and keeps the resulting preference after restart", async () => {
    await turn("回复短一点", "first");
    await turn("回复短一点", "first");
    expect((await store.snapshot()).learnedPreferences).toEqual([]);
    expect(await style()).not.toContain(lesson);
    await turn("回复短一点", "second");

    store = new RelationshipLogStore(file);
    expect((await store.snapshot()).learnedPreferences).toMatchObject([{ conversationId: "private-one", topic: "length" }]);
    expect(await style()).toContain("日常接话短一点");
    expect(await style("private-two")).not.toContain(lesson);
    expect(await store.buildContext("private-one")).not.toContain(lesson);
    expect(await store.buildContext("private-one", false, "嗯嗯", true)).toBe("");
    expect(await store.exportData()).not.toContain("回复短一点");
  });

  it("applies a durable request immediately and respects a later reversal", async () => {
    await turn("以后少问一点", "first");
    expect(await style()).toContain("少用问句收尾");
    expect(await style("private-one", "以后可以追问我")).not.toContain(lesson);
    await turn("以后可以追问我", "second");
    expect((await store.snapshot()).learnedPreferences).toEqual([]);
  });

  it("stops learning while disabled, rejects stale completions and supports scoped deletion", async () => {
    await turn("以后少问一点", "first");
    await turn("以后回复短一点", "second", { conversationId: "private-two" });
    const oldRevision = store.getControls().learningRevision;
    await store.updatePreferences({ learnConversationStyle: false });
    await turn("以后回复短一点", "third");
    expect(await style()).not.toContain(lesson);
    await store.updatePreferences({ learnConversationStyle: true });
    await turn("以后回复短一点", "fourth", { revision: oldRevision });
    await turn("以后回复短一点", "group", { privateContext: false });
    expect(await style()).not.toContain("日常接话短一点");
    const { revision } = await store.snapshot();
    await store.command({ type: "forget_learned_preference", conversationId: "private-one", topic: "questions", expectedRevision: revision });
    expect(await style()).not.toContain(lesson);
    expect(await style("private-two")).toContain("日常接话短一点");
    await store.forgetConversation("private-two");
    expect((await store.snapshot()).learnedPreferences).toEqual([]);
  });

  it("removes evidence when its source turns are rewritten, deleted or reset", async () => {
    await turn("回复短一点", "first");
    await turn("回复短一点", "second");
    store.retainCompanionFeedbackTurns("private-one", new Set(["first"]));
    expect(await style()).not.toContain(lesson);

    const source = await turn("以后少问一点", "third");
    const { revision } = await store.snapshot();
    await store.command({ type: "delete_record", expectedRevision: revision, id: source!.id });
    expect(await style()).not.toContain(lesson);

    await turn("以后少问一点", "fourth");
    const reset = await store.snapshot();
    await store.command({ type: "reset_relationship", expectedRevision: reset.revision });
    expect((await store.snapshot()).learnedPreferences).toEqual([]);
  });
});
