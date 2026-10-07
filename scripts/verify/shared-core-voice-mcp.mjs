// Production Web/core with local HTTP audio/model fixtures and real MCP SDK transports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
const require = createRequire(import.meta.url);
const { z } = createRequire(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"))("zod");
const { createWebServer } = require('../../dist/server/server/index.js');
const serve = process.argv.includes('--serve');
const data = await mkdtemp(path.join(os.tmpdir(), 'cyrene-voice-mcp-'));
const workspace = path.join(data, 'workspace'); await mkdir(workspace);
const pcm = Buffer.alloc(32_000); for (let i = 0; i < 16_000; i++) pcm.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / 16000) * 4000, i * 2);
const wav = Buffer.alloc(44 + pcm.length); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
await writeFile(path.join(workspace, 'audio-test.wav'), wav);
const results = [], events = [], logs = [], modelRequests = [], ttsRequests = [], asrRequests = [], mcpCalls = [];
const sseTransports = new Map(), mcpInstances = new Set();
function makeMcp() {
  const mcp = new McpServer({ name: 'Cyrene acceptance', version: '1.0.0' });
  mcp.registerTool('echo', { description: 'Echo a test value', inputSchema: { value: z.string() }, annotations: { readOnlyHint: true } }, async ({ value }) => { mcpCalls.push(value); return { content: [{ type: 'text', text: `MCP_EXECUTED:${value}` }] }; });
  mcp.registerTool('unknown', { description: 'Unknown effect, must remain guarded', inputSchema: {} }, async () => { mcpCalls.push('UNSAFE_EXECUTED'); return { content: [{ type: 'text', text: 'unexpected' }] }; });
  mcpInstances.add(mcp); return mcp;
}
const fixture = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/messages') {
      if (req.headers.authorization !== 'Bearer fixture-mcp') { res.writeHead(401).end(); return; }
      if (url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res); sseTransports.set(transport.sessionId, transport);
        res.on('close', () => sseTransports.delete(transport.sessionId)); await makeMcp().connect(transport); return;
      }
      if (url.pathname === '/messages') { const transport = sseTransports.get(url.searchParams.get('sessionId')); if (!transport) { res.writeHead(404).end(); return; } await transport.handlePostMessage(req, res); return; }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = makeMcp(); await mcp.connect(transport); res.on('close', () => { void transport.close(); void mcp.close(); mcpInstances.delete(mcp); });
      await transport.handleRequest(req, res); return;
    }
    let raw = Buffer.alloc(0); for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    if (url.pathname === '/asr' || url.pathname === '/asr-error') {
      assert.equal(req.headers.authorization, 'Bearer fixture-asr');
      const offset = raw.indexOf(Buffer.from('RIFF')); assert.ok(offset >= 0);
      assert.equal(raw.toString('ascii', offset + 8, offset + 12), 'WAVE'); assert.equal(raw.readUInt32LE(offset + 24), 16000); assert.equal(raw.readUInt16LE(offset + 22), 1); assert.equal(raw.readUInt16LE(offset + 34), 16);
      const length = raw.readUInt32LE(offset + 40); assert.ok(length >= 30000 && length <= 3840000); assert.ok(raw.subarray(offset + 44, offset + 44 + length).some(byte => byte !== 0));
      asrRequests.push(raw.length);
      res.writeHead(url.pathname === '/asr-error' ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(url.pathname === '/asr-error' ? { error: 'fixture unavailable' } : { text: '你好昔涟，语音识别验收。' })); return;
    }
    const body = JSON.parse(raw.toString() || '{}');
    if (url.pathname === '/tts') {
      assert.equal(req.headers.authorization, 'Bearer fixture-tts'); ttsRequests.push(body);
      if (body.text.includes('slow')) await new Promise(resolve => setTimeout(resolve, 1500));
      if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav); return;
    }
    modelRequests.push(body);
    const messages = body.messages || [], index = messages.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('case:'));
    const user = messages[index]?.content || '', tools = body.tools?.map(t => t.function?.name) || [];
    let name, args;
    if (!messages.slice(index + 1).some(m => m.role === 'tool') && user.includes('case:mcp-')) {
      const id = user.includes('unknown') ? 'accept-http-unknown' : user.includes('http') ? 'accept-http-echo' : user.includes('sse') ? 'accept-sse-echo' : 'filesystem-mcp-read_text_file';
      assert.ok(tools.includes(id), `Tool ${id} missing from model request`);
      name = id; args = id.endsWith('unknown') ? {} : id.endsWith('echo') ? { value: user } : { path: path.join(workspace, 'read-proof.txt') };
    }
    const content = '昔涟在这里，语音和 MCP 验收完成。';
    if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (name) { chunk({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ content }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  } catch (error) { logs.push(String(error.stack)); if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
await writeFile(path.join(data, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], settings: { general: { uiTheme: 'cyrene-pink', proactiveChatMode: 'off', ttsEngine: 'custom-cloud', ttsAutoRead: false, ttsCustomCloudEndpointUrl: fixtureUrl + '/tts', ttsCustomCloudApiKey: 'fixture-tts', ttsCustomCloudFormat: 'wav', asrEngine: 'local', asrLocalUrl: fixtureUrl + '/asr', asrLocalModel: 'whisper-1', asrLocalKey: 'fixture-asr' }, config: { memoryMode: 'off', runtimeSync: 'off' }, modelProfiles: [{ id: 'voice-fixture', provider: 'ChatGPT（OpenAI）', displayName: 'Local acceptance', apiKey: 'fixture-model', baseUrl: fixtureUrl + '/v1', explicitTransport: 'openai', model: 'fixture-model', models: ['fixture-model'] }], defaultModelProfileId: 'voice-fixture' } }));
let handle, base, cookie, clientToken, socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 20000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timeout: ${label}`); await delay(30); } }
async function http(route, body, token = clientToken) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...(token ? { 'X-Cyrene-Client': token } : {}), ...(route.includes('bootstrap') ? { 'X-Cyrene-Setup-Token': 'fixture-setup' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return { response, value };
}
async function invoke(channel, ...args) { const { response, value } = await http('/api/core/invoke', { channel, args }); if (!response.ok) throw new Error(`${channel}: ${JSON.stringify(value)}`); return value; }
const audioWire = { __cyreneBinary: 'base64', data: pcm.toString('base64') };
async function newClient() {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } }); let token = '';
  ws.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'ready') token = event.clientToken; if (event.type === 'CORE_EVENT') events.push({ ...event, owner: token }); });
  await waitFor(() => token, 'client ready'); return { socket: ws, token };
}
async function launch() {
  handle = createWebServer({ staticRoot: path.resolve("dist/renderer"), dataDir: data, secureCookies: false, setupToken: 'fixture-setup', sharedCore: true, logger: { info: v => logs.push(v), warn: v => logs.push(v), error: v => logs.push(v) } });
  await new Promise(resolve => handle.server.listen(serve ? 4318 : 0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${handle.server.address().port}`;
  await http('/api/auth/bootstrap', { username: 'admin', password: '123456' });
  const login = await http('/api/auth/login', { username: 'admin', password: '123456' }); assert.equal(login.response.status, 200); cookie = login.response.headers.get('set-cookie').split(';')[0];
  const next = await newClient(); socket = next.socket; clientToken = next.token; await handle.startChannels();
  await invoke('settings:get-general');
}
async function check(name, action) { const start = Date.now(); await action(); results.push({ name, ok: true, ms: Date.now() - start }); console.log('PASS', name); }
async function run(session, text) {
  const start = events.length; const ack = await invoke('agui:run', { sessionId: session.id, currentUser: { turnId: randomUUID(), text, visibleContent: text }, assistantTurnId: randomUUID(), styleId: 'default' }); assert.equal(ack.success, true);
  await waitFor(() => events.slice(start).some(event => event.channel === 'agui:event' && event.args[0]?.runId === ack.runId && ['RUN_FINISHED', 'RUN_ERROR'].includes(event.args[0]?.type)), 'agent finished');
  const runEvents = events.slice(start).filter(e => e.channel === 'agui:event' && e.args[0]?.runId === ack.runId).map(e => e.args[0]); assert.ok(!runEvents.some(e => e.type === 'RUN_ERROR'), JSON.stringify(runEvents));
  return runEvents;
}
try {
  await launch();
  await check('TTS/ASR/MCP are registered in production authenticated core', async () => {
    const { value } = await http('/api/core/capabilities', {});
    for (const channel of ['tts:session-start', 'tts:synthesize-custom-cloud', 'web:asr-transcribe', 'call:open', 'call:start', 'mcp:add-server', 'mcp:reconnect-server']) assert.ok(value.handlers.includes(channel), channel);
  });
  const session = await invoke('chats:create', { title: '语音与 MCP 验收', mode: 'chat' });
  await run(session, '你好昔涟，请介绍一下语音能力。');
  const stored = await invoke('chats:get', session.id), message = stored.messages.find(m => m.role === 'model'); assert.ok(message);
  const tts = { requestId: randomUUID(), conversationId: session.id, messageId: message.id, speechText: '你好昔涟，语音测试。', converterVersion: 'v1' };
  await check('TTS pronunciation endpoint returns playable WAV', async () => {
    const result = await invoke('tts:synthesize-custom-cloud', { endpointUrl: fixtureUrl + '/tts', apiKey: 'fixture-tts', text: tts.speechText, format: 'wav' }); assert.equal(result.format, 'wav'); assert.deepEqual(Buffer.from(result.base64, 'base64'), wav);
  });
  let synthesis;
  await check('Original chat TTS session synthesizes and persists the audio cache', async () => { synthesis = await invoke('tts:session-start', tts); assert.equal(synthesis.status, 'ready'); assert.equal(synthesis.format, 'wav'); assert.deepEqual(await readFile(path.join(data, 'cyrene-tts-cache', synthesis.cacheKey + '.wav')), wav); });
  await check('Automatic reading respects its switch', async () => { const before = ttsRequests.length; assert.equal((await invoke('tts:session-start', { ...tts, requestId: randomUUID(), automatic: true })).status, 'skipped'); assert.equal(ttsRequests.length, before); });
  await check('Another authenticated browser cannot cancel an owned TTS session', async () => {
    const other = await newClient(), id = randomUUID(); const pending = invoke('tts:session-start', { ...tts, requestId: id, speechText: 'slow owned synthesis' });
    await delay(100); const denied = await http('/api/core/invoke', { channel: 'tts:session-cancel', args: [id] }, other.token); assert.equal(denied.value, false);
    assert.equal(await invoke('tts:session-cancel', id), true); await pending.catch(() => {}); other.socket.close();
  });
  await check('Historical v2 TTS presentation cache survives reload and engine disablement', async () => {
    assert.equal((await invoke('cta:presentation-checkpoint', { sessionId: session.id, messageId: message.id, mutationKey: randomUUID(), patch: { ttsCacheKey: synthesis.cacheKey, ttsCacheVersion: tts.converterVersion } })).ok, true);
    assert.equal((await invoke('chats:get', session.id)).messages.find(m => m.id === message.id).ttsCacheKey, synthesis.cacheKey);
    const before = ttsRequests.length;
    await invoke('settings:save-general', { ttsEngine: 'off' });
    const cached = await invoke('tts:session-start', { ...tts, requestId: randomUUID() });
    assert.equal(cached.status, 'ready'); assert.equal(cached.cached, true); assert.deepEqual(Buffer.from(cached.base64, 'base64'), wav);
    assert.equal(ttsRequests.length, before, 'cached playback must not contact the provider');
    await invoke('settings:save-general', { ttsEngine: 'custom-cloud' });
  });
  await check('ASR receives actual PCM as WAV and returns final transcript', async () => { assert.equal((await invoke('web:asr-transcribe', audioWire)).text, '你好昔涟，语音识别验收。'); assert.ok(asrRequests.length); });
  await check('Malformed audio and provider failures surface actionable errors', async () => {
    await assert.rejects(invoke('web:asr-transcribe', {}), /INVALID_PCM/);
    await invoke('settings:save-general', { asrLocalUrl: fixtureUrl + '/asr-error' }); await assert.rejects(invoke('web:asr-transcribe', audioWire), /503/); await invoke('settings:save-general', { asrLocalUrl: fixtureUrl + '/asr' });
  });
  await check('Voice call executes ASR → original persona/model → TTS → next listening turn', async () => {
    const before = events.length; await invoke('call:open'); await invoke('call:start'); await invoke('call:audio-frame', audioWire); await invoke('call:turn-end');
    const turn = events.slice(before); assert.ok(turn.some(e => e.channel === 'call:asr-result' && e.args[0]?.final.includes('你好昔涟')));
    const audio = turn.find(e => e.channel === 'call:tts-audio')?.args[0]; assert.equal(audio?.format, 'wav'); assert.deepEqual(Buffer.from(audio.base64, 'base64'), wav);
    assert.ok(JSON.stringify(modelRequests.at(-1).messages).includes('昔涟')); await invoke('call:tts-done'); assert.ok(events.at(-1)?.channel === 'call:state' && events.at(-1)?.args[0]?.state === 'LISTENING');
  });
  await check('Voice owner prevents cross-browser control and disconnect releases the call', async () => {
    const other = await newClient(); const busy = await http('/api/core/invoke', { channel: 'call:start', args: [] }, other.token); assert.equal(busy.response.status, 400); assert.match(busy.value.error, /VOICE_CALL_BUSY/);
    const denied = await http('/api/core/invoke', { channel: 'call:stop', args: [] }, other.token); assert.match(denied.value.error, /NOT_OWNED/);
    const before = asrRequests.length; socket.close(); await delay(100); clientToken = other.token; socket = other.socket; await invoke('call:start'); await invoke('call:audio-frame', audioWire); await invoke('call:stop'); assert.equal(asrRequests.length, before, 'hangup must discard buffered audio');
  });
  await invoke('permission:set-level', 'full'); const work = await invoke('chats:create', { title: 'MCP 工具验收', mode: 'work' }); await invoke('chats:set-workspace', { sessionId: work.id, workspaceRoot: workspace });
  for (const transport of ['http', 'sse']) await check(`MCP ${transport} authenticates, discovers and executes a tool through the original Agent`, async () => {
    const result = await invoke('mcp:add-server', { id: 'accept-' + transport, name: 'Acceptance ' + transport, transport, url: fixtureUrl + (transport === 'http' ? '/mcp' : '/sse'), headers: { Authorization: 'Bearer fixture-mcp' } }); assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(result.toolIds.includes('accept-' + transport + '-echo'));
    const stream = await run(work, 'case:mcp-' + transport); assert.ok(mcpCalls.includes('case:mcp-' + transport)); assert.ok(JSON.stringify(stream).includes('MCP_EXECUTED'));
  });
  await check('MCP tools with unknown effects are refused by the original execution policy', async () => {
    const stream = await run(work, 'case:mcp-http-unknown');
    assert.ok(!mcpCalls.includes('UNSAFE_EXECUTED'), 'unclassified tool must never reach the MCP server');
    const refused = stream.find(event => event.type === 'TOOL_CALL_RESULT' && event.status === 'failed');
    assert.ok(refused); assert.match(refused.content, /effectKind 为 unknown.*拒绝执行/);
  });
  await check('MCP validates configuration before spawning or connecting', async () => { assert.equal((await invoke('mcp:add-server', { id: 'bad:id', name: 'Invalid', transport: 'stdio', command: process.execPath })).ok, false); assert.equal((await invoke('mcp:add-server', { id: 'bad-url', name: 'Invalid', transport: 'http', url: 'file:///tmp/mcp' })).ok, false); });
  await check('MCP stdio starts real bundled Filesystem server and executes a read', async () => {
    const cli = path.join(path.dirname(require.resolve('@modelcontextprotocol/server-filesystem/package.json')), 'dist/index.js'); await writeFile(path.join(workspace, 'read-proof.txt'), 'FILESYSTEM_MCP_EXECUTED');
    const result = await invoke('mcp:add-server', { id: 'filesystem-mcp', name: 'Filesystem acceptance', transport: 'stdio', command: process.execPath, args: [cli, workspace], cwd: workspace, env: {} }); assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(JSON.stringify(await run(work, 'case:mcp-stdio')).includes('FILESYSTEM_MCP_EXECUTED'));
    assert.equal((await invoke('mcp:list-server-configs')).find(c => c.id === 'filesystem-mcp').cwd, workspace);
  });
  await check('MCP reconnect preserves its configuration and refreshes discovered tools', async () => { assert.equal((await invoke('mcp:reconnect-server', 'accept-http')).ok, true); assert.equal((await invoke('mcp:list-servers')).find(c => c.id === 'accept-http').connected, true); });
  await check('MCP persisted remote configurations automatically reconnect after server restart', async () => {
    socket.close(); await handle.close(); await launch();
    for (let i = 0; i < 100; i++) { if ((await invoke('mcp:list-servers')).filter(c => c.connected && c.id.startsWith('accept-')).length === 2) break; await delay(50); }
    assert.equal((await invoke('mcp:list-servers')).filter(c => c.connected && c.id.startsWith('accept-')).length, 2);
  });
  await check('Bundled MCP settings sync uses Node/headless Chromium and removes tools when disabled', async () => {
    await invoke('settings:save-general', { playwrightMcpEnabled: true, filesystemMcpEnabled: true }); const configs = await invoke('mcp:list-server-configs'); const pw = configs.find(c => c.id === 'playwright-mcp'); assert.ok(pw.args.includes('chromium')); assert.equal(pw.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.ok((await invoke('mcp:list-servers')).find(c => c.id === 'playwright-mcp')?.toolCount > 0);
    await invoke('settings:save-general', { playwrightMcpEnabled: false, filesystemMcpEnabled: false }); assert.ok(!(await invoke('mcp:list-server-configs')).some(c => ['playwright-mcp', 'filesystem-mcp'].includes(c.id)));
  });
  await check('MCP remove disconnects the server and removes the persisted tools', async () => { await invoke('mcp:remove-server', 'accept-sse'); assert.ok(!(await invoke('mcp:list-server-configs')).some(c => c.id === 'accept-sse')); assert.ok(!(await invoke('mcp:list-servers')).some(c => c.id === 'accept-sse')); });
  await mkdir('docs/verification', { recursive: true }); await writeFile('docs/verification/shared-core-voice-mcp-results.json', JSON.stringify({ at: new Date().toISOString(), dataDir: data, results, actualMcpCalls: mcpCalls, audio: { ttsRequests: ttsRequests.length, asrRequests: asrRequests.length, wavBytes: wav.length }, fixtureUrl }, null, 2));
  console.log('ALL PASSED', results.length, 'checks. Fixture:', data);
  if (serve) { console.log('UI fixture: http://localhost:4318/web/ admin / 123456'); console.log('Upload audio:', path.join(workspace, 'audio-test.wav')); console.log('MCP JSON:', JSON.stringify({ mcpServers: { 'UI acceptance': { type: 'http', url: fixtureUrl + '/mcp', headers: { Authorization: 'Bearer fixture-mcp' } } } })); await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); }); }
} catch (error) { console.error('FAIL', error); console.error('Fixture:', data); console.error('Recent logs:', logs.slice(-10).map(v => String(v).slice(0, 600))); process.exitCode = 1; }
finally { socket?.close(); if (handle) await handle.close(); for (const mcp of mcpInstances) await mcp.close().catch(() => {}); for (const transport of sseTransports.values()) await transport.close().catch(() => {}); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
