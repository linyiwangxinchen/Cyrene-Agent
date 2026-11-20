import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCompanionCorrection, RelationshipLogStore } from "./relationship-log-core";

describe("corrections and promises from a private chat", () => {
  let directory: string;
  let file: string;
  let store: RelationshipLogStore;
  let sequence: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-correction-"));
    file = path.join(directory, "relationship-log.json");
    store = new RelationshipLogStore(file);
    sequence = 0;
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function turn(userText: string, assistantText = "好。", options: { conversationId?: string; privateContext?: boolean } = {}) {
    sequence++;
    return store.recordTurn({
      userText, assistantText, cyreneFeeling: "平静", channel: "wechat",
      conversationId: options.conversationId ?? "private-one", privateContext: options.privateContext,
      runId: `run-${sequence}`,
      companionFeedback: { text: userText, userTurnId: `turn-${sequence}`, revision: store.getControls().learningRevision },
    });
  }

  it("recognizes the corrections the user actually sent", () => {
    expect(isCompanionCorrection("纠正：就没有表达边界这种词！人也不会把东西标成可复查来源")).toBe(true);
    expect(isCompanionCorrection("纠正：安排怎么能硬拽呢，今天又怎么能照眼下的一小步来呢")).toBe(true);
    expect(isCompanionCorrection("昔涟宝宝说的话怎么没头没脑的呀")).toBe(true);
    expect(isCompanionCorrection("嘻嘻喵～")).toBe(false);
    expect(isCompanionCorrection("帮我把国防科技大学后面的航空宇航科学与技术也圈一下")).toBe(false);
  });

  it("keeps a correction for the same conversation after restart, once", async () => {
    const correction = "纠正：就没有表达边界这种词！人也不会把东西标成可复查来源";
    await turn(correction);
    await turn(correction);
    store = new RelationshipLogStore(file);
    const context = await store.buildContext("private-one", true, "戳～", true);
    expect(context).toContain("【对方纠正过的地方】");
    expect(context.split(correction).length - 1).toBe(1);
    expect(await store.buildContext("private-two", true, "戳～", true)).not.toContain(correction);
  });

  it("does not learn corrections from shared chats", async () => {
    await turn("纠正：别再说这种话", "好。", { privateContext: false });
    expect(await store.buildContext("private-one", true, "戳～", true)).not.toContain("【对方纠正过的地方】");
  });

  it("records task promises but not story lines or vows about talking", async () => {
    await turn("给翁法罗斯续写今日的故事", "缇安探过脑袋：「要不要我来开一扇近一点的门？」");
    await turn("一定要记好了哦", "记好了，之后我会按这些信息来，话题也会接得更稳");
    await turn("帮我做个 PDF", "好，我来把四份文件按顺序合成一个 PDF，做好发你。");
    const promises = (await store.snapshot()).commitments.map(item => item.promise);
    expect(promises).toEqual(["好，我来把四份文件按顺序合成一个 PDF，做好发你"]);
  });

  it("keeps the task ledger out of chat context", async () => {
    await turn("帮我做个 PDF", "好，我来把四份文件按顺序合成一个 PDF，做好发你。");
    expect(await store.buildContext("private-one", true, "戳～", true, false)).not.toContain("【助手承诺账本】");
    expect(await store.buildContext("private-one", true, undefined, false, true)).toContain("【助手承诺账本】");
  });
});
