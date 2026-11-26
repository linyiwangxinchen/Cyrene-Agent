import assert from "node:assert/strict";
import test from "node:test";
import { registerReadingContext } from "../reading-context.mjs";
import { speakingStyle } from "../lib/speaking-style.mjs";

test("answers reading questions with dated evidence from the requested thread", () => {
  let provider;
  let reads = 0;
  registerReadingContext({ registerPromptProvider: p => { provider = p; } }, () => {
    reads++;
    return [
      { tid: "24", title: "新帖子", at: 1700000000100 },
      { tid: "23", title: "摄影手记", summary: "讨论夜景测光", imported: true, at: 1700000000000 },
    ];
  });
  assert.equal(provider.privateCompanionOnly, true);
  assert.deepEqual(provider.sources, ["conversation"]);
  for (const userText of ["推荐一个摄影贴吧", "今天不想聊贴吧看了什么", "聊聊夜景"]) {
    assert.equal(provider.provide({ userText }), "");
  }
  assert.equal(reads, 0);
  const result = provider.provide({ userText: "贴吧读了什么？我问的是 https://tieba.baidu.com/p/23" });
  assert.match(result, /讨论夜景测光/);
  assert.match(result, /用户导入摘录/);
  assert.match(result, /2023-11-14/);
  assert.doesNotMatch(result, /新帖子/);
  assert.match(provider.provide({ userText: "贴吧看了什么？https://tieba.baidu.com/p/999" }), /没有找到/);
  for (const userText of ["贴吧学到了什么？", "最近逛吧有什么收获？"]) {
    assert.match(provider.provide({ userText }), /讨论夜景测光/);
  }
});

test("casual private chat can use a bounded set of recent verified reading observations when learning is on", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 26);
  const publicNote = (tid, summary, extra = {}) => ({
    tid, at: now - DAY, summary, bar: "摄影", analysisStatus: "complete",
    title: "原帖标题", floors: [{ body: "完整的楼层原文" }],
    evidence: [{ quote: "楼层原句", source: `https://tieba.baidu.com/p/${tid}#post_content_12` }], ...extra,
  });
  const history = [
    publicNote("10", "拍夜景时可以留意窗里的倒影。更多资料 https://example.invalid/night"),
    publicNote("11", "用户导入的文字", { imported: true }),
    publicNote("12", "太早以前的手记", { at: now - 15 * DAY }),
    publicNote("13", "没分析完的手记", { analysisStatus: "failed" }),
    publicNote("14", "缺少可核对的出处", { evidence: [{ quote: "错引", source: "https://tieba.baidu.com/p/22" }] }),
    publicNote("15", "雨后地面的反光可以改变构图。"),
    publicNote("16", "第三条见闻。" + "长".repeat(200)),
    publicNote("17", "这些见闻多于三条"),
  ];
  let provider;
  let enabled = true;
  registerReadingContext({ registerPromptProvider: p => { provider = p; } }, () => history, () => enabled, () => now);
  const text = provider.provide({ userText: "最近想去河边拍夜景。" });
  assert.match(text, /近期实读的贴吧手记/);
  assert.match(text, /每次最多提一条/);
  const rows = JSON.parse(text.split("\n")[1]);
  assert.deepEqual(rows[0], { 阅读时间: "2026-11-25T00:00:00.000Z", 吧名: "摄影", 见闻: "拍夜景时可以留意窗里的倒影。更多资料" });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].见闻.length, 120);
  assert.doesNotMatch(text, /https|原帖标题|完整的楼层原文|楼层原句|用户导入的文字|太早以前|没分析完|缺少可核对|多于三条/);
  for (const userText of ["今天别提贴吧了", "我现在难受，先听我说", "说话简短点", "正常说话", "别学贴吧说话", "别用梗"]) {
    assert.equal(provider.provide({ userText }), "");
  }
  assert.match(provider.provide({ userText: "你今天都干了点啥？" }), /按用户当地时间判断/);
  enabled = false;
  assert.equal(provider.provide({ userText: "最近想去河边拍夜景。" }), "");
  assert.match(provider.provide({ userText: "贴吧看到了什么？" }), /https:\/\/tieba\.baidu\.com\/p\/10/);
});

test("style accumulates across distinct sources without repeating their quotes or dropping user's corrections", () => {
  const sample = (tid, quote, extra = {}) => ({
    quote, source: `https://tieba.baidu.com/p/${tid}`, scene: "摄影夜景", ...extra,
  });
  const samples = [
    sample("1", "当晚留了月亮", { style: "acknowledge" }),
    sample("2", "我帮照片拿了个号", { delivery: "先接住对方的好消息" }),
    sample("3", "纸花只能开一次", { style: "pacing" }),
    sample("4", "空气多留一厘米", { style: "pacing" }),
    sample("5", "放条鱼在窗台", { style: "playful" }),
    sample("6", "放条鱼在窗台", { style: "playful" }),
  ];
  const conversation = { userText: "想周末去看展，顺便逛小店。" };
  const style = speakingStyle(samples, conversation);
  assert.match(style, /贴吧读帖里积累的接话习惯/);
  assert.match(style, /先顺着对方刚提到的事回应/);
  assert.match(style, /留一点空间/);
  assert.doesNotMatch(style, /玩笑|月亮|照片|纸花|空气|https|摄影夜景/);
  const corrected = speakingStyle(samples, { ...conversation, isExpressionBlocked: text => text.includes("纸花") });
  assert.match(corrected, /先顺着对方刚提到的事回应/);
  assert.doesNotMatch(corrected, /留一点空间/);
  for (const userText of ["别再用当晚留了月亮", "说话直接点", "我很着急，先听我说"]) {
    assert.equal(speakingStyle(samples, { userText }), "");
  }
  assert.equal(speakingStyle(samples.slice(0, 1), conversation), "");
  assert.equal(speakingStyle([samples[0], sample("1", "同一个帖子里的另一句", { style: "acknowledge" })], conversation), "");
  const scoped = speakingStyle(samples.slice(0, 1), { userText: "摄影夜景该怎么拍？" });
  assert.match(scoped, /先顺着对方刚提到的事回应/);
  assert.doesNotMatch(scoped, /月亮|https/);
});
