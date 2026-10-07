# Linux 构建、执行、停止和异机编译部署

适用于 Ubuntu/Debian。Linux 运行 Node 服务，其他电脑和手机通过浏览器访问。服务器无需 Electron 桌面、Live2D、托盘或显示服务器。文件、命令、知识库、Skill、插件、MCP 和渠道均使用服务器的资源。

## 1. 环境和目录

使用 Node.js **24.x**、pnpm **10.33.0**，版本约束见 `package.json`。从 Node.js 官方发行包或可信仓库安装 Node 后执行 `npm install --global pnpm@10.33.0`。确认版本，再安装系统工具：

```bash
node --version
pnpm --version
sudo apt-get update
sudo apt-get install -y git ca-certificates curl python3 build-essential pkg-config ffmpeg
```

原生依赖可能需要 Python/C++ 工具链；浏览器控制需要项目版本匹配的 Playwright Chromium。建议构建机至少有 4 GiB 内存，小内存服务器优先使用第 6 节异机编译。这是部署建议，运行资源还取决于模型、索引与任务规模。

推荐程序 `/opt/cyrene-agent`，数据 `/var/lib/cyrene-agent`，工作区 `/srv/cyrene/workspaces`，环境文件 `/etc/cyrene-agent/server.env`。使用 `/root/cyrene` 时需对应修改路径、服务账号和权限，不能照抄非 root 服务示例。

## 2. Linux 从源码构建

在构建账号拥有的目录执行：

```bash
git clone https://github.com/linyiwangxinchen/Cyrene-Agent.git
cd Cyrene-Agent
# Web 构建需要开发依赖，但无需下载 Electron 二进制。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm run check:server
pnpm run check:renderer
pnpm run build:web
```

`build:web` 编译服务端 TypeScript，打包共享业务核心和知识库 worker，复制插件面板资源，再构建页面。入口包括：

```text
dist/server/server/index.js
dist/headless/core.cjs
dist/headless/knowledge-index-worker.js
dist/headless/conversation-database-worker.js
dist/plugin-panel/
dist/renderer/web/index.html
dist/renderer/assets/
```

上游跟踪的 `dist/renderer/avatars`、`stickers`、`icons`、`models` 等是源资源；不是本次构建缓存。运行还需要完整 `prompts/`、`skills/`、`resources/`、依赖清单以及目标平台的 `node_modules`。只复制 HTML、`dist/server` 或 `core.cjs` 不够，缺失提示词会导致初始化或人格异常。

在部署目录安装 Chromium 系统库和浏览器：

```bash
cd /opt/cyrene-agent
sudo node node_modules/playwright/cli.js install-deps chromium
PLAYWRIGHT_BROWSERS_PATH=/opt/cyrene-agent/.browsers \
  node node_modules/playwright/cli.js install chromium
```

浏览器目录须能被服务账号读取。LSP、Python 库、uv/uvx、向量模型以及特定 Skill/MCP 的依赖按实际使用情况另装；项目不内置 Whisper 服务或所有语言工具链。

## 3. 前台执行和首次初始化

首次启动创建自己的唯一管理员账号，源码没有预设管理员密码。初始化令牌由首次启动日志输出，也可通过 `CYRENE_SETUP_TOKEN` 配置；创建账号后不再允许重新初始化。

本机 HTTP 检查：

```bash
cd /opt/cyrene-agent
export CYRENE_DATA_DIR=/var/lib/cyrene-agent
export PLAYWRIGHT_BROWSERS_PATH=/opt/cyrene-agent/.browsers
export CYRENE_WEB_HOST=127.0.0.1
export CYRENE_WEB_PORT=4317
export CYRENE_SECURE_COOKIES=0
node dist/server/server/index.js
```

打开 `http://127.0.0.1:4317/web/`，输入初始化令牌并创建管理员，再登录。其他机器直接检查 HTTP 时显式将监听地址改为 `0.0.0.0`，访问 `http://服务器地址:4317/web/`；此时保持 `CYRENE_SECURE_COOKIES=0`。正式 HTTPS 配置见下一节。远程麦克风录音需要 HTTPS，HTTP 可上传音频测试。

前台停止：该终端按 **Ctrl+C**，服务收到 SIGINT 后关闭连接和业务核心。

| 环境变量 | 用途 |
| --- | --- |
| `CYRENE_WEB_HOST` / `CYRENE_WEB_PORT` | 默认 `127.0.0.1` / `4317` |
| `CYRENE_DATA_DIR` | 持久化目录；默认 `$XDG_DATA_HOME/cyrene-agent`，未设 XDG 时为 `~/.local/share/cyrene-agent` |
| `CYRENE_SECURE_COOKIES` | 默认启用；HTTP 检查设 `0`，HTTPS 设 `1` |
| `CYRENE_SETUP_TOKEN` | 首次初始化令牌；账号创建后可移除 |
| `CYRENE_PROMPTS_DIR` | 程序提示词目录；通常保持部署包随带的 `prompts/` |
| `PLAYWRIGHT_BROWSERS_PATH` | 安装和运行必须使用同一个 Chromium 路径 |

## 4. systemd 后台执行和 HTTPS

以 root 初始化账号和目录：

```bash
id cyrene >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /var/lib/cyrene-agent --shell /usr/sbin/nologin cyrene
sudo install -d -o cyrene -g cyrene -m 700 /var/lib/cyrene-agent
sudo install -d -o cyrene -g cyrene -m 750 /srv/cyrene/workspaces
sudo install -d -m 700 /etc/cyrene-agent
sudo install -m 644 deploy/systemd/cyrene-web.service.example /etc/systemd/system/cyrene-web.service
```

编辑服务文件，核实 `WorkingDirectory`、`ExecStart` 的 Node 绝对路径、`User`、`Group` 和浏览器路径。官方 Node 解压包可能不在 `/usr/bin/node`，使用 `command -v node` 查询。用编辑器创建 `/etc/cyrene-agent/server.env`：

```ini
CYRENE_SETUP_TOKEN=填写你生成的随机初始化令牌
```

令牌可用 `openssl rand -hex 32` 生成；设 `sudo chmod 600 /etc/cyrene-agent/server.env`，不要放进 Git。Nginx/Caddy 示例见 `deploy/nginx/cyrene-web.conf.example` 和 `deploy/caddy/Caddyfile.example`，替换域名及证书路径，透传 WebSocket。Nginx 示例上传限制为 32 MiB，允许单张 15 MiB 动态图片。

例如使用 Nginx，在准备好匹配域名的证书后安装并启用站点：

```bash
sudo apt-get install -y nginx
sudo install -m 644 deploy/nginx/cyrene-web.conf.example /etc/nginx/sites-available/cyrene-web
# 用编辑器修改域名及证书路径，然后启用站点。
sudo ln -s /etc/nginx/sites-available/cyrene-web /etc/nginx/sites-enabled/cyrene-web
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

如果使用 Caddy，将示例域名替换为实际域名并合并到 `/etc/caddy/Caddyfile`，执行 `sudo caddy validate --config /etc/caddy/Caddyfile` 和 `sudo systemctl reload caddy`。公网域名需要正确 DNS 和 80/443 端口；内网域名使用自己的可信证书或 Caddy `tls internal`，并将内部 CA 信任安装到访问设备。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cyrene-web
sudo systemctl status cyrene-web --no-pager
curl --fail http://127.0.0.1:4317/healthz
```

在 `https://你的域名/web/` 初始化并登录。完成后移除环境文件的 `CYRENE_SETUP_TOKEN`，执行 `sudo systemctl restart cyrene-web`；同一数据目录的账号保留。

示例 `ProtectSystem=full`、`ProtectHome=read-only` 会限制部分目录写入。如果工作区位于 `/home/账号/project`，仅为指定目录增加 `ReadWritePaths=`。模型和渠道密钥在网页配置；MCP/Skill 命令使用 Linux 路径，不能使用浏览器电脑的 Windows 盘符。

## 5. 启动、停止、日志与更新

```bash
sudo systemctl start cyrene-web
sudo systemctl restart cyrene-web
sudo systemctl stop cyrene-web
# 停止并取消开机启动；恢复用 enable --now
sudo systemctl disable --now cyrene-web
sudo systemctl status cyrene-web --no-pager
sudo journalctl -u cyrene-web -n 100 --no-pager
sudo journalctl -u cyrene-web -f
```

手工后台运行的进程可以向明确 PID 发送 `kill -TERM <PID>`，不要使用匹配所有 Node 进程的 kill 命令。`systemctl stop` 会发送 SIGTERM 正常关闭；停止不是删除数据。

更新前备份独立数据目录和旧程序，短暂停止服务以取得一致的数据副本。在新的版本目录完成安装、构建与检查后切换服务路径，或停止后更新既有程序目录；不要把账号、API Key、微信凭据、记忆、会话、用户上传打进升级包。源码升级可 `git pull --ff-only` 后执行第 2 节，失败时不要替换正常服务。避免新 HTML 引用的 hash 资源没有同步或更新时删除旧资源。

### SQLite 存储迁移后的升级与回退

合入 2026-10-08 的上游更新后，会话、运行回执、子任务和模型用量统一保存在数据目录的 `cyrene.sqlite`，数据库读写由独立 worker 执行。首次启动会只读导入旧会话/轨迹、子任务及 `token-usage.json`；旧文件保留，新版本后续写入 SQLite。

升级前停止服务并备份**完整数据目录**。运行中的数据库可能还有 `cyrene.sqlite-wal` 和 `cyrene.sqlite-shm`，不能只复制主数据库文件作为一致备份。若必须在线备份，应使用 SQLite 备份机制并同时处理其他业务文件。回退到迁移前版本时恢复升级前的整份数据备份；旧 JSON 文件不会包含新版本运行后的新增会话。

运行包必须带有 `dist/headless/conversation-database-worker.js`。仅传 `core.cjs` 会使数据库客户端尝试源码编译回退；精简生产包没有 TypeScript 源码和 esbuild，无法承担该回退。`create-web-runtime.mjs` 会校验数据库 worker 是否存在，避免导出不完整运行包。

## 6. 其他机器编译后上传执行

### 6.1 Windows、macOS 或另一台 Linux 编译

使用相同 Git 提交、Node 24.x、pnpm 10.33.0。JS/页面可跨平台转移，**Windows/macOS 的 node_modules 和 Chromium 不能直接当作 Linux 运行依赖**。

```bash
pnpm install --frozen-lockfile
pnpm run check:server
pnpm run check:renderer
pnpm run build:web
# 新目录必须在源码目录之外；不会覆盖已有目录。
node scripts/packaging/create-web-runtime.mjs ../web-release-1.3.1
tar -czf ../web-release-1.3.1.tar.gz -C ../web-release-1.3.1 .
sha256sum ../web-release-1.3.1.tar.gz
scp ../web-release-1.3.1.tar.gz your-user@your-server:/tmp/
```

PowerShell 可用系统 `tar.exe`、`scp.exe`，校验命令为 `Get-FileHash -Algorithm SHA256 ../web-release-1.3.1.tar.gz`；安装前可设 `$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'`。导出脚本带入编译入口、源资源、依赖清单和部署示例，排除依赖目录、浏览器、源码映射、测试 JS 和用户数据。不要压缩整个含私有配置的开发目录。

### 6.2 Linux 安装运行依赖并启动

解压到新的部署目录并核对 SHA256；命令由拥有该目录的账号执行，root 安装后确保服务账号可读：

```bash
sha256sum /tmp/web-release-1.3.1.tar.gz
sudo install -d -o cyrene -g cyrene /opt/cyrene-agent
sudo tar -xzf /tmp/web-release-1.3.1.tar.gz -C /opt/cyrene-agent
cd /opt/cyrene-agent
pnpm install --prod --frozen-lockfile
sudo node node_modules/playwright/cli.js install-deps chromium
PLAYWRIGHT_BROWSERS_PATH=/opt/cyrene-agent/.browsers \
  node node_modules/playwright/cli.js install chromium
```

随后按第 3 节前台启动，或第 4 节设置 systemd。HTTPS 反向代理后的执行命令：

```bash
CYRENE_DATA_DIR=/var/lib/cyrene-agent \
PLAYWRIGHT_BROWSERS_PATH=/opt/cyrene-agent/.browsers \
CYRENE_WEB_HOST=127.0.0.1 CYRENE_SECURE_COOKIES=1 \
node dist/server/server/index.js
```

目标 Linux 不再编译 TypeScript/Vite，只安装该 Linux/CPU 架构的运行依赖。原生库安装失败应修复网络、工具链或系统库，不要复制 Windows 的 sharp/tree-sitter/LanceDB/ONNX 二进制。

完全离线部署须在同 CPU 架构、兼容 Linux 发行版/libc、相同 Node 版本的 Linux 构建机准备生产依赖和 Chromium，再连同 pnpm `.pnpm` 实体目录一起归档；目标仍需 Chromium/音频系统库。x86_64 与 arm64 不可混用。普通跨系统部署优先采用“传编译产物，目标机安装运行依赖”。

## 7. 验收和常见问题

源码构建目录可运行 `pnpm run verify:shared-core` 和 `pnpm run verify:voice-mcp`。脚本需要开发工具与隔离样例，不随精简运行包提供。运行包用健康检查、登录、真实模型对话、工作区操作、带图动态和实际使用的渠道/语音/MCP 验收；仅 `/healthz` 正常不代表所有业务配置完成。

完整契约与功能报告按以下顺序生成；均使用隔离样例，不读取正式账号配置。浏览器控制验收需要已安装 Chromium：

```bash
pnpm run build:web
node scripts/verify/shared-core-startup.mjs
node scripts/verify/shared-core-contracts.mjs
pnpm run verify:shared-core
pnpm run verify:voice-mcp
node scripts/verify/shared-core-feature-report.mjs
```

报告输出到忽略提交的 `docs/verification/`，无需从开发机复制历史报告。

| 现象 | 检查 |
| --- | --- |
| HTTP 登录后回登录页 | HTTP 检查设置 Secure Cookie 为 `0`，HTTPS 为 `1` |
| 页面空白、JS 404 | 检查完整 renderer 与 hash 资源，刷新页面 |
| 人格变成普通助手 | 检查完整 prompts、用户覆盖和对话模式 |
| 动态图片失败 | 代理上传限制；PNG/JPEG/WebP，最多 9 张，每张 15 MiB |
| MCP/浏览器失败 | 服务账号 PATH、Linux 命令、Chromium 路径及系统库 |
| 微信慢或收不到消息 | iLink 网络、日志、实际启用状态，避免同账号多个轮询客户端 |
| 服务消失 | journal、服务状态及 OOM 日志；小内存机器避免并行重型编译 |

语音/MCP、用户覆盖和能力边界详见 [linux-web.md](linux-web.md)。OIDC 尚未实现，Gmail 专用授权仍暂缓；本版本使用单管理员本地账号与 Cookie 会话。
