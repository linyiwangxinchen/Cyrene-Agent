import assert from "node:assert/strict";
import test from "node:test";
import { createForum } from "../lib/forum.mjs";
import { publicPage } from "../lib/public-pages.mjs";

const TEST_COOKIE = "SID=fixture-cookie; theme=clean;";
const CONFIG = { bar: "摄影" };
const LISTING = '<a class="j_th_tit" href="/p/3">光圈</a>';
const POST = '<h1 class="core_title_txt">光圈</h1><div id="post_content_1">试试对着天空拍。</div>';

function setup() {
  const encryptedFixture = new Map();
  const secrets = {
    get: async (key) => encryptedFixture.get(key),
    set: async (key, value) => encryptedFixture.set(key, value),
    delete: async (key) => encryptedFixture.delete(key),
  };
  const publicData = new Map([["config", CONFIG]]);
  const requests = [];
  const modelInputs = [];
  let response = async path => path.startsWith("/f") ? LISTING : POST;
  const ctx = {
    signal: new AbortController().signal,
    storage: { get: key => publicData.get(key), set: (key, value) => publicData.set(key, value) },
    deps: {
      secrets,
      llm: { generateText: async messages => {
        modelInputs.push(messages);
        return JSON.stringify({ summary: "在练习拍天空。", evidence: ["天空"], expressions: [] });
      } },
    },
  };
  function start() {
    return createForum(ctx, {
      now: () => 1000,
      page: async (path, _signal, cookie) => {
        requests.push({ path, cookie });
        return response(path);
      },
    });
  }
  return {
    forum: start(), start, requests, publicData, encryptedFixture, modelInputs,
    respondWith(value) { response = value; },
  };
}

test("reading-session credentials stay in the secrets service and are absent from public IPC and model prompts", async () => {
  const fixture = setup();
  const saved = await fixture.forum.invoke("auth-save", { cookie: "Cookie: " + TEST_COOKIE });
  assert.deepEqual(saved.auth, { available: true, hasCookie: true });
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual([...fixture.encryptedFixture.values()], ["SID=fixture-cookie; theme=clean"]);
  const restarted = fixture.start();
  const checked = await restarted.invoke("auth-check");
  assert.equal(checked.auth.check.status, "accessible");
  assert.match(checked.auth.check.message, /页面可读性/);
  assert.deepEqual(fixture.requests[0], { path: "/f?kw=" + encodeURIComponent("摄影"), cookie: "SID=fixture-cookie; theme=clean" });

  const read = await restarted.invoke("read", { url: "/p/3" });
  assert.equal(read.reading.analysisStatus, "complete");
  assert.equal(fixture.requests[1].cookie, "SID=fixture-cookie; theme=clean");
  assert.doesNotMatch(JSON.stringify([saved, checked, read, [ ...fixture.publicData ], fixture.modelInputs]), /fixture-cookie/u);

  const cleared = await restarted.invoke("auth-clear");
  assert.deepEqual(cleared.auth, { available: true, hasCookie: false });
  assert.equal(fixture.encryptedFixture.size, 0);
  await restarted.invoke("discover");
  assert.equal(fixture.requests[2].cookie, undefined);
  await restarted.invoke("read", { url: "/p/4", excerpt: "试试对着天空拍。" });
  assert.equal(fixture.requests.length, 3);
});

test("malformed cookie values are rejected without replacing stored credentials", async () => {
  const fixture = setup();
  await fixture.forum.invoke("auth-save", { cookie: TEST_COOKIE });
  for (const invalid of ["", "BDUSS=fake\r\nReferer: elsewhere", '{"cookie":"not a header"}', "SID=" + "x".repeat(8200), "x = not-valid", "SID=foo,bar"]) {
    await assert.rejects(fixture.forum.invoke("auth-save", { cookie: invalid }), /Cookie/u);
  }
  assert.deepEqual([...fixture.encryptedFixture.values()], ["SID=fixture-cookie; theme=clean"]);
});

test("cookie edits serialize with active first-party requests", async () => {
  const fixture = setup();
  await fixture.forum.invoke("auth-save", { cookie: TEST_COOKIE });
  let finish, markEntered;
  const entered = new Promise(resolve => { markEntered = resolve; });
  fixture.respondWith(() => new Promise(resolve => { finish = resolve; markEntered(); }));
  const pending = fixture.forum.invoke("discover");
  await entered;
  await assert.rejects(fixture.forum.invoke("auth-clear"), /等本轮/u);
  finish(LISTING);
  await pending;
  assert.equal((await fixture.forum.invoke("auth-clear")).auth.hasCookie, false);
});

test("HTTP access limits stop credential forwarding and are reported as inconclusive", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 302, headers: { Location: "https://other.example/auth" } });
  };
  const signal = new AbortController().signal;
  await assert.rejects(publicPage("/f?kw=foo", signal, TEST_COOKIE), { pauseVisit: true });
  await assert.rejects(publicPage("/%2f%2fother.example", signal, TEST_COOKIE), /入口/u);
  await assert.rejects(publicPage("/p/3/../../download", signal, TEST_COOKIE), /入口/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://tieba.baidu.com/f?kw=foo");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Cookie, TEST_COOKIE);

  const fixture = setup();
  fixture.respondWith((path) => publicPage(path, signal, TEST_COOKIE));
  await fixture.forum.invoke("auth-save", { cookie: TEST_COOKIE });
  const blocked = await fixture.forum.invoke("auth-check");
  assert.equal(blocked.auth.check.status, "blocked");
  assert.match(blocked.auth.check.message, /无法判断 Cookie 是否仍有效/u);
  assert.doesNotMatch(JSON.stringify(blocked), /other\.example|fixture-cookie/u);
});
