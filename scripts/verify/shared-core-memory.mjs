// Run after pnpm run build:server. Uses a local fixture and isolated temporary data.
// The production Web host forks a real headless core: an unhandled rejection must
// fail the authenticated IPC checks, even when the HTTP health check stays alive.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { responseBody, streamEvents } from '../../src/main/orchestrator/vendors/sdk-stream/model-fixtures.ts';

const require = createRequire(import.meta.url);
const { createWebServer } = require('../../dist/server/server/index.js');
const { CURRENT_DISCLAIMER_VERSION } = require('../../dist/server/shared/disclaimer.js');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cyrene-memory-'));
const sessionId = 'wiki-backfill-fixture';
const model = 'gpt-6.1-sol';
const userText = '请记住，我喜欢在清晨读书。';
const vectorTurns = [
  '平时请叫我小屿。',
  '我这段时间在制作夜景摄影集。',
  '傍晚去了河边散步。',
  '天黑后桥上的灯亮起来了。',
  '我找到了一个视野开阔的位置。',
  '上周我在河边拍到了第一张星轨照片。',
];
const vectorReply = '听起来挺有意思，愿意多聊聊吗？';
const vectorCandidates = [
  { layer: 'L0', field: 'preferredName', content: '小屿', evidenceIndex: 0 },
  { layer: 'L1', field: 'currentProject', content: '制作夜景摄影集', evidenceIndex: 1 },
  { layer: 'L2', slug: '河边拍星轨', content: '用户在河边拍到了第一张星轨照片', evidenceIndex: 5 },
];
const previousNodeOptions = process.env.NODE_OPTIONS;
// Do not let an inherited warning-only policy hide a rejected background tail.
process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --unhandled-rejections=strict`.trim();
const results = [], logs = [], requests = [], ignoredRequests = [], aguiEvents = [], vectorRequests = [];
let mode = 'unauthorized', handle, socket, baseUrl, cookie = '', clientToken = '';
let vectorDataDir, vectorSessionId;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Bound the acceptance run even if the child process dies with an unresolved IPC.
const watchdog = setTimeout(() => { console.error('FAIL memory acceptance exceeded 45 seconds'); process.exit(1); }, 45_000);

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

function respondVector(request, response, body) {
  const prompt = strings([body.instructions, body.input, body.messages]).join('\n');
  let text = vectorReply;
  if (prompt.includes('保守的记忆候选提取器')) {
    assert.equal(request.url, '/v1/responses');
    assert.equal(body.model, model);
    assert.ok(vectorSessionId && prompt.includes(`conversationId: ${vectorSessionId}`));
    assert.deepEqual(Array.from(prompt.matchAll(/^用户：(.+)$/gm), match => match[1]), vectorTurns);
    assert.deepEqual(Array.from(prompt.matchAll(/^AI：(.+)$/gm), match => match[1]), vectorTurns.map(() => vectorReply));
    vectorRequests.push({ kind: 'judge', path: request.url, stream: body.stream });
    text = JSON.stringify({
      candidates: vectorCandidates.map(({ evidenceIndex, ...candidate }) => ({
        ...candidate,
        ...(candidate.layer === 'L2' && { sourceQuote: vectorTurns[evidenceIndex] }),
        summary: candidate.content,
        confidence: 0.99,
        triggerText: vectorTurns[evidenceIndex],
        certainty: 'explicit',
        attribution: 'user_explicit',
        evidenceQuotes: [vectorTurns[evidenceIndex]],
        shouldWrite: true,
      })),
      entities: [],
    });
  } else if (prompt.includes('保守的聊天连续性信息提取器')) {
    text = JSON.stringify({ operations: [] });
  }
  const transport = request.url === '/v1/responses' ? 'responses' : 'openai';
  if (!body.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody(transport, { text })));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of streamEvents(transport, { text })) {
    response.write(`event: ${event.type ?? 'data'}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (mode === 'vector') {
      respondVector(request, response, body);
      return;
    }
    const requestItem = { mode, path: request.url, stream: body.stream, model: body.model };
    // Runtime startup may also probe the configured model for Amphoreus. That
    // request is unrelated to Wiki backfill and must not count as a memory
    // retry in this acceptance fixture.
    if (!JSON.stringify(body.input ?? '').includes(sessionId)) {
      ignoredRequests.push(requestItem);
      response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'non-memory fixture request ignored' } }));
      return;
    }
    requests.push(requestItem);
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

async function launch(first = false, root = dataDir) {
  handle = createWebServer({ dataDir: root, secureCookies: false, setupToken: 'fixture-memory-setup', sharedCore: true,
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
  socket.on('message', raw => {
    const event = JSON.parse(String(raw));
    if (event.type === 'ready') clientToken = event.clientToken;
    if (event.type === 'CORE_EVENT' && event.channel === 'agui:event') aguiEvents.push(event.args[0]);
  });
  await waitFor(() => clientToken, 'authenticated WebSocket');
  await handle.startChannels();
}

async function close() {
  socket?.close(); socket = undefined;
  const current = handle; handle = undefined;
  if (current) await current.close();
}

function isSqliteBusy(error) {
  return error && typeof error === 'object' && (
    error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED'
    || (typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 0xff))
  );
}

function progress({ poll = false, databasePath = path.join(dataDir, 'memory', 'wiki', 'wiki.sqlite') } = {}) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec('PRAGMA busy_timeout=50');
    return database.prepare('SELECT through_seq FROM progress WHERE conversation_id=?').get(sessionId)?.through_seq ?? 0;
  } catch (error) {
    // Wiki uses DELETE journaling: a legitimate startup writer can briefly hold
    // the database lock. Only a polling observer treats that as not ready yet.
    if (poll && isSqliteBusy(error)) return undefined;
    throw error;
  } finally { database?.close(); }
}

function transcript() {
  const database = new DatabaseSync(path.join(dataDir, 'cyrene.sqlite'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=100');
    return database.prepare('SELECT seq,entry_json FROM transcript_entries WHERE conversation_id=? ORDER BY seq').all(sessionId);
  }
  finally { database.close(); }
}

async function check(name, run) {
  const start = Date.now(); await run(); results.push({ name, ok: true, ms: Date.now() - start }); console.log('PASS', name);
}

function fixtureSettings(memoryMode, general) {
  return { version: 1, sessions: [], settings: {
    general: { proactiveChatMode: 'off', chatToolsEnabled: false, disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION, ...general },
    config: { memoryMode, runtimeSync: 'off' },
    modelProfiles: [{ id: 'memory-profile', provider: 'ChatGPT（OpenAI）', displayName: 'Local memory acceptance',
      apiKey: 'local-memory-fixture-key', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, explicitTransport: 'responses', model, models: [model] }],
    defaultModelProfileId: 'memory-profile',
  } };
}

async function verifyVectorMemory() {
  await close();
  mode = 'vector';
  vectorDataDir = await mkdtemp(path.join(os.tmpdir(), 'cyrene-vector-memory-'));
  await writeFile(path.join(vectorDataDir, 'web-data.json'), JSON.stringify(fixtureSettings('vector', { chatSocialContextEnabled: true })));
  await launch(true, vectorDataDir);
  assert.equal((await invoke('settings:get-general')).chatSocialContextEnabled, true);
  const session = await invoke('chats:create', { mode: 'chat', title: 'Vector memory acceptance' });
  vectorSessionId = session.id;
  const turnIds = [];
  for (const text of vectorTurns) {
    const turnId = randomUUID();
    turnIds.push(turnId);
    const run = await invoke('agui:run', {
      sessionId: session.id, styleId: 'default',
      currentUser: { turnId, text, visibleContent: text },
      assistantTurnId: randomUUID(),
    });
    assert.ok(run.success, JSON.stringify(run));
    const terminal = () => aguiEvents.find(event => event.runId === run.runId && ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type));
    await waitFor(terminal, `finished vector-memory chat turn ${turnIds.length}`);
    assert.equal(terminal().type, 'RUN_FINISHED', JSON.stringify(terminal()));
    assert.equal(terminal().result?.status, 'success', JSON.stringify(terminal()));
  }
  const memoryPath = path.join(vectorDataDir, 'memory.json');
  async function readMemory() {
    try { return JSON.parse(await readFile(memoryPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  await waitFor(async () => {
    const memory = await readMemory();
    return memory?.l1.roundCount === vectorTurns.length
      && memory.l2.some(entry => ['synced', 'sync_failed'].includes(entry.syncStatus));
  }, 'vector judge persisted L2 and finalized the sixth turn');
  const memory = await readMemory();
  assert.equal(memory.l0.preferredName, '小屿');
  assert.equal(memory.l1.currentProject, '制作夜景摄影集');
  assert.equal(memory.l1.roundCount, vectorTurns.length);
  const entry = memory.l2.find(item => item.slug === '河边拍星轨');
  assert.equal(entry?.sourceQuote, vectorTurns[5]);
  assert.equal(entry?.sourceConversationId, session.id);
  assert.deepEqual(entry?.sourceMessageIds, [`user:v1:${turnIds[5]}:r1`]);
  assert.deepEqual(memory.profileSources['L0.preferredName'].sources, [{ conversationId: session.id, messageId: `user:v1:${turnIds[0]}:r1` }]);
  assert.deepEqual(memory.profileSources['L1.currentProject'].sources, [{ conversationId: session.id, messageId: `user:v1:${turnIds[1]}:r1` }]);
  assert.equal(vectorRequests.length, 1);
  assert.ok(!logs.some(line => String(line).includes('Fixture error:')), 'fixture assertions must all pass');
  console.log(`Vector store: L2 ${entry.syncStatus}; isolated memory: ${memoryPath}`);
}

try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await mkdir(path.join(dataDir, 'cyrene-chats', 'sessions'), { recursive: true });
  await mkdir(path.join(dataDir, 'transcripts', sessionId), { recursive: true });
  await writeFile(path.join(dataDir, 'web-data.json'), JSON.stringify(fixtureSettings('wiki')));
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

  await check('Wiki progress observer retries a real temporary SQLite lock without hiding non-lock failures', async () => {
    const writer = new DatabaseSync(path.join(dataDir, 'memory', 'wiki', 'wiki.sqlite'));
    let locked = false, releaseTimer;
    try {
      writer.exec('PRAGMA busy_timeout=100; BEGIN EXCLUSIVE'); locked = true;
      assert.equal(progress({ poll: true }), undefined, 'an exclusively locked progress database is not ready');
      assert.throws(() => progress(), isSqliteBusy, 'non-polling reads must report contention');
      releaseTimer = setTimeout(() => { writer.exec('ROLLBACK'); locked = false; }, 100);
      await waitFor(() => progress({ poll: true }) === 0, 'progress read recovers after the writer releases its lock');
      assert.equal(locked, false);
      const invalidDatabase = path.join(dataDir, 'invalid-observer.sqlite');
      await writeFile(invalidDatabase, 'This fixture is deliberately not a SQLite database.');
      assert.throws(() => progress({ poll: true, databasePath: invalidDatabase }), error => error?.errcode === 26,
        'polling must still reject a corrupt/non-database file');
    } finally { clearTimeout(releaseTimer); if (locked) writer.exec('ROLLBACK'); writer.close(); }
  });

  await check('Restart recovers the pending Wiki batch through a stream-only Responses relay and records source-grounded knowledge', async () => {
    await close(); mode = 'success'; await launch();
    await waitFor(() => progress({ poll: true }) === 2, 'successful background extraction after restart');
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
  await check('Six successful Web Chat turns persist source-backed L0/L1/L2 with social context enabled', verifyVectorMemory);
  const report = path.join(dataDir, 'verification-results.json');
  await writeFile(report, JSON.stringify({ at: new Date().toISOString(), results, requests, ignoredRequests, vectorRequests, vectorDataDir }, null, 2));
  console.log(`ALL PASSED ${results.length} checks; isolated evidence: ${report}`);
} catch (error) {
  console.error('FAIL', error); console.error('Recent isolated core logs:', logs.slice(-16).join('\n'));
  console.error('Isolated data:', dataDir, vectorDataDir ?? ''); process.exitCode = 1;
} finally {
  try { await close(); } finally {
    await new Promise(resolve => provider.close(resolve)); clearTimeout(watchdog);
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
}
