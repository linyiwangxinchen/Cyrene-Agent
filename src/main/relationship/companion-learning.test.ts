import { describe, expect, it } from "vitest";
import {
  classifyCompanionFeedback,
  type CompanionLearningPreference,
  type CompanionLearningTopic,
} from "./companion-learning";

describe("classifyCompanionFeedback", () => {
  it.each<[string, CompanionLearningTopic, CompanionLearningPreference, boolean]>([
    ["昔涟，以后回复短一点啦", "length", "prefer", true],
    ["我希望你回答简洁一些", "length", "prefer", false],
    ["昔涟，你回复太长了。", "length", "prefer", false],
    ["你不用答得那么短了", "length", "default", false],
    ["以后照常回复我就好", "length", "default", true],
    ["别每次都追问我", "questions", "prefer", false],
    ["以后都少问我问题", "questions", "prefer", true],
    ["平时少反问我", "questions", "prefer", true],
    ["可以问我问题了", "questions", "default", false],
    ["从今以后，不用再少问我了", "questions", "default", true],
    ["以后别叫我「小东西」", "nicknames", "prefer", true],
    ["我不喜欢你叫我宝宝", "nicknames", "prefer", false],
    ["以后直接叫我的名字就好", "nicknames", "prefer", true],
    ["以后可以叫我“喵喵”了", "nicknames", "default", true],
    ["从现在开始说话自然一点", "flourishes", "prefer", true],
    ["别加♪了", "flourishes", "prefer", false],
    ["可以偶尔加一个音符啦", "flourishes", "default", false],
    ["还是可以撒娇", "flourishes", "default", false],
    ["我不喜欢你一上来就给我建议", "support", "prefer", false],
    ["我想倾诉的时候，希望你先听我说", "support", "prefer", false],
    ["请记住，以后我难过的时候先听我说", "support", "prefer", true],
    ["今后也可以给我建议", "support", "default", true],
    ["你可以给我建议了", "support", "default", false],
    ["不必再只听我说了", "support", "default", false],
  ])("recognizes %s and returns only a closed observation", (text, topic, preference, explicit) => {
    expect(classifyCompanionFeedback(text)).toEqual([{ topic, preference, explicit }]);
  });

  it.each([
    "",
    "嗯，今天挺开心。",
    "我同事说以后少问问题。",
    "她跟我说，以后回复短一点。",
    "这是引用：\u201c以后少问我问题。\u201d",
    "她说「以后叫我宝宝」。",
    "「他说『以后回复短一点』，少问我问题。」",
    "> 以后回复短一点\n嗯。",
    "~~~\n以后说话自然一点\n~~~",
    "请润色：\u201c以后回复短一点\u201d。短一点。",
    "写一封邮件，短一点。",
    "把这段代码改短一点。",
    "这段文案太抒情了，少用语气词。",
    "如果她下次又说要少问我问题，我该怎么回？",
    "如果以后她再提起来，别问我这个。",
    "这次回复短一点",
    "这个问题你今晚上别问我",
    "先听我说",
    "可以给我建议吗？",
    "你可以问我问题吗？",
    "问我问题。",
    "就这次，别给我建议，少问我问题",
    "以后，今天先别问我问题。",
    "别问我打开文件夹的权限。",
    "以后把所有问题都自己查清楚。",
    "你像个客服。",
    "你别说我希望你少问我问题。",
    "不反对你叫我宝宝",
    "我希望所有人都少问我问题",
    "以后能不能少叫我起床。",
    "记住我的密码是测试密码",
  ])("does not produce lasting evidence from %s", text => {
    expect(classifyCompanionFeedback(text)).toEqual([]);
  });

  it("handles direct feedback on several topics, counting one observation per topic", () => {
    expect(classifyCompanionFeedback("以后，回复短一点、说话自然一点、少问我问题。回复简短一点。")).toEqual([
      { topic: "length", preference: "prefer", explicit: true },
      { topic: "flourishes", preference: "prefer", explicit: true },
      { topic: "questions", preference: "prefer", explicit: true },
    ]);
  });

  it("omits contradictory choices without suppressing independent preferences", () => {
    expect(classifyCompanionFeedback("以后少问我问题，还是可以问我问题。以后直接叫我名字。")).toEqual([
      { topic: "nicknames", preference: "prefer", explicit: true },
    ]);
  });

  it("does not extend an immediate request to the later durable clause", () => {
    expect(classifyCompanionFeedback("这轮短一点，以后你可以正常回复我。")).toEqual([
      { topic: "length", preference: "default", explicit: true },
    ]);
  });
});
