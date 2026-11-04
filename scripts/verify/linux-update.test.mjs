import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { manageLinuxUpdate, parseSystemdEnvironment, parseSystemdWorkingDirectory, run } from '../deployment/update-linux.mjs';

const entries = ['dist/server/server/index.js', 'dist/headless/core.cjs', 'dist/headless/conversation-database-worker.js', 'dist/renderer/web/index.html'];
const write = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
const read = file => fs.readFile(file, 'utf8');
const present = file => fs.stat(file).then(() => true, () => false);
const git = (args, cwd) => run('git', args, { cwd, quiet: true });

async function fixture(t, fault = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cyrene-linux-update-')));
  t.after(async () => {
    // Only this test's freshly-created child of the OS temp directory is removed.
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const origin = path.join(root, 'origin'), app = path.join(root, 'app'), data = path.join(root, 'private-data');
  await fs.mkdir(origin); await fs.mkdir(data);
  await git(['init', '--initial-branch=master'], origin);
  await git(['config', 'user.email', 'linux-update-test@example.invalid'], origin);
  await git(['config', 'user.name', 'Update test'], origin);
  await git(['config', 'core.autocrlf', 'false'], origin);
  await write(path.join(origin, '.gitignore'), 'node_modules/\n.browsers/\ndist/*\n!dist/asset.txt\n');
  await write(path.join(origin, 'package.json'), '{"packageManager":"pnpm@10.33.0"}\n');
  await write(path.join(origin, 'source.txt'), 'old source'); await write(path.join(origin, 'dist/asset.txt'), 'old asset');
  await git(['add', '.'], origin); await git(['commit', '-m', 'old'], origin);
  const oldCommit = await git(['rev-parse', 'HEAD'], origin);
  await git(['-c', 'core.autocrlf=false', 'clone', origin, app], root); await git(['config', 'core.autocrlf', 'false'], app);
  for (const entry of entries) await write(path.join(app, entry), 'old runtime');
  await write(path.join(app, 'node_modules/runtime.txt'), 'old dependencies');
  await write(path.join(data, 'conversation.txt'), 'old private conversation');
  await write(path.join(data, 'cyrene.sqlite-wal'), 'old WAL');
  await write(path.join(origin, 'source.txt'), 'new source'); await write(path.join(origin, 'dist/asset.txt'), 'new asset');
  await git(['add', '.'], origin); await git(['commit', '-m', 'new'], origin);
  const newCommit = await git(['rev-parse', 'HEAD'], origin);
  const calls = []; let active = true, newVerifyFailed = false, interrupted = false;
  const config = { appDir: app, dataDir: data, browserDir: path.join(app, '.browsers'), port: 4317 };
  const deps = {
    git,
    inspect: async () => ({ ...config }),
    active: async () => active,
    stop: async () => { calls.push('stop'); active = false; },
    start: async () => {
      calls.push('start'); active = true;
      if (fault.migrate && await git(['rev-parse', 'HEAD'], app) === newCommit) await write(path.join(data, 'conversation.txt'), 'new migration and conversation');
    },
    copyData: async (source, destination) => {
      assert.equal(active, false, 'data is copied only while service is stopped'); calls.push('copy');
      if (fault.backup && source === data) throw new Error('backup failed');
      await fs.cp(source, destination, { recursive: true, preserveTimestamps: true });
      if (fault.interruptAfterBackup) interrupted = true;
    },
    schemaVersions: async () => ({ 'cyrene.sqlite': 1 }),
    prepare: async stage => {
      calls.push('prepare'); assert.equal(active, true, 'old service runs throughout build');
      assert.equal(await read(path.join(app, entries[0])), 'old runtime');
      assert.equal(await git(['rev-parse', 'HEAD'], app), oldCommit);
      assert.equal(await read(path.join(stage, 'source.txt')), 'new source');
      if (fault.build) throw new Error('network/build failed');
      for (const entry of entries) await write(path.join(stage, entry), 'new runtime');
      if (!fault.missingDependencies) await write(path.join(stage, 'node_modules/runtime.txt'), 'new dependencies');
      if (fault.concurrentEdit) await write(path.join(app, 'new-user-file.txt'), 'keep me');
    },
    verify: async (_service, _port, options) => {
      assert.equal(active, true); calls.push('verify');
      const current = await git(['rev-parse', 'HEAD'], app);
      if (current === newCommit && fault.startup && !newVerifyFailed) { newVerifyFailed = true; throw new Error('core not ready'); }
      if (current === oldCommit) assert.equal(options?.legacy, true);
      else assert.equal(options?.legacy, undefined);
    },
    abortRequested: () => fault.interrupt || interrupted,
    log: () => {},
  };
  const stateRoot = path.join(root, '.cyrene-updates-app');
  const record = async () => { const { id } = JSON.parse(await read(path.join(stateRoot, 'latest.json'))); return { directory: path.join(stateRoot, id), state: JSON.parse(await read(path.join(stateRoot, id, 'record.json'))) }; };
  const update = options => manageLinuxUpdate({ repo: app, ...options }, deps);
  const assertOld = async () => {
    assert.equal(active, true);
    assert.equal(await git(['rev-parse', 'HEAD'], app), oldCommit);
    assert.equal(await git(['branch', '--show-current'], app), 'master');
    assert.equal(await read(path.join(app, 'source.txt')), 'old source');
    assert.equal(await read(path.join(app, 'dist/asset.txt')), 'old asset');
    assert.equal(await read(path.join(app, entries[0])), 'old runtime');
    assert.equal(await read(path.join(app, 'node_modules/runtime.txt')), 'old dependencies');
    assert.equal(await read(path.join(data, 'conversation.txt')), 'old private conversation');
    assert.equal(await read(path.join(data, 'cyrene.sqlite-wal')), 'old WAL');
  };
  return { root, app, data, config, calls, stateRoot, record, update, assertOld, oldCommit, newCommit };
}

test('systemd environment parser retains quoted spaces and never executes expansion', () => {
  assert.deepEqual(parseSystemdEnvironment('"CYRENE_DATA_DIR=/srv/private data" CYRENE_WEB_PORT=4317 "NOTE=$(touch /tmp/no)"'), {
    CYRENE_DATA_DIR: '/srv/private data', CYRENE_WEB_PORT: '4317', NOTE: '$(touch /tmp/no)',
  });
});

test('systemd WorkingDirectory must be an absolute normalized path', () => {
  assert.equal(parseSystemdWorkingDirectory('/srv/cyrene/../cyrene-agent'), '/srv/cyrene-agent');
  assert.throws(() => parseSystemdWorkingDirectory('~/cyrene-agent'), /绝对路径/);
  assert.throws(() => parseSystemdWorkingDirectory(''), /绝对路径/);
});

test('isolated build, stopped consistent snapshot and ready check finish a recorded update', async t => {
  const f = await fixture(t); const result = await f.update();
  assert.equal(result.phase, 'complete'); assert.equal(result.oldCommit, f.oldCommit); assert.equal(result.newCommit, f.newCommit);
  assert.deepEqual(f.calls, ['prepare', 'stop', 'copy', 'start', 'verify']);
  assert.equal(await git(['rev-parse', 'HEAD'], f.app), f.newCommit);
  assert.equal(await read(path.join(f.app, entries[0])), 'new runtime');
  const { directory, state } = await f.record();
  assert.equal(await read(path.join(directory, 'data/cyrene.sqlite-wal')), 'old WAL');
  assert.equal(await read(path.join(directory, 'runtime/node_modules/runtime.txt')), 'old dependencies');
  assert.match(state.artifactSha256[entries[0]], /^[a-f0-9]{64}$/);
  assert.deepEqual(state.schemaVersions, { 'cyrene.sqlite': 1 });
  assert.equal(await present(path.join(f.stateRoot, 'lock.json')), false);
});

test('installation/download failure leaves the original process and files untouched', async t => {
  const f = await fixture(t, { build: true }); await assert.rejects(f.update(), /network\/build failed/);
  await f.assertOld(); assert.deepEqual(f.calls, ['prepare']);
  assert.equal((await f.record()).state.phase, 'prepare_failed');
});

test('interruption before cutover keeps the service online', async t => {
  const f = await fixture(t, { interrupt: true }); await assert.rejects(f.update(), /中断/);
  await f.assertOld(); assert.deepEqual(f.calls, ['prepare']);
});

test('a failed consistent backup restarts old service without switching source', async t => {
  const f = await fixture(t, { backup: true }); await assert.rejects(f.update(), /backup failed/);
  await f.assertOld(); assert.deepEqual(f.calls, ['prepare', 'stop', 'copy', 'start', 'verify']);
  assert.equal((await f.record()).state.phase, 'rolled_back');
});

test('interruption after backup and a partially failed artifact switch restore the original runtime', async t => {
  const interrupted = await fixture(t, { interruptAfterBackup: true });
  await assert.rejects(interrupted.update(), /中断/); await interrupted.assertOld();
  const partial = await fixture(t, { missingDependencies: true });
  await assert.rejects(partial.update(), /ENOENT/); await partial.assertOld();
  assert.equal((await partial.record()).state.phase, 'rolled_back');
});

test('failed new core restores the exact old commit, generated runtime, tracked resources and data', async t => {
  const f = await fixture(t, { startup: true, migrate: true }); await assert.rejects(f.update(), /core not ready/);
  await f.assertOld(); const { state } = await f.record();
  assert.equal(state.phase, 'rolled_back'); assert.equal(state.dataRestored, true);
  assert.equal(await read(path.join(state.failedData, 'conversation.txt')), 'new migration and conversation');
});

test('manual rollback uses recorded old commit and requires explicit old-data restoration', async t => {
  const f = await fixture(t, { migrate: true }); await f.update();
  await assert.rejects(f.update({ action: 'rollback' }), /restore-data/);
  await assert.rejects(f.update({ action: 'recover' }), /升级已完成/);
  await f.update({ action: 'rollback', restoreData: true }); await f.assertOld();
});

test('recovery resumes an interrupted data rename without overwriting failed-version data', async t => {
  const f = await fixture(t, { migrate: true }); await f.update();
  const { directory, state } = await f.record();
  const restore = path.join(f.root, `.cyrene-restore-${state.id}`), failed = path.join(f.root, `.cyrene-failed-data-${state.id}`);
  await fs.cp(path.join(directory, 'data'), restore, { recursive: true });
  await fs.rename(f.data, failed); state.phase = 'recovery_required';
  await write(path.join(directory, 'record.json'), JSON.stringify(state));
  await f.update({ action: 'recover' }); await f.assertOld();
  assert.equal(await read(path.join(failed, 'conversation.txt')), 'new migration and conversation');
});

test('dirty source, new user files during build and overlapping private-data paths block cutover', async t => {
  const f = await fixture(t); await write(path.join(f.app, 'source.txt'), 'user edit');
  await assert.rejects(f.update(), /未提交/); assert.deepEqual(f.calls, []);
  await git(['restore', '--', 'source.txt'], f.app); f.config.dataDir = f.root;
  await assert.rejects(f.update(), /数据目录必须独立/); assert.deepEqual(f.calls, []);
  const concurrent = await fixture(t, { concurrentEdit: true });
  await assert.rejects(concurrent.update(), /构建期间源码发生变化/); await concurrent.assertOld();
  assert.equal(await read(path.join(concurrent.app, 'new-user-file.txt')), 'keep me');
});

test('live updater lock prevents a second updater; untracked models are preserved', async t => {
  const f = await fixture(t); await fs.mkdir(f.stateRoot);
  await write(path.join(f.stateRoot, 'lock.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.update(), /另一个升级进程/); assert.deepEqual(f.calls, []);
  await fs.unlink(path.join(f.stateRoot, 'lock.json'));
  await write(path.join(f.app, 'models/local-model.bin'), 'private model'); await f.update();
  assert.equal(await read(path.join(f.app, 'models/local-model.bin')), 'private model');
});

test('rollback refuses new source edits before stopping the successful service', async t => {
  const f = await fixture(t); await f.update(); const previousCalls = [...f.calls];
  await write(path.join(f.app, 'source.txt'), 'new user work');
  await assert.rejects(f.update({ action: 'rollback', restoreData: true }), /源码存在新修改/);
  assert.deepEqual(f.calls, previousCalls);
  assert.equal(await read(path.join(f.app, 'source.txt')), 'new user work');
  assert.equal(await read(path.join(f.app, entries[0])), 'new runtime');
});

test('a managed artifact junction/symlink is rejected before it can affect external files', async t => {
  const f = await fixture(t); const external = path.join(f.root, 'outside-runtime');
  await fs.rename(path.join(f.app, 'node_modules'), external);
  await fs.symlink(external, path.join(f.app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.update(), /符号链接/); assert.deepEqual(f.calls, []);
  assert.equal(await read(path.join(external, 'runtime.txt')), 'old dependencies');
});

test('cancelable build subprocess rejects on abort', async () => {
  const controller = new AbortController();
  const promise = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { quiet: true, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, /中断/);
});
