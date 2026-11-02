import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { DEFAULTS } from "../lib/config.mjs";

const html = readFileSync(new URL("../panel.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../panel.js", import.meta.url), "utf8");
const BV = "BV17x411w7KC", BV2 = "BV1bNns6BEEA";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.ok(predicate(), "panel operation did not settle");
}
async function fixture(t) {
  const dom = new JSDOM(html, { url: "https://panel.test/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, intervals = [], calls = [];
  const state = { data: { config: { ...DEFAULTS, interests: "原来的兴趣" }, account: { loggedIn: false },
    environment: { installed: true, log: [] }, stats: { picked: 0 }, run: null,
    videos: [{ bvid: BV, title: "第一条视频", queueStatus: "queued" }], reports: [], memories: [], actions: [],
    questions: [], events: [], runs: [], profiles: [], charter: "任务章程" }, hook: null };
  w.setInterval = callback => { intervals.push(callback); return intervals.length; };
  w.CyrenePanel = { onTheme() {}, invoke: async (_namespace, command, args) => {
    calls.push(command);
    const intercepted = state.hook?.(command, args);
    if (intercepted !== undefined) return intercepted;
    if (command === "snapshot") return structuredClone(state.data);
    return { ok: true };
  } };
  w.eval(script);
  await until(() => d.querySelector("#garden").getAttribute("aria-busy") === "false");
  const button = text => [...d.querySelectorAll("button")].find(element => element.textContent === text);
  const type = (element, value) => { element.value = value; element.dispatchEvent(new w.Event("input", { bubbles: true })); };
  return { w, d, state, calls, button, type, poll: () => intervals[0]() };
}

test("后台状态变化和列表新增不会替换输入框或未变化的卡片", async t => {
  const f = await fixture(t);
  f.button("一起看").click();
  const input = f.d.querySelector('[aria-label="添加视频"]'), card = f.d.querySelector("article.card");
  f.type(input, "BV还没输入完"); input.focus(); input.setSelectionRange(2, 4);
  f.state.data.run = { id: "background", phase: "后台读取字幕", started: Date.now() };
  f.poll();
  await until(() => f.d.querySelector("#status").textContent.includes("后台读取字幕"));
  assert.equal(f.d.querySelector('[aria-label="添加视频"]'), input);
  assert.equal(f.d.querySelector("article.card"), card);
  assert.equal(f.d.activeElement, input);
  assert.deepEqual([input.value, input.selectionStart, input.selectionEnd], ["BV还没输入完", 2, 4]);
  f.state.data.videos.push({ bvid: BV2, title: "新来的待看视频", queueStatus: "queued" });
  f.poll();
  await until(() => f.d.querySelectorAll("article.card").length === 2);
  assert.equal(f.d.querySelector("article.card"), card);
  assert.equal(f.d.querySelector('[aria-label="添加视频"]'), input);
  assert.equal(input.value, "BV还没输入完");
});

test("提交撞上正在进行的轮询时仍读取最新队列，并保留随后输入的链接", async t => {
  const f = await fixture(t), stale = deferred(), submitted = deferred();
  f.button("一起看").click();
  const input = f.d.querySelector('[aria-label="添加视频"]');
  const oldData = structuredClone(f.state.data);
  let holdSnapshot = true;
  f.state.hook = command => {
    if (command === "snapshot" && holdSnapshot) { holdSnapshot = false; return stale.promise; }
    if (command === "queue") return submitted.promise;
  };
  f.poll(); f.poll(); f.poll();
  assert.equal(f.calls.filter(command => command === "snapshot").length, 2, "snapshot requests must not pile up");
  f.type(input, BV2);
  input.form.dispatchEvent(new f.w.Event("submit", { bubbles: true, cancelable: true }));
  f.type(input, "https://www.bilibili.com/video/下一条");
  f.state.data.videos.push({ bvid: BV2, title: "刚提交的视频", queueStatus: "queued" });
  submitted.resolve({ ok: true });
  await until(() => f.d.querySelector("#notice").textContent.includes("已收进待看"));
  stale.resolve(oldData);
  await until(() => f.d.querySelectorAll("article.card").length === 2 && !f.button("加入待看").disabled);
  assert.equal(f.calls.filter(command => command === "snapshot").length, 3);
  assert.equal(f.d.querySelector('[aria-label="添加视频"]'), input);
  assert.equal(input.value, "https://www.bilibili.com/video/下一条");
});

test("设置草稿不被轮询或重复点击当前页清空，放弃修改仍可恢复", async t => {
  const f = await fixture(t);
  f.button("设置").click();
  const input = f.d.querySelector('[name="interests"]');
  f.type(input, "尚未保存的新兴趣");
  f.poll(); await new Promise(setImmediate);
  f.button("设置").click();
  f.button("一起看").click();
  assert.equal(f.d.querySelector('[name="interests"]'), input);
  assert.equal(input.value, "尚未保存的新兴趣");
  assert.match(f.d.querySelector("#notice").textContent, /尚未保存/);
  f.button("放弃修改").click();
  assert.equal(f.d.querySelector('[name="interests"]').value, "原来的兴趣");
});
