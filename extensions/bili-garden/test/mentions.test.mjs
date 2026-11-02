import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GardenStore } from "../lib/store.mjs";
import { GardenService } from "../lib/service.mjs";

const BV = "BV17x411w7KC";
function setup(t, { call, llm = {}, config = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cyrene-mention-"));
  const store = new GardenStore(root);
  store.saveConfig({ guardOn: true, autoSend: true, guardWhitelist: ["456"], quietStart: "00:00", quietEnd: "00:00", ...config });
  let now = Date.parse("2026-11-02T04:00:00Z");
  const client = { account: async () => ({ loggedIn: true, uid: "123" }), call,
    info: async () => ({ bvid: BV, title: "他人的视频", ownerUid: "789", duration: 30 }),
    subtitle: async () => ({ text: "", segments: [] }),
  };
  const service = new GardenService({ id: "bili-garden", signal: new AbortController().signal,
    storage: { rootDir: () => root }, deps: { llm } }, fileURLToPath(new URL("../", import.meta.url)), {
    client, store, now: () => now, schedule: false,
    runtime: { status: () => ({ installed: true }), stopWorker() {}, async close() {} },
  });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, store, advance: () => { now += 11 * 60000; } };
}
const mention = (rpid = "100", uid = "456") => ({ bvid: BV, rpid, uid, root_id: 0, text: "@昔涟 你在吗？" });

test("UP 视频列表失败不阻断其他视频中的白名单 @，扫描结果可见", async t => {
  const calls = [];
  const { service, store } = setup(t, { call: async (name, args) => {
    calls.push([name, args]);
    if (name === "bili_user_videos") throw new Error("fixture list unavailable");
    return { at: [mention()], comments: [], at_cursor: { id: 11, time: 20 }, at_resume: null };
  } });
  const result = await service.scanGuard();
  assert.equal(result.items.length, 1);
  assert.deepEqual(calls.find(([name]) => name === "bili_guard_scan")[1].bvids, []);
  assert.equal(store.get("cursor", "123").id, 11);
  const status = (await service.snapshot()).guard;
  assert.equal(status.lastScan.allowedAt, 1);
  assert.ok(status.lastScan.errors.some(message => message.includes("视频列表")));
});

test("扫描说明区分白名单过滤、无效目标和重复消息，且保留分页进度", async t => {
  let args;
  const resume = { id: 8, time: 8, head: { id: 20, time: 20 } };
  const { service, store } = setup(t, { call: async (name, input) => {
    if (name === "bili_user_videos") return { videos: [] };
    args = input;
    return { at: [mention(), mention("101", "999"), { ...mention("102"), bvid: "" }], comments: [],
      at_cursor: { id: 1, time: 1 }, at_resume: resume };
  } });
  await service.scanGuard();
  await service.scanGuard();
  assert.deepEqual(args.at_resume, resume);
  assert.equal(store.list("guard").length, 1);
  const scan = (await service.snapshot()).guard.lastScan;
  assert.equal(scan.filteredAt, 1);
  assert.equal(scan.invalid, 1);
  assert.equal(scan.queued, 0);
  assert.equal(scan.backlog, true);
});

test("别人视频下的一级 @ 没有字幕仍可自然回复，自动发送只执行一次", async t => {
  const sent = [];
  const { service, store, advance } = setup(t, {
    call: async (name, args) => {
      if (name === "bili_user_videos") return { videos: [] };
      if (name === "bili_guard_scan") return { at: [mention()], comments: [], at_cursor: { id: 1, time: 1 }, at_resume: null };
      if (name === "bili_reply") { sent.push(args); return { success: true, rpid: "200" }; }
      throw new Error("Unexpected fixture call");
    },
    llm: { runGoal: async input => {
      const find = name => input.tools.find(tool => tool.name === name);
      const read = JSON.parse(await find("read_video").execute({ bvid: BV }));
      assert.equal(read.available, false);
      const reply = JSON.parse(await find("propose_interaction").execute({ kind: "reply", bvid: BV, rpid: "100",
        text: "在呀，我是昔涟。这个视频暂时没有可读字幕，你想聊哪一段？", reason: "回应白名单用户的直接呼唤" }));
      assert.equal(reply.status, "sent");
      await find("finish_report").execute({ items: [], summary: "已回复这条呼唤" });
      return { terminal: { status: "success" } };
    } },
  });
  await service.tick();
  await service.active?.promise;
  assert.equal(store.runs()[0].status, "success");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bvid, BV);
  assert.equal(sent[0].rpid, 100);
  assert.equal(sent[0].root, 0);
  advance(); await service.tick(); await service.active?.promise;
  assert.equal(sent.length, 1);
});

test("关闭自动发送时留草稿，撤销白名单后手动发送也被拒绝", async t => {
  let sends = 0;
  const { service, store } = setup(t, { config: { autoSend: false }, call: async name => {
    if (name === "bili_user_videos") return { videos: [] };
    if (name === "bili_guard_scan") return { at: [mention()], comments: [], at_cursor: { id: 1, time: 1 } };
    sends++; return { success: true, rpid: "200" };
  } });
  await service.scanGuard();
  const draft = await service.policy.draft({ kind: "reply", guard: true, bvid: BV, rpid: "100", text: "我在这里。", reason: "回答用户在评论中的呼唤" });
  assert.equal(draft.status, "draft");
  assert.equal(sends, 0);
  store.saveConfig({ guardWhitelist: [] });
  await assert.rejects(() => service.policy.execute(draft.id), /白名单/);
  assert.equal(sends, 0);
});

test("历史失败 @ 可以重新入队，已发送和结果不明的记录不会重放", async t => {
  const { service, store } = setup(t);
  for (const [id, status] of [["1", null], ["2", "uncertain"], ["3", "sent"], ["4", "failed"]]) {
    store.put("guard", `123:${id}`, { ...mention(id), kind: "at", accountUid: "123", status: "pending", attempts: 3 });
    if (status) {
      const action = store.draft({ idem: `123:reply:${BV}:${id}`, day: "2026-11-02", kind: "reply", rpid: id, bvid: BV, accountUid: "123", guard: true });
      store.updateAction(action.id, status);
    }
  }
  const result = await service.dispatch("guard-retry");
  assert.match(result.message, /2 条/);
  assert.equal(store.get("guard", "123:1").attempts, 0);
  assert.equal(store.get("guard", "123:4").attempts, 0);
  assert.equal(store.get("guard", "123:2").attempts, 3);
  assert.equal(store.get("guard", "123:3").attempts, 3);
});

test("模型没有处理 @ 时不能用空报告伪装成功", async t => {
  const { service, store } = setup(t, { call: async name => name === "bili_user_videos" ? { videos: [] }
    : { at: [mention()], comments: [], at_cursor: { id: 1, time: 1 } },
    llm: { runGoal: async input => {
      await input.tools.find(tool => tool.name === "finish_report").execute({ items: [], summary: "没有字幕所以跳过" });
      return { terminal: { status: "success" } };
    } },
  });
  await service.tick(); await service.active?.promise;
  assert.equal(store.runs()[0].status, "failed");
  assert.match(store.runs()[0].error, /未处理/);
  assert.equal(store.pendingGuard("123", 3).length, 1);
});
