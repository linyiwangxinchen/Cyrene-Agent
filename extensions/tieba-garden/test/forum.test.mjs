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
