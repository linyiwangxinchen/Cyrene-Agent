import { access, chmod, copyFile, cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build on native Linux x64; never copy Windows node_modules.');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!output) throw new Error('Usage: node scripts/packaging/create-linux-portable.mjs <new-directory-outside-repository>');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: output, stdio: 'inherit', ...options });
execFileSync(process.execPath, [path.join(source, 'scripts/packaging/create-web-runtime.mjs'), output], { cwd: source, stdio: 'inherit' });
const browserRoot = path.join(output, 'browsers');
const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PLAYWRIGHT_BROWSERS_PATH: browserRoot };
run('pnpm', ['install', '--prod', '--frozen-lockfile'], { env });
const runtime = path.join(output, 'runtime');
await mkdir(runtime);
await copyFile(process.execPath, path.join(runtime, 'node'));
await chmod(path.join(runtime, 'node'), 0o755);
const nodeLicense = path.resolve(path.dirname(await realpath(process.execPath)), '../LICENSE');
await access(nodeLicense);
await copyFile(nodeLicense, path.join(runtime, 'NODE-LICENSE'));
const npmSource = path.resolve(path.dirname(await realpath(process.execPath)), '../lib/node_modules/npm');
await access(path.join(npmSource, 'bin/npm-cli.js'));
await cp(npmSource, path.join(runtime, 'node_modules/npm'), { recursive: true });
await symlink('node_modules/npm/bin/npm-cli.js', path.join(runtime, 'npm'));
await symlink('node_modules/npm/bin/npx-cli.js', path.join(runtime, 'npx'));
const require = createRequire(path.join(output, 'package.json'));
const playwrightRequire = createRequire(require.resolve('playwright/package.json'));
const mcpRequire = createRequire(require.resolve('@playwright/mcp/package.json'));
for (const owner of [playwrightRequire, mcpRequire]) {
  const cli = path.join(path.dirname(owner.resolve('playwright/package.json')), 'cli.js');
  run(path.join(runtime, 'node'), [cli, 'install', 'chromium'], { env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0' } });
}
const packageJson = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
run('gcc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie', '-Wl,-z,relro,-z,now', `-DCYRENE_VERSION="${packageJson.version}"`, path.join(source, 'scripts/packaging/linux-web-launcher.c'), '-o', path.join(output, 'cyrene-web')]);
await chmod(path.join(output, 'cyrene-web'), 0o755);
await writeFile(path.join(output, 'install-system-deps.sh'), '#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ./runtime/node node_modules/playwright/cli.js install-deps chromium\n');
await chmod(path.join(output, 'install-system-deps.sh'), 0o755);
const info = { product: 'Cyrene Web', version: packageJson.version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch, node: process.version, glibcBuild: process.report.getReport().header.glibcVersionRuntime, buildAt: new Date().toISOString(), packaging: 'native ELF launcher plus bundled Node, Linux production dependencies, assets and both Playwright Chromium versions', sourceDirectoryExcluded: true };
await writeFile(path.join(output, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
await writeFile(path.join(output, 'WEB-RELEASE.txt'), 'Cyrene Linux x64 portable runtime. Node.js/npm/npx, Linux production dependencies and both Chromium versions are bundled. Keep the complete directory and follow README-LINUX.md. No system Node.js or pnpm installation is required.\n');
await writeFile(path.join(output, 'README-LINUX.md'), `# Cyrene Web Linux x64 portable\n\n版本 ${packageJson.version}；源码 ${info.commit}。\n\n这是原生 Linux ELF 启动器及其完整依赖目录，不是纯单文件程序。请整体解压，保留 runtime、node_modules、dist、prompts、resources、skills、browsers 等目录。内置官方 Node.js ${process.version}、Linux 原生生产依赖及 Web/内置 MCP 所需的两套 Chromium；无需系统安装 Node.js、pnpm 或重新编译。\n\n构建/验收环境：Ubuntu 24.04 x86_64；其他 glibc Linux 尚未逐一验收，Alpine/musl、ARM 和 Windows 不适用。浏览器仍依赖系统动态库，首次部署运行：\n\n\`\`\`bash\nsudo ./install-system-deps.sh\n# 未安装 git/bash 时：sudo apt-get install -y git bash ca-certificates\nexport CYRENE_DATA_DIR="$HOME/.local/share/cyrene-agent"\nexport CYRENE_WEB_HOST=127.0.0.1\nexport CYRENE_WEB_PORT=4317\n./cyrene-web\n\`\`\`\n\n首次启动按终端的一次性 setup token 初始化管理员。使用反向代理提供 HTTPS；对外直接监听需自行设置 CYRENE_WEB_HOST。不要公开终端 setup token 或数据目录。\n\n前台停止按 Ctrl+C；systemd 的 ExecStart 指向解压目录里的 cyrene-web，WorkingDirectory 指向该目录，StopSignal 使用默认 SIGTERM。启动器 exec 后成为包内 Node 进程，SIGTERM 按应用正常关闭逻辑落盘，不需要 kill -9。\n\n升级先停止服务、备份现有 CYRENE_DATA_DIR，解压到新的目录并继续指向原有数据目录，更新 systemd 的 ExecStart/WorkingDirectory，再启动。不要把用户数据放进发行目录；不要覆盖或删除现有数据。\n\n维护命令：\n\n\`\`\`bash\n./cyrene-web --version\n./cyrene-web --node --version\n\`\`\`\n\n运行中的工作区、插件、外部 MCP 服务及模型/语音服务配置不随包提供。浏览器二进制已随包，Playwright 路径默认自动指向包内 browsers。可以通过 PLAYWRIGHT_BROWSERS_PATH 或 PLAYWRIGHT_MCP_EXECUTABLE_PATH 显式覆盖。\n`);
// Acceptance fixtures are copied temporarily and removed before creating the archive.
await mkdir(path.join(output, 'scripts/verify'), { recursive: true });
for (const name of ['shared-core-parity.mjs', 'shared-core-voice-mcp.mjs']) await cp(path.join(source, 'scripts/verify', name), path.join(output, 'scripts/verify', name));
console.log(JSON.stringify(info));
