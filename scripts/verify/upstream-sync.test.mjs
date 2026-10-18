import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./upstream-sync.mjs', import.meta.url));
const fixtures = {
  'src/main/index.ts': 'export const desktop = true;\n',
  'src/preload/index.ts': 'export const preload = true;\n',
  'src/server/index.ts': 'export const server = true;\n',
  'src/server/shared-core-client.ts': 'export const core = true;\n',
  'src/server/core/runtime.ts': 'export const runtime = true;\n',
  'src/server/core/worker.ts': 'export const worker = true;\n',
  'src/server/core/platform.ts': 'export const platform = true;\n',
  'src/renderer/web/main.tsx': 'export const web = true;\n',
  'src/renderer/web/core-transport.ts': 'export const transport = true;\n',
  'src/renderer/web/WebAuthGate.tsx': 'export const auth = true;\n',
  'scripts/build/headless-core.mjs': 'export const build = true;\n',
  'tsconfig.server.json': '{}\n',
  'docs/deployment/linux-web.md': '# Linux Web\n',
  'docs/deployment/linux-operations.md': '# Linux Operations\n',
  '.github/workflows/contributors.yml': `name: contributors
jobs:
  update-contributors:
    if: github.repository == 'Playa-Cyrene/Cyrene-Agent'
    runs-on: ubuntu-latest
    steps: []
`,
  '共同 文档.md': 'base\n',
};

function createRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cyrene-upstream-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (name, content) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  git('init', '-b', 'master');
  git('config', 'user.name', 'Sync preflight test');
  git('config', 'user.email', 'preflight@example.invalid');
  git('config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(fixtures)) write(name, content);
  const commit = message => { git('add', '--all'); git('commit', '-m', message); };
  commit('base');
  git('branch', 'upstream/master');
  const snapshot = () => ({
    head: git('rev-parse', 'HEAD'),
    branch: git('symbolic-ref', 'HEAD'),
    refs: git('show-ref'),
    index: git('ls-files', '--stage', '-z'),
    status: git('status', '--porcelain=v1', '-z'),
    diff: git('diff', '--binary', 'HEAD'),
  });
  const run = (args = []) => {
    const before = snapshot();
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.deepEqual(snapshot(), before, '预检不得改变当前分支、refs、索引或工作树');
    assert.equal(result.signal, null);
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  };
  return { root, git, write, commit, run };
}

test('无冲突合并预览使用默认 refs，保留双端入口且不切分支', t => {
  const repo = createRepo(t);
  repo.write('local.txt', 'local\n');
  repo.commit('local');
  repo.git('checkout', 'upstream/master');
  repo.write('upstream.txt', 'upstream\n');
  repo.commit('upstream');
  repo.git('checkout', 'master');
  const result = repo.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /本地独有提交：1；上游独有提交：1/);
  assert.match(result.output, /Git 可自动合并/);
  assert.match(result.output, /适配保护检查通过/);
});

test('真实内容冲突报告 Unicode 文件名，且不进入真实合并状态', t => {
  const repo = createRepo(t);
  repo.write('共同 文档.md', 'local\n');
  repo.commit('local conflict');
  repo.git('checkout', 'upstream/master');
  repo.write('共同 文档.md', 'upstream\n');
  repo.commit('upstream conflict');
  const result = repo.run(['master', 'upstream/master']);
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /双方修改文件：1/);
  assert.match(result.output, /需要人工解决的合并冲突/);
  assert.match(result.output, /共同 文档\.md/);
  assert.throws(() => repo.git('rev-parse', '--verify', 'MERGE_HEAD'));
});

test('脏工作区拒绝运行，保留未跟踪文件和未提交内容', t => {
  const repo = createRepo(t);
  repo.write('共同 文档.md', 'unsaved\n');
  repo.write('private-notes.txt', 'untracked\n');
  const result = repo.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /存在未提交修改/);
  assert.equal(readFileSync(path.join(repo.root, 'private-notes.txt'), 'utf8'), 'untracked\n');
});

test('没有文本冲突但删除 Web 认证入口时仍阻止通过', t => {
  const repo = createRepo(t);
  repo.git('checkout', 'upstream/master');
  repo.git('rm', 'src/renderer/web/WebAuthGate.tsx');
  repo.commit('remove web auth');
  const result = repo.run(['master', 'upstream/master']);
  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /Git 可自动合并/);
  assert.match(result.output, /关键入口缺失或为空：src\/renderer\/web\/WebAuthGate\.tsx/);
});

test('贡献者工作流的条件被扩大时拒绝通过，不接受注释中的旧条件', t => {
  const repo = createRepo(t);
  repo.git('checkout', 'upstream/master');
  repo.write('.github/workflows/contributors.yml', fixtures['.github/workflows/contributors.yml'].replace(
    "    if: github.repository == 'Playa-Cyrene/Cyrene-Agent'",
    "    # if: github.repository == 'Playa-Cyrene/Cyrene-Agent'\n    if: github.repository != ''",
  ));
  repo.commit('broaden contributor job');
  const result = repo.run(['master', 'upstream/master']);
  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /update-contributors job 缺少严格的上游仓库条件/);
});

test('ref 参数不被解释为 git 选项，也不写入任意路径', t => {
  const repo = createRepo(t);
  const result = repo.run(['--output=unexpected-file', 'upstream/master']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /上游同步预检失败/);
});
