import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const data = mkdtempSync(path.join(os.tmpdir(), 'cyrene-shared-core-'));
console.log('Isolated data:', data);
const child = fork('dist/headless/core.cjs', [], { env: { ...process.env, CYRENE_HEADLESS: '1', CYRENE_APP_ROOT: process.cwd(), CYRENE_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout.on('data', b => process.stdout.write(b)); child.stderr.on('data', b => process.stderr.write(b));
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
child.on('message', message => {
  if (message.type === 'ready') { console.log('READY', message.capabilities.handlers.length, 'handlers'); mkdirSync('docs/verification', { recursive: true }); writeFileSync('docs/verification/shared-core-capabilities.json', JSON.stringify({at:new Date().toISOString(), ...message.capabilities}, null, 2)); child.send({ type: 'shutdown' }); }
  if (message.type === 'failed') { console.error(message.error); process.exitCode = 1; }
});
child.on('exit', code => { clearTimeout(timeout); if (code) process.exitCode = code; });
