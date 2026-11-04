// Run after build:web. Real HTTP/auth/shared-core/SQLite; isolated fixture data only.
// Never configures a model, starts an external connector, or delivers a message.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createWebServer } = require(path.join(repository, "dist/server/server/index.js"));
const root = await mkdtemp(path.join(os.tmpdir(), "cyrene-continuity-flow-"));
const evidence = path.join(root, "evidence"); await mkdir(evidence);
const previousAppRoot = process.env.CYRENE_APP_ROOT;
process.env.CYRENE_APP_ROOT = repository;
const logs = [], results = [];
let handle, socket, base, cookie = "", clientToken = "";
const setupToken = "continuity-fixture-local-only";
const username = "continuity-fixture", password = "Fixture-Local-123!";
const operationId = "fixture-unknown-delivery", inboxId = "fixture-queued-disabled";
const receivedAt = Date.now();
await writeFile(path.join(root, "web-data.json"), JSON.stringify({ version: 1, sessions: [], settings: {
  general: { proactiveChatMode: "off", momentsEnabled: false }, config: { memoryMode: "off", runtimeSync: "off" }, modelProfiles: [],
} }));
await mkdir(path.join(root, "channel-recovery"));
const outgoing = { channel: "wechat", targetId: "fixture-not-a-real-contact", parts: [{ kind: "text", text: "本地隔离验收，不发送" }] };
const seed = async record => writeFile(path.join(root, "channel-recovery", `${createHash("sha256").update(record.id).digest("hex")}.json`), JSON.stringify(record), { mode: 0o600 });
await seed({ kind: "outbox", id: operationId, channel: "wechat", createdAt: receivedAt, updatedAt: receivedAt,
  fingerprint: createHash("sha256").update(JSON.stringify(outgoing)).digest("hex"), message: outgoing,
  parts: [{ status: "sending", updatedAt: receivedAt }] });
await seed({ kind: "inbox", id: inboxId, channel: "wechat", createdAt: receivedAt, updatedAt: receivedAt,
  message: { channel: "wechat", messageId: "fixture-platform-message", senderId: "fixture", chatId: "fixture-not-a-real-contact", text: "禁用渠道不得执行本消息", at: new Date(receivedAt).toISOString() },
  context: { sessionId: "fixture-external", boundConversationId: null }, status: "queued" });

async function start() {
  handle = createWebServer({ dataDir: root, sharedCore: true, secureCookies: false, setupToken,
    staticRoot: path.join(repository, "dist/renderer"), logger: { info: value => logs.push(String(value)), warn: value => logs.push(String(value)), error: value => logs.push(String(value)) } });
  await new Promise((resolve, reject) => { handle.server.once("error", reject); handle.server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${handle.server.address().port}`;
}
async function http(route, { method = "GET", body, headers = {}, authenticated = true } = {}) {
  const response = await fetch(base + route, { method, headers: {
    ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers,
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  return { response, value: await response.json() };
}
async function connect() {
  const login = await http("/api/auth/login", { method: "POST", authenticated: false, body: { username, password } });
  assert.equal(login.response.status, 200, JSON.stringify(login.value)); cookie = login.response.headers.get("set-cookie").split(";")[0];
  clientToken = ""; socket = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture WebSocket handshake timed out")), 15_000);
    socket.on("message", raw => { const value = JSON.parse(String(raw)); if (value.type === "ready") { clientToken = value.clientToken; clearTimeout(timer); resolve(); } });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
  });
}
async function request(channel, args = [], extra = {}) {
  return http("/api/core/invoke", { method: "POST", body: { channel, args }, headers: { "X-Cyrene-Client": clientToken, ...extra } });
}
async function invoke(channel, ...args) {
  const { response, value } = await request(channel, args); assert.equal(response.status, 200, JSON.stringify(value)); return value;
}
async function ready(expected) {
  // Public probe coalesces/caches checks for one second. No model request is used.
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await http("/readyz", { authenticated: false });
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    if (result.response.status === (expected ? 200 : 503) && result.value.ready === expected) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`readiness did not become ${expected}`);
}
async function close() {
  socket?.terminate(); socket = undefined; clientToken = "";
  const previous = handle; handle = undefined;
  if (previous) await previous.close();
}
async function check(name, task) { await task(); results.push(name); console.log("PASS", name); }
let followupId, cancelledId, conversationId;
try {
  console.log("Evidence:", evidence);
  await start();
  await check("Public readiness rejects a listening HTTP server before shared-core startup", () => ready(false));
  await check("Unauthenticated recovery reads/writes and followup writes are rejected", async () => {
    for (const [channel, args] of [["channels:recovery:list", []], ["channels:recovery:retry", [{ id: operationId, confirmed: true }]],
      ["companion:update", [{ type: "followup_save", topic: "unauthorized", conversationId: "fixture", nextEligibleAt: Date.now() + 60_000 }]]]) {
      assert.equal((await http("/api/core/invoke", { method: "POST", authenticated: false, body: { channel, args } })).response.status, 401);
    }
  });
  const boot = await http("/api/auth/bootstrap", { method: "POST", authenticated: false, body: { username, password }, headers: { "X-Cyrene-Setup-Token": setupToken } });
  assert.equal(boot.response.status, 201, JSON.stringify(boot.value));
  await connect(); await handle.startChannels();
  await check("Started production core and its SQLite metadata reader pass readiness", () => ready(true));
  await check("Authenticated recovery shows interrupted sends as unknown and cancels disabled queued input", async () => {
    const records = await invoke("channels:recovery:list");
    assert.equal(records.find(record => record.id === operationId)?.parts[0].status, "unknown");
    assert.equal(records.find(record => record.id === inboxId)?.status, "cancelled");
    const refused = await request("channels:recovery:retry", [{ id: operationId, confirmed: true }]); assert.notEqual(refused.response.status, 200);
    const notConfirmed = await request("channels:recovery:resolve", [{ id: operationId, index: 0, outcome: "sent" }]); assert.notEqual(notConfirmed.response.status, 200);
    const forged = await request("channels:recovery:resolve", [{ id: operationId, index: 0, outcome: "sent", confirmed: true }], { Origin: "https://untrusted.invalid" });
    assert.equal(forged.response.status, 403);
    await invoke("channels:recovery:resolve", { id: operationId, index: 0, outcome: "sent", confirmed: true });
    assert.equal((await invoke("channels:recovery:list")).find(record => record.id === operationId)?.status, "completed");
  });
  await check("Followup create/read/edit/pause/resume/complete/cancel uses revision-checked production IPC", async () => {
    const conversation = await invoke("chats:create", { title: "接续验收会话", mode: "chat" }); conversationId = conversation.id; assert.equal(typeof conversationId, "string");
    let state = await invoke("companion:get"); const previousRevision = state.revision;
    state = await invoke("companion:update", { type: "followup_save", expectedRevision: state.revision, topic: "报告进展", conversationId, nextEligibleAt: Date.now() + 86_400_000 });
    followupId = state.followups.find(item => item.topic === "报告进展")?.id; assert.equal(typeof followupId, "string");
    const stale = await request("companion:update", [{ type: "followup_status", expectedRevision: previousRevision, id: followupId, conversationId, status: "completed" }]); assert.notEqual(stale.response.status, 200);
    const invalid = await request("companion:update", [{ type: "followup_save", expectedRevision: state.revision, topic: "过期时间", conversationId, nextEligibleAt: Date.now() - 60_000 }]); assert.notEqual(invalid.response.status, 200);
    state = await invoke("companion:update", { type: "followup_save", expectedRevision: state.revision, id: followupId, topic: "报告修订进展", conversationId, nextEligibleAt: Date.now() + 86_400_000 });
    state = await invoke("companion:update", { type: "followup_status", expectedRevision: state.revision, id: followupId, conversationId, status: "paused" });
    assert.equal(state.followups.find(item => item.id === followupId)?.status, "paused");
    state = await invoke("companion:update", { type: "followup_status", expectedRevision: state.revision, id: followupId, conversationId, status: "active", nextEligibleAt: Date.now() + 86_400_000 });
    state = await invoke("companion:update", { type: "followup_status", expectedRevision: state.revision, id: followupId, conversationId, status: "completed" });
    state = await invoke("companion:update", { type: "followup_save", expectedRevision: state.revision, topic: "取消事项", conversationId, nextEligibleAt: Date.now() + 86_400_000 });
    cancelledId = state.followups.find(item => item.topic === "取消事项")?.id; assert.equal(typeof cancelledId, "string");
    state = await invoke("companion:update", { type: "followup_status", expectedRevision: state.revision, id: cancelledId, conversationId, status: "cancelled" });
    assert.equal(state.followups.find(item => item.id === cancelledId)?.status, "cancelled");
  });
  const oldBase = base; await close();
  await check("Fixture shutdown closes HTTP instead of leaving a false-ready service", async () => {
    await assert.rejects(fetch(oldBase + "/readyz", { signal: AbortSignal.timeout(2000) }));
  });
  await start(); await ready(false); await connect(); await handle.startChannels(); await ready(true);
  await check("Core restart retains followups and confirmed channel receipts without resending", async () => {
    const state = await invoke("companion:get");
    assert.ok(state.followups.some(item => item.id === followupId && item.topic === "报告修订进展" && item.conversationId === conversationId && item.status === "completed"));
    assert.ok(state.followups.some(item => item.id === cancelledId && item.status === "cancelled"));
    const records = await invoke("channels:recovery:list");
    assert.equal(records.find(item => item.id === operationId)?.status, "completed");
    assert.equal(records.find(item => item.id === inboxId)?.status, "cancelled");
  });
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ results, root }, null, 2));
  console.log(`Verified ${results.length} production boundary scenarios. Evidence: ${evidence}`);
} finally {
  await close(); await writeFile(path.join(evidence, "server.log"), logs.join("\n"));
  if (previousAppRoot === undefined) delete process.env.CYRENE_APP_ROOT; else process.env.CYRENE_APP_ROOT = previousAppRoot;
}
