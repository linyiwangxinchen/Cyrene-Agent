// Run after build:server and staging bundled plugins. Uses only temporary data and loopback HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { GardenStore } from "../../extensions/bili-garden/lib/store.mjs";
import { locateVideoExpression, rememberExpression } from "../../extensions/bili-garden/lib/expressions.mjs";
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
const biliFixtureId = "BV1JcnW6pEFT";
const biliEvidence = { bvid: biliFixtureId, source: "subtitle", text: "今天轮到花盆加班",
  segments: [{ from: 8, to: 12, text: "今天轮到花盆加班" }] };
garden.put("evidence", biliFixtureId, biliEvidence);
const biliExcerpt = locateVideoExpression(biliFixtureId, "花盆加班", { video: biliEvidence });
rememberExpression(
  garden,
  biliExcerpt.source.url,
  "花盆加班",
  "阳台浇水",
  biliExcerpt.text,
  { style: "detail" },
  biliExcerpt.source,
);
garden.close();
const captured = [];
const quote = "气泡锚点";
const liveThreadUrl = "https://tieba.baidu.com/p/23456";
const liveThreadTitle = "夜景摄影讨论";
const liveThreadQuote = "试试等日落后半小时再拍。";
const liveThreadSummary = "建议在傍晚光线渐暗时拍夜景。";
const importedThreadUrl = "https://tieba.baidu.com/p/12345";
const styleHeader = "外部阅读中积累的接话方式";
const styleTechnique = "先接住对方表达的感受或进展";
const readingHeader = "近期实读的贴吧手记";
const styleReply = "原来如此。你想从哪儿聊起？";

async function seedTiebaLearning(root) {
  const pluginData = path.join(root, "plugin-data", "tieba-garden");
  const at = Date.now() - 86_400_000;
  const source = liveThreadUrl + "#post_content_456";
  await mkdir(pluginData, { recursive: true });
  await writeFile(path.join(pluginData, "reading.json"), JSON.stringify({
    tid: "23456",
    url: liveThreadUrl,
    title: liveThreadTitle,
    bar: "摄影",
    at,
    imported: false,
    floors: [{ body: liveThreadQuote, post: "456", page: 1 }],
    summary: liveThreadSummary,
    evidence: [{ quote: liveThreadQuote, source, post: "456" }],
    analysisStatus: "complete",
    sampleIds: ["legacy-style"],
  }));
  await writeFile(path.join(pluginData, "expressions.json"), JSON.stringify([{
    id: "legacy-style",
    tid: "23456",
    quote: liveThreadQuote,
    source,
    at,
    scene: "夜景摄影",
    style: "acknowledge",
    origin: { kind: "forum_public", id: "23456:post:456", unit: "23456", url: source },
  }, {
    id: "second-style",
    tid: "34567",
    quote: "你终于把那段路走完啦。",
    source: "https://tieba.baidu.com/p/34567#post_content_678",
    at,
    scene: "进展与庆祝",
    style: "acknowledge",
    origin: { kind: "forum_public", id: "34567:post:678", unit: "34567", url: "https://tieba.baidu.com/p/34567#post_content_678" },
  }]));
}

const gateway = createServer(async (req, res) => {
  if (req.method === "GET") {
    if (req.url === "/browser-screenshot-fixture") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end('<!doctype html><title>Screenshot fixture</title><h1>Local fixture page</h1>');
    }
    res.statusCode = 404;
    return res.end();
  }
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const body = JSON.parse(Buffer.concat(parts).toString());
  captured.push(body);
  const prompt = JSON.stringify([body.instructions, body.input ?? body.messages]);
  let answer = prompt.includes("阅读论坛对话")
    ? JSON.stringify({
        summary: "摘录里用一个比喻形容网络断线。",
        evidence: [quote],
        expressions: [{
          quote,
          scene: "网络断线修复",
          cue: "庆祝",
          delivery: "先接住对方的好消息，再轻轻开一句玩笑",
          style: "acknowledge",
        }],
      })
    : prompt.includes(styleHeader) && prompt.includes(styleTechnique)
      ? styleReply
      : prompt.includes("你们在私聊中形成的说话习惯") && prompt.includes("好家伙")
        ? "好家伙，周末想去哪逛逛？"
        : "已经收到。";
  const transport = req.url.includes("/responses") ? "responses" : "openai";
  let fixtureTool;
  if (transport === "responses" && body.stream
    && (prompt.includes("DESKTOP_HISTORY_TOOL_CHECK") || prompt.includes("call_desktop_history_"))) {
    const input = body.input ?? [];
    const search = input.find(item => item.type === "function_call_output" && item.call_id === "call_desktop_history_search");
    const read = input.find(item => item.type === "function_call_output" && item.call_id === "call_desktop_history_read");
    const result = item => JSON.parse(JSON.parse(item.output).output);
    const available = (body.tools ?? []).map(tool => tool.name);
    if (!search && available.includes("search_chat_history")) {
      fixtureTool = { name: "search_chat_history", args: { query: "接力备忘" }, id: "desktop_history_search" };
    } else if (typeof search?.output === "string" && !read && available.includes("read_chat_history")) {
      const source = result(search).items?.find(item => item.title === "桌面引用来源");
      if (source) fixtureTool = { name: "read_chat_history", args: {
        conversationId: source.conversationId, ...(source.sourceRef ? { sourceRef: source.sourceRef } : {}),
      }, id: "desktop_history_read" };
    } else if (typeof read?.output === "string" && result(read).messages?.some(message => message.text.includes("DESKTOP_OLD_REFERENCE_TEXT"))) {
      answer = "DESKTOP_HISTORY_TOOL_ANSWER";
    }
  }
  if (transport === "responses" && prompt.includes("DESKTOP_BROWSER_IMAGE_CHECK")) {
    const requests = (body.input ?? []).filter(item => item.type === "function_call");
    const wanted = ["browser_control_start", "browser_screenshot", "browser_control_stop"]
      .find(name => !requests.some(item => item.name === name));
    const available = (body.tools ?? []).map(tool => tool.name);
    const searched = requests.some(item => item.name === "tool_search" && JSON.parse(item.arguments).query === `select:${wanted}`);
    if (wanted && available.includes(wanted)) fixtureTool = { name: wanted, args: {}, id: wanted };
    else if (wanted && available.includes("tool_search") && !searched) {
      fixtureTool = { name: "tool_search", args: { query: `select:${wanted}` }, id: `search_${wanted}` };
    }
  }
  const fixtureOptions = fixtureTool ? { tool: true, toolInput: fixtureTool.args, text: answer } : { text: answer };
  const encode = (value) => {
    const json = JSON.stringify(value);
    return fixtureTool ? json.replace(/"weather"/g, JSON.stringify(fixtureTool.name))
      .replace(/"(call|fc)_test"/g, (_match, prefix) => JSON.stringify(`${prefix}_${fixtureTool.id}`)) : json;
  };
  res.writeHead(200, {
    "Content-Type": body.stream ? "text/event-stream" : "application/json",
  });
  if (!body.stream)
    return res.end(encode(responseBody(transport, fixtureOptions)));
  for (const e of streamEvents(transport, fixtureOptions))
    res.write("data: " + encode(e) + "\n\n");
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
async function ask(mode, message, { existing, reply } = {}) {
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
  if (reply)
    assert.ok(
      events.some(
        (e) =>
          e.channel === "agui:event" &&
          e.args[0]?.runId === ack.runId &&
          e.args[0].type === "TEXT_MESSAGE_CONTENT" &&
          JSON.stringify(e.args[0]).includes(reply),
      ),
      "cross-chat expression in streamed reply",
    );
  console.log("PASS", mode, message);
  return { session, modelInput };
}
try {
  if (process.argv.includes("--desktop")) {
    const { verifyDesktop } = await import(
      "./companion-expressions-desktop.mjs"
    );
    await verifyDesktop(profile, captured, { seedTiebaLearning, liveThreadQuote, styleHeader,
      browserFixtureUrl: `http://127.0.0.1:${gateway.address().port}/browser-screenshot-fixture` });
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
  await seedTiebaLearning(dataDir);
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
  await panel("save", { learn: true });
  await invoke("settings:save-general", { conversationExpressionSources: [] });
  const beforeLearning = await ask("chat", "你今天过得怎么样？");
  assert.ok(!beforeLearning.modelInput.includes(styleHeader));
  assert.ok(beforeLearning.modelInput.includes(liveThreadSummary));
  await invoke("settings:save-general", { conversationExpressionSources: ["tieba-garden", "bili-garden"] });
  const fixtureCookie = "__bid_n=web_tieba_fixture_browser; BDUSS=web_tieba_fixture~session; ab_sr=web_tieba_fixture=";
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
    url: importedThreadUrl,
    title: "断线后的比喻",
    excerpt: "这次断线就叫气泡锚点吧",
  });
  assert.ok(!JSON.stringify(state).includes("web_tieba_fixture"));
  assert.ok(!JSON.stringify(captured).includes("web_tieba_fixture"));
  assert.equal((await panel("auth-clear")).auth.hasCookie, false);
  assert.deepEqual(await readdir(secretsDir), []);
  console.log("PASS Web imports, persists and clears Tieba Cookie using encrypted host storage");
  const newSample = state.samples.find((sample) => sample.quote === quote);
  assert.equal(newSample?.style, "acknowledge");
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
      page.on("response", (response) => {
        if (response.status() !== 403 || !/\/api\/core\/(?:invoke|send)$/u.test(new URL(response.url()).pathname)) return;
        const channel = response.request().postDataJSON()?.channel;
        if (typeof channel === "string") console.warn("Web fixture core request rejected", channel);
      });
      const visits = [];
      const replyActions = [];
      const draftContent = "等日落后半小时的建议很实用。";
      await page.route("**/api/core/invoke", async (route) => {
        const { channel, args } = route.request().postDataJSON();
        if (
          channel !== "plugins:panel:invoke" ||
          args[0] !== "tieba-garden" ||
          args[1] !== "forum"
        ) {
          return route.continue();
        }
        const [command, input] = args[2];
        if (command === "draft-reply" || command === "post-reply") {
          replyActions.push([command, input]);
          const data = command === "draft-reply" ? { content: draftContent }
            : { outcome: "unknown", url: liveThreadUrl };
          return route.fulfill({ json: { ok: true, data } });
        }
        if (command !== "visit") return route.continue();
        visits.push(input);
        const visitState = await panel("state", { compact: true });
        if (visitState.config.visitMode === "random") {
          visitState.visits = [{
            id: "random-visit-fixture", at: Date.now(), trigger: "manual", mode: "random",
            bars: ["茶具"], chosenBar: "茶具", status: "empty", read: [],
            publicDirectory: { categoriesAvailable: 9, pagesRead: 3, candidateCount: 12 },
          }];
        } else if (!visitState.config.bars.length) {
          visitState.visits = [
            {
              id: "autonomous-visit-fixture",
              at: Date.now(),
              trigger: "manual",
              bars: ["摄影", "音乐"],
              status: "empty",
              chosenBar: "音乐",
              choiceReason: "想找一首歌",
            },
          ];
        }
        return route.fulfill({ json: { ok: true, data: visitState } });
      });
      await page.goto(base);
      page.setDefaultTimeout(12000);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "功能插件", exact: true }).click();
      const frame = page.frameLocator('iframe[src*="tieba-garden"]');
      await frame.getByRole("button", { name: "表达收藏", exact: true }).click();
      await frame.locator("#expressions").getByText(quote, { exact: false }).first().waitFor();
      const settingsTab = frame.getByRole("button", { name: "巡游设置", exact: true });
      const journalTab = frame.getByRole("button", { name: "阅读手记", exact: true });
      const openFloors = (title) => frame.locator("#journal article").filter({ hasText: title })
        .getByRole("button", { name: "看楼层原文", exact: true }).click();
      const closeDetail = frame.getByRole("button", { name: "关闭", exact: true });
      const replyField = frame.getByLabel("回复这篇帖子", { exact: true });
      const sendReply = frame.getByRole("button", { name: "发送回复", exact: true });
      await journalTab.click();
      await openFloors("断线后的比喻");
      await frame.locator("#detail-body").getByText("这次断线就叫气泡锚点吧", { exact: true }).waitFor();
      assert.equal(await replyField.isVisible(), false);
      await closeDetail.click();
      await openFloors(liveThreadTitle);
      await frame.getByRole("button", { name: "昔涟拟回复", exact: true }).click();
      await frame.getByText("草稿已填入，修改后可发送。", { exact: true }).waitFor();
      assert.equal(await replyField.inputValue(), draftContent);
      assert.equal(await sendReply.isDisabled(), true);
      assert.deepEqual(replyActions, [["draft-reply", { url: liveThreadUrl }]]);
      await closeDetail.click();
      await settingsTab.click();
      assert.equal(await frame.locator("#learn").isChecked(), true);
      const allowPosting = frame.locator("#allow-posting");
      assert.equal(await allowPosting.isChecked(), false);
      const cookieField = frame.getByLabel("贴吧 Cookie", { exact: true });
      assert.equal(await cookieField.getAttribute("type"), "password");
      await cookieField.fill(fixtureCookie.replace(/[_~]/g, character => "\\" + character));
      await frame.getByRole("button", { name: "保存 Cookie", exact: true }).click();
      await frame.locator("#auth-state").getByText("已保存 Cookie", { exact: true }).waitFor();
      assert.equal(await cookieField.inputValue(), "");
      await journalTab.click();
      await openFloors(liveThreadTitle);
      assert.equal(await replyField.inputValue(), draftContent);
      assert.equal(await sendReply.isDisabled(), true);
      await closeDetail.click();
      await settingsTab.click();
      const browseTab = frame.getByRole("button", { name: "逛贴吧", exact: true });
      const visitButton = frame.getByRole("button", { name: "逛一逛", exact: true });
      const bars = frame.getByLabel("常逛的吧", { exact: true });
      const visitArgs = { background: true, compact: true };
      assert.equal(await bars.inputValue(), "");
      await browseTab.click();
      await Promise.all([
        frame
          .locator("#visits")
          .getByText("昔涟想逛 音乐吧 · 想找一首歌", { exact: true })
          .waitFor(),
        visitButton.click(),
      ]);
      assert.deepEqual(visits, [visitArgs]);
      assert.equal(await browseTab.getAttribute("aria-current"), "page");
      assert.equal(await bars.isVisible(), false);
      assert.deepEqual((await panel("state", { compact: true })).config.bars, []);
      await settingsTab.click();
      await bars.fill("摄影");
      await frame.locator("#post-limit").fill("5");
      await allowPosting.check();
      await frame.getByRole("button", { name: "保存设置", exact: true }).click();
      await frame.getByText("巡游设置已保存", { exact: true }).waitFor();
      const savedConfig = (await panel("state", { compact: true })).config;
      assert.deepEqual(savedConfig.bars, ["摄影"]);
      assert.equal(savedConfig.postsPerVisit, 5);
      assert.equal(savedConfig.allowPosting, true);
      await visitButton.click();
      await waitFor(() => visits.length > 1, "Tieba visit request with a saved forum");
      assert.deepEqual(visits, [visitArgs, visitArgs]);
      assert.equal(await browseTab.getAttribute("aria-current"), "page");

      await settingsTab.click();
      const visitMode = frame.locator("#visit-mode");
      await visitMode.selectOption("random");
      await frame.getByRole("button", { name: "保存设置", exact: true }).click();
      await frame.getByText("巡游设置已保存", { exact: true }).waitFor();
      const randomConfig = (await panel("state", { compact: true })).config;
      assert.equal(randomConfig.visitMode, "random");
      assert.deepEqual(randomConfig.bars, ["摄影"]);
      await visitButton.click();
      await frame.locator("#visits").getByText("随机抽到 茶具吧", { exact: true }).waitFor();
      await frame.locator("#visits").getByText("公开分类目录读到 3 页 · 12 个候选吧", { exact: true }).waitFor();
      assert.deepEqual(visits, [visitArgs, visitArgs, visitArgs]);
      console.log("PASS Chromium saves Tieba's random mode and displays the public directory draw");

      await journalTab.click();
      await openFloors(liveThreadTitle);
      await replyField.fill("🙂🙂🙂");
      assert.equal(await sendReply.isDisabled(), true);
      await replyField.fill("好".repeat(401));
      assert.equal(await sendReply.isDisabled(), true);
      await replyField.fill("🙂".repeat(400));
      assert.equal(await sendReply.isEnabled(), true);
      const editedReply = "这个时间点很实用，下次试试。";
      const enteredReply = " " + editedReply + " ";
      await replyField.fill(enteredReply);
      await sendReply.click();
      await frame.getByText("发送结果未确认，请到原帖核对是否已发布。", { exact: true }).waitFor();
      assert.equal(await replyField.inputValue(), enteredReply);
      assert.equal(await sendReply.isDisabled(), true);
      await closeDetail.click();
      await openFloors(liveThreadTitle);
      await sendReply.waitFor();
      assert.equal(await sendReply.isDisabled(), true);
      assert.deepEqual(replyActions, [
        ["draft-reply", { url: liveThreadUrl }],
        ["post-reply", { url: liveThreadUrl, content: editedReply }],
      ]);
      await closeDetail.click();
      await settingsTab.click();
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
        "PASS Chromium plugin iframe, masked Cookie management, Tieba visits and replies, graph sources and mobile search",
      );
    } finally {
      await browser.close();
    }
  }
  const everyday = await ask("chat", "周末准备做点什么？", { reply: styleReply });
  assert.notEqual(everyday.session.id, beforeLearning.session.id);
  assert.match(everyday.modelInput, /plugin:tieba-garden:expressions/);
  assert.ok(everyday.modelInput.includes(styleHeader));
  assert.ok(everyday.modelInput.includes(styleTechnique));
  assert.match(everyday.modelInput, /说话前的准备.*身份与关系.*场景与动作.*本轮接话/s);
  assert.ok(everyday.modelInput.includes(readingHeader));
  assert.ok(everyday.modelInput.includes(liveThreadSummary));
  for (const privateDetail of [quote, liveThreadQuote, liveThreadUrl, importedThreadUrl, "断线后的比喻"]) {
    assert.ok(!everyday.modelInput.includes(privateDetail), "ordinary prompt included " + privateDetail);
  }

  const requested = await ask("chat", "你最近在贴吧看了什么？");
  assert.match(requested.modelInput, /plugin:tieba-garden:readings/);
  assert.ok(requested.modelInput.includes(importedThreadUrl));
  assert.ok(requested.modelInput.includes(liveThreadUrl));
  assert.match(requested.modelInput, /断线后的比喻/);
  assert.match(requested.modelInput, /用户导入摘录/);
  const optedOut = await ask("chat", "认真点，不要玩梗。");
  assert.ok(!optedOut.modelInput.includes(styleHeader));
  assert.ok(!optedOut.modelInput.includes(readingHeader));

  await panel("save", { learn: false });
  const notLearning = await ask("chat", "周末准备做点什么？");
  assert.doesNotMatch(notLearning.modelInput, /plugin:tieba-garden:(?:expressions|readings)/);
  const requestedWhileOff = await ask("chat", "再说说你最近在贴吧看了什么？");
  assert.ok(requestedWhileOff.modelInput.includes(importedThreadUrl));
  await panel("save", { learn: true });
  await invoke("plugins:set-enabled", "bili-garden", true);
  const biliSpeech = (await ask("chat", "阳台浇水")).modelInput;
  assert.match(biliSpeech, /plugin:bili-garden:expressions/);
  assert.match(biliSpeech, /顺着对方刚提到的一个具体细节接话/);
  assert.doesNotMatch(biliSpeech, /花盆加班/);
  await invoke("plugins:set-enabled", "bili-garden", false);
  assert.doesNotMatch((await ask("chat", "阳台浇水")).modelInput, /plugin:bili-garden:expressions|花盆加班/);
  console.log(
    "PASS Bilibili SQLite expression reaches the model only while enabled",
  );
  const sharedVideo = (await ask("chat", "你看这条 B 站视频，第一轮造铁塔就把塔身漏啦。")).modelInput;
  assert.match(sharedVideo, /接住一个具体片段，说一句你看到这个细节时的反应/);
  assert.match(sharedVideo, /只有链接、标题或简介时，就按手头的内容接话/);
  assert.match(sharedVideo, /明确要总结、核对功能或聊多个看点时，按他的要求答清楚/);
  const videoTask = (await ask("work", "请总结这条 B 站视频里提到的两个功能。")).modelInput;
  assert.doesNotMatch(videoTask, /接住一个具体片段，说一句你看到这个细节时的反应/);
  console.log("PASS Bilibili casual sharing guidance reaches the Chat model without changing Work summaries");
  for (const mode of ["learn", "work", "code"]) {
    const isolated = await ask(mode, "你最近在贴吧看了什么？");
    assert.doesNotMatch(isolated.modelInput, /plugin:tieba-garden:(?:expressions|readings)/);
    assert.ok(!isolated.modelInput.includes(liveThreadSummary));
  }
  await invoke("plugins:set-enabled", "tieba-garden", false);
  const disabled = await ask("chat", "周末准备做点什么？");
  assert.doesNotMatch(disabled.modelInput, /plugin:tieba-garden:(?:expressions|readings)/);
  assert.ok(!(await graph()).nodes.some((n) => n.label === quote));
  await invoke("plugins:set-enabled", "tieba-garden", true);
  const resumed = await ask("chat", "今天有什么想聊的？", { reply: styleReply });
  assert.ok(resumed.modelInput.includes(styleHeader));
  assert.ok(!resumed.modelInput.includes(quote));
  await panel("forget", { id: newSample.id });
  assert.ok(!(await graph()).nodes.some((n) => n.label === quote));
  assert.ok((await ask("chat", "今天有什么想聊的？")).modelInput.includes(styleHeader));
  await panel("forget", { id: "second-style" });
  const forgot = await ask("chat", "今天有什么想聊的？");
  assert.ok(!forgot.modelInput.includes(styleHeader));
  console.log("PASS persisted Tieba style, recent reading, explicit sources and private chat isolation");
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
  const { session: mine } = await ask("chat", "以后把夜宵叫作“月亮补给”。我想亲你。");
  const after = await invoke("companion:get");
  assert.ok(
    after.desireHistory.some(
      (s) => s.conversationId === mine.id && s.reason === "warm",
    ),
  );
  assert.ok((await graph()).nodes.some((n) => n.label === "月亮补给"));
  const rememberedHere = await ask("chat", "夜宵吃什么", { existing: mine });
  assert.match(rememberedHere.modelInput, /你们在私聊中形成的说话习惯/);
  const rememberedAcrossChats = await ask("chat", "夜宵吃什么");
  assert.match(rememberedAcrossChats.modelInput, /月亮补给/);
  await ask("chat", "好家伙，快递提前到了");
  await ask("chat", "好家伙，小猫居然学会开门");
  const { modelInput: learned } = await ask("chat", "周末聊点啥", { reply: "好家伙" });
  assert.match(learned, /好家伙/);
  assert.doesNotMatch(learned, /快递提前到了|小猫居然学会开门/);
  await ask("chat", "以后别用“好家伙”");
  assert.doesNotMatch((await ask("chat", "周末聊点啥")).modelInput, /好家伙/);
  console.log(
    "PASS learned vocabulary and speaking style in fresh chats, cross-chat correction, desire and graph",
  );
} finally {
  socket?.terminate();
  if (handle.server.listening) await handle.close();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
}
