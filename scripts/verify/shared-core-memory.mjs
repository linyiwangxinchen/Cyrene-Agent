// Run after pnpm run build:server. Uses a local fixture and isolated temporary data.
// The production Web host forks a real headless core: an unhandled rejection must
// fail the authenticated IPC checks, even when the HTTP health check stays alive.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createWebServer } = require('../../dist/server/server/index.js');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cyrene-memory-'));
const sessionId = 'wiki-backfill-fixture';
const model = 'gpt-6.1-sol';
const userText = '请记住，我喜欢在清晨读书。';
const previousNodeOptions = process.env.NODE_OPTIONS;
// Do not let an inherited warning-only policy hide a rejected background tail.
process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --unhandled-rejections=strict`.trim();
const results = [], logs = [], requests = [];
let mode = 'unauthorized', handle, socket, baseUrl, cookie = '', clientToken = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Bound the acceptance run even if the child process dies with an unresolved IPC.
const watchdog = setTimeout(() => { console.error('FAIL memory acceptance exceeded 30 seconds'); process.exit(1); }, 30_000);

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ mode, path: request.url, stream: body.stream, model: body.model });
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer local-memory-fixture-key');
    assert.equal(body.model, model, 'memory backfill must resolve the configured default model profile');
    if (mode === 'unauthorized') {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture authentication failure', code: 'invalid_api_key' } }));
      return;
    }
    if (body.stream !== true) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture relay requires stream:true' } }));
      return;
    }
    assert.ok(body.max_output_tokens > 0, 'memory output tokens must remain bounded');
    const source = strings(body.input).map(text => { try { return JSON.parse(text); } catch { return null; } })
      .find(value => value?.conversationId === sessionId && Array.isArray(value.messages));
    assert.ok(source, 'memory extraction must receive the original canonical conversation');
    const user = source.messages.find(message => message.role === 'user');
    assert.equal(user.text, userText);
    const text = JSON.stringify({ candidates: [{ sourceId: user.sourceId, subject: '用户本人', predicate: '阅读偏好', value: '喜欢在清晨读书',
      scope: 'global', statementKind: 'assertion', pageType: 'self', tags: ['chat'], aliases: [], validFrom: '', validTo: '', evidenceQuote: '我喜欢在清晨读书' }] });
    const item = { id: 'msg_memory', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const terminal = { id: 'resp_memory', model, created_at: 1, status: 'completed', output: [item],
      usage: { input_tokens: 100, output_tokens: 70, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event('response.created', { response: { id: terminal.id, model, created_at: 1 } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: terminal });
    response.end();
  } catch (error) {
    logs.push(`Fixture error: ${error.stack}`);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'fixture assertion failed' } }));
  }
});

async function http(route, body, headers = {}) {
  const response = await fetch(baseUrl + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const raw = await response.text();
  let value; try { value = JSON.parse(raw); } catch { value = raw; }
  return { response, value };
}

async function invoke(channel, ...args) {
  const { response, value } = await http('/api/core/invoke', { channel, args }, { 'X-Cyrene-Client': clientToken });
  assert.equal(response.status, 200, `${channel}: ${JSON.stringify(value)}`);
  return value;
}

async function waitFor(predicate, label) {
  const end = Date.now() + 7000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(30);
  }
}

async function launch(first = false) {
  handle = createWebServer({ dataDir, secureCookies: false, setupToken: 'fixture-memory-setup', sharedCore: true,
    logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) } });
  await new Promise(resolve => handle.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
  cookie = ''; clientToken = '';
  const credentials = { username: 'memory-fixture', password: 'local-memory-fixture-password' };
  if (first) assert.equal((await http('/api/auth/bootstrap', credentials, { 'X-Cyrene-Setup-Token': 'fixture-memory-setup' })).response.status, 201);
  const login = await http('/api/auth/login', credentials);
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  socket.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'ready') clientToken = event.clientToken; });
  await waitFor(() => clientToken, 'authenticated WebSocket');
  await handle.startChannels();
}

async function close() {
  socket?.close(); socket = undefined;
  const current = handle; handle = undefined;
  if (current) await current.close();
}

function progress() {
  const database = new DatabaseSync(path.join(dataDir, 'memory', 'wiki', 'wiki.sqlite'), { readOnly: true });
  try { return database.prepare('SELECT through_seq FROM progress WHERE conversation_id=?').get(sessionId)?.through_seq ?? 0; }
  finally { database.close(); }
}

function transcript() {
  const database = new DatabaseSync(path.join(dataDir, 'cyrene.sqlite'), { readOnly: true });
  try { return database.prepare('SELECT seq,entry_json FROM transcript_entries WHERE conversation_id=? ORDER BY seq').all(sessionId); }
  finally { database.close(); }
}

async function check(name, run) {
  const start = Date.now(); await run(); results.push({ name, ok: true, ms: Date.now() - start }); console.log('PASS', name);
}

try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await mkdir(path.join(dataDir, 'cyrene-chats', 'sessions'), { recursive: true });
  await mkdir(path.join(dataDir, 'transcripts', sessionId), { recursive: true });
  await writeFile(path.join(dataDir, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], settings: {
    general: { proactiveChatMode: 'off', chatToolsEnabled: false }, config: { memoryMode: 'wiki', runtimeSync: 'off' },
    modelProfiles: [{ id: 'memory-profile', provider: 'ChatGPT（OpenAI）', displayName: 'Local memory acceptance',
      apiKey: 'local-memory-fixture-key', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, explicitTransport: 'responses', model, models: [model] }], defaultModelProfileId: 'memory-profile',
  } }));
  await writeFile(path.join(dataDir, 'cyrene-chats', 'sessions', `${sessionId}.json`), JSON.stringify({ schemaVersion: 1, id: sessionId, title: 'Wiki background failure acceptance',
    mode: 'chat', createdAt: 1, updatedAt: 2, modelProfileId: 'memory-profile', model, messages: [] }));
  const entries = [
    { id: 'memory-user', seq: 1, at: 1000, kind: 'user', turnId: 'memory-user-turn', revision: 1, payload: { text: userText } },
    { id: 'memory-assistant', seq: 2, at: 2000, kind: 'assistant', turnId: 'memory-assistant-turn', payload: { role: 'assistant', content: '记住啦，你喜欢在清晨读书。' } },
  ];
  await writeFile(path.join(dataDir, 'transcripts', sessionId, 'transcript.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

  await launch(true);
  // Opening the seeded v1 session performs its canonical SQLite migration.
  await invoke('chats:get', sessionId);
  const originalTranscript = transcript();
  assert.equal(originalTranscript.length, 2);
  await check('Wiki startup request failure leaves both HTTP and the real authenticated shared core usable', async () => {
    await waitFor(() => requests.length > 0 && logs.some(line => String(line).includes('[WikiMemory]')), 'Wiki startup backfill failure');
    await delay(250); // Allow detached rejection cleanup and the child exit event to run.
    assert.equal((await http('/healthz')).response.status, 200);
    const session = await invoke('chats:get', sessionId);
    assert.ok(session.messages.some(message => message.content === userText));
    const pages = await invoke('memory-wiki:list-pages', {});
    assert.equal(pages.total, 0);
    assert.equal(progress(), 0, 'a failed extraction must remain eligible for retry');
    assert.deepEqual(transcript(), originalTranscript, 'background failure must not mutate canonical chat history');
    assert.equal(requests.length, 1, 'permanent authentication failure must not trigger a retry loop');
  });

  await check('Restart recovers the pending Wiki batch through a stream-only Responses relay and records source-grounded knowledge', async () => {
    await close(); mode = 'success'; await launch();
    await waitFor(() => progress() === 2, 'successful background extraction after restart');
    const pages = await invoke('memory-wiki:list-pages', {});
    assert.equal(pages.total, 1);
    const page = await invoke('memory-wiki:read-page', 'global/self');
    assert.equal(page.claims.length, 1);
    assert.equal(page.claims[0].value, '喜欢在清晨读书');
    assert.equal(page.claims[0].sources[0].conversationId, sessionId);
    assert.equal(page.claims[0].sources[0].entryId, 'memory-user');
    assert.ok(requests.filter(request => request.mode === 'success').every(request => request.stream === true));
    assert.deepEqual(transcript(), originalTranscript);
    assert.equal((await http('/healthz')).response.status, 200);
  });

  await check('Processed Wiki progress and original chat survive another restart without extracting the same batch again', async () => {
    await close(); const count = requests.length; await launch();
    await delay(2300); // Wait beyond the two-second startup backfill delay.
    assert.equal(requests.length, count);
    assert.equal(progress(), 2);
    assert.equal((await invoke('memory-wiki:list-pages', {})).total, 1);
    assert.deepEqual(transcript(), originalTranscript);
    assert.ok((await invoke('chats:get', sessionId)).messages.some(message => message.content === userText));
    assert.ok(!logs.some(line => String(line).includes('Fixture error:')), 'fixture assertions must all pass');
  });
  const report = path.join(dataDir, 'verification-results.json');
  await writeFile(report, JSON.stringify({ at: new Date().toISOString(), results, requests }, null, 2));
  console.log(`ALL PASSED ${results.length} checks; isolated evidence: ${report}`);
} catch (error) {
  console.error('FAIL', error); console.error('Recent isolated core logs:', logs.slice(-16).join('\n'));
  console.error('Isolated data:', dataDir); process.exitCode = 1;
} finally {
  try { await close(); } finally {
    await new Promise(resolve => provider.close(resolve)); clearTimeout(watchdog);
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
}
