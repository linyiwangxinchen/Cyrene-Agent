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

以下命令在当前源码目录或解压后的运行包目录执行，不要求固定安装地址。程序路径通过 `pwd -P` 获取，数据默认保存在当前账号的 `${XDG_DATA_HOME:-$HOME/.local/share}/cyrene-agent`，浏览器安装在程序目录的 `.browsers/`。数据与源码分开，升级程序时保留数据目录。已经初始化过的部署必须继续使用原来的 `CYRENE_DATA_DIR`，不要因换目录或换账号而重新创建一份数据。

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

**上述构建完成后，先继续安装 Chromium 系统库和浏览器，再进行第 3 节首次启动或第 4 节 systemd 部署。** 不需要构建或启动 Electron，也不需要安装 Linux 桌面。

```bash
sudo "$(command -v node)" node_modules/playwright/cli.js install-deps chromium
export PLAYWRIGHT_BROWSERS_PATH="$(pwd -P)/.browsers"
node node_modules/playwright/cli.js install chromium
```

系统库安装命令使用当前 Node 的实际路径，避免 nvm 安装的 Node 不在 sudo 的 PATH 中。浏览器目录须能被服务账号读取。LSP、Python 库、uv/uvx、向量模型以及特定 Skill/MCP 的依赖按实际使用情况另装；项目不内置 Whisper 服务或所有语言工具链。

## 3. 前台执行和首次初始化

首次启动创建自己的唯一管理员账号，源码没有预设管理员密码。初始化令牌由首次启动日志输出，也可通过 `CYRENE_SETUP_TOKEN` 配置；创建账号后不再允许重新初始化。

### 3.1 启动服务

在刚刚完成构建的目录执行。已有数据目录时先设置 `CYRENE_DATA_DIR`；下面的默认值仅在未设置时使用：

```bash
export CYRENE_DATA_DIR="${CYRENE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cyrene-agent}"
mkdir -p "$CYRENE_DATA_DIR" || { echo "无法创建数据目录"; exit 1; }
export CYRENE_DATA_DIR="$(cd "$CYRENE_DATA_DIR" && pwd -P)"
export PLAYWRIGHT_BROWSERS_PATH="$(pwd -P)/.browsers"
export CYRENE_WEB_HOST=0.0.0.0
export CYRENE_WEB_PORT=4317
export CYRENE_SECURE_COOKIES=0
pnpm run start:web
```

此处 `0.0.0.0` 是监听所有网卡的配置值，不是浏览器访问地址。其他电脑或手机访问 `http://服务器地址:4317/web/`，并确保服务器防火墙及云安全组允许访问 TCP 4317。服务器本机可用 `http://localhost:4317/web/`。只需本机访问时将监听地址设为 `127.0.0.1`。

HTTP 检查必须使用 `CYRENE_SECURE_COOKIES=0`；HTTPS 部署改为 `1`，见第 4.3 节。远程麦克风录音需要 HTTPS，HTTP 可上传音频测试。

### 3.2 初始化、登录和功能检查

从启动日志找到一次性初始化令牌，在网页初始化页面输入令牌，创建自己的管理员账号，再登录。同一数据目录已有账号时直接登录；无需重新初始化。接下来在模型设置中配置模型并测试连接，创建 Chat 对话，再创建 Work/Code 会话并绑定服务器上的工作区目录。浏览器电脑的盘符和文件目录不是 Linux 工作区。

服务启动时若出现：

```text
[Permission] 未找到持久化档位文件，使用默认 read-only
```

这是尚未保存 Agent 权限档位的正常提示，不是启动失败，也不是 Linux 文件系统权限报错。默认只读会限制 Agent 修改文件等操作，不影响服务自身保存账号和会话。Shell 是否可执行还取决于档位对应的沙箱边界，不能将 `read-only` 简单理解为禁用所有命令。

需要修改文件时，在 **设置 → 工具配置 → 本地文件 → 文件与命令权限** 选择“审批”，在聊天中逐次确认操作；“完全”允许直接操作。Work/Code 输入框下方也可切换权限。设置立即生效并保存到 `$CYRENE_DATA_DIR/agent-permission.json`，无需重启或编译。Agent 档位不能绕过 Linux 服务账号的文件权限。重启后若配置、账号或权限消失，检查前台与 systemd 是否使用同一数据目录和账号，以及该账号能否写入数据目录。

### 3.3 停止前台实例

在启动终端按 **Ctrl+C**，服务收到 SIGINT 后关闭连接和业务核心。**Ctrl+Z 只会暂停进程，端口仍然占用**；误按后执行 `jobs -l` 查看任务，执行 `fg` 恢复对应任务，再按 Ctrl+C。多个后台任务时用 `fg %任务编号` 选择。

设置 systemd 前先退出这个前台实例，避免两个实例同时占用 4317、同一数据目录或同一微信账号。也可以直接使用 `node dist/server/server/index.js` 启动；两种命令运行的是同一个服务入口，不要同时执行。

| 环境变量 | 用途 |
| --- | --- |
| `CYRENE_WEB_HOST` / `CYRENE_WEB_PORT` | 默认 `127.0.0.1` / `4317` |
| `CYRENE_DATA_DIR` | 持久化目录；默认 `$XDG_DATA_HOME/cyrene-agent`，未设 XDG 时为 `~/.local/share/cyrene-agent` |
| `CYRENE_SECURE_COOKIES` | 默认启用；HTTP 检查设 `0`，HTTPS 设 `1` |
| `CYRENE_SETUP_TOKEN` | 首次初始化令牌；账号创建后可移除 |
| `CYRENE_PROMPTS_DIR` | 程序提示词目录；通常保持部署包随带的 `prompts/` |
| `PLAYWRIGHT_BROWSERS_PATH` | 安装和运行必须使用同一个 Chromium 路径 |

## 4. systemd 后台执行和 HTTPS

### 4.1 从当前目录生成服务配置

以下步骤使用**当前登录账号**运行服务，延续前台启动时的数据和浏览器目录。无需将源码移动到指定位置；在源码或运行包根目录执行。如果前台使用了自定义数据目录，应在这个终端先导出同一个 `CYRENE_DATA_DIR`。不要同时运行前台实例。

```bash
CYRENE_APP_DIR="$(pwd -P)"
test -f "$CYRENE_APP_DIR/dist/server/server/index.js" || { echo "请在完成 Web 构建的程序根目录执行"; exit 1; }
CYRENE_SERVICE_USER="$(id -un)"
CYRENE_NODE_BIN="$(readlink -f "$(command -v node)")"
test -x "$CYRENE_NODE_BIN" || { echo "未找到可执行的 Node，请先安装 Node 24.x"; exit 1; }
export CYRENE_DATA_DIR="${CYRENE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cyrene-agent}"
mkdir -p "$CYRENE_DATA_DIR" || { echo "无法创建数据目录"; exit 1; }
CYRENE_SERVICE_DATA="$(cd "$CYRENE_DATA_DIR" && pwd -P)"
CYRENE_SERVICE_BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-$CYRENE_APP_DIR/.browsers}"
mkdir -p "$CYRENE_SERVICE_BROWSERS" || { echo "无法创建浏览器目录"; exit 1; }
CYRENE_SERVICE_BROWSERS="$(cd "$CYRENE_SERVICE_BROWSERS" && pwd -P)"

sudo tee /etc/systemd/system/cyrene-web.service >/dev/null <<EOF
[Unit]
Description=Cyrene Agent Web Server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$CYRENE_SERVICE_USER
WorkingDirectory=$CYRENE_APP_DIR
Environment="NODE_ENV=production"
Environment="PATH=$(dirname "$CYRENE_NODE_BIN"):$PATH"
Environment="CYRENE_DATA_DIR=$CYRENE_SERVICE_DATA"
Environment="PLAYWRIGHT_BROWSERS_PATH=$CYRENE_SERVICE_BROWSERS"
Environment="CYRENE_WEB_HOST=0.0.0.0"
Environment="CYRENE_WEB_PORT=4317"
Environment="CYRENE_SECURE_COOKIES=0"
ExecStart="$CYRENE_NODE_BIN" "$CYRENE_APP_DIR/dist/server/server/index.js"
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

sudo systemd-analyze verify /etc/systemd/system/cyrene-web.service
```

`systemd-analyze verify` 无配置错误后再启动服务。systemd 要求 `WorkingDirectory` 是绝对路径；上述命令自动获取当前目录，**该行不要加外围双引号，也不要写 `.` 或 `$PWD` 字面量**。`Environment` 和 `ExecStart` 的引号用于各自的参数解析，应保留。systemd 不会自动加载交互终端的 nvm 配置或 shell 初始化文件，因此这里写入 Node 绝对路径及当前 PATH；以后移动程序或删除该 Node 版本时，重新生成配置。

### 4.2 启动并设置开机自启

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cyrene-web
sudo systemctl status cyrene-web --no-pager -l
curl --fail --show-error --max-time 10 http://localhost:4317/healthz
```

状态应为 `Active: active (running)`，健康检查应成功返回。若还未创建账号，从下面的日志查找初始化令牌，再按第 3.2 节登录配置：

```bash
sudo journalctl -u cyrene-web -n 100 --no-pager -l
```

仅显示 `Started` 或开机自启链接创建成功，不代表进程持续运行；端口占用时会反复启动失败，处理见第 5.1 节。健康检查用 `--max-time 10` 避免一直等待；中止检查按 Ctrl+C，不要按 Ctrl+Z。

### 4.3 切换到 HTTPS 反向代理

Nginx/Caddy 示例见 `deploy/nginx/cyrene-web.conf.example` 和 `deploy/caddy/Caddyfile.example`，替换域名及证书路径，透传 WebSocket。Nginx 示例上传限制为 32 MiB，允许单张 15 MiB 动态图片。代理就绪后用下面的 drop-in 切换监听地址和 Cookie 设置，不需要改源码路径：

```bash
sudo mkdir -p /etc/systemd/system/cyrene-web.service.d
sudo tee /etc/systemd/system/cyrene-web.service.d/https.conf >/dev/null <<'EOF'
[Service]
Environment="CYRENE_WEB_HOST=127.0.0.1"
Environment="CYRENE_SECURE_COOKIES=1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart cyrene-web
```

此后从其他机器通过 `https://你的域名/web/` 登录，4317 仅供本机反向代理访问。不要继续用远程 HTTP 地址登录；Secure Cookie 不能用于远程 HTTP 会话。健康检查在服务器上仍可使用 localhost。

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

### 4.4 独立服务账号部署

若改为独立服务账号，可参考 `deploy/systemd/cyrene-web.service.example`，按实际目录修改 `User`、`Group`、`WorkingDirectory`、`ExecStart`、数据和浏览器路径，并给该账号相应目录访问权限。不要直接覆盖已生成的配置，模板的固定地址仅为示例；非 root 账号不能直接访问 root 的私有程序目录。切换账号时保留同一数据目录，先停止服务再调整数据归属。

该模板的 `ProtectSystem=full`、`ProtectHome=read-only` 会限制部分目录写入。如果工作区放在受保护目录，仅为需要写入的工作区增加 `ReadWritePaths=`。可选初始化令牌通过模板的 `EnvironmentFile` 配置，账号创建后移除令牌并重启；令牌文件不要提交到 Git。默认动态生成的服务使用启动日志中的随机令牌，无需额外配置。

模型和渠道密钥在网页配置；MCP/Skill 命令使用 Linux 路径，不能使用浏览器电脑的 Windows 盘符。

## 5. 启动、停止、日志与更新

```bash
sudo systemctl start cyrene-web
sudo systemctl restart cyrene-web
sudo systemctl stop cyrene-web
# 停止并取消开机启动；恢复用 enable --now
sudo systemctl disable --now cyrene-web
sudo systemctl status cyrene-web --no-pager -l
sudo journalctl -u cyrene-web -n 100 --no-pager -l
sudo journalctl -u cyrene-web -f
```

之后统一使用 systemd 管理，不要同时手工运行 `pnpm run start:web`。`systemctl stop` 会先发送 SIGTERM 正常关闭；停止不是删除数据。

### 5.1 4317 端口占用：EADDRINUSE

日志出现 `listen EADDRINUSE: address already in use 0.0.0.0:4317` 时，说明另一个实例或程序占用了端口。先停止失败服务的自动重启，再检查占用者：

```bash
sudo systemctl stop cyrene-web
sudo ss -ltnp 'sport = :4317'
```

根据输出中的 `pid=数字` 输入 PID，检查命令行、程序目录和所属服务：

```bash
read -r -p "输入占用 4317 的 PID: " CYRENE_OLD_PID
sudo ps -fp "$CYRENE_OLD_PID"
sudo readlink -f "/proc/$CYRENE_OLD_PID/cwd"
sudo systemctl status "$CYRENE_OLD_PID" --no-pager -l
```

如果是原来手工启动的 Cyrene，先回原终端按 Ctrl+C；Ctrl+Z 暂停的任务先用 `fg` 恢复。**本次部署中确认旧实例需要 `kill -9` 才能退出**；原终端不可用或正常退出无效时，确认 PID 仍属于该旧实例后执行：

```bash
sudo kill -9 "$CYRENE_OLD_PID"
sudo ss -ltnp 'sport = :4317'
```

`kill -9` 强制结束进程，不执行正常的连接释放或数据收尾，因此只用于确认后的旧实例，不要批量杀死所有 Node 进程。如果占用者由另一项 systemd 服务、PM2 或容器管理，应停止对应管理实例，否则它可能被重新拉起。

确认 `ss` 不再显示 LISTEN 记录后重新启动：

```bash
sudo systemctl reset-failed cyrene-web
sudo systemctl enable --now cyrene-web
sudo systemctl status cyrene-web --no-pager -l
curl --fail --show-error --max-time 10 http://localhost:4317/healthz
```

### 5.2 WorkingDirectory 报 bad-setting

若日志显示 `WorkingDirectory= path is not absolute: "…"`，检查路径外围是否错误添加了双引号。对于此前生成的带双引号配置，可以仅移除该行外围的引号，不改其他设置：

```bash
sudo sed -i 's/^WorkingDirectory="\(.*\)"$/WorkingDirectory=\1/' /etc/systemd/system/cyrene-web.service
sudo systemd-analyze verify /etc/systemd/system/cyrene-web.service
```

无配置错误后执行第 4.2 节。若该行本身是相对路径或错误地址，返回程序根目录重新执行第 4.1 节生成正确的绝对路径。

### 5.3 更新程序

### 5.3.1 已有 Clone 目录的原地更新

如果服务器已经完成 `git clone`、依赖安装和首次构建，后续更新不需要重新安装操作系统依赖，也不需要重新 clone。以下命令在**当前源码目录根部**执行；先确认服务使用的程序目录和数据目录：

```bash
pwd -P
git status --short
sudo systemctl cat cyrene-web | grep -E 'WorkingDirectory=|ExecStart=|CYRENE_DATA_DIR=|PLAYWRIGHT_BROWSERS_PATH='
```

`git status --short` 必须为空，或者你已经确认并保存了自己的本地修改。不要用 `git reset --hard` 清掉未提交修改，也不要在正在运行的服务目录直接覆盖文件。把上一条命令显示的 `CYRENE_DATA_DIR` 复制到下面的输入中；它必须是当前正式账号、会话、模型和渠道所使用的数据目录：

```bash
read -r -p "粘贴 systemd 中 CYRENE_DATA_DIR 的值: " CYRENE_DATA_DIR
test -d "$CYRENE_DATA_DIR" || { echo "数据目录不存在，停止更新"; exit 1; }
CYRENE_DATA_DIR="$(cd "$CYRENE_DATA_DIR" && pwd -P)"
CYRENE_BACKUP_DIR="../cyrene-data-backup-$(date +%Y%m%d-%H%M%S)"
sudo cp -a -- "$CYRENE_DATA_DIR" "$CYRENE_BACKUP_DIR"
echo "数据备份: $CYRENE_BACKUP_DIR"
```

确认备份完成后，停止服务、拉取本仓库已经验收过的 `master`，并在原目录重新构建：

```bash
sudo systemctl stop cyrene-web

git fetch origin --prune
git pull --ff-only origin master

# 只在锁文件允许时安装；不会下载 Electron 二进制。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 run check:server
corepack pnpm@10.33.0 run check:renderer
corepack pnpm@10.33.0 run build:web

# 使用原程序目录下的浏览器，缺失时才安装；已有浏览器无需重复下载。
export PLAYWRIGHT_BROWSERS_PATH="$(pwd -P)/.browsers"
if ! compgen -G "$PLAYWRIGHT_BROWSERS_PATH/chromium-*" > /dev/null; then
  corepack pnpm@10.33.0 exec playwright install chromium
fi

sudo systemctl daemon-reload
sudo systemctl restart cyrene-web
sudo systemctl status cyrene-web --no-pager -l
curl --fail --show-error --max-time 10 http://localhost:4317/healthz
```

如果 systemd 配置中的 `WorkingDirectory`、Node 路径或浏览器路径已经变化，不要手改旧文件，回到第 4.1 节在当前目录重新生成服务配置，再执行 `daemon-reload` 和 `restart`。如果使用 HTTPS，健康检查仍在服务器上访问 `localhost`；浏览器继续使用原来的 HTTPS 反向代理地址。重启后应强制刷新浏览器，以加载新的带 hash 的 Web 资源。

`git pull --ff-only` 如果提示本地分支有分叉或未提交修改，应停止并先保存修改，不能强制 reset。若拉取后类型检查或构建失败，先保持服务停止，回退到更新前提交并重新构建：

```bash
git reflog -n 5
read -r -p "输入更新前的提交号: " CYRENE_OLD_COMMIT
git switch --detach "$CYRENE_OLD_COMMIT"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 run build:web
sudo systemctl restart cyrene-web
```

回退后保留刚才的数据备份；如果新版本执行过数据库迁移，必须按照 SQLite 回退说明恢复**完整数据目录**，不能只切换 Git 提交。

### 5.3.2 新目录切换更新

需要降低停机时间时，在当前 Clone 目录之外创建新目录，按第 2 节完成构建和第 4.1 节生成配置，确认新目录的服务可启动后再停止旧服务、备份数据并切换 systemd 的 `WorkingDirectory`/`ExecStart`。不要让两个版本同时写同一 `CYRENE_DATA_DIR`；切换完成后只保留一个启用的 `cyrene-web` 服务。

更新前备份独立数据目录和旧程序，短暂停止服务以取得一致的数据副本。在新的版本目录完成安装、构建与检查后切换服务路径，或停止后更新既有程序目录；不要把账号、API Key、微信凭据、记忆、会话、用户上传打进升级包。避免新 HTML 引用的 hash 资源没有同步或更新时删除旧资源。

### SQLite 存储迁移后的升级与回退

合入 2026-10-08 的上游更新后，会话、运行回执、子任务和模型用量统一保存在数据目录的 `cyrene.sqlite`，数据库读写由独立 worker 执行。首次启动会只读导入旧会话/轨迹、子任务及 `token-usage.json`；旧文件保留，新版本后续写入 SQLite。

升级前停止服务并备份**完整数据目录**。运行中的数据库可能还有 `cyrene.sqlite-wal` 和 `cyrene.sqlite-shm`，不能只复制主数据库文件作为一致备份。若必须在线备份，应使用 SQLite 备份机制并同时处理其他业务文件。回退到迁移前版本时恢复升级前的整份数据备份；旧 JSON 文件不会包含新版本运行后的新增会话。

运行包必须带有 `dist/headless/conversation-database-worker.js`。仅传 `core.cjs` 会使数据库客户端尝试源码编译回退；精简生产包没有 TypeScript 源码和 esbuild，无法承担该回退。`create-web-runtime.mjs` 会校验数据库 worker 是否存在，避免导出不完整运行包。

## 6. 其他机器编译后上传执行

### 6.1 Windows、macOS 或另一台 Linux 编译

使用相同 Git 提交、Node 24.x、pnpm 10.33.0。JS/页面可跨平台转移，**Windows/macOS 的 node_modules 和 Chromium 不能直接当作 Linux 运行依赖**。

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm run check:server
pnpm run check:renderer
pnpm run build:web
# 新目录必须在源码目录之外；不会覆盖已有目录。
node scripts/packaging/create-web-runtime.mjs ../web-release-1.3.1
tar -czf ../web-release-1.3.1.tar.gz -C ../web-release-1.3.1 .
sha256sum ../web-release-1.3.1.tar.gz
read -r -p "输入目标 SSH 账号和服务器（账号@服务器）: " CYRENE_UPLOAD_TARGET
scp ../web-release-1.3.1.tar.gz "$CYRENE_UPLOAD_TARGET:./"
```

上传命令将压缩包放在远程 SSH 账号的主目录，不要求固定程序部署地址。PowerShell 安装前使用 `$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'`，其余 pnpm、Node 导出及 `tar.exe` 命令相同；校验命令为 `Get-FileHash -Algorithm SHA256 ../web-release-1.3.1.tar.gz`，上传可用 `$cyreneUploadTarget = Read-Host '输入账号@服务器'` 和 `scp.exe ../web-release-1.3.1.tar.gz "${cyreneUploadTarget}:./"`。导出脚本带入编译入口、源资源、依赖清单和部署示例，排除依赖目录、浏览器、源码映射、测试 JS 和用户数据。不要压缩整个含私有配置的开发目录。

### 6.2 Linux 安装运行依赖并启动

在 Linux 上进入上传压缩包所在目录并核对 SHA256，然后解压到新的相对目录。示例目录若已存在，换一个新名称，不要直接覆盖运行中的程序：

```bash
sha256sum ./web-release-1.3.1.tar.gz
mkdir ./web-release-1.3.1 && tar -xzf ./web-release-1.3.1.tar.gz -C ./web-release-1.3.1
cd ./web-release-1.3.1
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --prod --frozen-lockfile
sudo "$(command -v node)" node_modules/playwright/cli.js install-deps chromium
export PLAYWRIGHT_BROWSERS_PATH="$(pwd -P)/.browsers"
node node_modules/playwright/cli.js install chromium
```

随后在该运行包根目录按第 3 节前台启动，或第 4 节生成 systemd 配置；首次使用创建账号，升级则复用原数据目录。HTTPS 反向代理按第 4.3 节配置。异机编译包不需要重新执行 `check:server`、`check:renderer` 或 `build:web`。

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
| systemd 报 bad-setting / WorkingDirectory 非绝对路径 | 第 5.2 节；不要给 WorkingDirectory 添加外围引号 |
| EADDRINUSE / systemd 反复重启 | 第 5.1 节；检查 4317 占用 PID，确认旧实例后终止，不要同时前台和 systemd 启动 |
| 未找到权限档位文件，默认 read-only | 第 3.2 节；首次启动正常提示，在 Web 设置权限并检查数据目录持久化 |
| 微信慢或收不到消息 | iLink 网络、日志、实际启用状态，避免同账号多个轮询客户端 |
| 服务消失 | journal、服务状态及 OOM 日志；小内存机器避免并行重型编译 |

语音/MCP、用户覆盖和能力边界详见 [linux-web.md](linux-web.md)。OIDC 尚未实现，Gmail 专用授权仍暂缓；本版本使用单管理员本地账号与 Cookie 会话。
