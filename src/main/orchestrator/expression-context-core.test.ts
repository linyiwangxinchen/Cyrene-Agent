import { describe, expect, it } from "vitest";
import { buildRecentPhrasingHint } from "./expression-context-core";

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
});
