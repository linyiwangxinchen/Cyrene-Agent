import assert from "node:assert/strict";
import test from "node:test";
import { createForum } from "../lib/forum.mjs";
import { authenticatedPage } from "../lib/authenticated-page.mjs";
import { createAuthenticatedReader, publicPage } from "../lib/public-pages.mjs";
import { normalizeCookie } from "../lib/session.mjs";

const TEST_COOKIE = "SID=fixture-cookie; theme=clean;";
const CONFIG = { bar: "摄影" };
const LISTING = '<a class="j_th_tit" href="/p/3">光圈</a>';
const POST = '<title>光圈_百度贴吧</title><div class="content">试试对着天空拍。</div>';

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
  let response = async path => /[?]kw=/.test(path) ? LISTING : POST;
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
  assert.match(checked.auth.check.message, /帖子列表可读/);
  assert.deepEqual(fixture.requests[0], {
    path: "/mo/q/m?kw=" + encodeURIComponent("摄影") + "&pn=0",
    cookie: "SID=fixture-cookie; theme=clean",
  });

  await restarted.invoke("save", { replies: true });
  const read = await restarted.invoke("read", { url: "/p/3" });
  assert.equal(read.reading.analysisStatus, "complete");
  assert.equal(read.reading.evidence[0].source, "https://tieba.baidu.com/p/3");
  assert.match(read.reading.replyStatus, /未提供可定位的楼层 ID/);
  assert.deepEqual(fixture.requests[1], { path: "/mo/q/m?kz=3&pn=1", cookie: "SID=fixture-cookie; theme=clean" });
  assert.equal(fixture.requests.length, 2);
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
  for (const invalid of ["", "BDUSS=fake\r\nReferer: elsewhere", '{"cookie":"not a header"}', "SID=" + "x".repeat(8200), "x = not-valid", "SID=foo,bar", "SID=foo\\bar"]) {
    await assert.rejects(fixture.forum.invoke("auth-save", { cookie: invalid }), /Cookie/u);
  }
  assert.deepEqual([...fixture.encryptedFixture.values()], ["SID=fixture-cookie; theme=clean"]);
});

test("browser Cookie values survive formatted-text escaping and authenticated requests", async () => {
  const raw = "BAIDUID_BFESS=fixture:FG=1; __bid_n=fixture-browser; BDUSS=fixture~auth; BDUSS_BFESS=fixture~auth; ab_sr=fixture==";
  const copied = raw.replace(/[_~]/g, character => "\\" + character);
  assert.equal(normalizeCookie(raw), raw);
  const fixture = setup();
  const state = await fixture.forum.invoke("auth-save", { cookie: "Cookie: " + copied });
  assert.equal(state.auth.hasCookie, true);
  assert.deepEqual([...fixture.encryptedFixture.values()], [raw]);
  await fixture.start().invoke("auth-check");
  assert.equal(fixture.requests[0].cookie, raw);
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

test("HTTP access limits stop credential forwarding and are reported as inconclusive", async () => {
  const calls = [];
  const read = async (url, signal, cookie) => {
    calls.push({ url: url.href, signal, cookie });
    return { status: 302, buffer: Buffer.alloc(0) };
  };
  const signal = new AbortController().signal;
  await assert.rejects(publicPage("/mo/q/m?kw=foo&pn=0", signal, TEST_COOKIE, read), { pauseVisit: true });
  await assert.rejects(publicPage("/mo/q/m?kz=3&pn=1&other=invalid", signal, TEST_COOKIE, read), /入口/u);
  await assert.rejects(publicPage("/%2f%2fother.example", signal, TEST_COOKIE, read), /入口/u);
  await assert.rejects(publicPage("/p/3/../../download", signal, TEST_COOKIE, read), /入口/u);
  assert.deepEqual(calls, [{ url: "https://tieba.baidu.com/mo/q/m?kw=foo&pn=0", signal, cookie: "SID=fixture-cookie; theme=clean" }]);

  const fixture = setup();
  fixture.respondWith(path => publicPage(path, signal, TEST_COOKIE, read));
  await fixture.forum.invoke("auth-save", { cookie: TEST_COOKIE });
  const blocked = await fixture.forum.invoke("auth-check");
  assert.equal(blocked.auth.check.status, "blocked");
  assert.match(blocked.auth.check.message, /无法判断 Cookie 是否仍有效/u);
  assert.doesNotMatch(JSON.stringify(blocked), /other\.example|fixture-cookie/u);
});

test("authenticated reads confirm login, reuse the issued session for pages, and stop on denied login", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const path = "/mo/q/m?kw=foo&pn=0";
  const url = new URL(path, "https://tieba.baidu.com");
  let loggedIn = true;
  const reader = createAuthenticatedReader(async (destination, _signal, jar) => {
    calls.push({ destination: destination.pathname, jar });
    return destination.pathname === "/dc/common/tbs"
      ? { status: 200, buffer: Buffer.from(JSON.stringify({ is_login: loggedIn ? 1 : 0 })), jar: "issued-on-sign-in" }
      : { status: 200, buffer: Buffer.from(LISTING), jar: "issued-on-reading" };
  }, Date.now, 0);
  const cookie = "BDUSS=demo-session; theme=light";
  assert.equal(await publicPage(path, signal, cookie, reader.read), LISTING);
  await reader.read(url, signal, cookie);
  assert.deepEqual(calls.map(call => call.destination), ["/dc/common/tbs", "/mo/q/m", "/mo/q/m"]);
  assert.match(calls[0].jar, /\tBDUSS\tdemo-session\n$/);
  assert.doesNotMatch(calls[0].jar, /theme/);
  assert.equal(calls[1].jar, "issued-on-sign-in");
  assert.equal(calls[2].jar, "issued-on-reading");
  reader.clear();
  loggedIn = false;
  await assert.rejects(reader.read(url, signal, cookie), /未识别当前 Cookie/);
  assert.equal(calls.length, 4);
});

test("the curl child uses standard input for credentials and returns response metadata and its cookie jar", async () => {
  const jar = ".baidu.com\tTRUE\t/\tFALSE\t4102444800\tBDUSS\tdemo-session\n";
  const signal = new AbortController().signal;
  const run = (_binary, args, options, callback) => {
    assert.equal(args[0], "--disable");
    assert.equal(args.at(-1), "https://tieba.baidu.com/dc/common/tbs");
    assert.ok(args.includes("--cookie-jar") && args.includes("--cookie"));
    for (const argument of ["--location", "--insecure", "--user-agent"]) assert.ok(!args.includes(argument));
    assert.doesNotMatch(args.join(" "), /demo-session/);
    assert.equal(options.signal, signal);
    return { stdin: { on() {}, end(input) {
      assert.equal(input, jar);
      callback(null, Buffer.from('{}\n__CYRENE_TIEBA_HTTP__:200\napplication/json\n' + jar));
    } } };
  };
  const result = await authenticatedPage(new URL("/dc/common/tbs", "https://tieba.baidu.com"), signal, jar, run);
  assert.deepEqual(result, { status: 200, buffer: Buffer.from("{}"), declared: "application/json", jar });
  assert.throws(() => authenticatedPage(new URL("http://tieba.baidu.com/dc/common/tbs"), signal, jar, run), /Invalid Tieba destination/);
});
