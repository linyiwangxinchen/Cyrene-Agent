// Exercise the packaged application with an isolated profile. Windows login items,
// global shortcuts and visible windows are suppressed by the test bootstrap only.
// Run after packaging: node scripts/verify/windows-packaged.mjs [unpacked-directory]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { chromium } from 'playwright';

assert.equal(process.platform, 'win32', 'This verification requires Windows');
const unpacked = path.resolve(process.argv[2] ?? 'release/win-unpacked');
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const root = await mkdtemp(path.join(os.tmpdir(), 'cyrene-packaged-'));
const paths = Object.fromEntries(['profile', 'roaming', 'local', 'data', 'session', 'logs', 'temp', 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'].map((key) => [key, path.join(root, key)]));
for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });
await writeFile(path.join(paths.data, 'app-settings.json'), JSON.stringify({ petVisible: false, launchAtLogin: false, proactiveChatMode: 'off', momentsEnabled: false, cyreneMomentsPostingEnabled: false, cyreneMomentsReactionsEnabled: false, momentsCharacterReactionsEnabled: false, disclaimerAcceptedVersion: '2026-11-02', language: 'zh-CN', playwrightMcpEnabled: false, filesystemMcpEnabled: false }));
await writeFile(path.join(paths.data, 'model-settings.json'), JSON.stringify({ memoryMode: 'off', runtimeSync: 'off', rerankerMode: 'none' }));
await writeFile(path.join(paths.data, 'user-profile.json'), JSON.stringify({ nickname: 'Release fixture', timezone: 'Asia/Shanghai' }));
await writeFile(path.join(paths.data, 'gpu-acl-ok'), 'Isolated release verification; ACL integration is excluded.');
const bootstrap = path.join(root, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, globalShortcut, dialog } = require('electron');
const paths = ${JSON.stringify(paths)};
process.execArgv = process.execArgv.filter((arg) => !arg.startsWith('--inspect'));
// Workers must not inherit the harness's initial --inspect-brk pause.
const threads = require('node:worker_threads');
const Worker = threads.Worker;
threads.Worker = class extends Worker {
  constructor(source, options) { super(source, { ...options, execArgv: [] }); }
};
app.setPath('home', paths.profile);
app.setPath('appData', paths.roaming);
app.setPath('userData', paths.data);
app.setPath('sessionData', paths.session);
app.setPath('logs', paths.logs);
for (const name of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) app.setPath(name, paths[name]);
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
app.on('browser-window-created', (_event, window) => {
  window.show = window.showInactive = window.focus = () => {};
});
`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|systemdrive|number_of_processors|processor_architecture)$/i.test(key)));
Object.assign(env, { APPDATA: paths.roaming, LOCALAPPDATA: paths.local, USERPROFILE: paths.profile, TEMP: paths.temp, TMP: paths.temp });
const logs = [], errors = [], results = [];
let application;
async function until(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function launchPackaged() {
  let output = '', browser, inspector, sequence = 0;
  const pending = new Map(), events = [];
  const child = spawn(path.join(unpacked, 'Cyrene.exe'), ['--inspect-brk=0', '--remote-debugging-port=0', `--user-data-dir=${paths.data}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (error) => errors.push(error.message));
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (value) => { output += String(value); logs.push(String(value)); appendFileSync(path.join(root, 'runtime.log'), value); });
  const exit = once(child, 'exit');
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    inspector.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const close = async () => {
    await browser?.close().catch(() => {});
    if (inspector?.readyState === WebSocket.OPEN) {
      await send('Runtime.evaluate', { expression: "require('electron').app.quit()", includeCommandLineAPI: true }).catch(() => {});
      inspector.close();
    }
    if (child.exitCode === null) {
      const timeout = setTimeout(() => child.kill(), 10_000);
      await exit;
      clearTimeout(timeout);
    }
  };
  try {
    const nodeUrl = await until(() => output.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1], 'Node inspector');
    inspector = new WebSocket(nodeUrl);
    inspector.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(new Error(JSON.stringify(message.error))); else request?.resolve(message.result);
      } else events.push(message);
    });
    await once(inspector, 'open');
    await send('Runtime.enable');
    await send('Debugger.enable');
    await send('Runtime.runIfWaitingForDebugger');
    const pause = await until(() => events.find((event) => event.method === 'Debugger.paused'), 'application entry breakpoint');
    const boot = await send('Debugger.evaluateOnCallFrame', { callFrameId: pause.params.callFrames[0].callFrameId, expression: `require(${JSON.stringify(bootstrap)})`, returnByValue: true });
    assert.ok(!boot.exceptionDetails, JSON.stringify(boot.exceptionDetails));
    await send('Debugger.resume');
    const browserUrl = await until(() => output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chromium debugging endpoint');
    await send('Debugger.disable');
    await evaluate("require('electron').app.whenReady().then(() => true)");
    for (let attempt = 0; attempt < 100; attempt++) {
      const loaded = await evaluate("require('electron').BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('/react/index.html'))");
      if (loaded) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.connectOverCDP(browserUrl, { noDefaults: true });
    await until(() => output.includes('[StartupTiming] bg/proactive-trigger'), 'background startup');
    assert.ok(!/\[Background\].*failed:/.test(output), 'Background startup must complete without failures');
    return { evaluate, windows: () => browser.contexts().flatMap((context) => context.pages()), close };
  } catch (error) { await close(); throw error; }
}
async function start() {
  application = await launchPackaged();
  const info = await application.evaluate("(() => { const { app } = require('electron'); return { version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData'), appData: app.getPath('appData'), appPath: app.getAppPath() }; })()");
  assert.equal(info.version, expectedVersion);
  assert.equal(info.packaged, true);
  assert.equal(info.userData, paths.data);
  assert.equal(info.appData, paths.roaming);
  assert.equal(info.appPath, path.join(unpacked, 'resources', 'app.asar'));
  const deadline = Date.now() + 30_000;
  let page;
  while (Date.now() < deadline) {
    page = application.windows().find((window) => window.url().includes('/react/index.html'));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Packaged workspace window must open');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.companion?.getWorld), { timeout: 30_000 });
  return page;
}
try {
  const cli = execFileSync(path.join(unpacked, 'Cyrene.exe'), [path.join(unpacked, 'resources', 'app.asar', 'dist', 'cli', 'index.js'), 'config', '--help'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert.match(cli, /init/); assert.match(cli, /validate/); assert.match(cli, /apply/);
  results.push('CLI configuration commands from the packaged ASAR');
  const page = await start();
  const view = await page.evaluate(() => window.companion.getWorld());
  assert.equal(view.amphoreus.name, '翁法罗斯');
  assert.equal(view.amphoreus.residents.length, 21);
  assert.equal(view.amphoreus.residentStates.length, 21);
  assert.equal(view.amphoreus.activities.length, 21);
  assert.equal(view.amphoreus.clock.timezone, 'Asia/Shanghai');
  results.push('Packaged Electron, preload IPC and all 21 residents');
  const history = await page.evaluate(() => window.companion.getWorldHistory({ limit: 20 }));
  assert.ok(Array.isArray(history.entries));
  const update = await page.evaluate(() => window.companion.getWorldUpdate());
  const unchanged = await page.evaluate((cursor) => window.companion.getWorldUpdate(cursor), update.cursor);
  assert.equal(unchanged.view, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < 500);
  results.push('SQLite history and small unchanged-update response');
  await writeFile(path.join(root, 'workspace-text.txt'), await page.locator('body').innerText());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '翁法罗斯', exact: true }).click();
  await page.getByRole('heading', { name: '翁法罗斯', exact: true }).waitFor();
  await page.getByRole('tab', { name: '居民', exact: true }).click();
  await page.getByText('阿格莱雅', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(root, 'amphoreus-residents.png') });
  results.push('Settings navigation and resident UI');
  await page.evaluate(() => window.companion.configureWorld({ narrativeEnabled: false }));
  assert.equal((await page.evaluate(() => window.companion.getWorld())).amphoreus.narrativeEnabled, false);
  await application.close(); application = undefined;
  const restored = await start();
  assert.equal((await restored.evaluate(() => window.companion.getWorld())).amphoreus.narrativeEnabled, false);
  assert.equal((await restored.evaluate(() => window.companion.getWorld())).amphoreus.residentStates.length, 21);
  results.push('Configuration and world state survive a packaged-app restart');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ root, expectedVersion, results, rendererErrors: errors }, null, 2));
} finally {
  await writeFile(path.join(root, 'runtime.log'), logs.join(''));
  await writeFile(path.join(root, 'verification.json'), JSON.stringify({ root, expectedVersion, results, rendererErrors: errors }, null, 2));
  await application?.close();
  console.log(`Verification artifacts: ${root}`);
}
