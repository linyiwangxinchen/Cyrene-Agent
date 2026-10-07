import fs from 'node:fs';
import ts from 'typescript';

// Derive contracts from current source, not a developer's historical report.
// Registration is coverage evidence; execution has separate acceptance fixtures.
const capabilityFile = 'docs/verification/shared-core-capabilities.json';
if (!fs.existsSync(capabilityFile)) throw new Error('Run node scripts/verify/shared-core-startup.mjs first');
const capabilities = JSON.parse(fs.readFileSync(capabilityFile, 'utf8'));
const parse = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const unwrap = node => ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;
const keyOf = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : undefined;
const channels = new Map();
function readChannels(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText() === 'IPC' && node.initializer) {
    const object = unwrap(node.initializer);
    for (const member of object.properties ?? []) if (ts.isPropertyAssignment(member) && ts.isStringLiteral(member.initializer)) channels.set(keyOf(member.name), member.initializer.text);
  }
  ts.forEachChild(node, readChannels);
}
readChannels(parse('src/shared/ipc-channels.ts'));
const rows = [];
for (const file of ['src/preload/index.ts', 'src/preload/music.ts', 'src/preload/learn-exam-page.ts']) {
  const source = parse(file), variables = new Map(), exposed = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, unwrap(node.initializer));
    if (ts.isCallExpression(node) && node.expression.getText() === 'contextBridge.exposeInMainWorld' && ts.isStringLiteral(node.arguments[0])) exposed.set(node.arguments[0].text, node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [namespace, expression] of exposed) {
    const object = ts.isIdentifier(expression) ? variables.get(expression.text) : unwrap(expression);
    if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`Unsupported exposed API object: ${file} ${namespace}`);
    for (const member of object.properties) {
      const method = keyOf(member.name);
      if (!method) throw new Error(`Unsupported preload member: ${file} ${member.getText()}`);
      const calls = [];
      function walk(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === 'ipcRenderer') {
          const operation = node.expression.name.text, arg = node.arguments[0];
          if (arg && ts.isPropertyAccessExpression(arg) && arg.expression.getText() === 'IPC') {
            const channel = channels.get(arg.name.text);
            if (!channel) throw new Error(`Unknown IPC constant: ${arg.getText()}`);
            calls.push({ operation, channel });
          } else if (arg && ts.isStringLiteral(arg)) calls.push({ operation, channel: arg.text });
          else if (['invoke', 'send', 'on', 'once'].includes(operation)) throw new Error(`Unresolved IPC call: ${file} ${node.getText()}`);
        }
        ts.forEachChild(node, walk);
      }
      walk(member);
      rows.push({ api: `${namespace}.${method}`, source: `${file}:${source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1}`, calls });
    }
  }
}
const handlers = new Set(capabilities.handlers), listeners = new Set(capabilities.listeners);
for (const row of rows) {
  const incoming = row.calls.filter(call => ['invoke', 'send'].includes(call.operation));
  const rendererPort = row.api.startsWith('openInApp.');
  const deferred = /^(gmail|mailDrafts)\./.test(row.api);
  const desktopOnly = /^(live2dSpeech|live2dAction|live2dDiagnostics|appUpdate)\./.test(row.api)
    || incoming.some(call => /^(window:|app:quit|screenshot:)|^settings:open-chrome-gpu$/.test(call.channel));
  const missing = incoming.filter(call => !(call.operation === 'invoke' ? handlers : listeners).has(call.channel));
  row.status = deferred ? 'deferred-by-scope' : rendererPort ? 'original-renderer-and-event-transport' : desktopOnly ? 'desktop-only-excluded' : missing.length ? 'missing' : incoming.length ? 'shared-core-or-platform-port' : 'original-renderer-and-event-transport';
  if (row.status === 'missing') row.missing = missing;
  if (rendererPort) row.webPort = 'Browse the server workspace via chats:get / chats:open-workspace; native app targets are hidden.';
}
const counts = {}; for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
const report = { at: new Date().toISOString(), engine: capabilities.engine, runtimeHandlers: handlers.size, runtimeListeners: listeners.size, totalPreloadMembers: rows.length, counts, note: 'Derived from current preload source. Includes callbacks and constants. Registration does not imply every external service was exercised.', rows };
fs.writeFileSync('docs/verification/shared-core-contract-coverage.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ totalPreloadMembers: rows.length, counts, runtimeHandlers: handlers.size, runtimeListeners: listeners.size }));
const missing = rows.filter(row => row.status === 'missing');
if (missing.length) { console.error(JSON.stringify(missing, null, 2)); process.exitCode = 1; }
