import { describe, expect, it } from "vitest";
import { DEFAULT_PROACTIVE_TARGET_SCORE, normalizeProactiveTargetScore } from "./preferences";

describe("normalizeProactiveTargetScore", () => {
  it("将目标评分限制在 0-100，并按整数保存", () => {
    expect(normalizeProactiveTargetScore(-1)).toBe(0);
    expect(normalizeProactiveTargetScore(100.4)).toBe(100);
    expect(normalizeProactiveTargetScore(42.6)).toBe(43);
  });

  it("无效输入回退到默认值 60", () => {
    expect(normalizeProactiveTargetScore("bad")).toBe(DEFAULT_PROACTIVE_TARGET_SCORE);
    expect(normalizeProactiveTargetScore(undefined)).toBe(60);
  });
});
