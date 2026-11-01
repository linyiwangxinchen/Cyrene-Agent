import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GardenStore } from "../lib/store.mjs";
import { normalizeConfig, due, localClock, videoId } from "../lib/config.mjs";
import { InteractionPolicy, invitation } from "../lib/policy.mjs";
import { saveReport, markdownReport, timePlaylist } from "../lib/content.mjs";
import { GardenRunner } from "../lib/runner.mjs";
import { GardenService } from "../lib/service.mjs";
import { BilibiliClient } from "../lib/bilibili.mjs";

test("缺少平台回执不能记成发送成功", async t => {
  const {store}=setup(t);store.saveConfig({dmOn:true,dmUid:'456'});
  const p=policy(store,{call:async()=>({})});
  const draft=await p.draft({kind:'dm',targetUid:'456',text:'今天想分享一条视频。',reason:'分享刚刚读取的视频发现'});
  await assert.rejects(()=>p.execute(draft.id),/回执/);
  assert.equal(store.action(draft.id).status,'uncertain');
});

const BV = "BV1JcnW6pEFT",
  BV2 = "BV1bNns6BEEA";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cyrene-garden-"));
  let store = new GardenStore(root);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    reopen() {
      store.close();
      store = new GardenStore(root);
      return store;
    },
  };
}
function evidence(store, bvid = BV) {
  store.put("video", bvid, {
    bvid,
    title: "一条真实视频",
    owner: "UP",
    duration: 300,
  });
  store.put("evidence", bvid, {
    bvid,
    text: "春天种花需要阳光",
    source: "subtitle",
    segments: [{ from: 12, to: 15, text: "春天种花需要阳光" }],
  });
}
const account = async () => ({ loggedIn: true, uid: "123", name: "测试账号" });
function policy(
  store,
  client = {
    call: async () => ({ success: true, rpid: "888", has_liked: true }),
  },
) {
  return new InteractionPolicy({
    store,
    client,
    config: () => store.config(),
    account,
  });
}

test("配置、BV、时区与零额度有统一语义", () => {
  assert.equal(videoId(`https://www.bilibili.com/video/${BV}?t=30`), BV);
  assert.throws(() => videoId("https://evil.test/video/" + BV));
  assert.throws(() => normalizeConfig({ timezone: "not-a-zone" }));
  assert.throws(() => normalizeConfig({ likesPerDay: 11 }));
  assert.throws(() => normalizeConfig({ dmOn: true }));
  const cfg = normalizeConfig({
    autoRun: true,
    quietStart: "00:00",
    quietEnd: "00:00",
    runsPerDay: 2,
  });
  const now = new Date("2026-11-01T16:00:00Z");
  assert.equal(localClock(now, cfg.timezone).day, "2026-11-02");
  assert.equal(due(cfg, { now, loggedIn: true }), true);
  assert.equal(due({ ...cfg, runsPerDay: 0 }, { now, loggedIn: true }), false);
  assert.equal(
    due(
      { ...cfg, valleyOnly: true },
      { now: new Date("2026-11-02T02:00:00Z"), loggedIn: true },
    ),
    false,
  );
  assert.equal(
    due(
      { ...cfg, valleyOnly: true },
      { now: new Date("2026-11-01T02:00:00Z"), loggedIn: true },
    ),
    true,
  );
});
test("重启保留数据，将中断发送标成 uncertain，不允许重新预留", (t) => {
  const fixture = setup(t),
    s = fixture.store;
  s.saveConfig({ interests: "园艺" });
  const run = s.startRun({
    day: "2026-11-01",
    source: "auto",
    kind: "discover",
  });
  const a = s.draft({ idem: "unique", day: run.day, kind: "like" });
  s.reserveAction(a.id, { day: run.day, daily: 1 });
  s.updateRun(run.id, { phase: "读字幕" });
  const restored = fixture.reopen();
  assert.equal(restored.config().interests, "园艺");
  assert.equal(restored.run(run.id).status, "interrupted");
  assert.equal(restored.action(a.id).status, "uncertain");
  assert.throws(() => restored.reserveAction(a.id, { day: run.day, daily: 5 }));
});
test("没有内容证据不能互动，私信唯一UID在所有草稿入口生效", async (t) => {
  const { store } = setup(t),
    p = policy(store);
  store.saveConfig({ dmOn: true, dmUid: "456" });
  await assert.rejects(
    () => p.draft({ kind: "like", bvid: BV, reason: "我觉得内容很有价值" }),
    /证据/,
  );
  await assert.rejects(
    () =>
      p.draft({
        kind: "dm",
        targetUid: "999",
        text: "你好",
        reason: "想分享本轮看过的内容",
      }),
    /唯一/,
  );
});
test("关闭开关与0额度拒绝；并发操作只能发送一次", async (t) => {
  const { store } = setup(t);
  evidence(store);
  let calls = 0;
  const p = policy(store, {
    call: async () => {
      calls++;
      return { has_liked: true };
    },
  });
  const a = await p.draft({
    kind: "like",
    bvid: BV,
    reason: "这段内容提供实用的园艺方法",
  });
  await assert.rejects(() => p.execute(a.id), /关闭/);
  store.saveConfig({ likeOn: true, likesPerDay: 0 });
  await assert.rejects(() => p.execute(a.id), /额度/);
  store.saveConfig({ likesPerDay: 1 });
  const r = await Promise.allSettled([p.execute(a.id), p.execute(a.id)]);
  assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
});
test("网络中断保持 uncertain，平台明确拒绝才记 failed 并冷却", async (t) => {
  const { store } = setup(t);
  evidence(store);
  store.saveConfig({ likeOn: true });
  const p = policy(store, {
    call: async () => {
      throw new Error("timeout");
    },
  });
  const a = await p.draft({
    kind: "like",
    bvid: BV,
    reason: "这条教我如何养花很有用",
  });
  await assert.rejects(() => p.execute(a.id));
  assert.equal(store.action(a.id).status, "uncertain");
  evidence(store, BV2);
  const q = policy(store, {
    call: async () => {
      throw Object.assign(new Error("-412 risk"), { definitive: true });
    },
  });
  const b = await q.draft({
    kind: "like",
    bvid: BV2,
    reason: "新的养花方法值得参考",
  });
  await assert.rejects(() => q.execute(b.id));
  assert.equal(store.action(b.id).status, "failed");
  assert.ok(store.get("meta", "cooldown").until > Date.now());
});
test("仅受邀回复重新验证UP身份与否定语义", async (t) => {
  assert.equal(invitation("昔涟快来看看"), true);
  assert.equal(invitation("昔涟不要来"), false);
  const { store } = setup(t);
  evidence(store);
  store.saveConfig({ commentMode: "invited" });
  let sent = 0;
  const client = {
    info: async () => ({ ownerUid: "42" }),
    call: async (name) =>
      name === "bili_comments"
        ? { comments: [{ rpid: "9", mid: "99", content: "昔涟快来" }] }
        : (sent++, { success: true }),
  };
  const p = policy(store, client),
    a = await p.draft({
      kind: "reply",
      bvid: BV,
      rpid: "9",
      text: "我来看看这朵花。",
      reason: "作者邀请对园艺内容交流",
    });
  await assert.rejects(() => p.execute(a.id), /邀请/);
  assert.equal(sent, 0);
});
test("结构化报告按轮累积，伪造证据拒绝；限时片单有真实时长", (t) => {
  const { store } = setup(t);
  evidence(store);
  const input = {
    items: [
      {
        bvid: BV,
        summary: "种花需要阳光。",
        reason: "很适合你的小阳台。",
        citations: [0],
      },
    ],
    diary: "想和你一起看花开。",
    memories: ["用户喜欢园艺"],
  };
  assert.throws(() =>
    saveReport(
      store,
      { id: "bad", day: "2026-11-01" },
      { ...input, items: [{ ...input.items[0], citations: [99] }] },
      1,
    ),
  );
  saveReport(store, { id: "one", day: "2026-11-01" }, input, 1);
  saveReport(store, { id: "two", day: "2026-11-01" }, input, 1);
  assert.equal(store.list("report").length, 2);
  assert.equal(store.picked("2026-11-01"), 2);
  assert.match(markdownReport(store.list("report")), /\?t=12/);
  assert.equal(timePlaylist(store.list("video"), 10).seconds, 300);
});
test("真实工具循环契约注入昔涟人格、已存记忆与证据后提交", async (t) => {
  const { store } = setup(t);
  store.put("memory", "m", { text: "喜欢园艺" });
  let received;
  const client = {
    info: async () => ({ bvid: BV, title: "花园", owner: "UP", duration: 300 }),
    subtitle: async () => ({
      bvid: BV,
      text: "花要晒太阳",
      segments: [{ from: 1, text: "花要晒太阳" }],
    }),
  };
  const llm = {
    runGoal: async (input) => {
      received = input;
      const run = async (id, args) =>
        JSON.parse(await input.tools.find((t) => t.name === id).execute(args));
      await run("read_video", { bvid: BV });
      await run("finish_report", {
        items: [
          {
            bvid: BV,
            summary: "花要晒太阳",
            reason: "适合小阳台养花",
            citations: [0],
          },
        ],
        summary: "发现了实用养花视频",
        memories: [],
      });
      return { terminal: { status: "success" }, rounds: 2 };
    },
  };
  const runner = new GardenRunner({
    store,
    client,
    policy: policy(store),
    llm,
    config: () => store.config(),
    charter: async () => "沿用昔涟人格",
  });
  await runner.run(
    { id: "run", day: "2026-11-01", kind: "discover" },
    {},
    new AbortController().signal,
  );
  assert.equal(received.personaMode, "chat");
  assert.match(received.context, /喜欢园艺/);
  assert.ok(store.get("report", "run"));
});
test("模型只说完成而不提交报告时明确失败", async (t) => {
  const { store } = setup(t);
  const runner = new GardenRunner({
    store,
    client: {},
    policy: policy(store),
    llm: {
      runGoal: async () => ({
        terminal: { status: "success" },
        text: "我都做好了",
      }),
    },
    config: () => store.config(),
    charter: async () => "",
  });
  await assert.rejects(
    () =>
      runner.run(
        { id: "missing", day: "2026-11-01", kind: "discover" },
        {},
        new AbortController().signal,
      ),
    /没有提交/,
  );
  assert.equal(store.list("report").length, 0);
});
test("服务取消会中止任务，停止后不能再次操作；配置和待看保留", async (t) => {
  const { store, root } = setup(t);
  const ctx = {
    storage: { rootDir: () => root },
    signal: new AbortController().signal,
    deps: {
      llm: {
        listProfiles: async () => [],
        runGoal: (input) =>
          new Promise((_, reject) =>
            input.signal.addEventListener("abort", () =>
              reject(new Error("cancel")),
            ),
          ),
      },
    },
  };
  const runtime = {
    status: () => ({ installed: true }),
    stopWorker() {},
    async close() {},
  };
  const service = new GardenService(ctx, packageRoot, {
    store,
    runtime,
    client: { account },
    schedule: false,
  });
  await service.dispatch("config", { interests: "植物" });
  await service.dispatch("queue", { bvid: BV });
  const run = await service.dispatch("run", {});
  await new Promise((r) => setTimeout(r, 10));
  service.cancel();
  await service.active?.promise;
  assert.equal(store.run(run.runId).status, "cancelled");
  assert.equal(store.get("video", BV).queueStatus, "queued");
  await service.close();
  await assert.rejects(() => service.dispatch("snapshot"), /停止/);
});

test("检查期间关闭互动会立即阻断网络发送", async (t) => {
  const { store } = setup(t);
  evidence(store);
  store.saveConfig({ commentMode: "invited" });
  let sent = 0;
  const client = {
    info: async () => {
      store.saveConfig({ commentMode: "off" });
      return { ownerUid: "42" };
    },
    call: async (name) =>
      name === "bili_comments"
        ? { comments: [{ rpid: "9", mid: "42", content: "昔涟快来看看" }] }
        : (sent++, { success: true }),
  };
  const p = policy(store, client),
    a = await p.draft({
      kind: "reply",
      bvid: BV,
      rpid: "9",
      text: "我来看看花。",
      reason: "作者邀请交流养花方法",
    });
  await assert.rejects(() => p.execute(a.id), /变化/);
  assert.equal(sent, 0);
  assert.equal(store.action(a.id).status, "draft");
});
test("守护队列先持久化再推进游标，未处理项不会因本轮上限丢失", async (t) => {
  const { store, root } = setup(t);
  store.saveConfig({ guardOn: true, guardPerRound: 1 });
  const client = {
    account,
    call: async (name) =>
      name === "bili_user_videos"
        ? { videos: [{ bvid: BV }] }
        : {
            at: [],
            comments: [1, 2, 3].map((n) => ({
              bvid: BV,
              rpid: String(n),
              uid: 100 + n,
              text: "这种花应该如何浇水呢？",
              ctime: n,
            })),
            at_cursor: { id: 5, time: 6 },
          },
  };
  const service = new GardenService(
    {
      id: "bili-garden",
      storage: { rootDir: () => root },
      signal: new AbortController().signal,
      deps: { llm: {} },
    },
    packageRoot,
    {
      client,
      store,
      runtime: {
        status: () => ({ installed: true }),
        stopWorker() {},
        async close() {},
      },
      schedule: false,
    },
  );
  const scan = await service.scanGuard();
  assert.equal(scan.items.length, 1);
  assert.equal(store.list("guard").length, 3);
  assert.equal(store.get("cursor", "123").ctimes[BV], 3);
  await service.close();
});
test("ASR受当日额度限制且真正保存来源，空字幕不伪造成内容", async (t) => {
  const { store } = setup(t);
  store.saveConfig({ transcribe: true, transcribePerDay: 1 });
  let calls = 0,
    second;
  const client = {
    info: async (bvid) => ({ bvid, title: "花园", duration: 100 }),
    subtitle: async () => ({ text: "", segments: [] }),
    transcribe: async (bvid) => {
      calls++;
      return {
        bvid,
        text: "本地转写内容",
        source: "asr",
        segments: [{ from: 2, text: "本地转写内容" }],
      };
    },
  };
  const runner = new GardenRunner({
    store,
    client,
    policy: policy(store),
    config: () => store.config(),
    charter: async () => "",
    llm: {
      runGoal: async (input) => {
        const read = input.tools.find((t) => t.name === "read_video");
        await read.execute({ bvid: BV });
        second = JSON.parse(await read.execute({ bvid: BV2 }));
        await input.tools
          .find((t) => t.name === "finish_report")
          .execute({ items: [], summary: "只记录可读内容" });
        return { terminal: { status: "success" } };
      },
    },
  });
  await runner.run(
    { id: "asr", day: "2026-11-01", kind: "discover" },
    {},
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(store.get("evidence", BV).source, "asr");
  assert.equal(second.available, false);
  assert.equal(store.get("evidence", BV2), null);
});

test("守护明确失败可以重试，草稿和结果不明不会重新派给模型", async (t) => {
  const { store } = setup(t);
  evidence(store);
  store.saveConfig({ guardOn: true });
  store.put("guard", "123:8", {
    accountUid: "123",
    bvid: BV,
    rpid: "8",
    uid: "99",
    kind: "comment",
    status: "pending",
    attempts: 1,
  });
  const p = policy(store),
    input = {
      kind: "reply",
      bvid: BV,
      rpid: "8",
      guard: true,
      text: "可以先看看光照。",
      reason: "回复具体的园艺提问",
    };
  const a = await p.draft(input, { id: "first" });
  assert.equal(store.pendingGuard("123", 3).length, 0);
  store.updateAction(a.id, "failed", { error: "明确拒绝" });
  assert.equal(store.pendingGuard("123", 3).length, 1);
  const retry = await p.draft(input, { id: "second" });
  assert.equal(retry.id, a.id);
  assert.equal(retry.status, "draft");
  store.updateAction(a.id, "uncertain");
  assert.equal(store.pendingGuard("123", 3).length, 0);
  assert.equal((await p.draft(input, { id: "third" })).status, "uncertain");
});
test("普通评论解析指定昵称并保存实际发送正文", async (t) => {
  const { store } = setup(t);
  evidence(store);
  store.saveConfig({ commentMode: "normal", mentionUid: "456" });
  let sent;
  const p = policy(store, {
    call: async (name, args) =>
      name === "bili_user_info"
        ? { name: "读者" }
        : ((sent = args), { success: true, rpid: "900" }),
  });
  const a = await p.draft({
    kind: "comment",
    bvid: BV,
    text: "这段方法很实用。",
    reason: "分享有证据的园艺方法",
  });
  const done = await p.execute(a.id);
  assert.equal(sent.text, "@读者 这段方法很实用。");
  assert.equal(done.sentText, sent.text);
});
test("扫码凭据只交给 secrets，任意二维码key拒绝，面板结果不含cookie", async () => {
  const secrets = new Map();
  const jar = {
    get: async (k) => secrets.get(k),
    set: async (k, v) => secrets.set(k, v),
    delete: async (k) => secrets.delete(k),
  };
  const runtime = {
    status: () => ({ installed: true }),
    request: async () => ({ image: "data:image/png;base64,fixture" }),
    stopWorker() {},
  };
  const client = new BilibiliClient({
    secrets: jar,
    runtime,
    fetchImpl: async (url) => {
      if (url.includes("generate"))
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              qrcode_key: "test-key",
              url: "https://passport.bilibili.com/fixture",
            },
          }),
        );
      if (url.includes("/poll")) {
        const headers = new Headers();
        headers.append("set-cookie", "SESSDATA=private-fixture; Path=/");
        headers.append("set-cookie", "bili_jct=private-csrf; Path=/");
        headers.append("set-cookie", "DedeUserID=123; Path=/");
        return new Response(JSON.stringify({ code: 0, data: { code: 0 } }), {
          headers,
        });
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: { isLogin: true, mid: 123, uname: "测试账号" },
        }),
      );
    },
  });
  assert.equal((await client.loginPoll("not-issued")).state, "expired");
  await client.loginStart();
  const result = await client.loginPoll("test-key");
  assert.equal(result.state, "ok");
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
  assert.match(await jar.get("bilibili-account"), /private-fixture/);
  await client.logout();
  assert.equal(await client.loggedIn(), false);
});
