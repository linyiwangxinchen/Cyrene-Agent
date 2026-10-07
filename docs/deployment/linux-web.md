# Linux Web Server 部署基线

当前部署基线覆盖 Web Server、认证、会话、工作区文件、Chat/Work/Code/Learn、浏览器面板、设置页面和 AG-UI 运行链路。服务端启动的是 Windows 端同一套 Agent/Harness、工具、Skill/插件、Scheduler、记忆/RAG、知识库、考试、Git 和渠道业务模块，数据使用 Linux 文件系统持久化。动态/评论/点赞、定时任务、会话队列、插件面板、知识库索引和微信 iLink/飞书 WSS/QQ NapCat/QQ 官方机器人均已接入；TTS、ASR、语音通话和 MCP 现已接入原业务实现，Gmail 仍按此前约定暂缓。桌面 Live2D、托盘、全局快捷键和本机 GUI 不需要安装。

## 构建

```bash
corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 run build:server
corepack pnpm@10.33.0 run build:renderer
# Root/admin installs only Chromium's OS libraries, not a desktop environment.
sudo node node_modules/playwright/cli.js install-deps chromium
# Browser binaries must be readable by the systemd service account.
PLAYWRIGHT_BROWSERS_PATH=/opt/cyrene-agent/.browsers node node_modules/playwright/cli.js install chromium
```

构建结果为 `dist/server/server/index.js`、`dist/headless/core.cjs`、知识库索引 worker、`dist/plugin-panel/` 和 `dist/renderer/`。运行时保留 `node_modules/`、`prompts/`、`skills/`、`resources/` 和可选的 `vendor/cyrene-skills/`，不能仅复制 HTML 或 `dist/server/`。Node 使用 24.x，系统需有 Git；Code 模式的语言服务器和 Skill 自身依赖按所用语言/技能安装。Chromium 和系统依赖的安装方式见 [Playwright 官方文档](https://playwright.dev/docs/browsers#install-system-dependencies)。

部署时须同时保留仓库的 `prompts/` 目录，包括模式规则、身份、`soul.md`、台词参考、`styles/` 和 `worldbook/`。Web Server 与 Windows 端读取同一套资源；只复制 `dist/` 会缺少人格内容。默认从服务程序所在目录定位资源，不依赖启动时的当前目录；可用 `CYRENE_PROMPTS_DIR=/opt/cyrene-agent/prompts` 指定其他位置。缺少必需提示词会明确报错。

用户覆盖文件位于 `$CYRENE_DATA_DIR/prompts/`，按文件优先于随程序部署的版本。自定义表达风格位于 `$CYRENE_DATA_DIR/styles/custom/custom.md`；可选通用语气规则为 `$CYRENE_DATA_DIR/prompts/tone-rules.md`。这些文件使用 UTF-8。身份规则与风格分开，风格只改变表达方式；Work/Code 不注入 Chat 风格或风格采样参数。

每轮模型请求读取已保存的用户资料、启用的 L0/L1/L2 记忆、关系线索及已有会话/工作区摘要；摘要、Wiki 和向量模式由原记忆调度器管理。`memoryMode=off` 会关闭记忆和关系线索注入及关系日志记录，用户资料仍用于语言和称呼设置。

当前 Web 端不启动 Electron、Live2D 或桌面窗口；所有工作区路径指向服务端文件系统。浏览器只负责显示 UI 和发送操作请求。

## 首次初始化

服务启动时需要一个一次性 setup token。生产环境建议写入 `/etc/cyrene-agent/server.env`：

```ini
CYRENE_SETUP_TOKEN=替换为高熵随机值
```

启动后在浏览器打开反向代理地址，在初始化页面输入该令牌并创建唯一管理员账号。创建完成后应从环境文件移除令牌并重启服务；服务仍会拒绝已经初始化的 bootstrap 请求。

## systemd 和反向代理

- 将 `deploy/systemd/cyrene-web.service.example` 复制为 systemd 服务并按实际安装路径修改。
- Nginx 使用 `deploy/nginx/cyrene-web.conf.example`；Caddy 使用 `deploy/caddy/Caddyfile.example`。
- WebSocket 必须透传 Upgrade/Connection，HTTPS 终止点必须把 `X-Forwarded-Proto` 设置为 `https`。
- 服务默认只监听 `127.0.0.1`，外部访问只能经过反向代理。
- 连接手机页面可配置微信、飞书和 QQ（NapCat）。微信凭据保存在数据目录的 `weixin/credentials.json`；飞书和 QQ 的密钥只在服务端使用，配置 API 只返回 `hasAppSecret`/`hasAccessToken` 标志。
- QQ NapCat 反向 WebSocket 默认使用 `/onebot/v11/ws`；监听到非回环地址时必须设置 Access Token，群消息还需要群白名单和 @ 机器人。
- 外部渠道收到消息后会自动创建或复用会话，消息会写入渠道日志并出现在上下文绑定列表；绑定和工具访问按原渠道策略执行，配置模型后，服务端会生成回复并通过原渠道发送。微信 QR 登录保留二维码/轮询/确认/取消/凭据存储；飞书保留官方长连接；QQ 保留 NapCat 和官方机器人两条链路。渠道语音复用原 TTS 合成服务，是否可收发音频还取决于具体渠道协议与账户权限，需实际账号验收。

## TTS / ASR / 语音通话

设置中的语音合成支持原有 MiniMax、MiMo、Mossland、GPT-SoVITS 和自定义云接口。配置地址与 API Key 后，使用“试听”验证；Web 页面提供音频播放控件，聊天的朗读、自动朗读、暂停/继续及历史音频缓存继续使用原 TTS 会话逻辑。音频从服务器合成，在访问网页的电脑播放。浏览器阻止自动播放时，点击播放控件即可。

语音识别保留阿里云、Mossland、MiniMax，新增“本地 / 自部署”的 OpenAI 兼容音频转写接口。例如 `http://127.0.0.1:8000/v1/audio/transcriptions`，填写实际模型名和可选 API Key；请求为带 `file`、`model`、`response_format=json` 的 multipart，响应为 `{ "text": "转写结果" }`。该地址由 Linux Server 请求，`127.0.0.1` 指服务器自身。项目不内置 Whisper 模型或识别服务，需自行部署所选服务。阿里云识别语种由 Appkey 对应项目的模型决定，需在阿里云控制台选择。

使用“选择音频测试”上传浏览器可解码的音频，或点击“开始录音测试”并允许麦克风。单次最长 120 秒、文件最多 12 MB，浏览器转为 16 kHz 单声道 PCM，服务器通过配置的引擎转写。远程麦克风访问必须使用 HTTPS；本机 localhost 可使用 HTTP。麦克风和扬声器均来自浏览器电脑，Linux Server 无需声卡或桌面。

角色菜单的“语音通话”复用原 VAD、ASR→人格/模型→TTS→下一轮流程，须同时配置模型、ASR、TTS。单用户通话绑定发起的浏览器连接；挂断、关闭页面或连接断开会取消识别/合成并释放通话。其他浏览器连接不能抢占通话或取消其 TTS 会话。

## MCP

MCP 设置支持 stdio、Streamable HTTP、SSE、表单和 JSON 导入、服务器环境变量、远程请求头、服务端工作目录、状态/工具数量、重连、删除和启动自动恢复。带空格的参数使用引号，或直接填写 JSON 字符串数组。凭据保存在服务端数据目录的 `mcp-servers.json`，Linux 文件权限为 0600。

stdio 进程运行在 Linux Server 上。先安装该 MCP 所需的 Node / npx / Python / uvx 及其他依赖，使用服务器可执行命令、绝对工作目录和 Linux 路径；Windows 盘符、exe 或浏览器电脑上的路径不可直接使用。HTTP/SSE 填实际地址；令牌可填入请求头 `Authorization: Bearer ...`。远程 MCP 的特定 OAuth 登录流程仍取决于该服务，原项目没有通用 MCP OAuth 授权页面。

内置 Filesystem 和 Playwright 开关会实际启动/停止 bundled MCP；Web 使用 Node 启动，Playwright 使用 headless Chromium。Filesystem 默认限制在服务账号的下载/上传目录，其他资料目录可作为自定义 MCP 的参数显式添加。发现的工具进入原工具注册器、模式工具集和执行权限策略；缺少 effect annotations 的工具按原策略视为 `unknown`，需通过可信配置的 `effectKindOverrides` 指明用途，不能仅凭连接成功判定其可执行。

## 数据目录

首期认证数据默认位于 `$XDG_DATA_HOME/cyrene-agent`，也可以使用 `CYRENE_DATA_DIR` 固定为 `/var/lib/cyrene-agent`。创建 `cyrene` 服务账号并令它拥有数据目录。用户工作区建议放在 `/srv/cyrene/workspaces` 并授予该账号读写权限；`/opt`、`/usr`、`/etc` 在示例服务中受 `ProtectSystem=full` 保护，`/home` 默认只读。若工作区放在 `/home`，需为指定工作区额外配置 `ReadWritePaths=`，而不是给整个主目录写权限。

从旧 Web 数据首次启动会先备份，再将模型、用户资料、会话、队列、记忆、任务、渠道绑定和媒体导入原业务存储。知识库通过原索引器重建。没有工作区绑定的旧定时任务会由原策略停用，需在页面中重新绑定后启用；服务不会自动扩大它们的文件权限。Windows 数据迁入 Linux 时，盘符绝对路径需要重新选择 Linux 工作区和资料目录。

## 验收与更新

在部署目录执行 `corepack pnpm@10.33.0 run verify:shared-core` 和 `corepack pnpm@10.33.0 run verify:voice-mcp`，会使用临时数据、本地模型/音频协议服务、真实 MCP SDK 测试服务、bundled Filesystem 进程和隔离渠道网关验证完整调用链，不改管理员的正式会话。然后浏览器登录验收实际模型、音频供应商与渠道账号。需要检查真实账户的 QR/长连接/收发，不能用本地模拟网关代替供应商验收。

Linux 版通过重新构建并 `systemctl restart cyrene-web` 更新，界面不会显示 Windows 安装器更新按钮。浏览器音频播放使用浏览器扬声器，不要求服务器安装 GUI 或 mpv。
