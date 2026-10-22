// Run after pnpm run build:server. Real headless worker, model requests, shell
// processes and SQLite; isolated data only, no provider credentials required.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const data = await mkdtemp(path.join(os.tmpdir(), 'cyrene-shell-continuation-'));
const workspace = path.join(data, 'workspace'), nextWorkspace = path.join(data, 'next-workspace');
await mkdir(workspace); await mkdir(nextWorkspace);
const results = [], requests = [], events = [], logs = [], pending = new Map(), held = new Map(), aborted = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${logs.slice(-30).join('')}`);
    await delay(25);
  }
}
async function check(name, action) {
  const started = Date.now(); await action(); results.push({ name, ok: true, ms: Date.now() - started }); console.log('PASS', name);
}
const script = path.join(workspace, 'background.cjs');
await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(process.argv[3],String(process.pid));console.log('fixture-ready');const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);console.log('fixture-finished:'+process.argv[4]);}},30);`);
const jobs = new Map();
function commandFor(name) {
  const release = path.join(workspace, `${name}.release`), pidFile = path.join(workspace, `${name}.pid`);
  jobs.set(name, { release, pidFile });
  const quoted = [process.execPath, script, release, pidFile, name].map(value => `"${value}"`).join(' ');
  return process.platform === 'win32' ? `"${quoted}"` : quoted;
}
const commands = Object.fromEntries(['deliver', 'workspace', 'delete', 'shutdown', 'linger'].map(name => [name, commandFor(name)]));
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages ?? [];
    const text = messages.findLast(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('case:'))?.content ?? '';
    const name = /^case:(\w+)/.exec(text)?.[1];
    const completion = messages.some(message => JSON.stringify(message.content).includes('[后台 Shell 任务结束事件]'));
    const toolResult = messages.some(message => message.role === 'tool');
    const record = { name, completion, body }; requests.push(record);
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const finish = () => { chunk({ content: completion ? `continued-${name}` : `initial-${name}` }); chunk({}, 'stop'); response.end('data: [DONE]\n\n'); };
    chunk({ role: 'assistant' });
    if ((completion && ['workspace', 'delete', 'shutdown'].includes(name)) || name === 'learnA') {
      const key = completion ? `${name}:background` : name;
      held.set(key, finish); response.once('close', () => { held.delete(key); if (!response.writableEnded) aborted.add(key); });
      return;
    }
    if (commands[name] && !completion && !toolResult) {
      assert.ok(body.tools?.some(tool => tool.function?.name === 'run_shell'), 'model must receive real shell tool');
      chunk({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: commands[name], cwd: workspace, shell: process.platform === 'win32' ? 'cmd' : 'bash', run_in_background: true }) } }] });
      chunk({}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
    }
    finish();
  } catch (error) { logs.push(String(error)); response.destroy(error); }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(data, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], settings: {
  general: { proactiveChatMode: 'off', momentsEnabled: false, cyreneMomentsPostingEnabled: false, cyreneMomentsReactionsEnabled: false, summaryMemoryEnabled: false },
  config: { memoryMode: 'summary', runtimeSync: 'off' },
  modelProfiles: [{ id: 'fixture', provider: 'ChatGPT（OpenAI）', displayName: 'Fixture', apiKey: 'fixture-local-only', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, explicitTransport: 'openai', model: 'fixture', models: ['fixture'] }], defaultModelProfileId: 'fixture',
} }));
let child, childExit, ready = false;
function start() {
  ready = false;
  child = fork(path.resolve('dist/headless/core.cjs'), [], { env: { ...process.env, CYRENE_HEADLESS: '1', CYRENE_DATA_DIR: data, CYRENE_APP_ROOT: process.cwd(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', chunk => logs.push(String(chunk))); child.stderr.on('data', chunk => logs.push(String(chunk)));
  childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.on('message', message => {
    if (message.type === 'ready') ready = true;
    if (message.type === 'failed') logs.push(message.error);
    if (message.type === 'event') events.push(message);
    if (message.type === 'response') {
      const request = pending.get(message.requestId); if (!request) return;
      pending.delete(message.requestId); clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
    }
  });
}
async function rpc(message, clientId = 101) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`IPC timeout: ${message.channel ?? message.type}`)); }, 40_000);
    pending.set(requestId, { resolve, reject, timer }); child.send({ ...message, requestId, clientId });
  });
}
const invoke = (channel, ...args) => rpc({ type: 'invoke', channel, args });
const terminal = runId => events.find(event => event.channel === 'agui:event' && event.args[0]?.runId === runId && ['RUN_FINISHED', 'RUN_ERROR'].includes(event.args[0]?.type));
async function run(session, name) {
  const text = `case:${name}`;
  const ack = await invoke('agui:run', { sessionId: session.id, currentUser: { turnId: randomUUID(), text, visibleContent: text }, assistantTurnId: randomUUID() });
  assert.equal(ack.success, true); return ack;
}
async function finishRun(ack) {
  await waitFor(() => terminal(ack.runId), 'run terminal'); assert.equal(terminal(ack.runId).args[0].type, 'RUN_FINISHED');
}
async function session(name, mode = 'work') {
  const value = await invoke('chats:create', { title: name, mode });
  const vault = mode === 'learn' ? path.join(data, name) : workspace;
  await mkdir(vault, { recursive: true });
  assert.equal((await invoke('chats:set-workspace', { sessionId: value.id, workspaceRoot: vault })).ok, true); return value;
}
function databaseQuery(query, ...args) {
  const db = new DatabaseSync(path.join(data, 'cyrene.sqlite'), { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=5000'); return db.prepare(query).all(...args); } finally { db.close(); }
}
async function stop() {
  child.send({ type: 'shutdown' });
  let timer;
  try {
    const result = await Promise.race([childExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Headless shutdown timed out')), 15_000); })]);
    assert.equal(result.code, 0, JSON.stringify(result));
  } finally { clearTimeout(timer); }
}
try {
  start(); await waitFor(() => ready, 'headless startup', 60_000);
  await invoke('permission:set-level', 'full');
  let delivered;
  await check('Background shell completes after browser disconnect and broadcasts a canonical continuation', async () => {
    delivered = await session('deliver'); const ack = await run(delivered, 'deliver'); await finishRun(ack);
    await waitFor(() => existsSync(jobs.get('deliver').pidFile), 'shell process ready');
    child.send({ type: 'disconnect', clientId: 101 }); await rpc({ type: 'capabilities' }, 202);
    const prior = events.length; await writeFile(jobs.get('deliver').release, 'go');
    await waitFor(() => events.slice(prior).some(event => event.channel === 'agui:event' && event.args[0]?.type === 'RUN_FINISHED'), 'background terminal');
    const stream = events.slice(prior).filter(event => event.channel === 'agui:event');
    assert.ok(stream.some(event => event.args[0]?.type === 'TEXT_MESSAGE_CONTENT' && event.args[0].delta?.includes('continued-deliver')));
    assert.ok(stream.every(event => event.clientId === undefined), 'server continuation must broadcast independently of original browser');
    const saved = await invoke('chats:get', delivered.id);
    assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
    assert.ok(saved.messages.some(message => message.content?.includes('continued-deliver')));
    assert.equal(databaseQuery("SELECT kind FROM transcript_entries WHERE conversation_id=? AND kind='background_event'", delivered.id).length, 1);
    const body = requests.find(item => item.name === 'deliver' && item.completion).body;
    assert.ok(!body.tools?.some(tool => ['ask_user', 'request_user_input', 'pop_quiz'].includes(tool.function?.name)), 'background model must not request unavailable interaction');
  });
  for (const mutation of ['workspace', 'delete']) await check(`Session ${mutation} cancels and retires an in-flight background continuation`, async () => {
    const value = await session(mutation); const ack = await run(value, mutation); await finishRun(ack);
    await writeFile(jobs.get(mutation).release, 'go'); await waitFor(() => held.has(`${mutation}:background`), 'background model request');
    if (mutation === 'workspace') {
      assert.equal((await invoke('chats:set-workspace', { sessionId: value.id, workspaceRoot: nextWorkspace })).ok, true);
      assert.ok(databaseQuery("SELECT kind FROM transcript_entries WHERE conversation_id=? AND kind='background_event_retired'", value.id).length > 0);
      assert.equal((await invoke('chats:get', value.id)).workspaceBinding.workspaceRoot, nextWorkspace);
    } else { await invoke('chats:delete', value.id); assert.equal(await invoke('chats:get', value.id), null); }
    await waitFor(() => aborted.has(`${mutation}:background`), 'cancelled background model connection');
  });
  await check('Two Learn workspaces cannot run concurrently and the blocked conversation remains retryable', async () => {
    const a = await session('learn-a', 'learn'), b = await session('learn-b', 'learn');
    const ack = await run(a, 'learnA'); await waitFor(() => held.has('learnA'), 'first Learn run');
    await assert.rejects(run(b, 'learnB'), /LEARN_RUN_ACTIVE:/);
    assert.ok(!requests.some(request => request.name === 'learnB'), 'blocked Learn conversation must not enter provider or reconfigure the active vault');
    const blocked = (await invoke('chats:get', b.id)).messages;
    assert.ok(blocked.some(message => message.runSnapshot?.terminalStatus === 'runtime_error'
      && /另一个学习会话正在运行|Another learning conversation is running|別の学習会話が実行中/.test(JSON.stringify(message.processMessages))));
    held.get('learnA')(); await finishRun(ack); await finishRun(await run(b, 'learnB'));
  });
  await check('Graceful shutdown stops running shell processes before SQLite closes and preserves restart state', async () => {
    const value = await session('linger'); await finishRun(await run(value, 'linger'));
    await waitFor(() => existsSync(jobs.get('linger').pidFile), 'shutdown shell ready');
    const pid = Number(await readFile(jobs.get('linger').pidFile, 'utf8'));
    const continuing = await session('shutdown'); await finishRun(await run(continuing, 'shutdown'));
    await writeFile(jobs.get('shutdown').release, 'go'); await waitFor(() => held.has('shutdown:background'), 'shutdown background model request');
    await stop(); assert.throws(() => process.kill(pid, 0));
    await waitFor(() => aborted.has('shutdown:background'), 'shutdown cancelled background model connection');
    const rows = databaseQuery("SELECT record_json FROM shell_jobs WHERE json_extract(record_json,'$.command')=?", commands.linger);
    assert.equal(JSON.parse(rows[0].record_json).status, 'stopped');
    start(); await waitFor(() => ready, 'headless restart', 60_000);
    assert.ok((await invoke('chats:get', delivered.id)).messages.some(message => message.content?.includes('continued-deliver')));
    assert.ok(!logs.some(line => /SQLITE_MISUSE|database is closed|UnhandledPromiseRejection/.test(line)));
    await stop();
  });
  console.log(JSON.stringify({ ok: true, checks: results, dataDir: data }, null, 2));
} finally {
  for (const finish of held.values()) finish();
  if (child?.exitCode === null) { child.send({ type: 'shutdown' }); await Promise.race([childExit, delay(10_000)]); if (child.exitCode === null) child.kill(); }
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fixture closed')); }
  await new Promise(resolve => provider.close(resolve));
}
