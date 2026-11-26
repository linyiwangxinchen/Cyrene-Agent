import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelationshipLogStore } from "./relationship-log-core";
import { addDesireSample, desireSignal } from "./partner-desire";
import { desireValue, type DesireSample } from "../../shared/companion";
import type { CompanionReference } from "../../shared/companion-references";

describe("private conversation expressions and partner state", () => {
  let dir: string, file: string, store: RelationshipLogStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cyrene-expression-"));
    file = path.join(dir, "relationship-log.json");
    store = new RelationshipLogStore(file);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const turn = (
    id: string,
    text: string,
    conversationId = "one",
    privateContext = true,
  ) =>
    store.recordTurn({
      companionTurnId: id,
      conversationId,
      privateContext,
      userText: text,
      assistantText: "知道了",
      channel: "desktop",
      cyreneFeeling: "平静",
      runId: id,
    });
  const context = (id: string, text: string) =>
    store.buildContext(id, true, text, true, false);
  it("retains opted-in vocabulary across restart and removes source-backed projections on correction or rewind", async () => {
    await turn("old", "把摄影叫作“星鱼”");
    await store.updatePreferences({ learnPrivateExpressions: true });
    expect(store.privateExpressions()).toEqual([]);
    await turn("first", "以后把夜宵叫作“月亮补给”");
    store = new RelationshipLogStore(file);
    expect(await context("one", "今天吃什么夜宵")).toContain("月亮补给");
    expect(await context("two", "今天吃什么夜宵")).toContain("月亮补给");
    await turn("group", "把大海叫作“蓝豆花”", "group", false);
    expect(store.privateExpressions().map((s) => s.quote)).toEqual([
      "月亮补给",
    ]);
    await turn("second", "以后别用“月亮补给”");
    expect(store.privateExpressions()).toEqual([]);
    expect(store.blockedExpressions("one", "")).toContain("月亮补给");
    expect(store.blockedExpressions("two", "")).toContain("月亮补给");
    store.retainCompanionFeedbackTurns("one", new Set(["first"]));
    expect(store.privateExpressions()).toHaveLength(1);
    await store.forgetConversation("one");
    expect(store.privateExpressions()).toEqual([]);
  });
  it("learns a shared quotation only after two separate private turns", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    await turn("1", "今天开工也要“鱼力全开”");
    expect(store.privateExpressions()).toHaveLength(0);
    await turn("2", "又到开工时间，“鱼力全开”");
    expect(await context("one", "准备开工")).toContain("鱼力全开");
  });
  it("reports only learned context applied to this reply, with the original source turns", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    for (const [id, text] of [
      ["phrase", "以后把夜宵叫作“月亮补给”"],
      ["pref", "以后少问我问题"],
    ]) store.recordAcceptedCompanionFeedback({
      conversationId: "source-chat", userTurnId: id, userEntryId: id, userRevision: 1, speechScope: "owner", channel: "desktop", text,
    });
    const references: CompanionReference[] = [];
    const build = (text: string, scope = "owner") => store.buildContext("chat", true, text, true, false, scope,
      item => references.push(item));
    const prompt = await build("今天吃什么夜宵");
    expect(prompt).toContain("月亮补给");
    expect(prompt).toContain("少用问句收尾");
    expect(references.splice(0)).toEqual([
      { kind: "expression", quote: "月亮补给", conversationId: "source-chat", userTurnId: "phrase" },
      { kind: "preference", topic: "questions", conversationId: "source-chat", userTurnId: "pref" },
    ]);
    await build("以后可以追问我。聊点别的吧。");
    await build("今天吃什么夜宵", "peer:different-account");
    expect(references).toEqual([]);
  });
  it("does not learn an expression from repeated disapproval or mixed historical and current sentiment", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    await turn("one", "我不喜欢‘月亮补给’，这词有点怪。");
    await turn("two", "以前不喜欢‘月亮补给’，现在倒是能接受。");
    await turn("three", "听起来很别扭，尤其是‘月亮补给’。");
    expect(store.privateExpressions()).toEqual([]);
    expect(store.blockedExpressions("one", "")).toEqual([]);
  });
  it("applies direct word corrections without a model response, and can explicitly restore a word", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    const accepted = (id: string, text: string) => store.recordAcceptedCompanionFeedback({
      conversationId: "one", userEntryId: id, userTurnId: id, userRevision: 1, channel: "desktop", speechScope: "owner", text,
    });
    accepted("definition", "以后把宵夜叫作“月亮补给”");
    accepted("quoted", "朋友说：“以后别用‘月亮补给’”");
    accepted("temporary", "这次先别用“月亮补给”");
    expect(store.blockedExpressions("one", "这次先别用“月亮补给”")).toEqual(["月亮补给"]);
    expect(store.blockedExpressions("one", "")).toEqual([]);
    expect(await context("two", "点宵夜")).toContain("月亮补给");
    accepted("block", "以后别再用“月亮补给”");
    expect(store.blockedExpressions("two", "")).toEqual(["月亮补给"]);
    accepted("restore", "以后可以重新用“月亮补给”");
    store = new RelationshipLogStore(file);
    expect(store.blockedExpressions("two", "")).toEqual([]);
    expect(await context("two", "点宵夜")).toContain("月亮补给");
    store.retainCompanionFeedbackTurns("one", new Set(["definition", "block"]));
    expect(store.blockedExpressions("two", "")).toEqual(["月亮补给"]);
  });
  it("learns unquoted conversational habits across sessions, respects speaker identity, retractions and pause", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    const say = (scope: string, session: string, id: string, text: string) =>
      store.recordTurn({
        speechScope: scope,
        conversationId: session,
        companionTurnId: id,
        userText: text,
        assistantText: "嗯",
        cyreneFeeling: "平静",
        channel: "wechat",
        privateContext: true,
        runId: id,
      });
    const get = (scope: string) =>
      store.buildContext("fresh-chat", true, "聊点啥", true, false, scope);
    await say("peer:a", "first", "a1", "好家伙，快递到了");
    await say("peer:b", "second", "b1", "好家伙，小猫会开门");
    expect(await get("peer:a")).not.toContain("好家伙");
    await say("peer:a", "third", "a2", "好家伙，冰箱里竟然还有西瓜");
    store = new RelationshipLogStore(file);
    expect(await get("peer:a")).toContain("好家伙");
    expect(await get("peer:a")).not.toMatch(/快递到了|冰箱/);
    expect(await get("peer:b")).not.toContain("好家伙");
    expect(await get("owner")).not.toContain("好家伙");
    await store.updatePreferences({ learnPrivateExpressions: false });
    expect(await get("peer:a")).not.toContain("好家伙");
    await store.updatePreferences({ learnPrivateExpressions: true });
    await say("peer:a", "fourth", "a3", "以后别用“好家伙”");
    expect(await get("peer:a")).not.toContain("好家伙");
    expect(store.blockedExpressions("other", "", "peer:a")).toEqual(["好家伙"]);
    expect(store.blockedExpressions("other", "", "peer:b")).toEqual([]);
    await store.forgetConversation("fourth");
    expect(await get("peer:a")).toContain("好家伙");
    await store.forgetConversation("first");
    expect(await get("peer:a")).not.toContain("好家伙");
  });
  it("resolves an unambiguous correction of the previous reply in the same private chat", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    await turn("a", "把宵夜叫作“月亮补给”");
    await store.recordTurn({
      conversationId: "one",
      companionTurnId: "b",
      userText: "吃什么",
      assistantText: "来点月亮补给？",
      cyreneFeeling: "平静",
      channel: "desktop",
    });
    await turn("c", "以后别这样说了");
    expect(await context("fresh", "今天吃什么宵夜")).not.toContain("月亮补给");
  });
  it("discovers a previously unknown opening from three different everyday contexts", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    await turn("one", "咸鱼摆尾，刚把窗台收拾完了", "a");
    await turn("two", "咸鱼摆尾，刚把窗台收拾完了", "b");
    await turn("three", "咸鱼摆尾，午休可算结束了", "b");
    expect(await context("c", "周末好")).not.toContain("咸鱼摆尾");
    await turn("four", "咸鱼摆尾，今天有个好消息", "a");
    expect(await context("c", "周末好")).toContain("咸鱼摆尾");
    expect(await context("c", "周末好")).not.toContain("午休");
    expect(await context("c", "我今天很难受")).not.toContain("咸鱼摆尾");
  });
  it("keeps a learned definition when the ordinary turn log rotates", async () => {
    await store.updatePreferences({ learnPrivateExpressions: true });
    await turn("vocab", "以后把晚饭叫作“猫猫补给”");
    // Seed the rolling log at its limit in the same repository format.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file.replace(/\.json$/, ".sqlite"));
    const raw = JSON.parse(
      db.prepare("SELECT body FROM companion_state WHERE id=1").get()!
        .body as string,
    );
    raw.entries = Array.from({ length: 500 }, (_, i) => ({
      ...raw.entries[0],
      id: "other-" + i,
      companionTurnId: undefined,
      userText: "路过",
      learnedExpressions: undefined,
    }));
    db.prepare("UPDATE companion_state SET body=? WHERE id=1").run(
      JSON.stringify(raw),
    );
    db.close();
    store = new RelationshipLogStore(file);
    await turn("next", "普通聊天", "other");
    expect(await context("fresh", "今天吃什么晚饭")).toContain("猫猫补给");
    await store.forgetConversation("one");
    expect(await context("fresh", "今天吃什么晚饭")).not.toContain("猫猫补给");
  });
  it("keeps desire scoped to the session, and honors refusal before increases or repeated runs", async () => {
    await store.updatePreferences({
      relationshipMode: "partner",
      affection: true,
      desireEnabled: true,
      desireInitiative: true,
    });
    await turn("a", "想亲你");
    expect((await store.snapshot()).desireHistory).toHaveLength(1);
    expect(await context("one", "周末好")).toContain("性致");
    expect(await context("two", "周末好")).not.toContain("性致");
    expect(await context("one", "我不想亲你")).toContain("收住");
    await turn("b", "我不想亲你");
    expect((await store.snapshot()).desireHistory?.at(-1)?.value).toBe(0);
    expect(await context("one", "周末好")).toContain("收住");
    await store.forgetConversation("one");
    expect((await store.snapshot()).desireHistory).toEqual([]);
    await turn("c", "想亲你");
    await store.updatePreferences({ desireEnabled: false });
    expect(await store.exportData()).not.toContain('"reason": "warm"');
    const history: DesireSample[] = [];
    addDesireSample(history, "one", "id", "想亲你", 0);
    addDesireSample(history, "one", "id", "想亲你", 1);
    expect(history).toHaveLength(1);
    expect(desireValue(history[0], 8 * 3600000)).toBeLessThan(history[0].value);
    for (const text of ["停", "别再吻我", "别这样", "不想亲你"])
      expect(desireSignal(text)).toBe("stop");
  });
});
