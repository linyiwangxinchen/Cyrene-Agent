import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const protectedFiles = [
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/server/index.ts',
  'src/server/shared-core-client.ts',
  'src/server/core/runtime.ts',
  'src/server/core/worker.ts',
  'src/server/core/platform.ts',
  'src/renderer/web/main.tsx',
  'src/renderer/web/core-transport.ts',
  'src/renderer/web/WebAuthGate.tsx',
  'scripts/build/headless-core.mjs',
  'tsconfig.server.json',
  'docs/deployment/linux-web.md',
  'docs/deployment/linux-operations.md',
];

async function git(args, acceptedCodes = [0]) {
  try {
    const result = await execFileAsync('git', ['--no-optional-locks', ...args], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (acceptedCodes.includes(error.code)) return error;
    throw new Error(String(error.stderr || error.message).trim());
  }
}

async function resolveCommit(ref) {
  // All later commands receive only validated object IDs, never user options.
  const { stdout } = await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const sha = stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error(`无法解析提交：${ref}`);
  return sha;
}

function contributorJobIsUpstreamOnly(content) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => /^  update-contributors:\s*(?:#.*)?$/.test(line));
  if (start < 0) return false;
  const job = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  [^\s#]/.test(line) || /^[^\s#]/.test(line)) break;
    job.push(line);
  }
  const condition = job.find(line => /^    if:/.test(line));
  if (!condition) return false;
  let expression = condition.slice(condition.indexOf(':') + 1).trim();
  if (expression.startsWith('${{')) {
    if (!expression.endsWith('}}')) return false;
    expression = expression.slice(3, -2).trim();
  }
  return /^github\.repository\s*==\s*(['"])Playa-Cyrene\/Cyrene-Agent\1$/.test(expression);
}

async function inspectGuards(tree) {
  const failures = [];
  for (const file of protectedFiles) {
    const { stdout, code } = await git(['cat-file', '-s', `${tree}:${file}`], [0, 128]);
    if (code !== 0 || Number(stdout.trim()) === 0) failures.push(`关键入口缺失或为空：${file}`);
  }
  const workflow = '.github/workflows/contributors.yml';
  const content = await git(['show', `${tree}:${workflow}`], [0, 128]);
  if (content.code !== 0 || !contributorJobIsUpstreamOnly(content.stdout)) {
    failures.push(`${workflow} 的 update-contributors job 缺少严格的上游仓库条件`);
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('用法：node scripts/verify/upstream-sync.mjs [本地 ref [上游 ref]]');
    console.log('默认：HEAD upstream/master。请先自行 fetch；本命令不 fetch、不切换分支、不合并、不修改索引/工作树。');
    return;
  }
  if (args.length > 2) throw new Error('最多提供两个位置参数：本地 ref 和上游 ref');
  const [leftRef = 'HEAD', rightRef = 'upstream/master'] = args;
  const dirty = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (dirty.stdout) throw new Error('存在未提交修改，请先保存后再预检；不会自动 stash、恢复或丢弃文件。');
  const left = await resolveCommit(leftRef);
  const right = await resolveCommit(rightRef);
  const baseResult = await git(['merge-base', left, right], [0, 1]);
  if (baseResult.code !== 0) throw new Error('两个 ref 没有共同祖先，请人工核对仓库来源。');
  const base = baseResult.stdout.trim();
  const counts = (await git(['rev-list', '--left-right', '--count', `${left}...${right}`])).stdout.trim().split(/\s+/);
  const changed = async sha => new Set((await git(['diff', '--no-renames', '--name-only', '-z', base, sha])).stdout.split('\0').filter(Boolean));
  const localFiles = await changed(left);
  const upstreamFiles = await changed(right);
  const overlap = [...localFiles].filter(file => upstreamFiles.has(file)).sort();
  console.log(`本地：${leftRef} ${left}\n上游：${rightRef} ${right}\n共同祖先：${base}`);
  console.log(`本地独有提交：${counts[0]}；上游独有提交：${counts[1]}`);
  console.log(`双方修改文件：${overlap.length}（重叠不等于冲突）`);
  for (const file of overlap) console.log(`  ${JSON.stringify(file)}`);

  // Git writes temporary objects only. It never updates HEAD, refs or the index.
  // Requires Git >= 2.38; an unsupported Git version fails closed.
  const merged = await git(['merge-tree', '--write-tree', '--name-only', '-z', left, right], [0, 1]);
  const fields = merged.stdout.split('\0');
  const tree = fields.shift();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree || '')) throw new Error('Git 未返回有效合并树，请确认 Git >= 2.38');
  if (merged.code !== 0) {
    console.log('预览结果：存在需要人工解决的合并冲突。');
    for (const file of fields.slice(0, fields.indexOf('') < 0 ? fields.length : fields.indexOf(''))) console.log(`  ${JSON.stringify(file)}`);
  } else {
    console.log('预览结果：Git 可自动合并，没有文本/结构冲突。');
  }
  const failures = await inspectGuards(tree);
  if (failures.length) {
    console.error('适配保护检查失败（若为有意重构，请先审核并更新保护清单）：');
    for (const failure of failures) console.error(`  ${failure}`);
  } else {
    console.log('适配保护检查通过：Windows/Linux/Web 入口存在，贡献者工作流仅允许上游回写。');
  }
  console.log('本命令仅预检；仍需审查语义差异，完成 Windows/Web 类型、构建及功能验收后才能提交/推送。');
  process.exitCode = failures.length ? 3 : merged.code !== 0 ? 2 : 0;
}

main().catch(error => {
  console.error(`上游同步预检失败：${error.message}`);
  process.exitCode = 1;
});
