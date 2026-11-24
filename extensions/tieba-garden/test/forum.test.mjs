import assert from "node:assert/strict";
import test from "node:test";
import { floorsFromHtml, repliesFromHtml, threadId } from "../index.mjs";
import { mobileRepliesFromHtml, mobileReplyPagePath, publicPage, repliesFromMobilePage, TiebaPageError } from "../lib/public-pages.mjs";
import {
  rememberExpression,
  relevantExpression,
} from "../../bili-garden/lib/expressions.mjs";

test("parsed floors and nested replies retain their origin", () => {
  assert.deepEqual(
    floorsFromHtml('<div id="post_content_12">首楼<br>在这儿</div>'),
    [{ post: "12", body: "首楼\n在这儿" }],
  );
  assert.deepEqual(
    repliesFromHtml(
      '<span class="lzl_content_main">回复小鱼：来啦</span>',
      "12",
    ),
    [{ post: "12", body: "回复小鱼：来啦", reply: true }],
  );
  assert.equal(threadId("https://tieba.baidu.com/p/123?pn=2"), "123");
  for (const url of [
    "https://example.com/p/123",
    "https://tieba.baidu.com.example.org/p/123",
    "/f?kw=a",
  ])
    assert.throws(() => threadId(url));
});

test("mobile floors exclude the top bar and retain text without post IDs", () => {
  const html = `
    <div class="top_bar content">导航</div>
    <div class="content lz">首楼 <b>正文</b><br>第二行</div>
    <div class='content'>回复<div><img src="picture"></div>继续 &amp; 结束</div>
    <div class="content">&nbsp;</div>
    <div class="pb_prompt_content is_prompt_show">立即下载客户端</div>
  `;
  assert.deepEqual(floorsFromHtml(html), []);
  assert.deepEqual(floorsFromHtml(html, true), [
    { post: "", body: "首楼 正文\n第二行" },
    { post: "", body: "回复\n继续 & 结束" },
  ]);
  assert.deepEqual(
    floorsFromHtml(html + '<div id="post_content_34">带 ID 的正文</div>', true),
    [{ post: "34", body: "带 ID 的正文" }],
  );
});

test("mobile floors use the enclosing main post's ID and floor number", () => {
  const html = `
    <ul>
      <li data-info="{&quot;pid&quot;:12345678901234567890,&quot;floor_num&quot;:11}" class="list_item j_post_list_item">
        <div class="list_item_wrapper"><div class="content" lz="1">第一个主楼层</div></div>
        <ul><li pid="42" class="j_list_item_floor">楼中楼</li></ul>
      </li>
      <li class="list_item j_post_list_item" data-info="{&quot;floor_num&quot;:12}">
        <div class="content">只有楼层号</div>
        <ul><li pid="44" class="j_list_item_floor">楼中楼</li></ul>
      </li>
      <li class="list_item j_post_list_item" data-info="{">
        <div class="content">无法读取楼层元数据</div>
      </li>
    </ul>
  `;
  assert.deepEqual(floorsFromHtml(html, true), [
    { post: "12345678901234567890", floor: 11, body: "第一个主楼层" },
    { post: "", floor: 12, body: "只有楼层号" },
    { post: "", body: "无法读取楼层元数据" },
  ]);
});

test("mobile thread pages keep embedded replies and counts with their parent floors", () => {
  const reply = (id, body) => `<li class="list_item_floor j_list_item_floor" pid="${id}">
    <div class="fmain j_floor_main"><div class="floor_footer_item">
      <a class="user_name">用户名</a><span class="floor_content">${body}</span>
    </div></div>
  </li>`;
  const item = (id, panel) => `<li class="j_post_list_item" data-info="{&quot;pid&quot;:${id}}">
    <div class="content">主楼层</div>${panel}
  </li>`;
  const panel = (count, replies) => `<div class="fr_list 2 j_floor_panel" data-list-count="${count}">
    <ul class="flist">${replies}</ul><a>查看全部回复</a>
  </div>`;
  const first = "12345678901234567890";
  const html = `<ul>
    ${item(first, panel(4, reply(42, "第一条<br>继续 &amp; 收尾") + reply(42, "重复") + reply(43, "&nbsp;")))}
    ${item("8", panel(0, ""))}
    ${item("9", "")}
    ${item("10", panel(1, reply(99, "未选中")))}
    ${item("11", panel("unknown", reply(55, "第二个楼层的回复")))}
  </ul>`;
  assert.deepEqual(mobileRepliesFromHtml(html, [first, "8", "9", "11"]), {
    replies: [
      { post: first, body: "第一条\n继续 & 收尾", reply: true, replyId: "42" },
      { post: "11", body: "第二个楼层的回复", reply: true, replyId: "55" },
    ],
    counts: new Map([[first, 4], ["8", 0]]),
  });
  const large = item("8", panel(50, Array.from({ length: 50 }, (_, index) => reply(index, "正文")).join("")));
  assert.equal(mobileRepliesFromHtml(large, ["8"]).replies.length, 40);
});

test("mobile replies use the first-party JSON route and retain page metadata", async (t) => {
  const html = `<li pid="12345678901234567890" class="list_item_floor j_list_item_floor">
    <div class="floor_footer_item"><a class="user_name">用户名</a><span class="floor_content">回复正文</span></div>
  </li>`;
  const payload = JSON.stringify({
    no: 0,
    data: { page: { current_page: 2, total_page: 2, total_num: 12 }, total_num: 2, floor_html: html },
  });
  const path = mobileReplyPagePath("10", "20", 2);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://tieba.baidu.com/mo/q/flr?kz=10&pid=20&fpn=2&is_ajax=1&has_url_param=0");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Accept, "application/json");
    return new Response(payload, { headers: { "content-type": "application/json; charset=utf-8" } });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(repliesFromMobilePage(await publicPage(path, signal), "20"), {
    replies: [{ post: "20", body: "回复正文", reply: true, replyId: "12345678901234567890" }],
    page: 2,
    total: 12,
    totalPages: 2,
  });
  assert.throws(() => mobileReplyPagePath("10", "20&pid=30"), TiebaPageError);
  await assert.rejects(publicPage(path + "&extra=1", signal), TiebaPageError);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test("mobile reply reads stop on redirects and verification responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, {
    status: 302,
    headers: { Location: "https://example.com/redirect" },
  }));
  const signal = new AbortController().signal;
  const path = mobileReplyPagePath("10", "20");
  const paused = error => error instanceof TiebaPageError && error.pauseVisit === true;
  await assert.rejects(publicPage(path, signal), paused);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.throws(() => repliesFromMobilePage('<title>百度安全验证</title>', "20"), paused);
  assert.throws(() => repliesFromMobilePage('{"no":403,"errmsg":"百度安全验证"}', "20"), paused);
});

test("Bilibili saves verifiable quotations and retrieves a relevant scene", () => {
  const store = { put: (_type, _id, item) => item };
  assert.throws(() =>
    rememberExpression(store, "url", "编造的", "调侃", "真正的原文"),
  );
  const sample = rememberExpression(
    store,
    "https://www.bilibili.com/video/BV1234567890",
    "鱼力全开",
    "准备开工",
    "打起精神，鱼力全开！",
  );
  assert.match(relevantExpression([sample], "准备开工"), /鱼力全开/);
  assert.equal(relevantExpression([sample], "午饭吃啥"), "");
  assert.equal(relevantExpression([sample], "难受，准备开工"), "");
});
