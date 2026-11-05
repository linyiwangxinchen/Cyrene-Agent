#!/usr/bin/env node
// Build in isolation, then stop/backup/switch. No credentials are copied into releases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ARTIFACTS = ['dist', 'node_modules'];
const ENTRY_FILES = ['dist/server/server/index.js', 'dist/headless/core.cjs', 'dist/headless/conversation-database-worker.js', 'dist/renderer/web/index.html'];
const TERMINAL = new Set(['complete', 'rolled_back', 'prepare_failed']);
const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a);

async function atomicJson(file, value) {
  const temporary = file + '.tmp';
  const handle = await fs.open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
  if (process.platform === 'linux') {
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export function parseSystemdEnvironment(value) {
  const tokens = value.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? [];
  return Object.fromEntries(tokens.map(token => {
    const text = token.replace(/^"|"$/g, '').replace(/\\(["\\ ])/g, '$1');
    const at = text.indexOf('='); return at < 1 ? null : [text.slice(0, at), text.slice(at + 1)];
  }).filter(Boolean));
}

export function parseSystemdWorkingDirectory(value) {
  // systemd paths always use Linux/POSIX syntax, even when the fixture is
  // inspected from Windows CI.
  if (!value || !path.posix.isAbsolute(value)) throw new Error('systemd WorkingDirectory 必须是绝对路径');
  return path.posix.normalize(value);
}

export function run(command, args, { cwd, env, quiet = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('更新已中断'));
    const grouped = process.platform === 'linux' && Boolean(signal);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let forceTimer;
    const terminate = type => { try { if (grouped && child.pid) process.kill(-child.pid, type); else child.kill(type); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const onAbort = () => { terminate('SIGTERM'); forceTimer = setTimeout(() => terminate('SIGKILL'), 5000); forceTimer.unref(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', bytes => { stdout += bytes; if (!quiet) process.stdout.write(bytes); });
    child.stderr.on('data', bytes => { stderr += bytes; if (!quiet) process.stderr.write(bytes); });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort); clearTimeout(forceTimer);
      if (signal?.aborted) return reject(new Error('更新已中断'));
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} 退出 ${code}${quiet ? ': ' + stderr.slice(-1000) : ''}`));
    });
  });
}

export function productionDependencies(signal) {
  const systemctl = async (...args) => process.getuid?.() === 0
    ? run('systemctl', args, { quiet: true }) : run('sudo', ['systemctl', ...args], { quiet: true });
  return {
    abortRequested: () => signal?.aborted,
    git: (args, cwd) => run('git', args, { cwd, quiet: true }),
    inspect: async service => {
      const [rawAppDir, rawEnv, rawExec] = await Promise.all(['WorkingDirectory', 'Environment', 'ExecStart'].map(property => systemctl('show', service, '--value', `--property=${property}`)));
      const appDir = parseSystemdWorkingDirectory(rawAppDir);
      const env = parseSystemdEnvironment(rawEnv);
      const node = /(?:^|\s)path=([^;]+?)\s*;/.exec(rawExec)?.[1];
      if (!node || !path.isAbsolute(node)) throw new Error('无法确认 systemd 的 Node 路径；请使用教程中的直接 Node ExecStart 配置');
      const version = await run(node, ['--version'], { quiet: true });
      if (!/^v24\./.test(version) || !/^v24\./.test(process.version)) throw new Error('构建与服务使用的 Node 必须是 24.x');
      if (!rawExec.includes(path.join(appDir, 'dist/server/server/index.js'))) throw new Error('ExecStart 必须使用当前 Clone 的 dist/server/server/index.js');
      if (env.CYRENE_WEB_HOST && !['0.0.0.0', '127.0.0.1', 'localhost', '::'].includes(env.CYRENE_WEB_HOST)) throw new Error('自动就绪检查要求服务可通过本机 127.0.0.1 访问');
      return { appDir, dataDir: env.CYRENE_DATA_DIR, browserDir: env.PLAYWRIGHT_BROWSERS_PATH || path.join(appDir, '.browsers'), port: Number(env.CYRENE_WEB_PORT || 4317) };
    },
    active: async service => (await systemctl('is-active', service).catch(() => 'inactive')) === 'active',
    stop: service => systemctl('stop', service),
    start: service => systemctl('start', service),
    copyData: async (source, destination) => {
      await run('cp', ['-a', '--', source, destination], { quiet: true });
      await run('sync', ['-f', '--', destination], { quiet: true });
    },
    schemaVersions: async directory => {
      const versions = {};
      const { DatabaseSync } = await import('node:sqlite');
      for (const name of await fs.readdir(directory)) {
        if (!name.endsWith('.sqlite') || !(await fs.lstat(path.join(directory, name))).isFile()) continue;
        const database = new DatabaseSync(path.join(directory, name), { readOnly: true });
        try { versions[name] = database.prepare('PRAGMA user_version').get().user_version; }
        finally { database.close(); }
      }
      return versions;
    },
    prepare: async (directory, browserDir) => {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.packageManager !== 'pnpm@10.33.0') throw new Error('目标版本已更换 pnpm，请先更新部署工具，未停止现有服务');
      const env = { ELECTRON_SKIP_BINARY_DOWNLOAD: '1', PLAYWRIGHT_BROWSERS_PATH: browserDir, PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
      await run('corepack', ['pnpm@10.33.0', 'install', '--frozen-lockfile'], { cwd: directory, env, signal });
      for (const task of ['check:server', 'check:renderer', 'build:web']) await run('corepack', ['pnpm@10.33.0', 'run', task], { cwd: directory, env, signal });
      await run(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium'], { cwd: directory, env, signal });
      const mcpCli = await run(process.execPath, ['-e', 'const p=require("node:path");const r=require("node:module").createRequire(require.resolve("@playwright/mcp/package.json"));process.stdout.write(p.join(p.dirname(r.resolve("playwright/package.json")),"cli.js"))'], { cwd: directory, quiet: true });
      await run(process.execPath, [mcpCli, 'install', 'chromium'], { cwd: directory, env, signal });
    },
    verify: async (service, port, { legacy = false } = {}) => {
      // New releases must answer the shared-core readiness probe. Only an old
      // rollback target may lack it; no probe sends a paid request or channel message.
      let consecutive = 0, previousPid;
      for (let attempt = 0; attempt < 30; attempt++) {
        const active = await systemctl('is-active', service).catch(() => 'inactive');
        const pid = await systemctl('show', service, '--value', '--property=MainPID').catch(() => '0');
        const healthy = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000), redirect: 'error' }).then(async response => {
          if (response.status === 404 && legacy) {
            const old = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
            return old.ok && (await old.json()).ok === true;
          }
          return response.ok && (await response.json()).ready === true;
        }).catch(() => false);
        consecutive = active === 'active' && pid !== '0' && healthy ? (pid === previousPid ? consecutive + 1 : 1) : 0;
        previousPid = pid;
        if (consecutive >= 3) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('服务未通过持续存活/共享核心就绪检查');
    },
    log: message => console.log(message),
  };
}

/** Public for filesystem/process failure-injection tests; no test hooks in CLI. */
export async function manageLinuxUpdate(options = {}, deps = productionDependencies()) {
  const appDir = await fs.realpath(options.repo ?? process.cwd());
  const service = options.service ?? 'cyrene-web';
  if (!/^[a-zA-Z0-9_.@-]+$/.test(service)) throw new Error('无效 systemd 服务名称');
  const stateRoot = path.join(path.dirname(appDir), `.cyrene-updates-${path.basename(appDir)}`);
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if (await fs.realpath(stateRoot) !== stateRoot) throw new Error('升级记录目录不能是符号链接');
  if (process.platform === 'linux') await fs.chmod(stateRoot, 0o700);
  const lock = path.join(stateRoot, 'lock.json');
  if (await exists(lock)) {
    const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('升级锁损坏，请人工检查 lock.json');
    let live = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
    if (live) throw new Error('另一个升级进程仍在运行');
    await fs.unlink(lock);
  }
  const handle = await fs.open(lock, 'wx', 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
  let state, recordDir, switched = false, stopAttempted = false;
  const latestFile = path.join(stateRoot, 'latest.json');
  const save = async phase => {
    state.phase = phase; state.updatedAt = new Date().toISOString();
    await atomicJson(path.join(recordDir, 'record.json'), state);
    await atomicJson(latestFile, { id: state.id });
    deps.log(`升级阶段: ${phase}`);
  };
  const stageDir = () => path.join(recordDir, 'build');
  const backupDir = () => path.join(recordDir, 'data');
  const oldRuntime = () => path.join(recordDir, 'runtime');
  const checkAbort = () => { if (deps.abortRequested?.()) throw new Error('更新已中断，正在保留或恢复旧版本'); };
  const restoreTrackedArtifacts = async () => {
    if (await deps.git(['ls-files', '--', 'dist'], appDir)) await deps.git(['restore', '--worktree', '--', 'dist'], appDir);
  };
  const cleanStage = async () => {
    if (recordDir && await exists(stageDir())) await deps.git(['worktree', 'remove', '--force', stageDir()], appDir).catch(() => {});
  };
  const validateConfig = async () => {
    const config = await deps.inspect(service);
    if (!config.appDir || await fs.realpath(config.appDir) !== appDir) throw new Error('当前 Clone 目录与 systemd WorkingDirectory 不一致');
    if (!config.dataDir || !path.isAbsolute(config.dataDir)) throw new Error('服务必须配置绝对路径 CYRENE_DATA_DIR');
    const configuredDataDir = path.resolve(config.dataDir);
    config.dataDir = await fs.realpath(config.dataDir).catch(error => {
      if (error.code === 'ENOENT' && options.action === 'recover') return configuredDataDir;
      throw error;
    });
    if (config.dataDir !== configuredDataDir) throw new Error('CYRENE_DATA_DIR 请直接配置真实路径，不使用符号链接');
    if (config.dataDir === path.parse(config.dataDir).root || overlaps(config.dataDir, appDir) || overlaps(config.dataDir, stateRoot)) throw new Error('数据目录必须独立于源码和升级目录，不能是文件系统根目录');
    if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Web 端口无效');
    if (!path.isAbsolute(config.browserDir)) throw new Error('浏览器目录必须是绝对路径');
    const browserPath = await fs.realpath(config.browserDir).catch(error => { if (error.code === 'ENOENT') return path.resolve(config.browserDir); throw error; });
    if (overlaps(config.dataDir, browserPath) || overlaps(stateRoot, browserPath) || ARTIFACTS.some(name => overlaps(path.join(appDir, name), browserPath))) throw new Error('浏览器目录必须独立于数据、升级记录和 dist/node_modules');
    config.browserDir = browserPath;
    return config;
  };
  const rollback = async config => {
    const head = await deps.git(['rev-parse', 'HEAD'], appDir);
    if (![state.oldCommit, state.newCommit].includes(head)) throw new Error('仓库已被其他操作修改，不自动覆盖；请依据 record.json 恢复');
    const changes = (await deps.git(['diff', '--name-only', 'HEAD'], appDir)).split('\n').filter(Boolean);
    if (changes.some(file => !file.startsWith('dist/'))) throw new Error('源码存在新修改，未覆盖；请保留修改后再恢复');
    await save('rolling_back');
    await deps.stop(service);
    if (await deps.active(service)) throw new Error('服务未完全停止，不能回退数据');
    // Generated files can legitimately differ by EOL; move the entire new
    // runtime aside first. Restore tracked source with Git's non-destructive merge reset.
    for (const name of ARTIFACTS) {
      const saved = path.join(oldRuntime(), name);
      if (!await exists(saved)) continue;
      const current = path.join(appDir, name), failed = path.join(recordDir, `failed-${name}`);
      if (await exists(current)) {
        const destination = await exists(failed) ? path.join(recordDir, `partial-${name}-${randomUUID()}`) : failed;
        await fs.rename(current, destination);
      }
    }
    // Restore managed tracked assets before reset --merge. Unmanaged user edits
    // remain protected by Git and can cause a safe rollback failure.
    await restoreTrackedArtifacts();
    await deps.git(['reset', '--merge', state.oldCommit], appDir);
    for (const name of ARTIFACTS) {
      const saved = path.join(oldRuntime(), name);
      if (!await exists(saved)) continue;
      const current = path.join(appDir, name);
      if (await exists(current)) await fs.rm(current, { recursive: true }); // only Git-restored managed artifacts
      await fs.rename(saved, current);
    }
    // The forward Git merge may have updated bundled tracked resources before
    // dist was parked. Restore their exact old content as well as the old JS.
    await restoreTrackedArtifacts();
    if (state.startedNew && !state.dataRestored && await exists(backupDir())) {
      const restore = path.join(path.dirname(config.dataDir), `.cyrene-restore-${state.id}`);
      const failedData = path.join(path.dirname(config.dataDir), `.cyrene-failed-data-${state.id}`);
      if (await exists(failedData)) {
        // Resume a crash between the two atomic renames, or immediately after them.
        if (!await exists(config.dataDir) && await exists(restore)) await fs.rename(restore, config.dataDir);
        else if (!await exists(config.dataDir) || await exists(restore)) throw new Error('数据恢复状态不明确，保留材料供人工检查');
      } else {
        // A previous interrupted cp may be incomplete. Recreate only this known
        // transaction's temporary copy; never remove live data or the backup.
        if (await exists(restore)) await fs.rm(restore, { recursive: true });
        await deps.copyData(backupDir(), restore);
        await fs.rename(config.dataDir, failedData);
        await fs.rename(restore, config.dataDir);
      }
      state.failedData = failedData;
      state.dataRestored = true; await save('rolling_back');
    }
    await deps.start(service); await deps.verify(service, config.port, { legacy: true });
    await save('rolled_back');
    deps.log(`已恢复确定的旧版本 ${state.oldCommit}；升级记录: ${recordDir}`);
  };
  try {
    const config = await validateConfig();
    if (path.resolve(await deps.git(['rev-parse', '--show-toplevel'], appDir)) !== appDir) throw new Error('请在 Git Clone 根目录执行');
    if (!await fs.stat(path.join(appDir, '.git')).then(s => s.isDirectory()).catch(() => false)) throw new Error('更新入口需要独立 Clone，不能是 linked worktree');
    const action = options.action ?? 'update';
    if (await exists(latestFile)) {
      const latest = JSON.parse(await fs.readFile(latestFile, 'utf8'));
      if (!/^[a-zA-Z0-9-]+$/.test(latest.id)) throw new Error('升级记录编号无效');
      recordDir = path.join(stateRoot, latest.id);
      state = JSON.parse(await fs.readFile(path.join(recordDir, 'record.json'), 'utf8'));
      if (state.id !== latest.id || state.appDir !== appDir || state.dataDir !== config.dataDir || state.service !== service || !/^[a-f0-9]{40,64}$/.test(state.oldCommit) || !/^[a-f0-9]{40,64}$/.test(state.newCommit)) throw new Error('升级记录与当前服务不匹配');
      if (action === 'rollback' || action === 'recover') {
        if (action === 'recover' && state.phase === 'complete') throw new Error('升级已完成；如需回退请使用 rollback --restore-data');
        if (state.phase === 'rolled_back') { deps.log('该升级已经回退'); return state; }
        if (action === 'rollback' && !options.restoreData) throw new Error('回退会恢复升级前数据；新数据会另存。请明确添加 --restore-data');
        if (!state.stopAttempted) { await cleanStage(); await save('prepare_failed'); return state; }
        if (!state.backupComplete) { await deps.start(service); await deps.verify(service, config.port, { legacy: true }); await save('rolled_back'); return state; }
        await rollback(config); await cleanStage(); return state;
      }
      if (!TERMINAL.has(state.phase)) throw new Error('检测到未完成升级。先执行 recover，恢复到已知版本后再更新');
    } else if (action !== 'update') throw new Error('没有可恢复的升级记录');
    if (action !== 'update') throw new Error('未知操作');
    for (const name of ARTIFACTS) {
      const stat = await fs.lstat(path.join(appDir, name));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} 必须为本地运行目录，不能是符号链接`);
    }
    const branch = options.branch ?? 'master';
    if (!/^[a-zA-Z0-9_./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('分支名称无效');
    const remote = options.remote ?? 'origin';
    if (!/^[a-zA-Z0-9_./:@+-]+$/.test(remote) || remote.startsWith('-')) throw new Error('远程名称或地址无效');
    if (await deps.git(['branch', '--show-current'], appDir) !== branch) throw new Error(`请切换到 ${branch} 分支后更新`);
    const dirty = await deps.git(['status', '--porcelain=v1', '--untracked-files=all'], appDir);
    if (dirty.split('\n').filter(Boolean).some(line => !/^\?\? models\//.test(line))) throw new Error('存在未提交源码/配置修改；先保存。仅 models/ 下未跟踪模型可保留');
    if (!await deps.active(service)) throw new Error('服务当前未运行，请先确认旧版本可以正常启动');
    await deps.git(['fetch', remote, branch], appDir);
    const oldCommit = await deps.git(['rev-parse', 'HEAD'], appDir), newCommit = await deps.git(['rev-parse', 'FETCH_HEAD^{commit}'], appDir);
    await deps.git(['merge-base', '--is-ancestor', oldCommit, newCommit], appDir);
    if (oldCommit === newCommit) { deps.log('当前源码已是目标版本'); return { phase: 'unchanged' }; }
    const id = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
    recordDir = path.join(stateRoot, id); await fs.mkdir(recordDir, { mode: 0o700 });
    state = { version: 1, id, appDir, dataDir: config.dataDir, service, remote, branch, oldCommit, newCommit, createdAt: new Date().toISOString(), stopAttempted: false, backupComplete: false, startedNew: false };
    await fs.copyFile(fileURLToPath(import.meta.url), path.join(stateRoot, 'updater.mjs'));
    await save('building');
    await deps.git(['worktree', 'add', '--detach', stageDir(), newCommit], appDir);
    await deps.prepare(stageDir(), config.browserDir);
    checkAbort();
    state.artifactSha256 = Object.fromEntries(await Promise.all(ENTRY_FILES.map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(stageDir(), name))).digest('hex')])));
    // Recheck immediately before downtime; do not overwrite edits made during a long build.
    const changed = (await deps.git(['status', '--porcelain=v1', '--untracked-files=all'], appDir)).split('\n').filter(Boolean).some(line => !/^\?\? models\//.test(line));
    if (await deps.git(['rev-parse', 'HEAD'], appDir) !== oldCommit || changed) throw new Error('构建期间源码发生变化，取消切换，旧服务继续运行');
    await save('prepared');
    state.stopAttempted = stopAttempted = true; await save('stopping');
    await deps.stop(service);
    if (await deps.active(service)) throw new Error('服务未完全停止，不能备份或切换');
    await deps.copyData(config.dataDir, backupDir());
    state.backupComplete = true; await save('backup_complete');
    state.schemaVersions = await deps.schemaVersions?.(backupDir()) ?? {};
    checkAbort();
    await fs.mkdir(oldRuntime());
    await save('switching');
    // Git switches only known tracked files. User model caches and browser revisions stay put.
    await deps.git(['merge', '--ff-only', newCommit], appDir); switched = true;
    for (const name of ARTIFACTS) {
      const current = path.join(appDir, name);
      if (!await exists(current) || (await fs.lstat(current)).isSymbolicLink()) throw new Error(`${name} 必须为本地运行目录，不能是符号链接`);
      await fs.rename(current, path.join(oldRuntime(), name));
      await fs.rename(path.join(stageDir(), name), current);
      checkAbort();
    }
    state.startedNew = true; await save('starting');
    await deps.start(service); await deps.verify(service, config.port);
    checkAbort();
    await save('complete'); await cleanStage();
    deps.log(`更新成功 ${newCommit}；数据与旧运行文件保存在 ${recordDir}`);
    return state;
  } catch (error) {
    if (state && (stopAttempted || switched)) {
      try {
        if (state.backupComplete) await rollback(await validateConfig());
        else { await deps.start(service); await deps.verify(service, (await validateConfig()).port, { legacy: true }); await save('rolled_back'); }
      } catch (recoveryError) { state.recoveryError = String(recoveryError.message); await save('recovery_required'); deps.log(`自动回退未完成，保留全部材料: ${recordDir}`); }
    } else if (state?.phase === 'building' || state?.phase === 'prepared') await save('prepare_failed');
    await cleanStage();
    throw error;
  } finally { await fs.unlink(lock).catch(() => {}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux') { console.error('此工具只用于 Linux systemd 部署'); process.exitCode = 1; }
  else {
    const args = process.argv.slice(2), options = { action: args.shift() || 'update' };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--restore-data') options.restoreData = true;
      else if (['--repo', '--service', '--remote', '--branch'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else throw new Error(`未知参数: ${args[i]}`);
    }
    const controller = new AbortController();
    const cancel = () => { console.error('收到中断，正在结束构建或恢复旧版本；请等待恢复完成。'); controller.abort(); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    manageLinuxUpdate(options, productionDependencies(controller.signal)).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); });
  }
}
