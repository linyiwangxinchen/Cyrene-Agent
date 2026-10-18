# Fork 的 Windows 与 Linux 发行

本仓库保留上游的 `electron-builder.yml`。Fork 发版使用独立的
`electron-builder.fork.yml`，更新源为 `linyiwangxinchen/Cyrene-Agent`，
安装器名明确包含 Windows 和 x64。不要将 fork 安装包发布到上游更新源。

## Windows x64 安装器

在 Windows 安装 Node.js 24、pnpm 10.33.0 和 Rust stable 后，于仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run build
node scripts/build/screenshot-helper.mjs
node scripts/packaging/prepare-mingit.mjs
node scripts/packaging/prepare-mpv.mjs
pnpm exec electron-builder --config electron-builder.fork.yml --win nsis --x64 --publish never
node scripts/verify/installer-artifacts.mjs --artifact-name 'Cyrene-Windows-x64-Setup-${version}.exe'
```

产物为 `release/Cyrene-Windows-x64-Setup-<版本>.exe`、同名 `.blockmap` 和
`release/latest.yml`。验证脚本检查真实 SHA-512、文件大小和随包辅助程序；
发布前还需用隔离用户数据目录启动 `win-unpacked/Cyrene.exe`，核对窗口加载、
`resources/app-update.yml` 的 fork 地址及根目录许可文件。

没有配置代码签名证书时，安装包未签名。不要声称已签名；Windows 可能提示未知发布者。
Release 必须同时上传安装器、blockmap、latest.yml 及 SHA-256 清单。

## Linux x64 便携服务

GitHub Actions 的 **Build Linux portable** 工作流通过手动运行，使用 Ubuntu 24.04
原生构建和验收，不会连接或部署到生产服务器。

也可在 Ubuntu 24.04 x86_64 源码目录执行，输出目录必须是仓库外的新目录：

```bash
set -eu
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm run check:server
pnpm run check:renderer
pnpm run build:web
pnpm exec playwright install-deps chromium
bundle="$(dirname "$(pwd -P)")/Cyrene Linux portable"
node scripts/packaging/create-linux-portable.mjs "$bundle"
"$bundle/runtime/node" scripts/verify/linux-portable.mjs "$bundle"
cd "$bundle"
./cyrene-web --node scripts/verify/shared-core-parity.mjs
./cyrene-web --node scripts/verify/shared-core-voice-mcp.mjs
```

这是原生 ELF 启动器与完整依赖目录，包含官方 Node.js/npm/npx、Linux 生产依赖、
Web 静态资源、SQLite worker、提示词和两套 Playwright Chromium。用户无需安装
Node/pnpm 或在目标机器重新编译，但需保留整个目录，且浏览器仍需操作系统动态库。
不适用于 Windows、ARM、Alpine/musl；目前验收平台为 Ubuntu 24.04 x86_64。

验收覆盖隔离端口和数据目录、登录认证、HTTP/WebSocket、实际 SQLite worker、
重启持久化、SIGTERM 正常退出，以及现有工具/语音/MCP 验收。
工作流在验收后删除测试脚本和结果目录，再打包 tar.gz；保留
`BUILD-INFO.json`、`PORTABLE-ACCEPTANCE.json` 与随包 `README-LINUX.md`。
模型 API、微信账号、用户数据、工作区内容和外部 MCP 配置不会随包提供。

部署步骤见解压目录内 `README-LINUX.md`。启动 `./cyrene-web`，前台按 Ctrl+C 停止；
systemd 使用该启动器作为 ExecStart，数据目录继续由 `CYRENE_DATA_DIR` 指定。
升级时先停止服务、备份数据目录，再切换完整发行目录，不能覆盖已有用户数据。

## Release 与上游同步

Fork 使用独立且不覆盖上游的标签，例如 `1.3.4+fork.20261019`。不要移动已存在的
上游 `v1.3.4` 标签。发布说明注明 Windows/Linux 平台、源码提交、上游基线、
实际验收和签名状态。更新元数据内的应用版本仍来自 package.json，后续希望触发
自动升级的发行必须增加应用版本，不能只更换标签日期。

Fork 配置、打包脚本和独立工作流集中放置，合并上游时保留共享构建配置原貌，
减少同一个配置文件上的冲突。发布前确认资产不含密钥、个人配置或服务数据。
