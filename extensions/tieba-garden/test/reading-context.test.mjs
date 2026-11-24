import assert from "node:assert/strict";
import test from "node:test";
import { registerReadingContext } from "../reading-context.mjs";

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
});
