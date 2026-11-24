import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { authenticatedPost, initialJar, replyCookie } from "../lib/authenticated-page.mjs";
import { submitThreadReply } from "../lib/post-reply.mjs";

const origin = "https://tieba.baidu.com";
const url = origin + "/p/11114876630";
const content = "  这段写得真有意思 🎣\n期待后续。  ";
const cookie = "BDUSS=fixture-value";
const bar = "表达练习";
const fid = "28145568";
const pid = "12345678901234567";
const loginPage = '{"is_login":1,"tbs":"123456789abc"}';
const threadPage = '<a href="/f?kw=%E8%A1%A8%E8%BE%BE%E7%BB%83%E4%B9%A0&amp;mo_device=1">返回吧</a>';
const boardPage = '<script>new titleArea({forum_id: ' + fid + ', forum_name: "表达练习"});</script>';

function response(text, status = 200, jar) {
  return { status, buffer: Buffer.from(text), declared: "text/html; charset=utf-8", jar };
}

function fixture({ reply = '{"no":0,"data":{"pid":' + pid + ',"is_post_visible":1}}', reads = [
  response(loginPage, 200, initialJar(cookie) + ".tieba.baidu.com\tTRUE\t/\tTRUE\t0\tfixtureToken\tupdated\n"),
  response(threadPage),
  response(boardPage),
] } = {}) {
  const readCalls = [];
  const writeCalls = [];
  return {
    readCalls,
    writeCalls,
    read: async (destination, signal, jar) => {
      readCalls.push({ destination, signal, jar });
      return reads.shift();
    },
    write: async (destination, signal, header, form, tid) => {
      writeCalls.push({ destination, signal, header, form, tid });
      if (reply instanceof Error) throw reply;
      return typeof reply === "string" ? response(reply) : reply;
    },
  };
}

test("resolves first-party board metadata and submits a single reply with one fresh login token", async () => {
  const transport = fixture();
  const result = await submitThreadReply({ url: url + "?pn=2", content, cookie }, transport);
  assert.deepEqual(transport.readCalls.map(({ destination }) => destination.pathname + destination.search), [
    "/dc/common/tbs", "/mo/q/m?kz=11114876630&pn=1",
    "/mo/q/m?kw=%E8%A1%A8%E8%BE%BE%E7%BB%83%E4%B9%A0&pn=0",
  ]);
  assert.ok(transport.readCalls.every(({ destination }) => destination.origin === origin));
  assert.equal(transport.readCalls[0].jar, initialJar(cookie));
  assert.equal(transport.writeCalls.length, 1);
  const [request] = transport.writeCalls;
  assert.equal(request.destination.href, origin + "/f/commit/post/add");
  assert.equal(request.tid, "11114876630");
  assert.equal(request.header, cookie + "; fixtureToken=updated");
  assert.deepEqual(Object.fromEntries(request.form), {
    ie: "utf-8", kw: bar, fid, tid: request.tid, tbs: "123456789abc", files: "[]", content: content.trim(),
  });
  assert.equal(result.outcome, "published");
  assert.equal(result.postId, pid);
  assert.equal(result.url, url + "#post_content_" + pid);
});

test("accepts first-party mobile metadata and refuses mismatched or ambiguous board IDs", async () => {
  const scriptThread = '<script>const thread = {"fname":"表达练习"};</script>';
  const mobileBoard = '<a href="/mo/q/bawuindex?fn=%E8%A1%A8%E8%BE%BE%E7%BB%83%E4%B9%A0&amp;fid=28145568">吧务</a>';
  const proof = expected => fixture({ reads: [response(loginPage), response(scriptThread), response(expected)] });
  assert.equal((await submitThreadReply({ url, content, cookie }, proof(mobileBoard))).outcome, "published");
  for (const html of [
    '<a href="https://other.invalid/f?fid=28145568">错误来源</a>',
    '<a href="/mo/q/bawuindex?fn=another&amp;fid=28145568">其他吧</a>',
    mobileBoard + '<a href="/f?fid=333">不同编号</a>',
  ]) {
    const transport = proof(html);
    assert.equal((await submitThreadReply({ url, content, cookie }, transport)).outcome, "rejected");
    assert.equal(transport.writeCalls.length, 0);
  }
});

test("rejects bad input, expired sessions, safety challenges, and canceled approval before making a write", async () => {
  for (const input of [
    { url: "https://tieba.baidu.com.evil.invalid/p/11114876630", content, cookie },
    { url: "http://tieba.baidu.com/p/11114876630", content, cookie },
    { url: origin + "/p/0", content, cookie },
    { url, content: "短", cookie },
    { url, content, cookie: "bad cookie" },
  ]) {
    const transport = fixture();
    assert.equal((await submitThreadReply(input, transport)).outcome, "rejected");
    assert.equal(transport.readCalls.length, 0);
    assert.equal(transport.writeCalls.length, 0);
  }
  for (const read of [
    response('{"is_login":0}'),
    response("<title>百度安全验证</title>"),
    response("forbidden", 403),
  ]) {
    const transport = fixture({ reads: [read] });
    assert.equal((await submitThreadReply({ url, content, cookie }, transport)).outcome, "rejected");
    assert.equal(transport.readCalls.length, 1);
    assert.equal(transport.writeCalls.length, 0);
  }
  const transport = fixture();
  let guardCalls = 0;
  const result = await submitThreadReply({ url, content, cookie, canPost: () => { guardCalls += 1; return false; } }, transport);
  assert.equal(result.outcome, "rejected");
  assert.equal(transport.readCalls.length, 3);
  assert.equal(guardCalls, 1);
  assert.equal(transport.writeCalls.length, 0);
});

test("classifies confirmed receipt, rejection and ambiguous delivery without attempting a second write", async () => {
  for (const [reply, outcome] of [
    ['{"no":0,"data":{}}', "accepted"],
    ['{"no":"0","data":{"post_id":"' + pid + '","is_post_visible":"0"}}', "accepted"],
    ['{"no":231,"error":"do not forward "}', "rejected"],
    ['{"no":null}', "unknown"],
    ['{"no":false}', "unknown"],
    [response("<title>访问验证</title>"), "rejected"],
    [response("", 302), "rejected"],
    [response('{"no":0}', 503), "unknown"],
    [new Error("a transport error with " + cookie), "unknown"],
  ]) {
    const transport = fixture({ reply });
    const result = await submitThreadReply({ url, content, cookie }, transport);
    assert.equal(result.outcome, outcome);
    assert.equal(result.url, url);
    assert.equal(transport.writeCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-value|do not forward/);
  }
});

test("curl POST puts cookie and form on stdin and pins the destination, method and redirect behavior", async () => {
  let curlArgs;
  let stdinValue = "";
  const run = (_binary, args, _options, callback) => {
    curlArgs = args;
    const stdin = new Writable({
      write(chunk, _encoding, done) { stdinValue += chunk.toString(); done(); },
      final(done) {
        callback(null, Buffer.from('{"no":0}\n__CYRENE_TIEBA_HTTP__:200\napplication/json\n'));
        done();
      },
    });
    return { stdin };
  };
  const tid = "11114876630";
  const form = new URLSearchParams({ tid, content: content.trim(), tbs: "fixtureToken" });
  const endpoint = new URL("/f/commit/post/add", origin);
  const result = await authenticatedPost(endpoint, new AbortController().signal, cookie, form, tid, run);
  assert.deepEqual(result, { status: 200, buffer: Buffer.from('{"no":0}'), declared: "application/json", jar: "" });
  assert.deepEqual(curlArgs.slice(-2), ["--url", endpoint.href]);
  assert.equal(curlArgs[0], "--disable");
  assert.equal(curlArgs[curlArgs.indexOf("--config") + 1], "-");
  assert.equal(curlArgs[curlArgs.indexOf("--request") + 1], "POST");
  assert.ok(curlArgs.includes("Origin: " + origin) && curlArgs.includes(url));
  assert.doesNotMatch(curlArgs.join(" "), /fixture-value|fixtureToken|这段写得真有意思|--location|--retry|--insecure/);
  assert.match(stdinValue, /^header = "Cookie: BDUSS=fixture-value"\ndata-binary = "tid=11114876630&content=/);
  assert.match(stdinValue, /&tbs=fixtureToken"\n$/);
  assert.throws(() => authenticatedPost(new URL("/elsewhere", origin), undefined, cookie, form, tid, run));
  assert.throws(() => authenticatedPost(endpoint, undefined, cookie, form, "22", run));
});

test("reply cookies only include matching, current Baidu cookies", () => {
  const jar = [
    initialJar(cookie).trim(),
    "#HttpOnly_tieba.baidu.com\tFALSE\t/f\tTRUE\t0\teligible\tvalue",
    ".other.invalid\tTRUE\t/\tTRUE\t0\tforeign\tSECRET",
    "baidu.com\tFALSE\t/\tTRUE\t0\tonlyParent\tSECRET",
    "tieba.baidu.com\tFALSE\t/forum\tTRUE\t0\twrongPath\tSECRET",
    "tieba.baidu.com\tFALSE\t/\tTRUE\t1\texpired\tSECRET",
    "tieba.baidu.com\tFALSE\t/\tTRUE\t0\tbad;name\tSECRET",
  ].join("\n");
  assert.equal(replyCookie(jar), cookie + "; eligible=value");
});
