import assert from "node:assert/strict";
import test from "node:test";
import { floorsFromHtml, repliesFromHtml, threadId } from "../index.mjs";
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
