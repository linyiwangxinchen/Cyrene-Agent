import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { chromium } from "playwright";
import { GardenStore } from "../../extensions/bili-garden/lib/store.mjs";
const require = createRequire(import.meta.url),
  { createWebServer } = require("../../dist/server/server/index.js");
const data = await mkdtemp(path.join(os.tmpdir(), "cyrene-garden-web-"));
const evidence = process.argv[2] || path.join(data, "evidence");
await mkdir(evidence, { recursive: true });
await writeFile(
  path.join(data, "web-data.json"),
  JSON.stringify({
    version: 1,
    sessions: [],
    recentProjects: [],
    settings: {
      general: {
        plugins: { "bili-garden": true },
        proactiveChatMode: "off",
        momentsEnabled: false,
      },
      config: { memoryMode: "summary", runtimeSync: "off" },
      modelProfiles: [],
    },
  }),
);
const store = new GardenStore(path.join(data, "plugin-data/bili-garden"));
store.put("video", "BV1JcnW6pEFT", {
  bvid: "BV1JcnW6pEFT",
  title: "一起在阳台种花",
  owner: "测试 UP",
  duration: 300,
  picked: true,
  available: true,
  summary: "先了解植物对阳光的需求。",
  reason: "小小的阳台也能留下自己的春天。",
  readAt: Date.now(),
});
store.put("evidence", "BV1JcnW6pEFT", {
  bvid: "BV1JcnW6pEFT",
  text: "花朵需要合适的光照",
  source: "subtitle",
  segments: [{ from: 12, text: "花朵需要合适的光照" }],
});
store.put("memory", "test-memory", {
  text: "你喜欢轻松的园艺实操",
  day: "2026-11-01",
});
store.close();
const logs = [],
  handle = createWebServer({
    dataDir: data,
    staticRoot: path.resolve("dist/renderer"),
    secureCookies: false,
    setupToken: "garden-fixture-setup",
    sharedCore: true,
    logger: {
      info: (x) => logs.push(String(x)),
      warn: (x) => logs.push(String(x)),
      error: (x) => logs.push(String(x)),
    },
  });
await new Promise((r) => handle.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${handle.server.address().port}`;
let cookie = "",
  clientToken = "",
  socket,
  browser,
  page;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(route, method = "GET", body, headers = {}) {
  const r = await fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { r, value };
}
async function invoke(channel, ...args) {
  const { r, value } = await http(
    "/api/core/invoke",
    "POST",
    { channel, args },
    { "X-Cyrene-Client": clientToken },
  );
  assert.equal(r.status, 200, JSON.stringify(value));
  return value;
}
try {
  assert.equal(
    (await http("/api/plugin-panel/bili-garden/panel.html")).r.status,
    401,
  );
  await http(
    "/api/auth/bootstrap",
    "POST",
    { username: "garden-admin", password: "GardenFixture-123" },
    { "X-Cyrene-Setup-Token": "garden-fixture-setup" },
  );
  const login = await http("/api/auth/login", "POST", {
    username: "garden-admin",
    password: "GardenFixture-123",
  });
  assert.equal(login.r.status, 200);
  cookie = login.r.headers.get("set-cookie").split(";")[0];
  socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
    headers: { Cookie: cookie },
  });
  socket.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "ready") clientToken = m.clientToken;
  });
  for (let i = 0; i < 150 && !clientToken; i++) await pause(50);
  assert.ok(clientToken);
  await handle.startChannels();
  await invoke("plugins:set-enabled", "bili-garden", true);
  const list = await invoke("plugins:list");
  const plugin = (list.plugins ?? list).find((p) => p.id === "bili-garden");
  assert.ok(plugin, JSON.stringify({ list, logs }));
  assert.equal(plugin.enabled, true, JSON.stringify({ plugin, logs }));
  const panel = await http("/api/plugin-panel/bili-garden/panel.html");
  assert.equal(panel.r.status, 200);
  assert.match(panel.value, /小花园/);
  assert.match(
    panel.r.headers.get("content-security-policy"),
    /connect-src 'none'/,
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const [name, ...v] = cookie.split("=");
  await context.addCookies([{ name, value: v.join("="), url: base }]);
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(m.text());
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/plugin-panel/"))
      logs.push(`panel-resource ${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) =>
    logs.push(`request-failed ${r.url()} ${r.failure()?.errorText}`),
  );
  await page.goto(base + "/web/");
  await page
    .getByRole("button", { name: "设置", exact: true })
    .click({ timeout: 20000 });
  // The shared upstream settings search must work in authenticated desktop/mobile Web.
  const search = page.getByRole("button", { name: "搜索设置", exact: true });
  await search.click();
  // Use the translated placeholder to distinguish model selectors from this search input.
  const searchInput = page.getByPlaceholder("搜索设置名称或关键词");
  await searchInput.fill("GPU");
  await page.getByText("未找到相关设置", { exact: true }).waitFor();
  await searchInput.fill("语言");
  await page.getByRole("option", { name: "界面语言", exact: true }).click();
  await page.locator('[data-settings-search-id="settingsPage.general.language"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-settings-search-id="settingsPage.general.language"]')?.closest('.cy-settings-row')?.classList.contains('cy-settings-search-highlight'));
  const originalGeneral = await invoke("settings:get-general");
  await invoke("settings:save-general", { ...originalGeneral, proactiveChatMode: "on" });
  try {
    await search.click();
    await searchInput.fill("目标候选评分");
    await page.getByRole("option", { name: "目标候选评分", exact: true }).click();
    await page.locator('[data-settings-search-id="settingsPage.preferences.proactiveTargetScore"]').waitFor();
  } finally { await invoke("settings:save-general", originalGeneral); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "设置导航", exact: true }).click();
  await search.click();
  await searchInput.fill("小花园");
  await page.getByRole("option", { name: "功能插件", exact: true }).click();
  await searchInput.waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector('.cy-settings-page.is-mobile-nav-open'));
  await page.screenshot({ path: path.join(evidence, "settings-search-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  const frame = page.frameLocator('iframe[src*="bili-garden"]');
  await frame
    .getByRole("heading", { name: /昔涟的小花园/ })
    .waitFor({ timeout: 20000 });
  await frame
    .getByText("一起在阳台种花", { exact: true })
    .waitFor({ timeout: 10000 });
  await page.screenshot({
    path: path.join(evidence, "desktop.png"),
    fullPage: true,
  });
  await page
    .locator('iframe[src*="bili-garden"]')
    .screenshot({ path: path.join(evidence, "panel-desktop.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.uiTheme = "charcoal-pink";
  });
  await page.waitForTimeout(100);
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
  await page
    .locator('iframe[src*="bili-garden"]')
    .screenshot({ path: path.join(evidence, "panel-dark.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.uiTheme = "default";
  });
  await frame.getByRole("button", { name: "一起看", exact: true }).click();
  const queueInput = frame.getByRole("textbox", { name: "添加视频" });
  const originalQueueInput = await queueInput.elementHandle();
  await queueInput.fill("BV1bN");
  await queueInput.evaluate(element => element.setSelectionRange(2, 4));
  await page.waitForTimeout(8500); // Two real four-second snapshot intervals.
  assert.equal(await originalQueueInput.evaluate(element => element.isConnected), true, "idle polling replaced the queue input");
  assert.equal(await queueInput.inputValue(), "BV1bN", "polling cleared the unfinished video link");
  assert.deepEqual(await queueInput.evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd]), [true, 2, 4]);
  // A real queue mutation from another client must update cards without replacing the form.
  await invoke("plugin:bili-garden:garden", "queue", { bvid: "BV1bNns6BEEA" });
  await frame.getByRole("heading", { name: "BV1bNns6BEEA", exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await originalQueueInput.evaluate(element => element.isConnected), true);
  assert.equal(await queueInput.inputValue(), "BV1bN");
  const queueCard = await frame.locator("article.card").first().elementHandle();
  await page.waitForTimeout(4500);
  assert.equal(await queueCard.evaluate(element => element.isConnected), true, "unchanged video card was recreated");
  await queueInput.fill("BV1bNns6BEEA");
  const submitQueue = await frame.getByRole("button", { name: "加入待看", exact: true }).elementHandle();
  await frame.getByRole("button", { name: "加入待看", exact: true }).click();
  await submitQueue.waitForElementState("enabled");
  assert.equal(await queueInput.inputValue(), "", "successful submission should clear only its own draft");
  await frame
    .getByRole("heading", { name: "BV1bNns6BEEA", exact: true })
    .waitFor();
  await frame.getByRole("button", { name: "设置", exact: true }).click();
  await frame
    .getByLabel("你关心什么", { exact: true })
    .fill("园艺和可复现的科学实验");
  await frame.getByRole("button", { name: "保存设置", exact: true }).click();
  await frame.getByText("设置已保存", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(evidence, "mobile-settings.png"),
    fullPage: true,
  });
  assert.equal(
    await frame
      .locator("body")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    true,
    "mobile panel overflows horizontally",
  );
  await frame.getByRole("button", { name: "互动", exact: true }).click();
  await frame.getByRole("region", { name: "评论守护扫描状态" }).getByText(/评论守护未开启/).waitFor();
  await frame.getByRole("button", { name: "扫描 @ 与评论" }).click();
  await frame.getByRole("status").getByText("评论守护未启用", { exact: true }).waitFor();
  await frame.getByRole("button", { name: "一起看", exact: true }).click();
  await queueInput.fill("https://www.bilibili.com/video/");
  const mobileInput = await queueInput.elementHandle();
  const scroll = await frame.locator("body").evaluate(() => { window.scrollTo(0, 80); return window.scrollY; });
  await page.waitForTimeout(4500);
  assert.equal(await mobileInput.evaluate(element => element.isConnected), true);
  assert.equal(await queueInput.inputValue(), "https://www.bilibili.com/video/");
  assert.equal(await frame.locator("body").evaluate(() => window.scrollY), scroll);
  await page.screenshot({ path: path.join(evidence, "queue-mobile-stable.png"), fullPage: true });
  await frame.getByRole("button", { name: "手记", exact: true }).click();
  await frame.getByText("你喜欢轻松的园艺实操", { exact: true }).waitFor();
  await frame.getByRole("button", { name: "导出全部", exact: true }).click();
  await frame
    .getByRole("button", { name: "下载 Markdown", exact: true })
    .waitFor({ timeout: 5000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    frame.getByRole("button", { name: "下载 Markdown", exact: true }).click(),
  ]);
  await download.saveAs(path.join(evidence, "export.md"));
  await frame.getByRole("button", { name: "关闭详情" }).click();
  await frame.getByRole("button", { name: "发现", exact: true }).click();
  await context.route("https://www.bilibili.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>External link fixture</p>",
    }),
  );
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }),
    frame.getByRole("link", { name: "去 B 站看", exact: true }).click(),
  ]);
  await popup.waitForLoadState();
  assert.ok(popup.url().includes("BV1JcnW6pEFT"));
  await popup.close();
  await frame.getByRole("button", { name: "字幕与追问", exact: true }).click();
  await frame
    .locator("#detail-body")
    .getByText("花朵需要合适的光照", { exact: false })
    .waitFor();
  await frame.getByRole("button", { name: "关闭详情" }).click();
  await frame.getByRole("button", { name: "去发现视频", exact: true }).click();
  await frame.getByText(/请先在设置中登录 B 站/).waitFor();
  await page.screenshot({
    path: path.join(evidence, "mobile.png"),
    fullPage: true,
  });
  await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
  await page
    .locator('iframe[src*="bili-garden"]')
    .screenshot({ path: path.join(evidence, "panel-mobile.png") });
  assert.deepEqual(errors, []);
  await browser.close();
  browser = null;
  const persisted = new GardenStore(path.join(data, "plugin-data/bili-garden"));
  assert.equal(persisted.config().interests, "园艺和可复现的科学实验");
  assert.equal(persisted.get("video", "BV1bNns6BEEA").queueStatus, "queued");
  persisted.close();
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        ok: true,
        data,
        checks: [
          "auth",
          "native-plugin-load",
          "panel",
          "queue",
          "persist-config",
          "mobile-layout",
          "mention-status-and-disabled-gate",
          "queue-polling-preserves-input-focus-and-selection",
          "queue-updates-preserve-form-and-unchanged-cards",
          "queue-mobile-scroll-stability",
          "settings-search-web",
          "settings-search-mobile",
        "dark-theme",
        "markdown-download",
        "external-link",
          "memory",
          "evidence",
          "login-gate",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS authenticated native plugin and browser checks: ${evidence}`,
  );
} catch (e) {
  if (page)
    for (const f of page
      .frames()
      .filter((f) => f.url().includes("plugin-panel")))
      console.error(
        "FRAME:",
        (
          await f
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(-4500),
      );
  if (page) {
    await page
      .screenshot({ path: path.join(evidence, "failed.png"), fullPage: true })
      .catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 5000),
    );
  }
  console.error(logs.slice(-30).join("\n"));
  throw e;
} finally {
  await browser?.close();
  socket?.close();
  await handle.close();
}
