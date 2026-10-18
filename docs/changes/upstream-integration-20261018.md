# 上游同步记录（2026-10-18）

## 同步范围

- 原 fork master：`657f94af`；共同基点：`8d905897`。
- 上游 master：`13f61493`（包含 v1.3.4），本批 37 个提交，基点之后净改动 83 个文件。
- 集成分支：`integrate/upstream-linux-web-20261018`。
- 备份分支：`backup/master-before-upstream-20261018`，保留同步前 master。尚未提交的修复先备份到仓库外，再按主题提交到集成分支。
- 上游通过保留双亲的 merge commit `56c40e6c` 合入，未重写或强推历史。

## 冲突检查与兼容处理

本批双方修改重叠的文件有 9 个：README、package.json、AG-UI bridge、preload、ChatPage、三种语言文件和 Vite 配置。三方预览与实际合并均无文本冲突。此前 README 贡献者工作流只允许上游回写的限制仍然有效；保留上游 README 重构、贡献者内容和 fork 独立的 Linux/Web 入口。

上游的过期末轮回退保护、Markdown 行号导航、网易云歌单分页/曲目标识修复、QQ 监听地址解析、Gemini 4 Argon、动态图片 CSP、发布配置和 mpv 清单均已同步。Web 继续复用对应共享存储、模型注册表、音乐服务与 React 页面。

无文本冲突并不等于 Web 已适配：上游地址栏补全仅接入 Windows IPC，本次补齐 Web 宿主，直接复用 `normalizeAddressInput`、`parseHttpUrl` 和 `navigationErrorCode`，不复制规则。补全仅用于地址栏；Agent 工具仍要求完整 HTTP(S) URL，其他协议仍拒绝。

## 本地修复与提交主题

| 主题 | 作用与验证边界 |
| --- | --- |
| Linux 命令执行 | 按系统选择解释器，Linux 探测系统 Bash，Windows 保留 cmd/Git Bash；继续执行原有权限和沙箱限制。 |
| 原图上下文 | journal 保留用户附件引用；多轮请求和工具循环压缩后重新读取原图；检查点只保存最近一组原图的路径元数据，SQLite 归档重启、二次压缩后仍能恢复，新图替换旧图，撤回/回退不复活；最终 Responses 请求同时包含原图字节及绘图工具。 |
| 微信生成图投递 | 采集模型生成图片完成事件，将持久化文件交给渠道消息合成及发送；保留 Web 文件；iLink 测试对比加密上传后的原始字节。 |
| 微信重复发送保护 | Harness 不汇总 `lastResult.toolResults`，改从本轮真实派发事件读取文件参数；显式发送成功、失败或结果未知均不在收尾隐式重发。 |
| Web 地址栏 | 省略协议、全角主机和内网地址遵循上游补全规则；覆盖实际导航、持久化恢复、协议拒绝与加载失败。 |
| 主动聊天回归夹具 | 保留真实模型档案解析器，以空顶层配置和默认档案验证 SQLite 绑定会话、模型请求、微信发送及日志投影链路。 |
| MCP 浏览器路径与版本 | 内置 MCP 显式继承浏览器缓存/可执行文件路径；部署和更新分别安装 Web 与 MCP 各自依赖的 Chromium；新增真正启动浏览器并读取本地页面的验收。 |
| 同步预检与 CI | 新增独立脚本和 Ubuntu 24.04 工作流；不改上游 Windows CI，不为新脚本改 package.json。 |

功能变更使用独立中文提交主题和说明，便于向上游提取最小补丁。适配目录 `src/server/`、`src/renderer/web/`、`deploy/`、构建/验收脚本与部署文档均保留。

主要修改位置：`shell-runtime.ts` / `run-shell-tool.ts` 处理平台解释器；`build-options.ts`、`conversation-transcript-*` 和 `vendors/types.ts` 处理原图请求与持久化；`channels/bootstrap.ts`、`dispatcher.ts`、`outgoing-composer.ts` 和 `vendors/model-history.ts` 处理图片收尾投递及文件引用；`src/server/core/browser.ts` 处理 Web 地址栏；`sync-mcp-builtin.ts` 处理 MCP 子进程浏览器路径；`scripts/verify/`、对应测试及独立 workflow 检查以上链路。

## 防止后续重复冲突

1. 继续限定贡献者工作流只在上游回写；fork 不维护上游生成的 README 头像区。
2. 合并前运行 `node scripts/verify/upstream-sync.mjs`：先拒绝未提交修改，再预览三方合并、列出重叠/冲突文件，并检查双端入口及工作流保护。脚本不改分支、索引或工作树。
3. `rerere.enabled=true`、`rerere.autoupdate=false`：记录已解决冲突但不自动暂存，复用后仍须人工审查。
4. Linux/Web CI 独立放在 `.github/workflows/linux-web.yml`；关键规则复用共享函数，避免在 Web 复制一套逐渐漂移的实现。
5. 版本、锁文件和依赖变更跟随上游 pnpm 10.33.0；构建资源仅行尾变化时经检查恢复，不进行全仓换行归一化，不使用 `ours` 策略掩盖核心冲突。

这些措施减少重复冲突并提前发现语义差异，但无法保证未来上游与 fork 同时修改共享业务代码时 GitHub 永远自动合并。维护者操作命令见 [同步指南](upstream-sync.md)。

## 验证

- pnpm 10.33.0 冻结安装通过，保留上游锁文件。
- `check:main`、`check:preload`、`check:renderer`、`check:server` 通过。
- Windows `build`、Web `build:web` 通过；模型目录与插件 schema 检查通过。
- 全量 Vitest：596 个测试文件通过，5969 项通过、1 项跳过；真实压缩/归档/重启后的 Responses 原图字节和 MCP 路径继承均包含在内。
- `verify:shared-core`：34 项通过，包含认证、Chat/Work/Code/Learn、试卷、子代理、插件、知识库、定时任务、QQ、浏览器、后台命令与 SQLite 重启恢复。
- `verify:voice-mcp`：21 项通过，包含实际音频输入输出、会话归属、三种 MCP 传输、重连恢复，以及 Agent 实际调用 bundled MCP 打开本地 HTML、读取页面并将工具结果送回模型。
- 同步预检黑盒测试：6 项通过，逐项确认 HEAD、refs、索引和工作树不变。
- 实际历史 ref 的同步预检通过：`44b191d1` 对 `upstream/master`，确认双方重叠 9 个文件但无文本冲突。
- GitHub Ubuntu 24.04 最终功能集成验收：[Linux Web #3](https://github.com/linyiwangxinchen/Cyrene-Agent/actions/runs/39139161927) 对 `a6ff085c` 通过，耗时 2 分 15 秒，执行类型检查、Web 构建、图片/微信/压缩回归及认证后的业务/语音/MCP 验收；MCP 使用自身锁定依赖安装的 Chromium 默认启动，无可执行文件路径覆盖。
- 本地构建改写的 23 个已跟踪资源经 `git diff --ignore-space-at-eol` 确认仅行尾变化后恢复，未提交构建产物、依赖或运行数据。

自动验收使用本地受控模型/渠道服务，没有调用用户付费模型或向真实微信联系人发送测试消息。本地 MCP 浏览器使用环境覆盖指向已安装 Chromium，Ubuntu CI 则从锁定依赖安装并使用其默认版本。本次为源码同步与 GitHub 推送，不自动更新远端 Ubuntu 运行目录；照片人像保真效果仍须在部署后用实际照片和绘图服务复验。旧版本已归档且未保存原图引用的检查点保持兼容，但不能凭新字段恢复当时未保存的引用；这类旧会话需要重新附上原图。
