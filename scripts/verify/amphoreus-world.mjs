// Shared-core integration verification, with a temporary data root and a local fixture model only.
// Run after `corepack pnpm run build:server`; works on Windows and Linux with Node 24.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createWebServer } = require('../../dist/server/server/index.js');
const { CURRENT_DISCLAIMER_VERSION } = require('../../dist/server/shared/disclaimer.js');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cyrene-amphoreus-'));
let modelCalls = 0;
let fixtureError;
const model = createServer(async (req, res) => {
  try {
    let input = ''; for await (const part of req) input += part;
    const body = JSON.parse(input);
    modelCalls++;
    assert.ok(!body.tools?.length, 'World generation must not have tools');
    assert.ok(!input.includes('PRIVATE_USER_PROFILE'), 'User profile must not enter the world request');
    const context = JSON.parse(body.messages.findLast((m) => m.role === 'user').content);
    if (context.purpose === 'plan') assert.equal(context.residents.length, 21);
    const event = (startMinute, locationId, participants, title) => ({ startMinute, durationMinutes: 45, locationId, participants, activity: 'work', severity: 'notable', title, summary: `准备${title}` });
    const plan = { date: context.date, events: [
      event(570, 'okhema', ['aglaea', 'demeter', 'nike'], '协调物资'),
      event(900, 'grove', ['anaxa', 'dan-heng'], '讨论研究'),
      event(1185, 'aedes-elysiae', ['phainon', 'hatonus'], '村落往来'),
    ] };
    const content = JSON.stringify(context.purpose === 'resolve' ? { resolutions: context.events.map((event) => ({ eventId: event.id, version: event.version, status: 'completed', outcome: `${event.title}形成了可继续追踪的记录。`, effects: [{ kind: 'place', placeId: event.locationId, field: 'supplies', delta: -2, reason: '本次活动使用了少量公共物资' }], developments: [] })) } : plan);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'world-fixture', model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'world-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'world-fixture', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    }
  } catch (error) { fixtureError = error; res.writeHead(500); res.end('fixture rejected the request'); }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(dataDir, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], settings: {
  general: { proactiveChatMode: 'off', momentsEnabled: false, disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION }, config: { memoryMode: 'off', runtimeSync: 'off' },
  modelProfiles: [{ id: 'world-fixture', provider: 'ChatGPT（OpenAI）', displayName: 'World fixture', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, explicitTransport: 'openai', model: 'world-fixture', models: ['world-fixture'] }], defaultModelProfileId: 'world-fixture',
} }));
await writeFile(path.join(dataDir, 'web-features.json'), JSON.stringify({ profile: { nickname: 'PRIVATE_USER_PROFILE', timezone: 'Asia/Shanghai' }, channels: { wechat: { enabled: false }, feishu: { enabled: false }, qq: { enabled: false }, qqbot: { enabled: false } } }));
const logs = [];
const options = { dataDir, staticRoot: path.resolve('dist/renderer'), sharedCore: true, secureCookies: false, setupToken: 'world-fixture', logger: { info: (v) => logs.push(String(v)), warn: (v) => logs.push(String(v)), error: (v) => logs.push(String(v)) } };
let handle;
let socket;
let base;
let cookie = '';
let clientToken = '';
const results = [];
async function http(route, body, extra = {}) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extra }, body: JSON.stringify(body) });
  const value = await response.json(); return { response, value };
}
async function invoke(channel, ...args) {
  const result = await http('/api/core/invoke', { channel, args }, { 'X-Cyrene-Client': clientToken });
  if (!result.response.ok) throw new Error(`World IPC failed: ${channel} (${result.response.status})`);
  return result.value;
}
async function waitFor(predicate, label) {
  const end = Date.now() + 30_000;
  while (!await predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
}
async function connect(first) {
  handle = createWebServer(options);
  await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${handle.server.address().port}`;
  if (first) {
    assert.equal((await http('/api/core/invoke', { channel: 'companion:world:get', args: [] })).response.status, 401);
    await http('/api/auth/bootstrap', { username: 'world-test', password: 'world-fixture-password' }, { 'X-Cyrene-Setup-Token': 'world-fixture' });
  }
  const login = await http('/api/auth/login', { username: 'world-test', password: 'world-fixture-password' });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  clientToken = '';
  socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  socket.on('message', (raw) => { const event = JSON.parse(String(raw)); if (event.type === 'ready') clientToken = event.clientToken; });
  await waitFor(() => clientToken, 'websocket handshake');
  await handle.startChannels();
}
async function close() { socket?.close(); if (handle?.server.listening) await handle.close(); }
try {
  await connect(true);
  await waitFor(async () => (await invoke('companion:world:get')).amphoreus?.narrative?.status === 'success', 'daily world plan');
  if (fixtureError) throw fixtureError;
  const first = await invoke('companion:world:get');
  assert.equal(first.amphoreus.residents.length, 21);
  assert.equal(first.amphoreus.events.length, 3);
  assert.equal(modelCalls, 1);
  assert.equal((await invoke('settings:get-general')).proactiveChatMode, 'off');
  assert.ok(!JSON.stringify(first).includes('fixture-only'));
  assert.ok(first.amphoreus.events.every((event) => !event.participants.includes('cyrene')));
  results.push('autonomous generation with proactive chat off; 21 residents; no tools or private profile');
  await Promise.all(Array.from({ length: 5 }, () => invoke('companion:world:get')));
  assert.equal(modelCalls, 1);
  await invoke('companion:world:configure', { narrativeEnabled: false });
  assert.equal((await invoke('companion:world:get')).amphoreus.narrativeEnabled, false);
  const rejected = await http('/api/core/invoke', { channel: 'companion:world:configure', args: [{ narrativeEnabled: 'yes' }] }, { 'X-Cyrene-Client': clientToken });
  assert.ok(rejected.response.status >= 400);
  const update = await invoke('companion:world:update');
  assert.ok(update.view);
  const unchanged = await invoke('companion:world:update', update.cursor);
  assert.equal(unchanged.view, undefined); assert.ok(unchanged.clock);
  assert.ok(JSON.stringify(unchanged).length < 500);
  results.push('authenticated IPC validation, unchanged updates under 500 bytes, and separate generation switch');
  await close();
  const snapshotPath = path.join(dataDir, 'amphoreus-world.json');
  const past = JSON.parse(await readFile(snapshotPath, 'utf8'));
  for (const event of past.amphoreus.days[0].events) {
    event.startsAt -= 86_400_000; event.endsAt -= 86_400_000;
    event.date = new Date(Date.parse(event.date + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  }
  const picture = path.join(dataDir, 'fixture.png');
  await writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  past.artifacts.push({ id: 'world-artwork-fixture', eventId: past.state.currentActivity.id, kind: 'selfie', createdAt: Date.now(), updatedAt: Date.now(), promptFingerprint: 'fixture', outputPath: picture, status: 'generated' });
  await writeFile(snapshotPath, JSON.stringify(past));
  await connect(false);
  const restarted = await invoke('companion:world:get');
  assert.deepEqual(restarted.amphoreus.events.map((e) => e.id), first.amphoreus.events.map((e) => e.id));
  assert.equal(restarted.amphoreus.narrativeEnabled, false);
  await invoke('companion:world:configure', { narrativeEnabled: true });
  await invoke('companion:world:get');
  await waitFor(async () => (await invoke('companion:world:get')).amphoreus.events.every((e) => e.status === 'completed'), 'event resolution');
  assert.equal(modelCalls, 2);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'amphoreus-world.json'), 'utf8'));
  assert.equal(saved.version, 3);
  assert.equal(saved.amphoreus.schema, 2);
  const history = await invoke('companion:world:history', { limit: 2 });
  assert.equal(history.entries.length, 2); assert.ok(history.next);
  const older = await invoke('companion:world:history', { ...history.next, limit: 80 });
  assert.ok(!older.entries.some((entry) => history.entries.some((first) => first.id === entry.id)));
  assert.equal(await invoke('companion:world:artifact', '../../outside'), null);
  results.push('restart preserves intentions and resolves due events once; authenticated history pagination and artifact ID boundary');
  await mkdir('.build-temp', { recursive: true });
  if (process.argv.includes('--ui')) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1366, height: 960 }, locale: 'zh-CN' });
      const equals = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: base }]);
      const page = await context.newPage();
      const errors = []; page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '翁法罗斯', exact: true }).click();
      await page.locator('.cy-amphoreus__clock').waitFor();
      assert.equal(await page.evaluate(() => typeof window.companion.getWorldUpdate), 'function');
      assert.equal(await page.getByRole('heading', { name: '翁法罗斯', exact: true }).count(), 1);
      assert.ok(await page.getByRole('button', { name: '翁法罗斯', exact: true }).isVisible());
      await page.screenshot({ path: '.build-temp/amphoreus-desktop.png' });
      await page.getByRole('tab', { name: '居民', exact: true }).click();
      await page.getByRole('tabpanel', { name: '居民', exact: true }).locator('article').first().waitFor();
      assert.equal(await page.getByRole('tabpanel', { name: '居民', exact: true }).locator('article').count(), 21);
      await page.getByRole('tabpanel', { name: '居民', exact: true }).locator('details').first().locator('summary').click();
      await page.getByRole('button', { name: '查看此人的完整经历', exact: true }).first().click();
      await page.getByRole('tabpanel', { name: '世界编年史', exact: true }).locator('article').first().waitFor();
      await page.getByRole('tab', { name: '地点', exact: true }).click();
      await page.locator('.cy-amphoreus__map').waitFor();
      assert.equal(await page.locator('.cy-amphoreus__map button').count(), 10);
      await page.locator('.cy-amphoreus__map button').nth(1).click();
      assert.ok(await page.locator('.cy-amphoreus__place-detail').textContent());
      await page.screenshot({ path: '.build-temp/amphoreus-map-desktop.png' });
      await page.getByRole('tab', { name: '昔涟的生活', exact: true }).click();
      await page.getByRole('button', { name: '查看作品', exact: true }).click();
      const artwork = page.getByRole('img', { name: '昔涟生活记录中的画面', exact: true });
      await artwork.waitFor();
      assert.equal(await artwork.evaluate(async (image) => { await image.decode(); return image.naturalWidth; }), 1);
      await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).click();
      await page.getByRole('tab', { name: '地点', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: '.build-temp/amphoreus-mobile.png' });
      await page.locator('.cy-amphoreus__map').scrollIntoViewIfNeeded();
      await page.screenshot({ path: '.build-temp/amphoreus-map-mobile.png' });
      const client = await context.newCDPSession(page);
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', { offline: false, latency: 250, downloadThroughput: 256 * 1024, uploadThroughput: 128 * 1024 });
      await page.locator('.cy-amphoreus__heading').scrollIntoViewIfNeeded();
      const [updateResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/core/invoke') && response.request().postDataJSON()?.channel === 'companion:world:update'),
        page.getByRole('button', { name: /^刷\s*新$/ }).click({ timeout: 5000 }),
      ]);
      assert.equal(updateResponse.status(), 200);
      assert.ok((await updateResponse.body()).length < 500);
      await client.detach();
      const overflow = await page.locator('.cy-amphoreus').evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, `World panel overflow: ${overflow}px`);
      assert.deepEqual(errors, []);
      results.push('desktop and 390px mobile browser: top-level entry, 21 residents, personal history, 10-place map, image preview, simulated 250ms latency refresh under 500 bytes, no panel overflow or page errors');
    } finally { await browser.close(); }
  }
  await writeFile('.build-temp/amphoreus-verification.json', JSON.stringify({ at: new Date().toISOString(), platform: process.platform, dataDir, model: 'isolated fixture', results, modelCalls }, null, 2));
  console.log(JSON.stringify({ passed: results.length, modelCalls, platform: process.platform, report: '.build-temp/amphoreus-verification.json' }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Verification failed');
  console.error('Fixture data:', dataDir);
  process.exitCode = 1;
} finally { await close(); await new Promise((resolve) => model.close(resolve)); }
