// Run after build:server and staging bundled plugins. Uses only temporary data and loopback HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { GardenStore } from "../../extensions/bili-garden/lib/store.mjs";
import { rememberExpression } from "../../extensions/bili-garden/lib/expressions.mjs";
import {
  responseBody,
  streamEvents,
} from "../../src/main/orchestrator/vendors/sdk-stream/model-fixtures.ts";
const require = createRequire(import.meta.url);
const { createWebServer } = require("../../dist/server/server/index.js");
const {
  CURRENT_DISCLAIMER_VERSION,
} = require("../../dist/server/shared/disclaimer.js");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "cyrene-expression-"));
const garden = new GardenStore(path.join(dataDir, "plugin-data/bili-garden"));
garden.saveConfig({ learnExpressions: true });
rememberExpression(
  garden,
  "https://www.bilibili.com/video/BV1JcnW6pEFT",
  "花盆加班",
  "阳台浇水",
  "今天轮到花盆加班",
);
garden.close();
const captured = [];
const quote = "气泡锚点";
const gateway = createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const body = JSON.parse(Buffer.concat(parts).toString());
  captured.push(body);
  const extract = JSON.stringify(body.input ?? body.messages).includes(
    "阅读论坛对话",
  );
  const answer = extract
    ? JSON.stringify({
        summary: "摘录里用一个比喻形容网络断线。",
        evidence: [quote],
        expressions: [{
          quote,
          scene: "网络断线修复",
          cue: "庆祝",
          delivery: "先接住对方的好消息，再轻轻开一句玩笑",
        }],
      })
    : JSON.stringify(body.input ?? body.messages).includes(
          "plugin:tieba-garden:expressions",
        )
      ? "先把这个气泡锚点修好。"
      : JSON.stringify(body.input ?? body.messages).includes(
            "你们在私聊中形成的说话习惯",
          ) && JSON.stringify(body.input ?? body.messages).includes("好家伙")
        ? "好家伙，周末想去哪逛逛？"
        : "已经收到。";
  const transport = req.url.includes("/responses") ? "responses" : "openai";
  res.writeHead(200, {
    "Content-Type": body.stream ? "text/event-stream" : "application/json",
  });
  if (!body.stream)
    return res.end(JSON.stringify(responseBody(transport, { text: answer })));
  for (const e of streamEvents(transport, { text: answer }))
    res.write("data: " + JSON.stringify(e) + "\n\n");
  res.end("data: [DONE]\n\n");
});
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await listen(gateway);
const profile = {
  id: "local",
  provider: "ChatGPT（OpenAI）",
  model: "fixture-model",
  models: ["fixture-model"],
  explicitTransport: "responses",
  baseUrl: "http://127.0.0.1:" + gateway.address().port + "/v1",
  apiKey: "fixture-only",
};
await writeFile(
  path.join(dataDir, "web-data.json"),
  JSON.stringify({
    version: 1,
    sessions: [],
    recentProjects: [],
    settings: {
      general: {
        disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION,
        chatToolsEnabled: false,
        proactiveChatMode: "off",
        momentsEnabled: false,
      },
      config: { memoryMode: "off", runtimeSync: "off" },
      modelProfiles: [profile],
      defaultModelProfileId: "local",
    },
  }),
);
const events = [];
let cookie = "",
  token = "",
  socket;
const handle = createWebServer({
  dataDir,
  staticRoot: path.resolve("dist/renderer"),
  sharedCore: true,
  secureCookies: false,
  setupToken: "local-fixture",
});
async function http(route, body, headers = {}) {
  const response = await fetch(
    "http://127.0.0.1:" + handle.server.address().port + route,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
  const value = await response.json();
  assert.ok(response.ok, route + " " + JSON.stringify(value));
  return { value, response };
}
const invoke = async (channel, ...args) =>
  (
    await http(
      "/api/core/invoke",
      { channel, args },
      { "X-Cyrene-Client": token },
    )
  ).value;
async function waitFor(predicate, label) {
  const until = Date.now() + 30000;
  while (!predicate()) {
    if (Date.now() > until) throw Error("Timed out: " + label);
    await new Promise((r) => setTimeout(r, 40));
  }
}
async function ask(mode, message, expected, existing, expectedReply) {
  const session =
    existing ?? (await invoke("chats:create", { mode, title: message }));
  if (mode !== "chat")
    assert.ok(
      (
        await invoke("chats:set-workspace", {
          sessionId: session.id,
          workspaceRoot: dataDir,
        })
      ).ok,
    );
  const marker = randomUUID();
  const text = message + " " + marker;
  const start = captured.length;
  const ack = await invoke("agui:run", {
    sessionId: session.id,
    currentUser: { turnId: randomUUID(), text, visibleContent: text },
    assistantTurnId: randomUUID(),
    styleId: "default",
  });
  assert.ok(ack.success, JSON.stringify(ack));
  const terminal = () =>
    events.find(
      (e) =>
        e.channel === "agui:event" &&
        e.args[0]?.runId === ack.runId &&
        ["RUN_FINISHED", "RUN_ERROR"].includes(e.args[0].type),
    );
  await waitFor(terminal, mode + " response");
  assert.equal(
    terminal().args[0].type,
    "RUN_FINISHED",
    JSON.stringify(terminal()),
  );
  const body = captured
    .slice(start)
    .find((b) => JSON.stringify(b).includes(marker));
  assert.ok(body, "missing model request");
  const modelInput = JSON.stringify([
    body.instructions,
    body.input ?? body.messages,
  ]);
  assert.equal(
    modelInput.includes(quote),
    expected,
    mode + " expression in final payload",
  );
  assert.equal(
    modelInput.includes("plugin:tieba-garden:expressions"),
    expected,
    mode + " expression provider",
  );
  if (expected)
    assert.ok(
      events.some(
        (e) =>
          e.channel === "agui:event" &&
          e.args[0]?.runId === ack.runId &&
          e.args[0].type === "TEXT_MESSAGE_CONTENT" &&
          JSON.stringify(e.args[0]).includes(quote),
      ),
      "fixture reply rendered the learned expression",
    );
  if (expectedReply)
    assert.ok(
      events.some(
        (e) =>
          e.channel === "agui:event" &&
          e.args[0]?.runId === ack.runId &&
          e.args[0].type === "TEXT_MESSAGE_CONTENT" &&
          JSON.stringify(e.args[0]).includes(expectedReply),
      ),
      "cross-chat expression in streamed reply",
    );
  console.log("PASS", mode, message, expected);
  return session;
}
try {
  if (process.argv.includes("--desktop")) {
    const { verifyDesktop } = await import(
      "./companion-expressions-desktop.mjs"
    );
    await verifyDesktop(profile, captured);
  }
  await listen(handle.server);
  await http(
    "/api/auth/bootstrap",
    { username: "tester", password: "Fixture-123456" },
    { "X-Cyrene-Setup-Token": "local-fixture" },
  );
  const login = await http("/api/auth/login", {
    username: "tester",
    password: "Fixture-123456",
  });
  cookie = login.response.headers.get("set-cookie").split(";")[0];
  socket = new WebSocket(
    "ws://127.0.0.1:" + handle.server.address().port + "/ws",
    { headers: { Cookie: cookie } },
  );
  socket.on("message", (raw) => {
    const e = JSON.parse(String(raw));
    if (e.type === "ready") token = e.clientToken;
    if (e.type === "CORE_EVENT") events.push(e);
  });
  await waitFor(() => token, "auth");
  await handle.startChannels();
  await invoke("plugins:set-enabled", "tieba-garden", true);
  const panel = async (cmd, args = {}) => {
    const reply = await invoke(
      "plugins:panel:invoke",
      "tieba-garden",
      "forum",
      [cmd, args],
    );
    assert.ok(reply.ok, JSON.stringify(reply));
    return reply.data;
  };
  await panel("save", { bar: "摄影", learn: true });
  const fixtureCookie = "BDUSS=web_tieba_fixture_session; STOKEN=web_tieba_fixture_token";
  assert.equal((await panel("auth-save", { cookie: fixtureCookie })).auth.hasCookie, true);
  const secretsDir = path.join(dataDir, "plugin-data", "tieba-garden", "secrets");
  const secretFiles = await readdir(secretsDir);
  assert.equal(secretFiles.length, 1);
  assert.match(secretFiles[0], /\.enc$/);
  assert.ok(!(await readFile(path.join(secretsDir, secretFiles[0]))).includes(fixtureCookie));
  await invoke("plugins:set-enabled", "tieba-garden", false);
  await invoke("plugins:set-enabled", "tieba-garden", true);
  assert.equal((await panel("state", { compact: true })).auth.hasCookie, true);
  const state = await panel("read", {
    url: "https://tieba.baidu.com/p/12345",
    title: "断线后的比喻",
    excerpt: "这次断线就叫气泡锚点吧",
  });
  assert.ok(!JSON.stringify(state).includes("web_tieba_fixture"));
  assert.ok(!JSON.stringify(captured).includes("web_tieba_fixture"));
  assert.equal((await panel("auth-clear")).auth.hasCookie, false);
  assert.deepEqual(await readdir(secretsDir), []);
  console.log("PASS Web imports, persists and clears Tieba Cookie using encrypted host storage");
  assert.equal(state.samples[0].quote, quote);
  const graph = () => invoke("memory-panel:get-graph");
  assert.ok((await graph()).nodes.some((n) => n.label === quote));
  if (process.argv.includes("--ui")) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const base = "http://127.0.0.1:" + handle.server.address().port;
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
      });
      const i = cookie.indexOf("=");
      await context.addCookies([
        { name: cookie.slice(0, i), value: cookie.slice(i + 1), url: base },
      ]);
      const page = await context.newPage();
      await page.goto(base);
      page.setDefaultTimeout(12000);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "功能插件", exact: true }).click();
      const frame = page.frameLocator('iframe[src*="tieba-garden"]');
      await frame.getByRole("button", { name: "表达收藏", exact: true }).click();
      await frame.locator("#expressions").getByText(quote, { exact: false }).first().waitFor();
      await frame.getByRole("button", { name: "巡游设置", exact: true }).click();
      assert.equal(await frame.locator("#learn").isChecked(), true);
      const cookieField = frame.getByLabel("贴吧 Cookie", { exact: true });
      assert.equal(await cookieField.getAttribute("type"), "password");
      await cookieField.fill(fixtureCookie);
      await frame.getByRole("button", { name: "保存 Cookie", exact: true }).click();
      await frame.locator("#auth-state").getByText("已保存 Cookie", { exact: true }).waitFor();
      assert.equal(await cookieField.inputValue(), "");
      await frame.getByRole("button", { name: "清除 Cookie", exact: true }).click();
      await frame.locator("#auth-state").getByText("公开访问", { exact: true }).waitFor();
      await frame.getByRole("button", { name: "阅读手记", exact: true }).click();
      await frame.locator("#journal").getByText("断线后的比喻", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "记忆", exact: true }).click();
      await page.getByRole("button", { name: "打开记忆图谱" }).click();
      await page.getByRole("button", { name: "表达 · " + quote }).click();
      await page.getByRole("button", { name: "学自 · 贴吧帖子" }).click();
      assert.equal(
        await page.getByText("打开原始出处").getAttribute("href"),
        "https://tieba.baidu.com/p/12345",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "时间轴", exact: true }).click();
      await page.getByLabel("搜索记忆").fill(quote);
      await page
        .getByRole("button", { name: new RegExp("表达 · " + quote) })
        .waitFor();
      console.log(
        "PASS Chromium plugin iframe, masked Cookie management, graph sources and mobile search",
      );
    } finally {
      await browser.close();
    }
  }
  await ask("chat", "网络断线修复", true);
  await ask("chat", "你最近在贴吧看了什么？", false);
  assert.match(JSON.stringify(captured.at(-1)), /plugin:tieba-garden:readings/);
  assert.match(JSON.stringify(captured.at(-1)), /断线后的比喻/);
  assert.match(JSON.stringify(captured.at(-1)), /用户导入摘录/);
  await ask("chat", "种花怎么选花盆", false);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /plugin:tieba-garden:readings/);
  await ask("chat", "我的考试通过了", true);
  assert.match(JSON.stringify(captured.at(-1)), /先接住对方的好消息/);
  await invoke("plugins:set-enabled", "bili-garden", true);
  await ask("chat", "阳台浇水", false);
  assert.match(JSON.stringify(captured.at(-1)), /花盆加班/);
  await invoke("plugins:set-enabled", "bili-garden", false);
  await ask("chat", "阳台浇水", false);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /花盆加班/);
  console.log(
    "PASS Bilibili SQLite expression reaches the model only while enabled",
  );
  await ask("learn", "网络断线修复", false);
  await ask("work", "网络断线修复", false);
  await ask("code", "网络断线修复", false);
  await invoke("plugins:set-enabled", "tieba-garden", false);
  await ask("chat", "网络断线修复", false);
  assert.ok(!(await graph()).nodes.some((n) => n.label === quote));
  await invoke("plugins:set-enabled", "tieba-garden", true);
  await panel("forget", { id: state.samples[0].id });
  await ask("chat", "网络断线修复", false);
  const settings = await invoke("companion:get");
  await invoke("companion:update", {
    type: "preferences",
    expectedRevision: settings.revision,
    patch: {
      learnPrivateExpressions: true,
      relationshipMode: "partner",
      affection: true,
      desireEnabled: true,
    },
  });
  const mine = await ask("chat", "以后把夜宵叫作“月亮补给”。我想亲你。", false);
  const after = await invoke("companion:get");
  assert.ok(
    after.desireHistory.some(
      (s) => s.conversationId === mine.id && s.reason === "warm",
    ),
  );
  assert.ok((await graph()).nodes.some((n) => n.label === "月亮补给"));
  await ask("chat", "夜宵吃什么", false, mine);
  assert.match(JSON.stringify(captured.at(-1)), /你们在私聊中形成的说话习惯/);
  await ask("chat", "夜宵吃什么", false);
  assert.match(JSON.stringify(captured.at(-1)), /月亮补给/);
  await ask("chat", "好家伙，快递提前到了", false);
  await ask("chat", "好家伙，小猫居然学会开门", false);
  await ask("chat", "周末聊点啥", false, undefined, "好家伙");
  const learned = JSON.stringify(captured.at(-1));
  assert.match(learned, /好家伙/);
  assert.doesNotMatch(learned, /快递提前到了|小猫居然学会开门/);
  await ask("chat", "以后别用“好家伙”", false);
  await ask("chat", "周末聊点啥", false);
  assert.doesNotMatch(JSON.stringify(captured.at(-1)), /好家伙/);
  console.log(
    "PASS learned vocabulary and speaking style in fresh chats, cross-chat correction, desire and graph",
  );
} finally {
  socket?.terminate();
  if (handle.server.listening) await handle.close();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
}
