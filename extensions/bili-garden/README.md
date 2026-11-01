# 昔涟的 B 站小花园

昔涟会读字幕、挑视频、留下手记，也可以按你的设置守护评论区。Windows 与 Linux Web 使用同一个插件；在手机浏览器中也可以配置、扫码、查看记录。

## 启用

本插件需要本次提供的 Cyrene 宿主接口。请先使用同一份源码重新构建宿主；早期同版本号的安装包可能没有新增接口，插件会提示更新。

在仓库根目录构建：

```bash
# 小花园已合入 master；工作树干净时更新。
git fetch origin
git switch master
git pull --ff-only origin master
pnpm install --frozen-lockfile

# Linux Web
pnpm run build:web

# Windows 桌面开发版本
pnpm run build

# 生成可导入插件包
node scripts/packaging/bili-garden.mjs
```

构建后插件会出现在 **设置 → 功能插件 → 昔涟的 B 站小花园**，默认停用。启用后，同一页面下方显示完整面板。首次启用只创建自己的数据库，不自动下载环境、访问账号或发送消息。

`release/bili-garden-0.1.0.zip` 可以在兼容宿主中使用“导入插件”。已随宿主内置时直接启用即可，不需要重复导入相同 id。

Linux 服务更新后按现有部署文档重启 `cyrene-web`，然后浏览器刷新。服务运行期间不需要桌面、DISPLAY 或 DSH。

## 完全由昔涟运行

人格、模型调用、定时调度、记忆、配置、密钥和发送记录均由昔涟管理。B 站请求由本插件的 `python/bilibili_backend.py` 直接调用 `bilibili-api-python`；不安装或运行 DSH，也不启动独立 MCP 服务。Python 只是昔涟管理的子进程，Windows/Linux Web 使用相同接口。`vendor/` 仅保留必要许可证和来源声明。

## 第一次使用

1. 面板的“设置”中点击 **安装运行环境**。进度在本页显示。
2. 点击 **扫码登录**，用手机 B 站扫码并确认。
3. 填写兴趣、排除项与关键词，保存。模型默认跟随昔涟，也可选择已保存的模型档案。
4. 点击 **去发现视频**，或把 BV/视频链接放进“一起看”再阅读。
5. 在“手记”查看报告、日记和记忆；在卡片中打开“字幕与追问”。

自动发现、评论守护、评论/私信/赞藏及自动发送默认关闭。只开启评论等动作开关时，昔涟会先留草稿；“互动”页可以确认发送。开启自动发送后，也仍需满足对应动作开关、目标、证据、额度和冷却条件。

## 能做什么

- 搜索与指定视频阅读、时长筛选、字幕优先、可选本地 Whisper 转写。
- 按轮累积的日报和日记、每日/一周 Markdown 导出。
- 真正回注下一轮的兴趣记忆；可在面板删除不想保留的记忆。
- 待看/已看/不感兴趣、10/30/60 分钟精选片单、带字幕片段的追问。
- 普通评论或仅回复 UP 本人邀请；唯一接收 UID 私信；有理由、有证据的赞藏及撤销。
- 评论守护：目标 UP 视频下的有效评论，以及白名单用户的 @；队列持久化、游标和有限次重试。
- 运行进度、取消、失败原因、真实模型输入/输出/缓存用量和平台发送回执。

普通评论可配置提及 UID，发送时解析昵称并加入正文。与参考项目相同，这是正文提及；是否触发通知由 B 站决定。接口成功、自己账号下查到、所有人可见是不同状态，页面会区分发送与查询结果。

## 模型与昔涟设定

插件使用宿主的完整 Chat 人格、当前风格和用户修改的提示词。无需另填 API Key，也不使用 DSH 配置。任务章程只能定义选片与交付要求；初始章程不建立其他角色身份。

兴趣、排除项、反馈和最近记忆作为本轮资料加入动态上下文。视频评论、字幕和搜索结果作为外部资料处理。报告必须提交真实字幕编号，单纯说“已做好”不会被当成完成。

## Linux 与运行环境

所有路径都属于运行昔涟的服务器。可在设置里指定服务器 Python 可执行文件；修改路径后先保存设置，再安装。

安装优先使用 Python 3.10+，否则尝试系统 uv；两者都不可用时尝试下载匹配架构的官方 uv，并强制校验摘要。下载或校验失败时，可安装系统 Python 后重试，例如 Ubuntu/Debian：

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv
```

Python 业务依赖安装在插件数据目录的 `.venv`。基础依赖和转写依赖使用同一安装源：优先取服务环境变量 `CYRENE_BILI_PIP_INDEX`，其次 `PIP_INDEX_URL`，未设置时使用官方 `https://pypi.org/simple/`。地址必须为 HTTPS；插件安装时隔离系统的 pip.ini/pip.conf 和额外索引，不修改全局 pip 配置。首选源找不到包、连接失败或下载中断时，依次尝试尚未用过的官方 PyPI、阿里云 HTTPS 镜像，每个源最多一轮，不混合额外索引。当前插件运行期间，后续安装阶段优先沿用已成功的源；显式源设置改变后重新选源。取消、权限和磁盘错误不会触发切换。后端 Node 请求沿用宿主代理设置，Python 子进程保留 HTTP 代理环境。

下载前会把插件虚拟环境中低于 25.2 的 pip 升级到支持恢复下载的版本，不升级系统 pip。读取超时为 120 秒，连接重试 3 次，中断续传最多 5 次，每个源最多运行 15 分钟。已完整下载的文件缓存在插件数据目录 `pip-cache/`；同一条 pip 命令中可续传中断的文件，切换源或重启安装后不保证保留未完成部分。失败后可直接重试，不要先删除 `.venv` 或缓存。相关行为见 [pip 下载选项](https://pip.pypa.io/en/stable/cli/pip/)。

若转写安装报 `No matching distribution found for faster-whisper`：更新宿主并重启后，在小花园设置重新点击“安装转写环境与模型”。安装日志会列出实际 Python 版本、平台/架构和每一阶段的软件源；该错误也可能来自网络或 Python/平台兼容性，不能仅凭它断定镜像缺包。推荐使用 64 位 Python 3.11/3.12。软件包安装成功后还会单独下载并加载模型，只有全部成功才显示转写就绪。

转写环境及模型另行点击安装；更换 Whisper 模型后需要重新安装所选模型。正常阅读不会偷偷下载尚未安装的权重。视频转写使用 CPU/int8，较长视频会占用较多时间，受每日次数和运行超时约束。

时间窗口、静默时段、每日额度按配置的 IANA 时区计算，默认 `Asia/Shanghai`，不依赖服务器系统时区。额度 0 表示禁止；“最长视频分钟数”单独约定 0 表示不限制。

## 数据、停止与备份

数据在昔涟数据根目录下的 `plugin-data/bili-garden/`，与源码和插件 ZIP 分离。账号凭据由宿主 secrets 加密保存；没有明文 `bili_credential.json`，Python 仅从 stdin 接收当前调用凭据。

- `garden.sqlite`：配置、视频、字幕、报告、记忆、队列、执行与互动状态。
- `charter.md`：用户任务章程；升级遇到用户修改会保留原文件，并将新版放为 `.new`。
- `.venv`、`model-cache`：运行环境和可选转写缓存，可以按安装流程重建。

“停止本轮”会取消模型和 Python 操作；停用插件会停止轮询与进程。已发出的外部操作无法假称撤回。发送中发生超时或退出，会记为“结果不明”，不自动重发。只有平台明确拒绝的失败才能重新送审。

备份时先停用插件或停止服务，再备份整个插件数据目录；账号密钥还依赖宿主的安全存储材料，应与宿主数据整体备份。不要把这些数据放进 Git 或复制进插件包。

## 开发与验证

```bash
node --test extensions/bili-garden/test/*.test.mjs
pnpm exec vitest run src/main/plugin-agent.garden.test.ts src/main/plugin-panel-bridge.test.ts src/server/plugin-panel-document.test.ts
pnpm run build:web
node scripts/verify/bili-garden-agent.mjs
node scripts/verify/bili-garden-web.mjs
# 可选：实际安装 Python 依赖并验证二维码及接口白名单（不登录 B站）
node scripts/verify/bili-garden-runtime.mjs
```

功能设计和开发路线见 `docs/design/2026-11-01-bili-garden-roadmap.md`；实际验收范围见 `docs/changes/bili-garden-20261101.md`。

底层适配回归（安装 Python 运行依赖后，无需账号、不发网络请求）：

```bash
python -m pip install -r extensions/bili-garden/python/requirements.txt
python extensions/bili-garden/test/backend_test.py
```

真实安装验收（临时虚拟环境，无需账号，不下载 Whisper 模型）：

```bash
node scripts/verify/bili-garden-asr-install.mjs
```

使用上述验收输出的虚拟环境 Python 运行 `scripts/verify/bili-garden-download-recovery.py`，可在本机测试服务主动截断 wheel 下载后，验证 pip 发送非零 Range 请求续传并正确安装。此测试只安装临时测试包，不访问外部站点。
