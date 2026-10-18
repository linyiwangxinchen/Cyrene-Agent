import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Native Linux x64 acceptance required');
const launcher = path.join(root, 'cyrene-web');
assert.match(execFileSync('file', [launcher], { encoding: 'utf8' }), /ELF 64-bit.*x86-64/);
assert.match(execFileSync(launcher, ['--version'], { encoding: 'utf8' }), /Cyrene Web/);
assert.equal(execFileSync(launcher, ['--node', '-p', 'process.execPath'], { encoding: 'utf8' }).trim(), path.join(root, 'runtime/node'));
assert.equal(execFileSync(launcher, ['--node', '-p', 'process.env.PATH.split(":")[0]'], { encoding: 'utf8' }).trim(), path.join(root, 'runtime'));
assert.match(execFileSync(launcher, ['--node', '-e', 'const p=require("node:child_process").spawnSync("npx",["--version"],{encoding:"utf8"});if(p.error)throw p.error;process.stdout.write(p.stdout);process.exit(p.status??1)'], { encoding: 'utf8' }).trim(), /^\d+\.\d+\.\d+$/);
assert.ok(root.includes(' '), 'Acceptance must exercise an installation path containing spaces');
const require = createRequire(path.join(root, 'package.json'));
const WebSocket = require('ws');
const data = await mkdtemp(path.join(os.tmpdir(), 'cyrene-portable-data-'));
await writeFile(path.join(data, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], settings: { general: { proactiveChatMode: 'off', playwrightMcpEnabled: false, filesystemMcpEnabled: false }, config: { memoryMode: 'off', runtimeSync: 'off' } } }));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, socket, cookie, clientToken, session;
const logs = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(probe, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (child?.exitCode != null) throw new Error(`Server exited during ${label}: ${child.exitCode}\n${logs.slice(-20).join('')}`); try { if (await probe()) return; } catch {} await delay(50); }
  throw new Error(`Timed out: ${label}\n${logs.slice(-20).join('')}`);
}
async function api(route, method = 'GET', body, extra = {}) {
  const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
  return { response, value };
}
async function invoke(channel, ...args) {
  const { response, value } = await api('/api/core/invoke', 'POST', { channel, args }, { 'X-Cyrene-Client': clientToken });
  assert.equal(response.status, 200, `${channel}: ${JSON.stringify(value)}`); return value;
}
async function launch() {
  child = spawn(launcher, [], { cwd: os.tmpdir(), env: { ...process.env, CYRENE_DATA_DIR: data, CYRENE_WEB_HOST: '127.0.0.1', CYRENE_WEB_PORT: String(port), CYRENE_SETUP_TOKEN: 'portable-fixture-setup' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => logs.push(String(chunk))); child.stderr.on('data', chunk => logs.push(String(chunk)));
  await waitFor(async () => (await fetch(base + '/healthz')).ok, 'ELF launcher health');
}
async function login() {
  const result = await api('/api/auth/login', 'POST', { username: 'portable-fixture', password: 'fixture-local-password' });
  assert.equal(result.response.status, 200); cookie = result.response.headers.get('set-cookie').split(';')[0];
  clientToken = '';
  socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'ready') clientToken = message.clientToken; });
  await waitFor(() => clientToken, 'authenticated WebSocket');
}
async function stop() {
  socket?.close(); socket = undefined;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  let timer;
  const outcome = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SIGTERM did not stop portable server')), 30000); })]).finally(() => clearTimeout(timer));
  assert.deepEqual(outcome, { code: 0, signal: null }); child = undefined;
}
try {
  await launch();
  assert.equal((await api('/api/core/capabilities', 'POST', {})).response.status, 401);
  assert.equal((await api('/web/')).response.status, 200);
  assert.equal((await api('/api/auth/bootstrap', 'POST', { username: 'portable-fixture', password: 'fixture-local-password' }, { 'X-Cyrene-Setup-Token': 'portable-fixture-setup' })).response.status, 201);
  await login();
  const caps = await api('/api/core/capabilities', 'POST', {}, { 'X-Cyrene-Client': clientToken });
  assert.equal(caps.response.status, 200); assert.ok(caps.value.handlers.includes('chats:create'));
  session = await invoke('chats:create', { title: `Portable ${randomUUID()}`, mode: 'chat' });
  assert.ok(session.id); assert.equal((await invoke('chats:get', session.id)).title, session.title);
  await stop();
  const database = new DatabaseSync(path.join(data, 'cyrene.sqlite'), { readOnly: true });
  try { assert.ok(database.prepare('SELECT id FROM conversations WHERE id=?').get(session.id)); } finally { database.close(); }
  await launch(); await login();
  assert.equal((await invoke('chats:get', session.id)).title, session.title);
  await stop();
  console.log('PASS native ELF, paths with spaces, bundled Node execPath, authenticated API/WebSocket, actual SQLite worker, persistence/restart and graceful SIGTERM');
  await writeFile(path.join(root, 'PORTABLE-ACCEPTANCE.json'), JSON.stringify({ checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, checks: ['native-elf', 'paths-with-spaces', 'bundled-node-execPath', 'auth-http-websocket', 'sqlite-worker', 'restart-persistence', 'sigterm-clean-exit'], build: JSON.parse(await readFile(path.join(root, 'BUILD-INFO.json'), 'utf8')) }, null, 2) + '\n');
} finally {
  socket?.close();
  if (child && child.exitCode == null) { try { await stop(); } catch { child.kill('SIGKILL'); } }
}
