import { describe, expect, it } from "vitest";
import { buildRecallQueryPlan, tokenizeRecallText, validateRecallEventDate } from "./recall-query-plan";
import { createRecallScorer, presentRecallDetail, recallAlreadyVisible, selectRecallByTopic, validMemoryGist } from "./recall-presentation";

const now = Date.parse("2026-11-26T16:05:00Z");

describe("local recall plan and presentation", () => {
  it("handles explicit conversation dates on either side of local midnight and DST", () => {
    const plan = buildRecallQueryPlan({ query: "昨天我们聊了什么？", now, timeZone: "Asia/Shanghai" });
    expect(plan).toMatchObject({
      kind: "query", timeBasis: "conversation", clauses: [], from: Date.parse("2026-11-25T16:00:00Z"), to: Date.parse("2026-11-26T16:00:00Z"),
    });
    const dst = buildRecallQueryPlan({ query: "2026-03-08 的演出", now, timeZone: "America/New_York" });
    expect(dst).toMatchObject({
      timeBasis: "event", from: Date.parse("2026-03-08T05:00:00Z"), to: Date.parse("2026-03-09T04:00:00Z"),
    });
    const range = buildRecallQueryPlan({ query: "找 2026年11月21日 到 2026年11月25日 的观星", now });
    expect(range).toMatchObject({
      clauses: ["找 的观星"], from: Date.parse("2026-11-20T16:00:00Z"), to: Date.parse("2026-11-25T16:00:00Z"),
    });
  });

  it("does not silently broaden conflicting or impossible time constraints", () => {
    for (const query of ["昨天的观星和前天的露营", "2026-02-30 的观星", "2026-11-25 到 2026-11-22 的露营",
      "昨天的远足；昨天聊过的远足", "昨天的远足；上周的远足；请用简短语言", "昨天的远足；今天的散步；前天的露营；大前天的观星"]) {
      const plan = buildRecallQueryPlan({ query, now });
      expect(plan.ambiguousTime).toBe(true);
      expect(plan.from).toBeUndefined();
      expect(plan.scoped).toBeUndefined();
      expect(createRecallScorer(plan)("昨天的观星")).toEqual({ score: 0, topics: [] });
    }
    expect(validateRecallEventDate("2026-02-30", "2026-02-30 演出")).toBeUndefined();
    expect(validateRecallEventDate("2026-11-25", "25日去看星星")).toBeUndefined();
    expect(validateRecallEventDate("2026-11-25", "２０２６年１１月２５日去看星星")).toBe("2026-11-25");
  });

  it("uses independent explicit non-overlapping dates without forcing a single range", () => {
    const plan = buildRecallQueryPlan({ query: "昨天的远足；前天聊过的远足", now });
    expect(plan.ambiguousTime).toBe(true);
    expect(plan.from).toBeUndefined();
    expect(plan.scoped).toMatchObject([
      { dateLabel: "2026-11-26", timeBasis: "event" },
      { dateLabel: "2026-11-25", timeBasis: "conversation" },
    ]);
  });

  it("keeps distinct topics, literal token boundaries and a bounded pronominal hint", () => {
    expect(buildRecallQueryPlan({ query: "嗯嗯。", now }).kind).toBe("recent");
    const hints = buildRecallQueryPlan({ query: "那件事还记得吗？", topicHint: "去松林观星", now });
    expect(hints.clauses).toEqual(["那件事还记得吗", "去松林观星"]);
    expect(tokenizeRecallText("露营,ＣＡＭＰ テスト", "query")).toEqual(["露营", "camp", "テス", "スト"]);
    const scorer = createRecallScorer(buildRecallQueryPlan({ query: "露营；观星；camp", now }));
    expect(scorer("campus").score).toBe(0);
    const ranked = ["露营前准备", "露营后一趟", "观星等月亮", "camp in the mountains"].map(text => ({ text, ...scorer(text) }));
    expect(selectRecallByTopic(ranked, 3).map(item => item.text)).toEqual(["露营前准备", "观星等月亮", "camp in the mountains"]);
  });

  it("retains detail at high strength, accepts only a complete derived gist and omits text already visible", () => {
    const fact = "用户喜欢无糖石榴汁。";
    const detail = fact + "访谈原话只是补充了心情。".repeat(20);
    const plan = buildRecallQueryPlan({ query: "无糖石榴汁", recentVisible: [`请继续聊聊${fact}`] });
    expect(recallAlreadyVisible(plan, detail, fact)).toBe(true);
    expect(validMemoryGist(fact, detail)).toBe(fact);
    expect(validMemoryGist("糖石榴汁", detail)).toBeUndefined();
    expect(presentRecallDetail(detail, 1, { gist: fact })).toBe(`（简短线索）${fact}`);
    expect(presentRecallDetail(detail, 4, { gist: fact })).toBe(detail);
    expect(presentRecallDetail(detail, 1)).toMatch(/…$/u);
  });
});
