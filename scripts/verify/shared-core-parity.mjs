import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createWebServer } = require('../../dist/server/server/index.js');
const data = await mkdtemp(path.join(os.tmpdir(), 'cyrene-core-parity-'));
const workspace = path.join(data, 'workspace'); await mkdir(workspace);
const requests = [], results = [], events = [], logs = [];
const fixtureModel = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}'); requests.push(body);
  const tools = body.tools?.map(tool => tool.function?.name || tool.name) ?? [];
  const caseIndex = body.messages?.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('case:')) ?? -1;
  const userText = JSON.stringify(body.messages?.[caseIndex]?.content || '');
  const toolMessages = body.messages?.slice(caseIndex + 1).filter(message => message.role === 'tool') ?? [];
  let name, args;
  if (tools.length && /case:write-(work|code)/.test(userText) && !toolMessages.length) {
    name = tools.includes('Write') ? 'Write' : 'write_file';
    const mode = userText.includes('case:write-code') ? 'code' : 'work';
    args = { ...(name === 'Write' ? { file_path: path.join(workspace, `proof-${mode}.txt`) } : { path: path.join(workspace, `proof-${mode}.txt`) }), content: `shared-core-${mode}` };
  } else if (tools.includes('parity-plugin_echo') && userText.includes('case:plugin') && !toolMessages.length) { name = 'parity-plugin_echo'; args = { value: 'plugin-executed' }; }
  const toolResult = toolName => {
    const call = body.messages?.slice(caseIndex + 1).flatMap(message => message.tool_calls ?? []).find(call => call.function?.name === toolName);
    const message = toolMessages.find(message => message.tool_call_id === call?.id);
    if (!message) return null;
    let value = JSON.parse(message.content);
    if (typeof value.message === 'string') { try { value = JSON.parse(value.message); } catch {} }
    return value;
  };
  if (tools.includes('learn_exam_create_plan') && userText.includes('case:exam')) {
    const plan = toolResult('learn_exam_create_plan'), added = toolResult('learn_exam_add_single_choice'), published = toolResult('learn_exam_publish');
    if (!plan) { name = 'learn_exam_create_plan'; args = { schemaVersion: 1, title: 'Parity arithmetic', subject: 'Math', durationMinutes: 15, totalPoints: 10, quotas: [{ type: 'single_choice', count: 1, points: 10, learningObjectives: ['arithmetic'] }] }; }
    else if (!added) { name = 'learn_exam_add_single_choice'; args = { draftId: plan.draftId, questions: [{ type: 'single_choice', prompt: '1+1=?', points: 10, learningObjective: 'arithmetic', explanation: 'Two units', options: ['2', '3'], correctIndex: 0 }] }; }
    else if (!published) { name = 'learn_exam_publish'; args = { draftId: plan.draftId }; }
  }
  if (tools.includes('learn_exam_get_submission') && userText.includes('case:grade')) {
    const examId = String(body.messages[caseIndex].content).split(' ').at(-1), submission = toolResult('learn_exam_get_submission');
    if (!submission) { name = 'learn_exam_get_submission'; args = { examId }; }
    else if (!toolResult('learn_exam_save_grading')) { name = 'learn_exam_save_grading'; args = { examId, result: { totalScore: 10, summary: 'Passed', questionResults: submission.questions.map(question => ({ questionId: question.id, awardedPoints: question.points, feedback: 'Correct' })), abilityAnalysis: [{ ability: 'arithmetic', score: 10, total: 10, feedback: 'Passed' }], nextSteps: ['Practice'] } }; }
  }
  if (tools.includes('task') && userText.includes('case:subagent') && !toolMessages.length) {
    const schema = body.tools.find(tool => tool.function?.name === 'task').function.parameters;
    name = 'task'; args = { description: 'Inspect parity fixture', prompt: 'case:child Inspect workspace and report.', subagent_type: 'general', access_mode: 'read_only', max_parallel_tool_calls: 2, companion_id: schema.properties.companion_id.enum[0] };
  }
  if (tools.includes('invoke_skill') && userText.includes('case:skill') && !toolMessages.length) { name = 'invoke_skill'; args = { skill_id: 'parity-skill' }; }
  if (userText.includes('case:browser')) {
    if (!toolResult('browser_control_start')) { name = 'browser_control_start'; args = {}; }
    else if (!toolResult('browser_get_page_elements')) { name = 'browser_get_page_elements'; args = {}; }
    else if (!toolResult('browser_get_element_css') || !toolResult('browser_click')) {
      const text = toolResult('browser_get_page_elements').message ?? toolResult('browser_get_page_elements');
      const observationId = /observationId=([\w-]+)/.exec(text)?.[1], ref = /button "Click fixture" \[ref=([^\]]+)\]/.exec(text)?.[1];
      name = !toolResult('browser_get_element_css') ? 'browser_get_element_css' : 'browser_click'; args = { observationId, ref };
    } else if (!toolResult('browser_control_stop')) { name = 'browser_control_stop'; args = {}; }
  }
  if (userText.includes('case:picker-css') && !toolResult('browser_get_element_css')) {
    name = 'browser_get_element_css'; args = { observationId: /obs=([\w-]+)/.exec(userText)?.[1], ref: /ref=([\w-]+)/.exec(userText)?.[1] };
  }
  const content = '昔涟在这里，验收完成。';
  if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' });
  if (name) { chunk({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, 'tool_calls'); }
  else { chunk({ content }); chunk({}, 'stop'); }
  res.write(`data: ${JSON.stringify({ id: 'fixture', model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } })}\n\ndata: [DONE]\n\n`); res.end();
});
await new Promise(resolve => fixtureModel.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${fixtureModel.address().port}/v1`;
await mkdir(path.join(data, 'prompts'));
await writeFile(path.join(data, 'prompts', 'chat_identity.md'), await readFile('prompts/chat_identity.md', 'utf8') + '\nPARITY_USER_PROMPT_OVERRIDE');
await writeFile(path.join(data, 'web-data.json'), JSON.stringify({ version: 1, sessions: [], recentProjects: [workspace], settings: { general: { uiTheme: 'charcoal-pink', uiThemeRadius: false, taskCharacterPersonaEnabled: true, chatToolsEnabled: false, maxParallelToolCalls: 4, momentsEnabled: true, cyreneMomentsPostingEnabled: false, cyreneMomentsReactionsEnabled: false, momentsCharacterReactionsEnabled: false, proactiveChatMode: 'off', plugins: { 'parity-plugin': true } }, config: { memoryMode: 'summary', runtimeSync: 'off' }, modelProfiles: [{ id: 'fixture-profile', provider: 'ChatGPT（OpenAI）', displayName: 'Fixture', apiKey: 'fixture-local-only', baseUrl: modelUrl, explicitTransport: 'openai', model: 'fixture-model', models: ['fixture-model'], multimodal: true }], defaultModelProfileId: 'fixture-profile' } }));
await writeFile(path.join(data, 'web-features.json'), JSON.stringify({ profile: { nickname: 'Fixture', timezone: 'Asia/Shanghai' }, channels: { wechat: { enabled: false }, feishu: { enabled: false }, qq: { enabled: false }, qqbot: { enabled: false } }, memory: { l0: { preferredName: '验收用户' }, l1: {}, l2: [], reflections: [] }, schedules: [], knowledge: { enabled: true, collections: [] }, moments: { posts: [], comments: [], reactions: [] }, enabledPlugins: { 'parity-plugin': true } }));
const pluginDir = path.join(data, 'plugins', 'parity-plugin'); await mkdir(pluginDir, { recursive: true });
await writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify({ apiVersion: 1, id: 'parity-plugin', name: 'Parity fixture', version: '1.0.0', description: 'Isolated parity fixture', author: 'Fixture', entry: 'index.cjs', defaultEnabled: true, settingsPanel: 'panel.html' }));
await writeFile(path.join(pluginDir, 'index.cjs'), `module.exports={register(ctx){require('node:fs').writeFileSync(${JSON.stringify(path.join(data, 'plugin-activated.txt'))},'activated');ctx.registerTool({id:'parity-plugin_echo',name:'Parity echo',description:'Echo fixture value',enabled:true,risk:'safe',modes:['work'],effectKind:'read',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},execute:async args=>'plugin:'+args.value});},unregister(){}};`);
await writeFile(path.join(pluginDir, 'panel.html'), '<!doctype html><p>Plugin fixture panel</p><script src="/.cyrene/panel-bridge.js"></script>');
const skillDir = path.join(data, 'skills', 'parity-skill'); await mkdir(skillDir, { recursive: true });
await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Parity fixture\ndescription: A fixture for instruction loading\neffectKind: read\nmodes: [work, code, learn]\n---\nPARITY_SKILL_INSTRUCTIONS: inspect the fixture, then report the result.');
const handle = createWebServer({ dataDir: data, secureCookies: false, setupToken: 'fixture-setup', sharedCore: true, logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) } });
await new Promise(resolve => handle.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${handle.server.address().port}`;
let cookie = '', clientToken = '', socket;
async function http(route, method = 'GET', body, headers = {}) {
  const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; } return { response, value };
}
async function invoke(channel, ...args) { const { response, value } = await http('/api/core/invoke', 'POST', { channel, args }, { 'X-Cyrene-Client': clientToken }); if (!response.ok) throw new Error(`${channel}: ${JSON.stringify(value)}`); return value; }
async function send(channel, ...args) { const result = await http('/api/core/send', 'POST', { channel, args }, { 'X-Cyrene-Client': clientToken }); assert.equal(result.response.status, 200); }
async function check(name, action) { const started = Date.now(); await action(); results.push({ name, ok: true, ms: Date.now() - started }); console.log('PASS', name); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cssOutput(runId) {
  const root = path.join(data, 'cyrene-runs', 'tool-results');
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('meta.json')) continue;
    const meta = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    if (meta.runId === runId && meta.toolName === 'browser_get_element_css') return readFile(path.join(root, path.dirname(file), 'output.txt'), 'utf8');
  }
  throw new Error('CSS output artifact missing');
}
async function waitFor(predicate, label, timeout = 15000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(30); } }
async function run(session, text) {
  const prior = events.length;
  const ack = await invoke('agui:run', { sessionId: session.id, currentUser: { turnId: `user-${randomUUID()}`, text, visibleContent: text }, assistantTurnId: `assistant-${randomUUID()}`, styleId: 'default' });
  assert.equal(ack.success, true, JSON.stringify(ack));
  await waitFor(() => events.slice(prior).some(event => event.channel === 'agui:event' && ['RUN_FINISHED', 'RUN_ERROR'].includes(event.args[0]?.type) && event.args[0]?.runId === ack.runId), 'agent terminal', 45000);
  const stream = events.slice(prior).filter(event => event.channel === 'agui:event' && event.args[0]?.runId === ack.runId).map(event => event.args[0]);
  const error = stream.find(event => event.type === 'RUN_ERROR'); assert.equal(error, undefined, JSON.stringify(error));
  await send('agui:run-persisted', { runId: ack.runId, sessionId: session.id });
  return { ack, stream };
}
try {
  await check('Unauthenticated API is blocked', async () => assert.equal((await http('/api/core/capabilities', 'POST', {})).response.status, 401));
  await http('/api/auth/bootstrap', 'POST', { username: 'admin', password: '123456' }, { 'X-Cyrene-Setup-Token': 'fixture-setup' });
  const login = await http('/api/auth/login', 'POST', { username: 'admin', password: '123456' }); assert.equal(login.response.status, 200); cookie = login.response.headers.get('set-cookie').split(';')[0];
  socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  socket.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'ready') clientToken = event.clientToken; if (event.type === 'CORE_EVENT') events.push(event); });
  await waitFor(() => clientToken, 'websocket handshake'); await handle.startChannels();
  const capabilityResponse = await http('/api/core/capabilities', 'POST', {}, { 'X-Cyrene-Client': clientToken });
  assert.equal(capabilityResponse.response.status, 200);
  const runtimeCapabilities = capabilityResponse.value;
  await check('Upstream version and issue mail protocol reach the authenticated Web core', async () => {
    assert.equal(runtimeCapabilities.version, JSON.parse(await readFile('package.json', 'utf8')).version);
    const url = 'mailto:test@example.invalid?subject=fixture';
    assert.equal((await invoke('shell:open-external', url)).ok, true);
    await waitFor(() => events.some(event => event.channel === 'host:open-url' && event.args?.[0] === url), 'mail host event');
    assert.equal((await invoke('shell:open-external', 'javascript:alert(1)')).ok, false);
  });
  await check('Legacy model/profile/memory migration retains values', async () => { const settings = await invoke('settings:get-config'); assert.equal(settings.defaultModelProfileId, 'fixture-profile'); const panel = await invoke('memory-panel:get-data'); assert.equal(panel.l0.preferredName, '验收用户'); assert.equal(await readFile(path.join(data, 'plugin-activated.txt'), 'utf8'), 'activated'); });
  await check('Theme and radius use persisted desktop settings', async () => { assert.equal(await invoke('ui-theme:get'), 'charcoal-pink'); assert.equal(await invoke('ui-theme-radius:get'), false); });
  await invoke('permission:set-level', 'full');
  const sessions = {};
  for (const mode of ['chat', 'work', 'code', 'learn']) {
    sessions[mode] = await invoke('chats:create', { title: `Parity ${mode}`, mode });
    if (mode !== 'chat') assert.equal((await invoke('chats:set-workspace', { sessionId: sessions[mode].id, workspaceRoot: workspace })).ok, true);
  }
  await check('Chat uses persona, respects user prompt overrides and excludes Work/Code tools by default', async () => { const start = requests.length; const result = await run(sessions.chat, 'case:chat 你是谁？'); assert.equal(result.stream.filter(event => event.type === 'TEXT_MESSAGE_CONTENT').length, 1); const body = requests.slice(start).find(request => request.stream); assert.ok(JSON.stringify(body.messages).includes('昔涟')); assert.ok(JSON.stringify(body.messages).includes('PARITY_USER_PROMPT_OVERRIDE')); assert.ok(!body.tools?.some(tool => ['Write', 'run_shell', 'lsp'].includes(tool.function?.name))); });
  await check('Plan transitions persist and broadcast conversation-scoped state', async () => {
    const conversationId = sessions.code.id, prior = events.length;
    assert.equal((await invoke('plan:set-mode', { conversationId, target: 'on', workspaceRoot: workspace })).state, 'PLAN_DISCUSSING');
    await waitFor(() => events.slice(prior).some(event => event.channel === 'plan:state-changed' && event.args[0]?.conversationId === conversationId && event.args[0]?.state === 'PLAN_DISCUSSING'), 'plan state broadcast');
    assert.equal((await invoke('plan:get-state', { conversationId })).state, 'PLAN_DISCUSSING');
    assert.equal((await invoke('plan:set-mode', { conversationId, target: 'off' })).state, 'NORMAL');
  });
  await check('Open folder uses authenticated server directory browsing', async () => {
    const prior = events.length; await invoke('chats:open-folder');
    await waitFor(() => events.slice(prior).some(event => event.channel === 'host:open-directory'), 'server directory event');
    const folder = events.slice(prior).find(event => event.channel === 'host:open-directory').args[0];
    const result = await http(`/api/core/files?path=${encodeURIComponent(folder)}`); assert.equal(result.response.status, 200); assert.ok(result.value.entries.some(entry => entry.name === 'sessions' && entry.directory));
  });
  for (const mode of ['work', 'code']) await check(`${mode} executes tool calls and persists file/review evidence`, async () => { const result = await run(sessions[mode], `case:write-${mode}`); assert.equal(await readFile(path.join(workspace, `proof-${mode}.txt`), 'utf8'), `shared-core-${mode}`); assert.ok(result.stream.some(event => event.type === 'TOOL_CALL_START')); assert.ok(await invoke('review:get', result.ack.runId)); const session = await invoke('chats:get', sessions[mode].id); assert.ok(session.messages.some(message => message.role === 'model')); });
  await check('Learn routes through Harness and exposes exam tools', async () => { const start = requests.length; await run(sessions.learn, 'case:learn'); assert.ok(requests.slice(start).some(request => request.tools?.some(tool => tool.function?.name === 'learn_exam_create_plan'))); });
  await check('Learn exam is authored, answered with hidden solutions, submitted and graded', async () => {
    const prior = events.length; await run(sessions.learn, 'case:exam');
    const created = events.slice(prior).find(event => event.channel === 'learn-exam:created')?.args[0]; assert.ok(created?.examId, 'exam creation event');
    assert.equal(await invoke('browser-panel:open-exam', created), true);
    for (let attempt = 0; attempt < 50 && !events.slice(prior).some(event => event.channel === 'browser-panel:open-for-control'); attempt++) await delay(20);
    assert.ok(events.slice(prior).some(event => event.channel === 'browser-panel:open-for-control'), 'exam opens the browser inspector');
    const browser = await invoke('browser-panel:get-state'), tab = browser.tabs.find(tab => tab.id === browser.activeTabId);
    const token = new URL(tab.url, base).searchParams.get('token'); assert.ok(token);
    const page = async (channel, ...args) => { const result = await http('/api/core/invoke', 'POST', { channel, args, pageToken: token }, { 'X-Cyrene-Client': clientToken }); if (result.value.error === 'E_LEARN_EXAM_PAGE_FORBIDDEN') return result.value; assert.equal(result.response.status, 200, JSON.stringify(result.value)); return result.value; };
    assert.equal((await invoke('learn-exam-page:get')).error, 'E_LEARN_EXAM_PAGE_FORBIDDEN');
    const view = await page('learn-exam-page:get'); assert.equal(view.ok, true); assert.ok(!JSON.stringify(view).includes('correctOptionId'));
    const question = view.exam.questions[0]; assert.equal((await page('learn-exam-page:save-answer', { questionId: question.id, answer: { value: question.options[0].id } })).ok, true);
    assert.equal((await page('learn-exam-page:save-navigation', { activeQuestionId: question.id, flaggedQuestionIds: [question.id] })).ok, true);
    assert.equal((await page('learn-exam-page:submit')).shouldStartGrading, true); assert.equal((await page('learn-exam-page:submit')).shouldStartGrading, false);
    assert.equal((await page('learn-exam-page:save-answer', { questionId: question.id, answer: null })).ok, false);
    await run(sessions.learn, `case:grade ${created.examId}`);
    const graded = await page('learn-exam-page:get'); assert.equal(graded.exam.status, 'graded'); assert.equal(graded.exam.gradingResult.totalScore, 10);
    await invoke('browser-panel:close-tab', tab.id); assert.equal((await page('learn-exam-page:get')).error, 'E_LEARN_EXAM_PAGE_FORBIDDEN');
  });
  await check('Subagent performs an actual child run and persists its transcript', async () => {
    const start = requests.length; await run(sessions.work, 'case:subagent'); assert.ok(requests.slice(start).some(request => JSON.stringify(request.messages).includes('case:child')));
    const index = JSON.parse(await readFile(path.join(data, 'cyrene-tasks', 'index.json'), 'utf8')); const task = index.find(row => row.parentConversationId === sessions.work.id);
    const saved = await invoke('task-session:get', { taskId: task.id, parentConversationId: sessions.work.id }); assert.equal(saved.status, 'completed'); assert.ok(saved.messages.length > 0);
  });
  await check('Skill instructions are invoked and reach the next model request', async () => { const start = requests.length; await run(sessions.work, 'case:skill'); assert.ok(requests.slice(start).some(request => request.messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('PARITY_SKILL_INSTRUCTIONS')))); });
  await check('Plugin executes and its panel bridge is served in an isolated sandbox', async () => {
    const start = requests.length; await run(sessions.work, 'case:plugin'); assert.ok(requests.slice(start).some(request => request.messages?.some(message => message.role === 'tool' && String(message.content).includes('plugin-executed'))));
    const panel = await http('/api/plugin-panel/parity-plugin/panel.html'); assert.equal(panel.response.status, 200); assert.ok(panel.value.includes('/api/plugin-panel/parity-plugin/.cyrene/panel-bridge.js')); assert.ok(panel.response.headers.get('content-security-policy').includes('sandbox allow-scripts'));
    assert.equal((await http('/api/plugin-panel/parity-plugin/.cyrene/panel-bridge.js')).response.status, 200);
    assert.equal((await http('/api/core/resource?url=' + encodeURIComponent('cyrene-plugin://parity-plugin/panel.html'))).response.status, 403);
    await invoke('plugins:set-enabled', 'parity-plugin', false); assert.ok(!(await invoke('tool:get-catalog')).some(tool => tool.id === 'parity-plugin_echo'));
  });
  await check('Tools and Skill mode overrides persist', async () => { await invoke('tool:set-mode-override', { toolId: 'Read', mode: 'code', enabled: false }); assert.equal((await invoke('tool:get-mode-overrides')).Read.code, false); const skills = await invoke('skill:list'); assert.ok(skills.length > 0); await invoke('skill:set-mode-override', { skillId: skills[0].id, mode: 'learn', enabled: false }); assert.equal((await invoke('skill:get-mode-overrides'))[skills[0].id].learn, false); });
  await check('Invalid session model changes are rejected atomically', async () => { const result = await invoke('chats:set-session-model', { id: sessions.chat.id, model: 'not-in-profile' }); assert.equal(result.ok, false); assert.equal((await invoke('chats:get', sessions.chat.id)).model, 'fixture-model'); });
  await check('Knowledge base indexes files and returns actual documents/search hits', async () => { const file = path.join(workspace, 'knowledge.md'); await writeFile(file, '量子验收资料\nThe parity nebula document'); const state = await invoke('knowledge:create-collection', { name: 'Parity collection', scope: { kind: 'global' } }); const id = state.collections.at(-1).id; await invoke('knowledge:add-paths', id, [{ kind: 'file', path: file }]); await invoke('knowledge:refresh-collection', id); const documents = await invoke('knowledge:list-documents', id); assert.ok(Array.isArray(documents) && documents.length === 1); const hits = await invoke('knowledge:search', 'nebula', id); assert.ok(JSON.stringify(hits).includes('knowledge.md')); });
  await check('Scheduled task enforces its allow list, runs Harness and writes history/notification', async () => {
    const start = requests.length;
    const task = await invoke('scheduler:add', { title: 'Parity scheduled', prompt: 'case:scheduled', mode: 'work', enabled: true, toolMode: 'allow-list', allowedToolIds: [], workspaceBinding: { workspaceRoot: workspace, displayName: 'Fixture' }, schedule: { kind: 'daily', timeOfDay: '08:00' } }); assert.equal(task.ok, true, JSON.stringify(task));
    const fired = await invoke('scheduler:fire-now', task.value.id); assert.equal(fired.ok, true, JSON.stringify(fired)); const history = await invoke('scheduler:get-history', task.value.id, 10); assert.ok(history.value?.some(entry => entry.status === 'success'), JSON.stringify(history));
    assert.ok(!requests.slice(start).some(request => request.tools?.some(tool => tool.function?.name === 'Write')));
    const toast = (await invoke('toast:get-all')).find(item => item.kind === 'task-finished'); assert.ok(toast); await send('toast:dismissed', toast.id); assert.ok(!(await invoke('toast:get-all')).some(item => item.id === toast.id));
  });
  await check('Conversation rename/pin, idempotent queue, edit/claim and deletion work', async () => {
    const session = await invoke('chats:create', { title: 'Queue fixture', mode: 'chat' });
    assert.equal((await invoke('chats:rename', { id: session.id, title: 'Renamed fixture' })).title, 'Renamed fixture'); assert.equal((await invoke('chats:set-pinned', { id: session.id, pinned: true })).pinned, true);
    const entry = { id: 'queue-1', rawContent: 'before edit', visibleContent: 'before edit' };
    assert.equal((await invoke('chats:pending-enqueue', { sessionId: session.id, entry })).enqueued, true); assert.equal((await invoke('chats:pending-enqueue', { sessionId: session.id, entry })).enqueued, false);
    assert.equal((await invoke('chats:pending-edit', { sessionId: session.id, messageId: entry.id, rawContent: 'after edit' })).ok, true);
    const claimed = await invoke('chats:pending-claim', session.id); assert.equal(claimed.claimed, true); assert.equal(claimed.visibleContent, 'after edit');
    assert.equal((await invoke('chats:pending-complete-dispatch', { sessionId: session.id, messageId: entry.id })).ok, true); assert.equal((await invoke('chats:pending-list', session.id)).length, 0);
    assert.equal(await invoke('chats:delete', session.id), true); assert.equal(await invoke('chats:get', session.id), null);
  });
  await check('Avatar and sticker uploads use real file dialogs and media resources', async () => {
    const imagePath = path.join(workspace, 'avatar.png'); await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    const prior = events.length, pending = invoke('cyrene-avatar:upload'); await waitFor(() => events.slice(prior).some(event => event.channel === 'host:dialog'), 'avatar file dialog'); const dialog = events.slice(prior).find(event => event.channel === 'host:dialog').args[0];
    assert.equal((await http('/api/core/dialog', 'POST', { dialogId: dialog.id, value: { canceled: false, filePaths: [imagePath] } }, { 'X-Cyrene-Client': clientToken })).value, true); await pending;
    const avatar = await invoke('cyrene-avatar:get'); assert.ok(avatar?.startsWith('data:image/png;base64,'));
    await invoke('stickers:add', { sourcePath: imagePath, id: 'parity-sticker', description: 'Parity sticker', phrases: ['parity'] });
    const sticker = (await invoke('stickers:get-config')).find(item => item.id === 'parity-sticker'); assert.ok(sticker); assert.equal((await http('/api/core/resource?url=' + encodeURIComponent(sticker.src))).response.status, 200);
  });
  await check('Local music imports, streams with ranges and accepts browser playback feedback', async () => {
    const wavePath = path.join(workspace, 'parity-audio.wav'), wave = Buffer.alloc(16044);
    wave.write('RIFF', 0); wave.writeUInt32LE(wave.length-8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(16000, 40); await writeFile(wavePath, wave);
    const prior = events.length, pending = invoke('music:import-local-tracks');
    await waitFor(() => events.slice(prior).some(event => event.channel === 'host:dialog'), 'music import dialog');
    const dialog = events.slice(prior).find(event => event.channel === 'host:dialog').args[0];
    await http('/api/core/dialog', 'POST', {dialogId:dialog.id,value:{canceled:false,filePaths:[wavePath]}}, {'X-Cyrene-Client':clientToken});
    const imported = await pending; assert.equal(imported.ok, true, JSON.stringify(imported)); assert.equal(imported.data.imported, 1);
    const cached = await invoke('music:get-cached-tracks'); assert.equal(cached.ok, true); const track = cached.data.find(track => track.name === 'parity-audio'); assert.ok(track);
    assert.equal((await invoke('music:play-track', track.id)).ok, true);
    const source = await invoke('web:audio-get'); assert.ok(source.sourceId && source.src.startsWith('/api/core/audio'));
    const stream = await fetch(base+source.src,{headers:{Cookie:cookie,Range:'bytes=0-43'}}); assert.equal(stream.status,206); const header=Buffer.from(await stream.arrayBuffer()); assert.equal(header.toString('ascii',0,4),'RIFF'); assert.equal(header.length,44);
    assert.equal(await invoke('web:audio-state',{sourceId:source.sourceId,loaded:true,paused:false,position:0.25,duration:1,volume:70}),true);
    const playing = await invoke('web:audio-get'); assert.equal(playing.position,0.25); assert.equal(playing.loaded,true);
    await waitFor(()=>events.some(event=>event.channel==='music:playback:state'&&event.args[0]?.position===0.25),'shared music playback event');
    assert.equal((await invoke('music:playback:pause')).ok,true); assert.ok(events.some(event=>event.channel==='web:audio-command'&&event.args[0]?.command==='pause'));
    assert.equal((await invoke('music:playback:stop')).ok,true);
  });
  await check('QQ authenticated reverse WebSocket dispatches a real model reply and logs it', async () => {
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    await invoke('channels:save-config', { qq: { enabled: true, listenMode: 'loopback', port, accessToken: 'fixture-onebot', allowedPrivateUserIds: ['1000'], allowedGroupIds: [] }, ttsEnabled: false }); await invoke('channels:restart');
    const actions = [], gateway = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: 'Bearer fixture-onebot', 'X-Self-ID': '9000' } });
    gateway.on('message', raw => { const action = JSON.parse(String(raw)); actions.push(action); const result = action.action === 'get_login_info' ? { user_id: 9000, nickname: 'Fixture QQ' } : action.action === 'get_version_info' ? { app_name: 'NapCat', app_version: '4.8.115', protocol_version: 'v11' } : { message_id: 'fixture-reply' }; gateway.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: result })); });
    try { await new Promise((resolve, reject) => { gateway.once('open', resolve); gateway.once('error', reject); }); await waitFor(() => actions.some(action => action.action === 'get_version_info'), 'QQ handshake');
      gateway.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: 9000, post_type: 'message', message_type: 'private', message_id: 'qq-proof', user_id: 1000, sender: { user_id: 1000, nickname: 'Fixture' }, message: [{ type: 'text', data: { text: 'case:channel' } }] }));
      await waitFor(() => actions.some(action => action.action === 'send_private_msg'), 'QQ model reply', 30000); assert.ok(JSON.stringify(actions).includes('昔涟在这里'));
      assert.ok(JSON.stringify(await invoke('channels:log:get', 100)).includes('case:channel')); const bindings = await invoke('channels:context-bindings:get'); assert.ok(JSON.stringify(bindings).includes('1000'));
    } finally { gateway.close(); await invoke('channels:save-config', { qq: { enabled: false } }); await invoke('channels:restart'); }
  });
  await check('Memory edits and moments use original persistent stores', async () => { await invoke('memory-panel:save-l0', { preferredName: 'Parity updated' }); assert.equal((await invoke('memory-panel:get-data')).l0.preferredName, 'Parity updated'); const post = await invoke('moments:create-post', { text: 'Parity post' }); assert.equal(post.applied, true, JSON.stringify(post)); assert.ok(JSON.stringify(await invoke('moments:list')).includes('Parity post')); });
  await check('Usage report records actual model requests and token usage', async () => { const usage = await invoke('token-usage:get', 7); const model = usage.models.find(model => model.model === 'fixture-model'); assert.ok(model?.input > 0 && model.output > 0 && model.requests > 0); });
  await check('Server browser loads and snapshots an actual page', async () => { const page = createServer((_req, res) => res.end('<!doctype html><title>Parity page</title><button id="parity" onclick="this.textContent=\'Clicked\'">Click fixture</button>')); await new Promise(resolve => page.listen(0, '127.0.0.1', resolve)); try { assert.equal((await invoke('browser-panel:navigate', `http://127.0.0.1:${page.address().port}`)).ok, true); const shot = await invoke('web:browser-screenshot'); assert.ok(shot.src.startsWith('data:image/jpeg;base64,')); } finally { await new Promise(resolve => page.close(resolve)); } });
  await check('Element picker retains its observation for subsequent CSS reads', async () => {
    const page = createServer((_req, res) => res.end('<!doctype html><title>Picker fixture</title><style>button{width:140px;height:40px;background:rgb(20,30,40)}</style><button>Pick fixture</button>'));
    await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
    try {
      await invoke('browser-panel:navigate', `http://127.0.0.1:${page.address().port}`);
      const prior = events.length; assert.equal(await invoke('browser-panel:start-element-picker'), true);
      await invoke('web:browser-input', {type:'click',x:60,y:25});
      await waitFor(() => events.slice(prior).some(event => event.channel === 'browser-panel:element-selected'), 'picker selected event');
      const selected = events.slice(prior).find(event => event.channel === 'browser-panel:element-selected').args[0], start = requests.length;
      const result = await run(sessions.work, `case:picker-css obs=${selected.observationId} ref=${selected.ref}`);
      assert.ok(JSON.stringify(requests.slice(start)).includes('CSS 读取结果'), 'CSS preview reaches model');
      const output = await cssOutput(result.ack.runId); assert.ok(output.includes('computedStyle') && output.includes('matchedRules'), 'full CSS remains readable as a tool artifact');
    } finally { await new Promise(resolve => page.close(resolve)); }
  });
  await check('Browser control exposes action tools and clicks a real page element by ref', async () => {
    let clicked = 0;
    const page = createServer((req, res) => { if (req.url === '/clicked') { clicked++; res.end('ok'); } else res.end('<!doctype html><title>Control fixture</title><button onclick="fetch(\'/clicked\')">Click fixture</button>'); });
    await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
    try { await invoke('browser-panel:navigate', `http://127.0.0.1:${page.address().port}`); const result = await run(sessions.work, 'case:browser'); assert.equal(clicked, 1); assert.ok((await cssOutput(result.ack.runId)).includes('matchedRules'), 'matched CSS rules are preserved'); } finally { await new Promise(resolve => page.close(resolve)); }
  });
  await check('Logout revokes the established WebSocket', async () => { let closed = false; socket.once('close', code => { closed = code === 1008; }); await http('/api/auth/logout', 'POST'); await waitFor(() => closed, 'logout websocket revocation'); assert.equal((await http('/api/core/capabilities', 'POST', {})).response.status, 401); });
  await mkdir('docs/verification', { recursive: true });
  await writeFile('docs/verification/shared-core-parity-results.json', JSON.stringify({ at: new Date().toISOString(), dataDir: data, results, requests: requests.map(request => ({ model: request.model, stream: request.stream, tools: request.tools?.map(tool => tool.function?.name || tool.name) })), handlerCount: runtimeCapabilities.handlers?.length ?? null, engine: runtimeCapabilities.engine }, null, 2));
  console.log('ALL PASSED', results.length, 'checks; fixture data retained at', data);
} catch (error) { console.error('FAIL', error); console.error('Recent core logs:', logs.slice(-8).join('\n')); console.error('Request diagnostics:', JSON.stringify(requests.slice(-2).map(body => ({ model: body.model, user: body.messages?.map(message => ({ role: message.role, text: JSON.stringify(message.content).slice(0, 150), cases: JSON.stringify(message.content).match(/case:[\w-]+/g) })) })), null, 2)); console.error('Fixture:', data); process.exitCode = 1; }
finally { socket?.close(); await handle.close(); await new Promise(resolve => fixtureModel.close(resolve)); }
