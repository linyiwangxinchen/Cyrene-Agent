import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createForum } from "../lib/forum.mjs";
import { chooseRandomVisitBar } from "../lib/random-visit.mjs";
import { DIRECTORY_INDEX_PATH, directoryPathsFromHtml, forumsFromDirectoryHtml, publicPage, TiebaPageError } from "../lib/public-pages.mjs";

const signal = new AbortController().signal;
const category = (group, subgroup) => '<a href="/f/index/forumpark?' + new URLSearchParams({ pcn: group, cn: subgroup }).toString().replaceAll("&", "&amp;") + '">分类</a>';
const board = kw => '<a href="https://tieba.baidu.com/f?kw=' + encodeURIComponent(kw) + '">进吧</a>';
const list = (...rows) => '<!--贴吧列表start--><table><tr><td>' + rows.join("</td><td>") + '</td></tr></table><!--贴吧列表end-->';
const categoryHtml = category("科学", "观察") + category("生活", "音乐");
const note = '<h1 class="core_title_txt">楼层夹具</h1><div id="post_content_34">实读的一句文字。</div>';

function fixture(fetchPage, { generate, randomIndex = () => 0 } = {}) {
  const requests = [];
  const stored = new Map();
  const secrets = new Map();
  const clock = { at: 8000 };
  let postingCalls = 0;
  const start = () => createForum({
    signal, storage: { get: key => structuredClone(stored.get(key)), set: (key, value) => stored.set(key, structuredClone(value)) },
    deps: {
      secrets: { get: key => secrets.get(key), set: (key, value) => secrets.set(key, value) },
      llm: { generateText: generate ?? (async () => '{"summary":"留下实读手记","evidence":["实读的一句文字"],"expressions":[]}') },
    },
  }, {
    now: () => clock.at,
    randomIndex,
    postReply: async () => { postingCalls++; throw new Error("巡游不能发帖"); },
    page: async (path, _signal, cookie) => { requests.push({ path, cookie }); return fetchPage(path); },
  });
  return { ...start(), start, requests, clock, postingCalls: () => postingCalls };
}

test("public directory parser accepts verified HTML, UTF-8 and GBK links and ignores footer and foreign links", async () => {
  const header = '<a href="https://invalid.example/f/index/forumpark?pcn=外部&cn=外部">外部</a>';
  const paths = directoryPathsFromHtml(header + category("科学", "观察") + category("科学", "观察") + category("生活", "音乐")
    + "<!--" + category("缓存", "注释") + "-->" + "<template>" + category("缓存", "模板") + "</template>");
  assert.deepEqual(paths.map(path => new URL(path, "https://tieba.baidu.com").searchParams.get("sd")), ["观察", "音乐"]);
  const malformed = '<a href="http://tieba.baidu.com/f?kw=%XX不合法">坏链接</a>';
  const hrefFromBaidu = "<a href='http://tieba.baidu.com/f?kw=%BC%AA%C1%D6' target='_blank'>吉林</a>";
  assert.deepEqual(forumsFromDirectoryHtml(list(board("宋词吧"), hrefFromBaidu,
    '<a href="https://tieba.baidu.com.example/f?kw=假吧">外站</a>', '<a href="https://u:p@tieba.baidu.com/f?kw=登录链接">认证</a>', malformed,
    "<script>" + board("脚本中的链接") + "</script>", "<!--" + board("注释中的链接") + "-->")
    + board("贴吧意见反馈")), ["宋词吧", "吉林"]);
  assert.deepEqual(forumsFromDirectoryHtml(list()), []);
  assert.throws(() => forumsFromDirectoryHtml("暂时没有页面"), /没有返回可识别/u);
  await assert.rejects(publicPage(DIRECTORY_INDEX_PATH, signal, "fixture=session"), /入口无效/u);
  await assert.rejects(publicPage(paths[0], signal, "fixture=session"), /入口无效/u);
  await assert.rejects(publicPage(paths[0] + "&abc=1", signal), /入口无效/u);
});

test("draws each distinct candidate via a single unbiased index over the actual sampled pool", async () => {
  const chosen = [];
  const categories = categoryHtml + category("阅读", "书桌") + category("游戏", "像素");
  const pages = { 观察: ["海鸥", "苔藓"], 音乐: ["海鸥", "Lofi"], 书桌: ["lofi", "小说"], 像素: ["上限之外"] };
  for (let candidateIndex = 0; candidateIndex < 4; candidateIndex++) {
    const limits = [];
    const seen = [];
    const result = await chooseRandomVisitBar(async path => {
      if (path === DIRECTORY_INDEX_PATH) return categories;
      const child = new URL(path, "https://tieba.baidu.com").searchParams.get("sd");
      seen.push(child);
      return list(...pages[child].map(board));
    }, {
      signal, canContinue: () => true, randomIndex: size => { limits.push(size); return limits.length === 4 ? candidateIndex : 0; },
    });
    assert.deepEqual(seen, ["观察", "音乐", "书桌"]);
    assert.deepEqual(limits, [4, 3, 2, 4]);
    assert.equal(result.candidateCount, 4);
    assert.equal(result.pagesRead, 3);
    chosen.push(result.bar);
  }
  assert.deepEqual(chosen, ["海鸥", "苔藓", "Lofi", "小说"]);
});

test("random sampling stays anonymous and only the chosen board and thread use the saved session", async () => {
  const purposes = [];
  const signedInBoard = "/mo/q/m?kw=" + encodeURIComponent("公开观察") + "&pn=0";
  const signedInThread = "/mo/q/m?kz=57&pn=1";
  const plugin = fixture(path => {
    if (path === DIRECTORY_INDEX_PATH) return categoryHtml;
    if (path.startsWith("/f/fdir?")) return list(board("公开观察"), board("公开观察"));
    if (path === signedInBoard) return '<a class="j_th_tit" href="/p/57">新帖</a>';
    if (path === signedInThread) return note;
    throw new Error("纯随机请求了其他吧");
  }, {
    async generate(_messages, options) {
      purposes.push(options.purpose);
      if (purposes.length === 1) throw new Error("本轮手记模型超时");
      return '{"summary":"使用之前保存的楼层","evidence":["实读的一句文字"],"expressions":[]}';
    },
  });
  assert.equal((await plugin.invoke("state")).config.visitMode, "interest");
  await plugin.invoke("auth-save", { cookie: "fixture=session" });
  await plugin.invoke("save", { bars: ["常逛吧"], visitMode: "random", allowPosting: true, postsPerVisit: 5 });
  const restarted = plugin.start();
  const visited = await restarted.invoke("visit", { background: false });
  assert.equal(visited.config.visitMode, "random");
  assert.equal(visited.auth.hasCookie, true);
  assert.deepEqual(visited.config.bars, ["常逛吧"]);
  assert.deepEqual(visited.visits[0].publicDirectory, { candidateCount: 1, categoriesAvailable: 2, pagesRead: 2 });
  assert.equal(visited.visits[0].mode, "random");
  assert.deepEqual(visited.visits[0].bars, ["公开观察"]);
  assert.deepEqual(visited.visits[0].read, ["57"]);
  assert.equal(visited.visits[0].status, "partial");
  assert.equal(visited.reading.floors[0].origin, "forum_authenticated");
  assert.equal(plugin.requests.length, 5);
  assert.ok(plugin.requests.slice(0, 3).every(request => request.cookie === undefined));
  assert.deepEqual(plugin.requests.slice(3), [
    { path: signedInBoard, cookie: "fixture=session" }, { path: signedInThread, cookie: "fixture=session" },
  ]);
  assert.equal(plugin.postingCalls(), 0);
  const retried = await plugin.start().invoke("analyze", { tid: "57", background: false });
  assert.equal(retried.reading.analysisStatus, "complete");
  assert.deepEqual(purposes, ["forum-expressions", "forum-expressions"]);
  assert.equal(plugin.requests.length, 5);
});

test("a visitor denied access to the chosen board does not reroll or retry with another session", async () => {
  const chosenBoardPath = "/f?kw=" + encodeURIComponent("抽中的吧");
  const plugin = fixture(path => {
    if (path === DIRECTORY_INDEX_PATH) return categoryHtml;
    if (path.startsWith("/f/fdir?")) return list(board("抽中的吧"), board("不会补选的吧"));
    if (path === chosenBoardPath) throw new TiebaPageError("贴吧限制了自动访问（HTTP 403）", true);
    throw new Error("巡游多访问了其他吧");
  });
  await plugin.invoke("save", { bars: ["常逛吧"], visitMode: "random" });
  const result = await plugin.invoke("visit", { background: false });
  assert.equal(result.auth.hasCookie, false);
  assert.equal(result.visits[0].publicDirectory.candidateCount, 2);
  assert.equal(result.visits[0].chosenBar, "抽中的吧");
  assert.equal(result.visits[0].status, "failed");
  assert.deepEqual(result.visits[0].read, []);
  assert.match(result.status, /HTTP 403/u);
  assert.equal(plugin.requests.length, 4);
  assert.deepEqual(plugin.requests.at(-1), { path: chosenBoardPath, cookie: undefined });
  assert.ok(plugin.requests.every(request => request.cookie === undefined));
  assert.equal(plugin.postingCalls(), 0);
});

test("an empty public directory does not call favorites or interests and honors the automatic cooldown", async () => {
  let modelCalls = 0;
  const plugin = fixture(path => path === DIRECTORY_INDEX_PATH ? categoryHtml : list(), {
    generate: async () => { modelCalls++; throw new Error("不应调用模型"); },
  });
  await plugin.invoke("save", { bars: ["固定吧"], visitMode: "random", auto: true, intervalHours: 2 });
  plugin.backgroundTick();
  let state;
  do { await new Promise(resolve => setImmediate(resolve)); state = await plugin.invoke("state"); } while (state.busy);
  assert.equal(state.visits[0].mode, "random");
  assert.equal(state.visits[0].status, "empty");
  assert.equal(state.visits[0].chosenBar, undefined);
  assert.match(state.status, /没有可抽取的吧/u);
  assert.deepEqual(state.visits[0].bars, []);
  assert.equal(state.nextVisitAt, plugin.clock.at + 7_200_000);
  plugin.start().backgroundTick();
  assert.equal(modelCalls, 0);
  assert.equal(plugin.requests.length, 3);
});

test("a security challenge in the public directory ends the round even after collecting a candidate", async () => {
  const plugin = fixture(path => {
    if (path === DIRECTORY_INDEX_PATH) return categoryHtml;
    if (path.includes(encodeURIComponent("观察"))) return list(board("挑战前已取得的吧"));
    throw new TiebaPageError("贴吧要求安全验证", true);
  });
  await plugin.invoke("save", { visitMode: "random", bars: ["固定吧"] });
  const result = await plugin.invoke("visit", { background: false });
  assert.equal(result.visits[0].status, "failed");
  assert.equal(result.visits[0].chosenBar, undefined);
  assert.equal(result.visits[0].publicDirectory.candidateCount, 1);
  assert.match(result.status, /安全验证/u);
  assert.equal(plugin.requests.length, 3);
});

test("the real panel saves the selected mode and displays an empty public pool in the visit record", async t => {
  const plugin = fixture(path => path === DIRECTORY_INDEX_PATH ? categoryHtml : list());
  await plugin.invoke("save", { bars: ["手动收藏的吧"] });
  const dom = new JSDOM(readFileSync(new URL("../panel.html", import.meta.url), "utf8"), {
    url: "https://panel.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const doc = window.document;
  let poll;
  window.matchMedia = () => ({ matches: false });
  window.setInterval = callback => { poll = callback; return 1; };
  window.CyrenePanel = { invoke: (_namespace, command, args) => plugin.invoke(command, args) };
  window.eval(readFileSync(new URL("../panel.js", import.meta.url), "utf8"));
  const until = async predicate => {
    for (let attempt = 0; attempt < 30 && !predicate(); attempt++) await new Promise(setImmediate);
    assert.ok(predicate());
  };
  await until(() => !doc.querySelector("#visit").disabled);
  doc.querySelector('[data-section="settings"]').click();
  const select = doc.querySelector("#visit-mode");
  assert.equal(select.value, "interest");
  select.value = "random";
  select.dispatchEvent(new window.Event("input", { bubbles: true }));
  doc.querySelector("#save").click();
  await until(() => doc.querySelector("#settings-message").textContent === "设置已保存");
  const saved = await plugin.start().invoke("state");
  assert.equal(saved.config.visitMode, "random");
  assert.deepEqual(saved.config.bars, ["手动收藏的吧"]);

  doc.querySelector("#visit").click();
  await until(() => plugin.requests.length === 3);
  poll();
  await until(() => !doc.querySelector("#visit").disabled && doc.querySelector("#visits").textContent.includes("没有候选吧"));
  assert.match(doc.querySelector("#visits").textContent, /纯随机.*公开分类目录读到 2 页 · 0 个候选吧/u);
});
