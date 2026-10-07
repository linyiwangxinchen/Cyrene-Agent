// Assemble a portable Web release without machine-specific dependencies or data.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, cp, access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!output) throw new Error('Usage: node scripts/packaging/create-web-runtime.mjs <new-directory-outside-repository>');
const relative = path.relative(root, output);
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
  throw new Error('Release directory must be outside the source repository');
}
try { await access(output); throw new Error('Release directory already exists; choose a new directory'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

for (const required of ['dist/server/server/index.js', 'dist/headless/core.cjs', 'dist/headless/knowledge-index-worker.js', 'dist/plugin-panel', 'dist/renderer/web/index.html', 'dist/renderer/avatars/cyrene-avatar.png', 'prompts/chat_identity.md']) {
  await access(path.join(root, required));
}
// Product assets under dist/renderer are source files in the upstream repository.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const sources = tracked.filter(file => /^(prompts|skills|resources|vendor|packages|deploy)\//.test(file)
  || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', 'MODEL_LICENSE.md', 'THIRD_PARTY_NOTICES.md'].includes(file)
  || file.startsWith('LICENSES/'));
await mkdir(output, { recursive: true });
for (const rel of sources) {
  const dest = path.join(output, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(path.join(root, rel), dest);
}
for (const rel of ['deploy', 'dist/server', 'dist/headless', 'dist/plugin-panel', 'dist/renderer']) {
  await cp(path.join(root, rel), path.join(output, rel), {
    recursive: true,
    filter: file => !file.endsWith('.map') && !/\.test\.(?:js|cjs|mjs)$/.test(file),
  });
}
await writeFile(path.join(output, 'WEB-RELEASE.txt'), [
  'Cyrene Web runtime release',
  'Install Node.js 24.x and pnpm 10.33.0 on the target Linux machine.',
  'Run: pnpm install --prod --frozen-lockfile',
  'Install Playwright Chromium and OS dependencies on the target Linux machine.',
  'Run from this directory: node dist/server/server/index.js',
  'Set CYRENE_DATA_DIR to a separate persistent directory; configure HTTPS for remote use.',
  'No node_modules, browser binaries, credentials or user data are included.',
  '',
].join('\n'));
console.log(`Web release created: ${output}`);
