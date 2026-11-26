import { describe, expect, it } from "vitest";
import { buildCompanionSpeakingContext, buildRecentPhrasingHint } from "./expression-context-core";

describe("recent phrasing hint", () => {
  it("lists the openings she keeps reusing and the marks she overuses", () => {
    const history = [
      { role: "user", content: "喵～" }, { role: "assistant", content: "喵～人家在呢，雯雯♪" },
      { role: "user", content: "嘻嘻喵～" }, { role: "assistant", content: "嘻嘻喵～雯雯今天也这么可爱呀♪" },
      { role: "user", content: "蹭蹭～" }, { role: "assistant", content: "蹭蹭～人家也抱住雯雯啦♪" },
      { role: "user", content: "喵" }, { role: "assistant", content: "喵～人家在呢，雯雯♪" },
    ];
    const hint = buildRecentPhrasingHint(history, "雯雯");
    expect(hint).toContain("「喵～人家在呢」");
    expect(hint).toContain("这次不带");
    expect(hint).toContain("这次不用喊");
    expect(hint).toContain("自称「人家」");
  });

  it("stays silent for short chats", () => {
    expect(buildRecentPhrasingHint([{ role: "assistant", content: "嗨♪" }])).toBe("");
  });

  it("uses the last eight completed turns, ignoring earlier repetitions, tools and internal replies", () => {
    const mixed = [
      ...Array.from({ length: 11 }, (_, index) => [
        { role: "user", content: `一起聊第 ${index} 件事` },
        { role: "assistant", content: index < 3 ? "重复过的开头" : `第${index}种回复` },
      ]).flat(),
      { role: "user", content: "下一个问题" },
      { role: "assistant", content: "内部有答案", visibility: "internal" },
      { role: "assistant", content: "还在查资料", toolCalls: [{ id: "call" }] },
    ];
    const context = buildCompanionSpeakingContext({ text: "那就晚安。", messages: mixed, owner: true });
    expect(context).toContain("最近 8 个已完成轮次");
    expect(context).toContain("简短道别");
    expect(context).not.toMatch(/重复过的开头|内部有答案|还在查资料|近期用语/);
  });

  it("leaves varied openings alone and keeps quoted requests out of inferred actions", () => {
    const messages = ["今天风真大", "我也这么想", "等消息中"].flatMap(content =>
      [{ role: "user", content: "嗯" }, { role: "assistant", content }],
    );
    expect(buildRecentPhrasingHint(messages)).toBe("");
    expect(buildCompanionSpeakingContext({ text: "朋友说「晚安」。", messages, owner: false, nickname: "昵称" }))
      .not.toMatch(/简短道别|昵称/);
  });
});
