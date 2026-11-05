// Run after build:web. Uses isolated data and a local server; never real channels/model keys.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const { createWebServer } = require("../../dist/server/server/index.js");
const root = await mkdtemp(path.join(os.tmpdir(), "cyrene-companion-"));
const evidence = path.join(root, "evidence"); await mkdir(evidence);
console.log("Evidence:", evidence);
await writeFile(path.join(root, "web-data.json"), JSON.stringify({ version: 1, sessions: [], settings: { general: { proactiveChatMode: "off", momentsEnabled: false }, config: { memoryMode: "off", runtimeSync: "off" }, modelProfiles: [] } }));
await writeFile(path.join(root, "memory.json"), JSON.stringify({ schemaVersion: 2, version: 1,
  l0: { nickname: "", preferredName: "", occupation: "", longTermInterests: "", language: "zh-CN", permanentNote: "", isPinned: false, updatedAt: 0 },
  l1: { recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 0 },
  l2: [{ id: "fixture-memory", content: "验收记忆：一起读书", sourceQuote: "这周一起读一本书", triggerText: "测试来源", sourceConversationId: "fixture-chat", sourceMessageIds: ["fixture-user-entry"], createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 0, weight: 30, isPinned: false, status: "active", syncStatus: "pending_sync" }],
  evidence: [], reflectionLogs: [], conflictLogs: [], l2DmaeStates: [],
}));
// Offline recovery record; this fixture never enables a connector or sends text.
const recoveryId = "companion-ui-unknown-delivery";
const outgoing = { channel: "wechat", targetId: "fixture-not-a-real-contact", parts: [{ kind: "text", text: "隔离验收：仅确认状态，不实际发送" }] };
await mkdir(path.join(root, "channel-recovery"));
await writeFile(path.join(root, "channel-recovery", `${createHash("sha256").update(recoveryId).digest("hex")}.json`), JSON.stringify({
  kind: "outbox", id: recoveryId, channel: "wechat", createdAt: Date.now(), updatedAt: Date.now(),
  fingerprint: createHash("sha256").update(JSON.stringify(outgoing)).digest("hex"), message: outgoing,
  parts: [{ status: "sending", updatedAt: Date.now() }],
}), { mode: 0o600 });
const logs = [], results = [];
let server, socket, token, cookie, base, browser, page;
async function start() {
  server = createWebServer({ dataDir: root, sharedCore: true, secureCookies: false, setupToken: "companion-fixture-setup", staticRoot: path.resolve("dist/renderer"), logger: { info: x => logs.push(String(x)), warn: x => logs.push(String(x)), error: x => logs.push(String(x)) } });
  await new Promise(resolve => server.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.server.address().port}`;
}
async function http(route, method = "GET", body, headers = {}) {
  const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); return { response, value };
}
async function connect() {
  const login = await http("/api/auth/login", "POST", { username: "companion-test", password: "Fixture-Test-123" });
  assert.equal(login.response.status, 200); cookie = login.response.headers.get("set-cookie").split(";")[0];
  token = "";
  socket = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS timeout")), 15000);
    socket.on("message", raw => { const value = JSON.parse(String(raw)); if (value.type === "ready") { token = value.clientToken; clearTimeout(timer); resolve(); } });
    socket.on("error", reject);
  });
}
async function invoke(channel, ...args) {
  const result = await http("/api/core/invoke", "POST", { channel, args }, { "X-Cyrene-Client": token });
  assert.equal(result.response.status, 200, JSON.stringify(result.value)); return result.value;
}
async function check(name, fn) {
  try { await fn(); results.push(name); console.log("PASS", name); }
  catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {});
      await writeFile(path.join(evidence, "failure-dom.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
      const tabs = await page.locator('[role="tab"]').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        return { text: element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height, hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 500), parent: element.parentElement?.parentElement?.outerHTML.slice(0, 1000) };
      })).catch(() => []);
      await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ name, error: String(error), tabs }, null, 2));
    }
    throw error;
  }
}
async function companionTab(name) {
  const mobile = page.getByRole("combobox", { name: "昔涟设置分组", exact: true });
  // Viewport changes trigger the responsive settings selector asynchronously.
  // Wait for the narrow layout to settle before falling back to desktop tabs;
  // otherwise the first mobile navigation can race the React media-query update.
  let mobileVisible = false;
  try {
    await mobile.waitFor({ state: "visible", timeout: 5_000 });
    mobileVisible = true;
  } catch {
    // Desktop layout: the selector is absent/hidden and role=tab is authoritative.
  }
  if (mobileVisible) {
    await mobile.click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText(name, { exact: true }).click();
  } else await page.getByRole("tab", { name, exact: true }).click();
}
try {
  await start();
  await check("Unauthenticated companion writes are rejected", async () => {
    assert.equal((await http("/api/core/invoke", "POST", { channel: "companion:update", args: [] })).response.status, 401);
  });
  await http("/api/auth/bootstrap", "POST", { username: "companion-test", password: "Fixture-Test-123" }, { "X-Cyrene-Setup-Token": "companion-fixture-setup" });
  await connect(); await server.startChannels();
  const fixtureSession = await invoke("chats:create", { title: "手机跟进验收会话", mode: "chat" });
  await check("Authenticated production core persists validated preferences", async () => {
    const state = await invoke("companion:get");
    const updated = await invoke("companion:update", { type: "preferences", expectedRevision: state.revision, patch: { userLabel: "共同验收", boundaries: ["先回答问题"], closeness: 0.67 } });
    assert.equal(updated.relationship.stage, "close");
    const stale = await http("/api/core/invoke", "POST", { channel: "companion:update", args: [{ type: "preferences", expectedRevision: state.revision, patch: { userLabel: "stale" } }] }, { "X-Cyrene-Client": token });
    assert.notEqual(stale.response.status, 200);
    assert.equal((await invoke("companion:get")).relationship.userLabel, "共同验收");
    const forged = await http("/api/core/invoke", "POST", { channel: "companion:update", args: [{ type: "clear_history", expectedRevision: updated.revision }] }, { "X-Cyrene-Client": token, Origin: "https://untrusted.invalid" });
    assert.equal(forged.response.status, 403);
  });
  await check("Shared IPC exports relationship and vector memory without external services", async () => {
    assert.equal(JSON.parse(await invoke("companion:export")).format, "cyrene.relationship.v1");
    assert.equal(JSON.parse(await invoke("memory-governance:export")).format, "cyrene.vector-memory.v1");
  });
  socket.close(); await server.close(); await start(); await connect(); await server.startChannels();
  await check("Core restart retains state", async () => assert.equal((await invoke("companion:get")).relationship.userLabel, "共同验收"));
  if (process.argv.includes("--ui")) {
    browser = await chromium.launch({ headless: true, ...(process.env.CYRENE_TEST_BROWSER_CHANNEL ? { channel: process.env.CYRENE_TEST_BROWSER_CHANNEL } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    page = await context.newPage(); const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(base + "/web/");
    await page.getByLabel("账号", { exact: true }).fill("companion-test");
    await page.getByLabel("密码", { exact: true }).fill("Fixture-Test-123");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "查看免责声明", exact: true }).click();
    await page.getByRole("button", { name: "接受并继续", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "昔涟设置", exact: true }).click();
    await check("Desktop settings save through the real Web bridge", async () => {
      await page.getByLabel("对你的称呼", { exact: true }).fill("网页验收");
      await page.getByLabel("相处边界", { exact: true }).fill("不要替我推测情绪\n专心完成当前任务");
      await page.getByRole("button", { name: "保存相处偏好", exact: true }).click();
      await page.getByText("已保存，下次回应会使用当前设置。", { exact: true }).waitFor();
      assert.equal((await invoke("companion:get")).relationship.userLabel, "网页验收");
      await page.screenshot({ path: path.join(evidence, "desktop.png") });
    });
    await check("Mobile controls remain usable and state persists after navigation", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await companionTab("能力与权限");
      await page.getByRole("switch", { name: "暂停新工具调用", exact: true }).click();
      await page.getByRole("button", { name: "保存能力限制", exact: true }).click();
      await page.getByText("已保存，下次回应会使用当前设置。", { exact: true }).waitFor();
      assert.equal((await invoke("companion:get")).permissions.paused, true);
      assert.equal(await page.locator("body").evaluate(e => e.scrollWidth <= e.clientWidth + 1), true);
      await page.screenshot({ path: path.join(evidence, "mobile.png") });
      await companionTab("记录与修复");
      await page.getByLabel("新的修复约定", { exact: true }).fill("先回应问题，再关心感受");
      await page.getByRole("button", { name: "记录约定", exact: true }).click();
      await page.getByText("先回应问题，再关心感受", { exact: true }).waitFor();
      assert.ok((await invoke("companion:get")).records.some(r => r.kind === "repair"));
      await companionTab("相处与形象");
      assert.equal(await page.getByLabel("对你的称呼", { exact: true }).inputValue(), "网页验收");
    });
    await check("Mobile followups can be created, paused and completed through real IPC", async () => {
      await companionTab("具体跟进");
      await page.getByLabel("跟进事项名称", { exact: true }).fill("隔离验收：论文答辩");
      await page.getByLabel("跟进绑定会话", { exact: true }).click();
      await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: "手机跟进验收会话" }).click();
      await page.getByRole("button", { name: "添加跟进事项", exact: true }).click();
      const card = page.getByRole("tabpanel").locator("article.cy-companion__record").filter({ hasText: "隔离验收：论文答辩" });
      await card.getByRole("button", { name: /^暂\s*停$/ }).click();
      await card.getByText("已暂停", { exact: true }).waitFor();
      assert.ok((await invoke("companion:get")).followups.some(item => item.topic === "隔离验收：论文答辩" && item.conversationId === fixtureSession.id && item.status === "paused"));
      await card.getByRole("button", { name: /^完\s*成$/ }).click();
      await card.getByText("已完成", { exact: true }).waitFor();
      assert.ok((await invoke("companion:get")).followups.some(item => item.topic === "隔离验收：论文答辩" && item.status === "completed"));
      await card.scrollIntoViewIfNeeded();
      assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      await page.screenshot({ path: path.join(evidence, "followups-mobile.png") });
    });
    await check("Mobile channel recovery can acknowledge a fixture without transmitting", async () => {
      await page.getByRole("button", { name: "设置导航", exact: true }).click();
      await page.getByRole("button", { name: "连接手机", exact: true }).click();
      const panel = page.getByRole("region", { name: "渠道消息恢复", exact: true });
      await panel.getByRole("button", { name: "刷新记录", exact: true }).click();
      await panel.getByRole("button", { name: "确认已送达", exact: true }).click();
      await page.getByRole("button", { name: "已核对，已送达", exact: true }).click();
      await panel.getByRole("button", { name: "显示已完成", exact: true }).click();
      await panel.getByText("已送达", { exact: true }).waitFor();
      const records = await invoke("channels:recovery:list");
      assert.equal(records.find(item => item.id === recoveryId)?.status, "completed");
      await panel.scrollIntoViewIfNeeded();
      assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      await page.screenshot({ path: path.join(evidence, "channel-recovery-mobile.png") });
    });
    await check("Memory provenance and deletion work through mobile Web UI", async () => {
      await page.getByRole("button", { name: "设置导航", exact: true }).click();
      await page.getByRole("button", { name: "记忆", exact: true }).click();
      await page.getByText("向量模式", { exact: true }).click();
      await page.getByRole("button", { name: "来源与管理", exact: true }).click();
      await page.getByText("这周一起读一本书", { exact: true }).waitFor();
      await writeFile(path.join(evidence, "memory-ui.txt"), await page.locator("body").ariaSnapshot());
      await page.screenshot({ path: path.join(evidence, "memory-mobile.png") });
      await page.getByRole("dialog", { name: "记忆来源与管理", exact: true }).getByRole("button", { name: /^删\s*除$/ }).click();
      await page.getByRole("dialog", { name: "确认删除范围", exact: true }).getByRole("button", { name: /^确\s*认$/ }).click();
      await page.getByRole("dialog", { name: "记忆来源与管理", exact: true }).waitFor({ state: "hidden" });
      assert.equal(JSON.parse(await invoke("memory-governance:export")).l2.length, 0);
    });
    assert.deepEqual(pageErrors, []);
    await browser.close(); browser = undefined;
  } else {
    await invoke("memory-governance:change", { action: "delete", id: "fixture-memory", expectedContent: "验收记忆：一起读书" });
  }
  socket.close(); await server.close(); await start(); await connect(); await server.startChannels();
  await check("A fresh production core retains the forgetting markers and deleted memory", async () => {
    const memory = JSON.parse(await invoke("memory-governance:export"));
    assert.equal(memory.l2.length, 0);
    assert.ok(memory.forgetting.memoryIds.includes("fixture-memory"));
    assert.ok(memory.forgetting.sourceKeys.includes(JSON.stringify(["fixture-chat", "fixture-user-entry"])));
    if (process.argv.includes("--ui")) {
      assert.ok((await invoke("companion:get")).followups.some(item => item.topic === "隔离验收：论文答辩" && item.status === "completed"));
      assert.equal((await invoke("channels:recovery:list")).find(item => item.id === recoveryId)?.status, "completed");
    }
  });
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ results }, null, 2));
  console.log("Evidence:", evidence);
} finally {
  await writeFile(path.join(evidence, "server.log"), logs.join("\n"));
  await browser?.close(); socket?.close(); await server?.close();
}
