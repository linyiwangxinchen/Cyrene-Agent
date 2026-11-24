import assert from "node:assert/strict";
import test from "node:test";
import { createForum } from "../lib/forum.mjs";
import { publicPage, TiebaPageError } from "../lib/public-pages.mjs";

function fixture({ state = {}, fetch, generate, clock = { at: 1000 } } = {}) {
  const requests = [];
  const controller = new AbortController();
  const persisted = new Map(Object.entries(state));
  function start() {
    return createForum({
      signal: controller.signal,
      storage: { get: key => structuredClone(persisted.get(key)), set: (key, data) => persisted.set(key, structuredClone(data)) },
      deps: { llm: { generateText: generate ?? (async () => JSON.stringify({ summary: "这句接话挺自然。", evidence: ["慢慢来"], expressions: [{ quote: "慢慢来", scene: "赶工", cue: "鼓励" }] })) } },
    }, {
      now: () => clock.at,
      page: async path => {
        requests.push(path);
        return fetch(path);
      },
    });
  }
  return { ...start(), requests, restart: start, controller, persisted };
}

const note = '<h1 class="core_title_txt">读书和茶</h1><div id="post_content_34">慢慢来<div>先读完这本</div>再看看。</div>';
const listing = ids => ids.map(id => '<a class="j_th_tit" href="/p/' + id + '">帖子 ' + id + '</a>').join("");
const requestedBar = path => new URL(path, "https://tieba.baidu.com").searchParams.get("kw");
const modelNote = JSON.stringify({ summary: "读完这本书再看看。", evidence: ["慢慢来"], expressions: [] });

test("manual visit stores one completed post, skips previously seen posts and rotates after restart", async () => {
  const clock = { at: 1000 };
  const plugin = fixture({ clock, fetch: path => path.startsWith("/f?") ? listing(path.includes("first") ? [10, 11] : [20, 21]) : note });
  await plugin.invoke("save", { bars: ["first", "second"], auto: true, learn: true, intervalHours: 2, postsPerVisit: 1 });
  const first = await plugin.invoke("visit", { background: false, compact: true });
  assert.deepEqual(first.visits[0].read, ["10"]);
  assert.equal(first.visits[0].status, "complete");
  assert.equal(first.history[0].floors, undefined);
  assert.equal(first.history[0].floorCount, 1);
  assert.equal((await plugin.invoke("detail", { tid: "10" })).floors[0].body, "慢慢来先读完这本\n再看看。");
  assert.equal(first.samples[0].source, "https://tieba.baidu.com/p/10#post_content_34");
  clock.at++;
  assert.deepEqual((await plugin.restart().invoke("visit", { background: false })).visits[0].read, ["20"]);
  clock.at++;
  const third = await plugin.restart().invoke("visit", { background: false });
  assert.deepEqual(third.visits[0].read, ["11"]);
  assert.equal(third.visits[0].skipped, 1);
  assert.equal(third.nextVisitAt, clock.at + 7_200_000);
});

test("mixed visits check the rotating favorite and a distinct model pick with a shared post limit of one", async () => {
  const picks = [];
  const plugin = fixture({
    fetch: path => {
      const bar = requestedBar(path);
      return bar ? listing({ 摄影: [10, 11], 历史: [20, 21], 手帐: [30, 31] }[bar]) : note;
    },
    generate: async (messages, { purpose }) => {
      if (purpose !== "forum-visit-choice") return modelNote;
      picks.push(JSON.parse(messages[1].content));
      return JSON.stringify({
        bars: ["摄影吧", "https://other.example", "手帐"],
        reasons: { 手帐: "想看看大家怎样记录日常。" },
      });
    },
  });
  await plugin.invoke("save", { bars: ["摄影", "历史"] });
  const first = await plugin.invoke("visit", { background: false });
  assert.deepEqual(first.visits[0].bars, ["摄影", "手帐"]);
  assert.deepEqual(first.visits[0].read, ["10"]);
  assert.equal(first.visits[0].chosenBar, "手帐");
  assert.equal(first.visits[0].choiceReason, "想看看大家怎样记录日常。");
  const second = await plugin.restart().invoke("visit", { background: false });
  assert.deepEqual(second.visits[0].bars, ["手帐", "历史"]);
  assert.deepEqual(second.visits[0].read, ["30"]);
  assert.equal(second.reading.bar, "手帐");
  assert.deepEqual(second.config.bars, ["摄影", "历史"]);
  assert.deepEqual(picks.map(pick => pick.favorites), [["摄影", "历史"], ["摄影", "历史"]]);
  const pinned = await plugin.restart().invoke("visit", { bar: "历史", background: false });
  assert.deepEqual(pinned.visits[0].bars, ["历史"]);
  assert.deepEqual(pinned.visits[0].read, ["20"]);
  assert.equal(pinned.visits[0].chosenBar, undefined);
  assert.equal(picks.length, 2);
  assert.deepEqual(plugin.requests.filter(path => requestedBar(path)).map(requestedBar), ["摄影", "手帐", "手帐", "历史", "历史"]);
});

test("a visit can read five posts across the favorite and the model pick", async () => {
  const plugin = fixture({
    fetch: path => {
      const bar = requestedBar(path);
      if (!bar) return note;
      return listing(bar === "读书" ? [10, 11, 12, 13, 14] : [20, 21, 22, 23, 24]);
    },
    generate: async (_messages, { purpose }) => purpose === "forum-visit-choice"
      ? JSON.stringify({ bars: ["诗词"] }) : modelNote,
  });
  const configured = await plugin.invoke("save", { bars: ["读书"], postsPerVisit: 10 });
  assert.equal(configured.config.postsPerVisit, 5);
  const complete = await plugin.invoke("visit", { background: false });
  assert.deepEqual(complete.visits[0].bars, ["读书", "诗词"]);
  assert.deepEqual(complete.visits[0].read, ["10", "20", "11", "21", "12"]);
  assert.equal(plugin.requests.length, 7);
});

test("automatic visit without favorites uses real reading notes, falls through model choices and schedules the next visit", async () => {
  const clock = { at: 1000 };
  const prompts = [];
  const plugin = fixture({
    clock,
    fetch: path => {
      const bar = requestedBar(path);
      if (bar === "自然观察") return "<html></html>";
      return bar ? listing([32]) : note;
    },
    generate: async (messages, { purpose }) => {
      if (purpose !== "forum-visit-choice") return modelNote;
      prompts.push(messages);
      return JSON.stringify({ bars: ["自然观察", "手帐"], reasons: { 自然观察: "想看看大家记录了哪些植物。" } });
    },
  });
  await plugin.invoke("read", { url: "/p/31", bar: "读书" });
  await plugin.invoke("read", { url: "/p/33", title: "导入的信息", bar: "导入吧", excerpt: "慢慢来" });
  await plugin.invoke("save", { auto: true, intervalHours: 2 });
  const restarted = plugin.restart();
  restarted.backgroundTick();
  let snapshot = await restarted.invoke("state");
  for (let attempt = 0; snapshot.busy && attempt < 20; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    snapshot = await restarted.invoke("state");
  }
  assert.equal(snapshot.busy, false);
  assert.deepEqual(snapshot.config.bars, []);
  const visit = snapshot.visits[0];
  assert.equal(visit.trigger, "auto");
  assert.equal(visit.chosenBar, "自然观察");
  assert.equal(visit.choiceReason, "想看看大家记录了哪些植物。");
  assert.deepEqual(visit.bars, ["自然观察", "手帐"]);
  assert.deepEqual(visit.read, ["32"]);
  assert.equal(visit.status, "partial");
  assert.equal(snapshot.reading.bar, "手帐");
  assert.equal(snapshot.nextVisitAt, clock.at + 7_200_000);
  assert.deepEqual(JSON.parse(prompts[0][1].content), {
    favorites: [], recent: [], notes: [{ title: "读书和茶", bar: "读书", summary: "读完这本书再看看。" }],
  });
  restarted.backgroundTick();
  assert.equal((await restarted.invoke("state")).busy, false);
  assert.equal(prompts.length, 1);
});

test("empty favorites fall back to starter topics and rotate them after an unusable model response", async () => {
  const plugin = fixture({
    fetch: path => {
      const bar = requestedBar(path);
      return bar ? listing(bar === "读书" ? [41] : [42]) : note;
    },
    generate: async (_messages, { purpose }) => purpose === "forum-visit-choice" ? "please browse another website" : modelNote,
  });
  const first = await plugin.invoke("visit", { background: false });
  assert.deepEqual(first.visits[0].bars, ["读书"]);
  assert.deepEqual(first.visits[0].read, ["41"]);
  const second = await plugin.restart().invoke("visit", { background: false });
  assert.deepEqual(second.visits[0].bars, ["轻音乐"]);
  assert.deepEqual(second.visits[0].read, ["42"]);
  assert.deepEqual(second.config.bars, []);
});

test("read preserves evidence and re-analyzes without revisiting the site", async () => {
  let calls = 0;
  const plugin = fixture({
    fetch: path => path.includes("comment") ? '<span class="lzl_content_main">上来喝茶</span>' : note,
    generate: async messages => {
      calls++;
      if (calls === 1) throw new Error("HTTP 403");
      assert.match(messages[1].content, /上来喝茶/);
      return JSON.stringify({
        summary: "这句招呼很有意思。", evidence: ["上来喝茶", "不存在"],
        expressions: [{ quote: "上来喝茶", scene: "朋友进门" }],
      });
    },
  });
  await plugin.invoke("save", { bar: "读书", replies: true, learn: false });
  const first = await plugin.invoke("read", { url: "https://tieba.baidu.com/p/20?pn=2" });
  assert.equal(first.reading.analysisStatus, "failed");
  assert.equal(first.reading.floors.length, 2);
  const second = await plugin.restart().invoke("analyze", { tid: "20" });
  assert.equal(second.samples.length, 0);
  assert.equal(second.reading.analysisStatus, "complete");
  assert.equal(second.reading.summary, "这句招呼很有意思。");
  assert.equal(second.reading.evidence[0].source, "https://tieba.baidu.com/p/20?pn=2#post_content_34");
  assert.equal(second.reading.evidence.length, 1);
  assert.deepEqual(plugin.requests, ["/p/20?pn=2", "/p/comment?tid=20&pid=34&pn=1"]);
});

test("a verification page stops round requests while imported excerpts remain available", async () => {
  const plugin = fixture({
    fetch: () => { throw new TiebaPageError("贴吧限制了自动访问。可在浏览器打开原帖后导入楼层摘录。", true); },
  });
  await plugin.invoke("save", { bars: ["电影", "摄影"], learn: true });
  const blocked = await plugin.invoke("visit", { background: false });
  assert.equal(blocked.visits[0].status, "failed");
  assert.equal(plugin.requests.length, 1);
  const imported = await plugin.invoke("read", { url: "/p/101", title: "学摄影", bar: "摄影", excerpt: "你先慢慢来，找找光。" });
  assert.equal(plugin.requests.length, 1);
  assert.equal(imported.reading.imported, true);
  assert.equal(imported.samples[0].quote, "慢慢来");
  await plugin.invoke("forget", { id: imported.samples[0].id });
  assert.equal((await plugin.invoke("analyze", { tid: "101" })).samples.length, 0);
});

test("manual rereading refreshes the page and preserves the previous reading when blocked", async () => {
  let html = note;
  const plugin = fixture({ fetch: () => {
    if (!html) throw new TiebaPageError("贴吧要求安全验证", true);
    return html;
  } });
  const args = { url: "/p/30" };
  await plugin.invoke("read", args);
  html = note.replace("先读完这本", "这本已经读完了");
  const reread = await plugin.invoke("read", args);
  assert.equal(reread.reading.floors.length, 1);
  assert.match(reread.reading.floors[0].body, /已经读完了/);
  html = "";
  await assert.rejects(plugin.invoke("read", args), /安全验证/);
  const blocked = await plugin.invoke("state");
  assert.deepEqual(blocked.reading.floors, reread.reading.floors);
  assert.equal(plugin.requests.length, 3);
});

test("legacy config and already learned terms keep their public state and prompt availability", async () => {
  const sample = { id: "sample", scene: "摄影", quote: "找光", source: "https://tieba.baidu.com/p/88", at: 1 };
  const plugin = fixture({ state: {
    config: { bar: "摄影", learn: true },
    reading: { tid: "88", at: 1, floors: [{ post: "5", body: "找光" }] },
    expressions: [sample],
  } });
  const state = await plugin.invoke("state");
  assert.deepEqual(state.config.bars, ["摄影"]);
  assert.equal(state.reading.tid, "88");
  assert.deepEqual(plugin.learnedExpressions(), [sample]);
  await plugin.invoke("save", { learn: false });
  assert.deepEqual(plugin.learnedExpressions(), []);
  assert.deepEqual((await plugin.invoke("state")).samples, [sample]);
});

test("abort during analysis is recovered as retryable while previously saved floor remains", async () => {
  let unblock;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const plugin = fixture({
    generate: async (_messages, { signal }) => {
      entered();
      return new Promise((resolve, reject) => {
        unblock = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const work = plugin.invoke("read", { url: "/p/28", excerpt: "慢慢来" });
  const aborted = assert.rejects(work, { name: "AbortError" });
  await started;
  plugin.controller.abort();
  await aborted;
  unblock?.("late");
  const state = await plugin.restart().invoke("state");
  assert.equal(state.reading.analysisStatus, "failed");
  assert.equal(state.reading.floors[0].body, "慢慢来");
  assert.equal(state.samples.length, 0);
});

test("fetch uses the public official page, preserves declared GB18030, and stops at a challenge", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const signal = new AbortController().signal;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://tieba.baidu.com/p/123");
    assert.equal(options.redirect, "manual");
    assert.equal("Cookie" in options.headers, false);
    return new Response(Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4), { headers: { "Content-Type": "text/html; charset=gbk" } });
  };
  assert.equal(await publicPage("/p/123", signal), "中文");
  globalThis.fetch = async () => new Response("<title>百度安全验证</title>", { status: 403 });
  await assert.rejects(publicPage("/p/123", signal), { pauseVisit: true });
});
