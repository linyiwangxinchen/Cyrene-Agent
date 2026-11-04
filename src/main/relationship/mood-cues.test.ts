import { describe, expect, it } from "vitest";
import { detectUserMood } from "./mood-cues";

describe("conservative relationship cues", () => {
  it.each([
    "我不累", "现在没有压力", "我不是很难过", "我不担心", "我没觉得累",
    "我同事今天很焦虑", "妈妈很累", "他说我很难过", "如果我很累怎么办",
    "你累不累？", "她问：\"今天开心吗\"", "这段代码很困难", "积累经验", "不要拖累朋友",
    "> 我很焦虑\n这是引用", "```\n我难过\n```", "她说“我很难过”",
  ])("does not infer a user mood from %s", text => expect(detectUserMood(text)).toBe("未知"));
  it.each([
    ["我今天有点累", "疲惫"], ["好累啊", "疲惫"], ["今天没精神", "疲惫"],
    ["同事很开心，我有点难过", "低落"], ["我担心妈妈", "焦虑"],
    ["我不开心", "低落"], ["太好了", "开心"], ["别再问了", "明确边界"],
    ["我不是难过，只是很累", "疲惫"],
  ])("recognizes the direct cue %s", (text, mood) => expect(detectUserMood(text)).toBe(mood));
});
