import { describe, expect, it } from "vitest";
import { buildPersonMemoryContext } from "./context";
import { buildSocialExtractionPrompt } from "./extractor";
import { rankSocialAtoms } from "./retrieval";
import type { SocialAtom } from "./types";

const NOW = Date.parse("2026-11-20T13:00:00+08:00");
const DAY = 86_400_000;

const atom = (id: string, type: SocialAtom["type"], content: string, createdAt: number, extra: Partial<SocialAtom> = {}): SocialAtom => ({
  id, conversationId: "chat", type, content, evidenceTurnId: "u", evidenceQuote: "q", createdAt, status: "active", ...extra,
});

describe("what she remembers about the person", () => {
  const atoms = [
    atom("birthday", "long_term", "对方的生日是11月14日", NOW - 200 * DAY),
    atom("swim", "long_term", "对方喜欢游泳", NOW - 5 * DAY),
    atom("meetings", "short_term", "对方上午组会、下午方案讨论会，一整天都在开会", Date.parse("2026-11-16T17:10:00+08:00"), { expiresAt: NOW + DAY }),
    atom("old", "short_term", "对方在赶论文", NOW - 30 * DAY, { expiresAt: NOW - DAY }),
    atom("interview", "open_loop", "对方11月21日上午面试", NOW - DAY, { expiresAt: NOW + 2 * DAY }),
  ];

  it("is present even when the message has nothing to search for", () => {
    const { contextBlock, retrievedAtoms } = buildPersonMemoryContext(atoms, "戳～", { now: NOW, timezone: "Asia/Shanghai" });
    expect(contextBlock).toContain("对方的生日是11月14日");
    expect(contextBlock).toContain("11月16日说：对方上午组会");
    expect(contextBlock).toContain("对方11月21日上午面试");
    expect(contextBlock).not.toContain("赶论文");
    expect(retrievedAtoms.map(item => item.id).sort()).toEqual(["birthday", "interview", "meetings", "swim"]);
  });

  it("does not let long-term facts fade with age", () => {
    const ranked = rankSocialAtoms("生日", [atoms[0]], { now: NOW });
    expect(ranked.map(item => item.id)).toEqual(["birthday"]);
    const faded = rankSocialAtoms("生日", [{ ...atoms[0], type: "short_term", expiresAt: NOW + DAY }], { now: NOW });
    expect(faded).toHaveLength(1);
  });

  it("returns nothing when there is nothing to remember", () => {
    expect(buildPersonMemoryContext([], "喵", { now: NOW, timezone: "Asia/Shanghai" }).contextBlock).toBe("");
  });

  it("asks the extractor for absolute dates in the user's calendar", () => {
    const prompt = buildSocialExtractionPrompt({
      conversationId: "chat", now: NOW, timezone: "Asia/Shanghai", retrievedAtoms: [],
      userTurn: { id: "u", role: "user", text: "明天要面试" }, assistantTurn: { id: "a", role: "assistant", text: "加油！" },
    });
    expect(prompt).toContain("用户当地时间：2026年11月20日星期五 13:00");
    expect(prompt).toContain("不要写“明天”“这周”");
    expect(prompt).toContain("撒娇和亲昵互动");
  });
});
