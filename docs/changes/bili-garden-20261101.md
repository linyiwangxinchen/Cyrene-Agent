# 昔涟的 B 站小花园：实现与验收

开发基线 `be512f22`，备份分支 `backup/master-before-new-features-20261101`，开发分支 `feat/cyrene-bili-garden-20261101`。先完成 [完整设计和路线](../design/2026-11-01-bili-garden-roadmap.md)，再分阶段实现。

## 实现内容

| 文件/模块 | 作用 |
| --- | --- |
| `extensions/bili-garden/manifest.json`、`index.mjs` | 原生插件入口、默认停用、宿主 LLM/secrets 依赖、统一 IPC 与聊天任务工具 |
| `lib/config.mjs` | 统一配置校验、0 额度语义、IANA 时区、时段和运行间隔 |
| `lib/store.mjs` | SQLite/WAL、schema 版本、报告累计、队列、幂等动作、配额及重启中断恢复 |
| `lib/bilibili.mjs` | 扫码/登录轮询、加密凭据接口、账号状态和 API 结果归一化 |
| `lib/python.mjs`、`python/` | 平台环境安装、摘要校验、stdio 私有操作集合、超时/取消/子进程清理、带时间字幕和可选 ASR |
| `lib/policy.mjs` | 评论/守护/圈地目标检查、唯一私信接收人、赞藏证据/额度/冷却、发送与撤销状态机 |
| `lib/runner.mjs`、`content.mjs`、`charter.md` | 昔涟内容任务、冻结工具集、记忆回注、结构化报告、引用验证、片单与 Markdown 导出 |
| `lib/service.mjs` | 配置/任务/守护/界面命令、后台轮询、账号与启停生命周期 |
| `panel.html/css/js` | 发现、一起看、手记、互动、设置五页；亮暗主题、手机布局、进度/错误反馈 |
| `vendor/`、`NOTICE.md` | 明确保留 DSH 鱼塘和 bilibili-mcp 的来源、许可；不复用 DSH 宿主或开放全部 MCP 工具 |
| `src/plugins/api.ts`、`context.ts` | 兼容扩展人格模式、动态任务资料、档案描述、工具策略及用量结果 |
| `src/main/plugin-agent.ts`、`plugin-runtime.ts` | 真实共享 Chat 人格/默认档案、隔离任务轨迹、工具策略和用量；修复原无头目标未写入轨迹而实际报空内容的问题 |
| `src/main/orchestrator/harness/*` | 只读回调模型实际用量，不重复写全局用量统计 |
| React `PluginSettingsPanel`、`PluginModePanel` | 功能插件列表旁挂载配置面板，启停/刷新后同步重建面板 |
| `src/main/plugin-panel/panel-bridge.js` | 等待宿主初始化后再发送首个请求；超时清理、来源检查，避免首屏请求丢失 |
| `src/server/plugin-panel-document.ts`、`index.ts` | 已认证 HTML 内嵌本地脚本/样式及 nonce；修复 SameSite Cookie + opaque sandbox 导致资源被 ORB 拦截、以及全局 X-Frame-Options 阻止面板的问题 |
| `src/renderer/settings/plugin-panels.ts` | 保持 Web opaque origin；允许正常表单事件、用户打开链接/导出；失败请求回传，避免 Promise 悬挂 |
| `scripts/build/bundled-plugins.mjs` 及两个构建入口 | Windows 和 Linux Web 都随包提供默认停用插件，排除测试、环境和数据 |
| `scripts/packaging/bili-garden.mjs`、`create-web-runtime.mjs` | 独立 ZIP 以及 Linux runtime 内插件资源 |
| `src/plugins/extract-archive.ts`、`installer.ts` | 解决 Windows Node 24 文件流解压卡死：在原 50 MiB 归档上限内使用 yauzl Buffer reader，保留全部原路径/符号链接/体积/重复名校验，并增加实际大小与 CRC 校验 |
| `.github/workflows/linux-web.yml` | 后续 Linux CI 执行插件边界、真实宿主任务和浏览器验收 |

对外互动在 JS 宿主同一策略中检查；自动任务不能直接绕过包装器调用 Python MCP。Python 不落明文凭据。状态不明不会自动重发；评论查询只表述当前查询范围内的可见性。

## 验收进展

- 已通过插件 18 项行为测试：配置/BV/时区、重启、权限开关、UID、0 额度、并发、超时/风控、UP 邀请、报告和引用、真实记忆回注、取消、守护水位/重试、ASR 配额、扫码凭据边界、缺失回执及真实子进程清理。
- 已通过真实安装 Python 依赖、内嵌后端导入、二维码生成、未登录拒绝及未列入操作拒绝；没有调用真实 B 站发送接口。
- 已通过真实认证 headless core + fixture 模型/视频接口：用户修改的 Chat 人格、工具调用、报告、记忆、实际 token 与缓存统计、停用收尾。
- 已通过主项目 624 个 Vitest 文件：6568 项通过、1 项跳过；认证共享业务 34 项通过。
- Main、Preload、Renderer 和 Server 类型检查，`build:web` 与完整 Windows `build` 已通过。
- Electron 44.7.2 / 内嵌 Node 24.21.0 真实运行时通过已打包 ESM 插件加载、SQLite、IPC、配置和关闭检查。
- Ubuntu 24.04.2 LTS x86_64 / Node 24.16.0 在隔离临时目录通过全部 18 项原生插件测试；没有 DISPLAY 依赖，没有修改正式服务。
- 认证 Web + Chromium 通过插件启用/挂载、设置保存、队列和重载、字幕与记忆、未登录拦截、390px 手机布局、深色主题、Markdown 实际下载和独立外链窗口。外链目的页使用 fixture 拦截，未向真实 B 站账号发送内容。
- 既有语音/MCP 验收 21 项通过。
- 插件 ZIP 校验了 manifest、默认停用状态、许可和目录边界；不包含 test、node_modules、venv、数据库、日志或 Python 缓存。
- ZIP 导入额外回归：真实的大文件 deflate 解压、CRC 损坏拒绝、Finder 元数据兼容，以及原插件安装/替换/安全边界共 49 项通过。最终插件包已通过真实宿主导入准备、manifest 校验和暂存清理。

本地证据目录为 `D:/00linux/.build-temp/bili-garden-20261101/`。其中 `web-qa/` 含桌面/手机/深色截图、导出文件与结果 JSON，`linux-native.log/json` 是 Ubuntu 验收结果，`electron-result.json` 是 Electron 验证结果。构建与测试日志不进入 Git。

## 边界

本轮没有真实 B 站账号登录或真实评论/私信/赞藏投递，也没有把用户常驻服务切换到开发版本。Ubuntu 已完成原生插件测试；整套 Ubuntu Web 服务和真实 B 站网络链路仍需部署后验收。Whisper 下载及实际音频识别需要用户选择安装模型后单独实测，已覆盖无字幕、额度、缺环境及取消的程序路径。
