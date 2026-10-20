// Run after pnpm run build:server. No remote providers or existing user data are used.
// Exercises the authenticated production Web → shared core → model → SQLite path.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createWebServer } = require('../../dist/server/server/index.js');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cyrene-compaction-'));
const results = [], requests = [], events = [], logs = [];
const model = 'session-summary-model';
const contextWindow = 4096;
const automaticModel = 'automatic-session-model';
const automaticContextWindow = 32768;
const markers = ['ORIGINAL_GOAL', 'TOOL_FACT', 'FINAL_CONSTRAINT'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let providerMode = 'success', transientFailures = 0;
let handle, socket, baseUrl, cookie = '', clientToken = '';

function estimateTextTokens(text) {
  let ascii = 0, nonAscii = 0;
  for (const character of text) character.charCodeAt(0) > 127 ? nonAscii++ : ascii++;
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const text = body.messages.map(message => typeof message.content === 'string'
      ? message.content : JSON.stringify(message.content)).join('\n');
    const item = { mode: providerMode, model: body.model, authorization: request.headers.authorization,
      kind: body.stream === true ? 'conversation' : 'summary',
      stream: body.stream, tokens: estimateTextTokens(text) + 4 * body.messages.length,
      toolTokens: (body.tools ?? []).reduce((sum, tool) => sum + estimateTextTokens((tool.function?.name ?? tool.name ?? '')
        + (tool.function?.description ?? tool.description ?? '') + JSON.stringify(tool.function?.parameters ?? tool.parameters ?? {})), 0),
      maxOutputTokens: body.max_completion_tokens ?? body.max_tokens, bytes: Buffer.byteLength(raw), text };
    requests.push(item);
    // A real provider rejects a request that exceeds its advertised context window.
    assert.ok([model, automaticModel].includes(item.model), 'must use the conversation model, not the global/profile default');
    assert.equal(item.authorization, 'Bearer fixture-compaction-key');
    assert.ok(!/data:image\/|BASE64_IMAGE_PAYLOAD/.test(text), 'binary image data must not enter summary text');
    const requestContextWindow = item.model === automaticModel ? automaticContextWindow : contextWindow;
    if (body.stream === true) {
      assert.equal(body.model, automaticModel);
      assert.ok(text.includes('cyrene_compaction_checkpoint'), 'normal model request must use the automatic checkpoint');
      assert.ok(!text.includes('Earlier confirmed project information.'), 'compacted history must not be replayed in full');
      assert.ok(item.tokens + item.toolTokens < requestContextWindow, 'normal model input including tool definitions must fit the window');
      const content = '自动压缩后继续回复：已保留已有数据和用户约束。';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: 'auto-reply', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      chunk({ role: 'assistant' }); chunk({ content }); chunk({}, 'stop');
      response.end(`data: ${JSON.stringify({ id: 'auto-reply', choices: [], usage: { prompt_tokens: item.tokens, completion_tokens: 20, total_tokens: item.tokens + 20 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    assert.ok(item.tokens < requestContextWindow, `summary input ${item.tokens} exceeds ${requestContextWindow}`);
    assert.ok(item.maxOutputTokens > 0, 'summary output/reasoning tokens must be bounded');
    assert.ok(item.tokens + item.maxOutputTokens <= requestContextWindow, 'input plus reserved output must fit the conversation model window');
    if (providerMode === 'unauthorized') {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture invalid API key' } }));
      return;
    }
    if (providerMode === 'retry-once' && transientFailures++ === 0) {
      response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture temporarily unavailable' } }));
      return;
    }
    const facts = markers.filter(marker => text.includes(marker));
    const content = providerMode === 'empty' ? '' : `会话摘要：${facts.join('、')}。文件 /storage/output.txt。保留用户约束，继续完成任务。`;
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      id: `summary-${requests.length}`, object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: item.tokens, completion_tokens: content ? 35 : 0, total_tokens: item.tokens + (content ? 35 : 0) },
    }));
  } catch (error) {
    logs.push(String(error.stack));
    if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});

function sourceEntries(long) {
  const entries = [];
  const append = (kind, payload, fields = {}) => {
    const seq = entries.length + 1;
    entries.push({ id: `fixture-${seq}`, seq, at: seq, kind, ...fields, payload });
  };
  append('user', { text: `ORIGINAL_GOAL: 继续已有项目。${long ? 'Earlier confirmed project information. '.repeat(2200) : 'Confirmed project information. '.repeat(50)}` }, { turnId: 'first-user', revision: 1 });
  append('assistant', {
    role: 'assistant', content: long
      ? [{ type: 'text', text: '先检查已有文件。' }, { type: 'image_url', image_url: { url: `data:image/png;base64,BASE64_IMAGE_PAYLOAD${'A'.repeat(180000)}` } }]
      : '先检查已有文件。',
    toolCalls: [{ id: 'read-proof', name: 'read_file', arguments: JSON.stringify({ path: '/storage/output.txt' }) }],
  }, { turnId: 'first-assistant' });
  append('tool_result', { assistantEntryId: 'fixture-2', toolCallId: 'read-proof', outcome: 'success',
    message: { role: 'tool', toolCallId: 'read-proof', name: 'read_file', content: 'TOOL_FACT: 文件已经存在且校验成功。' } });
  append('assistant', { role: 'assistant', content: '文件检查通过。' }, { turnId: 'first-assistant' });
  append('user', { text: 'FINAL_CONSTRAINT: 必须保留 /storage/output.txt 中的用户数据。' }, { turnId: 'last-user', revision: 1 });
  append('assistant', { role: 'assistant', content: '最近一条回复：会保留已有数据。' }, { turnId: 'last-assistant' });
  return entries;
}

async function seedSession(id, long = false, automatic = false) {
  const session = { schemaVersion: 1, id, title: id, mode: automatic ? 'work' : 'chat', createdAt: 1, updatedAt: 2,
    modelProfileId: 'session-profile', model: automatic ? automaticModel : model, messages: [] };
  const sessionDirectory = path.join(dataDir, 'cyrene-chats', 'sessions');
  const transcriptDirectory = path.join(dataDir, 'transcripts', id);
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(path.join(sessionDirectory, `${id}.json`), JSON.stringify(session));
  const entries = sourceEntries(long);
  // Keep messages alone below the entry budget; Work prompt/tools must trigger Harness mid-loop compaction.
  if (automatic) entries[1].payload.content = '先检查已有文件。';
  await writeFile(path.join(transcriptDirectory, 'transcript.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

async function http(route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await response.text();
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  return { response, value };
}

async function invoke(channel, ...args) {
  const { response, value } = await http('/api/core/invoke', { channel, args }, { 'X-Cyrene-Client': clientToken });
  assert.equal(response.status, 200, `${channel}: ${JSON.stringify(value)}`);
  return value;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(30);
  }
}

async function launch(firstStart = false) {
  handle = createWebServer({ dataDir, secureCookies: false, setupToken: 'fixture-compaction-setup', sharedCore: true,
    logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) } });
  await new Promise(resolve => handle.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
  cookie = ''; clientToken = '';
  const credentials = { username: 'compaction-fixture', password: 'local-fixture-password' };
  if (firstStart) assert.equal((await http('/api/auth/bootstrap', credentials, { 'X-Cyrene-Setup-Token': 'fixture-compaction-setup' })).response.status, 201);
  const login = await http('/api/auth/login', credentials);
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  socket.on('message', raw => {
    const event = JSON.parse(String(raw));
    if (event.type === 'ready') clientToken = event.clientToken;
    if (event.type === 'CORE_EVENT') events.push(event);
  });
  await waitFor(() => clientToken, 'authenticated WebSocket');
  await handle.startChannels();
}

function databaseSnapshot(sessionId) {
  const database = new DatabaseSync(path.join(dataDir, 'cyrene.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT archived_through, max_seq FROM conversations WHERE id=?').get(sessionId);
    const entries = database.prepare('SELECT entry_json FROM transcript_entries WHERE conversation_id=? ORDER BY seq').all(sessionId).map(entry => JSON.parse(entry.entry_json));
    return { ...row, entries, checkpoints: entries.filter(entry => entry.kind === 'compaction_checkpoint') };
  } finally { database.close(); }
}

async function check(name, action) {
  const start = Date.now();
  await action();
  results.push({ name, ok: true, ms: Date.now() - start });
  console.log('PASS', name);
}

try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await writeFile(path.join(dataDir, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], settings: {
    general: { proactiveChatMode: 'off', chatToolsEnabled: false }, config: { memoryMode: 'off', runtimeSync: 'off' },
    modelProfiles: [
      { id: 'global-profile', provider: 'ChatGPT（OpenAI）', displayName: 'Must not use global profile', apiKey: 'wrong-global-key', baseUrl: providerUrl, explicitTransport: 'openai', model: 'global-default', models: ['global-default'] },
      { id: 'session-profile', provider: 'ChatGPT（OpenAI）', displayName: 'Conversation summary fixture', apiKey: 'fixture-compaction-key', baseUrl: providerUrl, explicitTransport: 'openai', model: 'profile-default', models: ['profile-default', model, automaticModel],
        contextWindowTokens: 256000, modelOptions: { [model]: { contextWindowTokens: contextWindow, multimodal: true }, [automaticModel]: { contextWindowTokens: automaticContextWindow } } },
    ], defaultModelProfileId: 'global-profile',
  } }));
  for (const id of ['long-success', 'auth-failure', 'empty-failure', 'transient-retry']) await seedSession(id, id === 'long-success');
  await seedSession('automatic-run', true, true);
  await launch(true);

  await check('Production Web core registers the manual transcript compaction handler', async () => {
    const { value } = await http('/api/core/capabilities', {}, { 'X-Cyrene-Client': clientToken });
    assert.equal(value.engine, 'shared-windows-core');
    assert.ok(value.handlers.includes('chats:compact'));
  });

  let projectedHistory;
  await check('Long multimodal/tool history compacts in bounded requests using the session profile and model', async () => {
    const before = await invoke('chats:get', 'long-success');
    assert.ok(before.messages.some(message => message.content.includes('ORIGINAL_GOAL')));
    const result = await invoke('chats:compact', { sessionId: 'long-success', retainTokens: 1 });
    assert.equal(result.ok, true, JSON.stringify(result));
    await waitFor(() => events.some(event => event.channel === 'chats:compaction-phase' && event.args[0]?.sessionId === 'long-success' && event.args[0]?.phase === 'finished'), 'compaction lifecycle broadcast');
    assert.ok(events.some(event => event.channel === 'chats:compaction-phase' && event.args[0]?.sessionId === 'long-success' && event.args[0]?.phase === 'running'));
    assert.ok(requests.length > 1, 'a single overlong message must be split before provider invocation');
    assert.ok(requests.some(request => request.text.includes('TOOL_FACT')), 'tool results must be retained');
    assert.ok(requests.some(request => request.text.includes('read_file')), 'tool identity must be retained');
    assert.ok(result.compactedMessages[0].content.includes('FINAL_CONSTRAINT'), 'final merge must retain the last historical constraint');
    assert.ok(!JSON.stringify(result.compactedMessages).includes('Earlier confirmed project information.'));
    const snapshot = databaseSnapshot('long-success');
    assert.equal(snapshot.checkpoints.length, 1);
    assert.ok(snapshot.archived_through > 0);
    assert.equal(snapshot.checkpoints[0].payload.trigger, 'manual');
    projectedHistory = await invoke('chats:get', 'long-success');
    assert.ok(projectedHistory.messages.some(message => message.compaction?.trigger === 'manual'));
    for (const original of before.messages) assert.ok(projectedHistory.messages.some(message => message.id === original.id && message.content === original.content), `historical message ${original.id} lost`);
    assert.equal(projectedHistory.currentContextUsage.contextWindowTokens, contextWindow);
    assert.ok(projectedHistory.currentContextUsage.totalTokens > 0);
  });

  for (const [id, mode] of [['auth-failure', 'unauthorized'], ['empty-failure', 'empty']]) {
    await check(`${mode} summary failure preserves transcript and never commits an invalid checkpoint`, async () => {
      const before = await invoke('chats:get', id), snapshot = databaseSnapshot(id), start = requests.length;
      providerMode = mode;
      const result = await invoke('chats:compact', { sessionId: id, retainTokens: 1 });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'TRANSCRIPT_COMPACTION_REQUIRED');
      assert.match(result.detail, mode === 'unauthorized' ? /认证|权限/ : /有效.*摘要/);
      assert.ok(!result.detail.includes('fixture invalid API key') && !result.detail.includes('fixture-compaction-key'), 'UI diagnostics must not expose provider text or credentials');
      assert.deepEqual(databaseSnapshot(id), snapshot, 'failed compaction must not change canonical transcript/archive state');
      assert.deepEqual((await invoke('chats:get', id)).messages, before.messages);
      if (mode === 'unauthorized') assert.equal(requests.length - start, 1, 'permanent authentication errors must not be retried');
    });
  }

  await check('A transient provider failure retries successfully before committing one checkpoint', async () => {
    providerMode = 'retry-once'; transientFailures = 0;
    const result = await invoke('chats:compact', { sessionId: 'transient-retry', retainTokens: 1 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(transientFailures >= 2);
    assert.equal(databaseSnapshot('transient-retry').checkpoints.length, 1);
  });

  await check('Real AGUI Work run compacts inside Harness and continues to a successful streamed reply', async () => {
    providerMode = 'success';
    const start = events.length, logStart = logs.length, requestStart = requests.length;
    const before = await invoke('chats:get', 'automatic-run');
    const ack = await invoke('agui:run', { sessionId: 'automatic-run',
      currentUser: { turnId: randomUUID(), text: '继续已有任务，确认之前的文件约束即可。', visibleContent: '继续已有任务，确认之前的文件约束即可。' }, assistantTurnId: randomUUID(), styleId: 'default' });
    assert.equal(ack.success, true, JSON.stringify(ack));
    await waitFor(() => events.slice(start).some(event => event.channel === 'agui:event' && event.args[0]?.runId === ack.runId && ['RUN_FINISHED', 'RUN_ERROR'].includes(event.args[0]?.type)), 'automatic compaction run terminal');
    const runEvents = events.slice(start).filter(event => event.channel === 'agui:event' && event.args[0]?.runId === ack.runId).map(event => event.args[0]);
    assert.equal(runEvents.find(event => event.type === 'RUN_ERROR'), undefined, JSON.stringify(runEvents));
    assert.equal(runEvents.find(event => event.type === 'RUN_FINISHED')?.result?.status, 'success', JSON.stringify(runEvents));
    assert.ok(runEvents.some(event => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta?.includes('自动压缩后继续回复')), 'final reply must be delivered through the real AGUI stream');
    assert.ok(logs.slice(logStart).some(line => String(line).includes('mid-loop compaction triggered')), 'must exercise Harness compaction, not only entry pre-compaction');
    assert.ok(requests.slice(requestStart).some(request => request.kind === 'summary'));
    assert.ok(requests.slice(requestStart).some(request => request.kind === 'conversation'));
    const phases = events.slice(start).filter(event => event.channel === 'chats:compaction-phase' && event.args[0]?.sessionId === 'automatic-run').map(event => event.args[0]);
    for (const phase of ['running', 'finished']) {
      const event = phases.find(event => event.phase === phase);
      assert.ok(event, `missing ${phase} lifecycle event`);
      assert.equal(event.contextUsage?.contextWindowTokens, automaticContextWindow);
      assert.ok(event.contextUsage.totalTokens > 0);
    }
    assert.ok(phases.find(event => event.phase === 'finished').contextUsage.totalTokens
      < phases.find(event => event.phase === 'running').contextUsage.totalTokens, 'finished usage must reflect the smaller compacted history');
    const snapshot = databaseSnapshot('automatic-run');
    assert.equal(snapshot.checkpoints.length, 1);
    assert.equal(snapshot.checkpoints[0].payload.trigger, 'automatic');
    const after = await invoke('chats:get', 'automatic-run');
    assert.ok(after.messages.some(message => message.compaction?.trigger === 'automatic'));
    for (const original of before.messages) assert.ok(after.messages.some(message => message.id === original.id && message.content === original.content), `automatic compaction lost historical message ${original.id}`);
    assert.ok(after.messages.some(message => message.content.includes('自动压缩后继续回复')));
  });

  await check('Restart retains checkpoint, archived history and current context usage', async () => {
    const snapshot = databaseSnapshot('long-success');
    const automaticSnapshot = databaseSnapshot('automatic-run');
    const automaticHistory = await invoke('chats:get', 'automatic-run');
    socket.close(); await handle.close(); socket = undefined; handle = undefined;
    await launch();
    assert.deepEqual(databaseSnapshot('long-success'), snapshot);
    const after = await invoke('chats:get', 'long-success');
    assert.deepEqual(after.messages, projectedHistory.messages);
    assert.deepEqual(after.currentContextUsage, projectedHistory.currentContextUsage);
    assert.deepEqual(databaseSnapshot('automatic-run'), automaticSnapshot);
    const automaticAfter = await invoke('chats:get', 'automatic-run');
    assert.deepEqual(automaticAfter.messages, automaticHistory.messages);
    assert.deepEqual(automaticAfter.currentContextUsage, automaticHistory.currentContextUsage);
  });

  const report = { at: new Date().toISOString(), dataDir, results, requests: requests.map(({ authorization, text, ...request }) => ({ ...request,
    markers: markers.filter(marker => text.includes(marker)) })) };
  await writeFile(path.join(dataDir, 'verification-results.json'), JSON.stringify(report, null, 2));
  console.log(`ALL PASSED ${results.length} checks; isolated evidence: ${path.join(dataDir, 'verification-results.json')}`);
} catch (error) {
  console.error('FAIL', error);
  console.error('Recent core logs:', logs.slice(-12).join('\n'));
  console.error('Isolated data:', dataDir);
  process.exitCode = 1;
} finally {
  socket?.close();
  try { if (handle) await handle.close(); }
  finally { await new Promise(resolve => provider.close(resolve)); }
}
