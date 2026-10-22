# 2026-10-22 上游集成与 Windows 1.3.4-3

## 同步范围

- 同步前 master：`94549db596710616f8c0a38ca9f6356ea015fbc0`，版本 1.3.4-2。
- 共同基点：`13f6149348c3d874d7e0a616e548b9cfdfd170cd`。
- 本次上游：`6094d1b638613c88f049314f5ddd308d74461576`；包含基点后的 64 个提交，净修改 77 个文件。
- 备份：`backup/master-before-upstream-20261022`；集成：`integrate/upstream-linux-web-20261022`。
- 保留双亲合并历史；不覆盖旧 Release、不强推、不修改用户数据目录。新版 Windows 安装包版本为用户指定的 `1.3.4-3`。

## 功能与兼容处理

| 范围 | 合入功能及保留的适配 |
| --- | --- |
| 后台 Shell | 合入完成结果持久化、自动续轮、来源工作区/运行/工具调用校验、退役与重试、前后台统一结算及退出处理。Web 宿主等待会话 IPC 初始化，并在工作区变更、删除前取消和结算旧续轮；退出先停止派发，再关闭 Shell 与数据库。 |
| 浏览器断开后的续轮 | 在共享 bridge 增加可选的后台上下文提示，Web 后台事件改走服务器广播，避免定时器继承已关闭浏览器的 AsyncLocalStorage。Windows 原调用方式保持兼容；不复制运行器或开放新的后台调用权限。 |
| Learn | 合入全局运行槽互斥、来源 Vault 固定、异步进度写回隔离，以及忙碌拒绝的 SQLite 轨迹与统计。后台执行继续禁止出卷、邮件草稿、权限询问等无人接收的交互卡片。 |
| 会话压缩 | 合入后台事件退役检查点和 CAS 保护；保留 fork 的分片摘要、Responses 流式设置和最近用户原图恢复。归档、退役、再次压缩后，旧任务结果不重新出现，原图引用和未消费事件保持正确。 |
| 定时任务 | 工作区用户任务重启后恢复 Work/Code；微信、飞书、QQ、QQ Bot 延时提醒仍为 Chat，并保留 delivery、reminder 和启用状态。插件任务继续走原审批与模式规则。 |
| MCP 设置 | 合入数字/布尔参数兼容、控制字符拒绝、提交前统一校验及编辑模式切换保护；保留带空格/引号参数、cwd、HTTP/SSE、effectKindOverrides 和原 IPC 往返能力。 |
| 模型 | 同步 MiniMax M3.1 Flash 正式型号；预览型号保留为历史兼容项，官方核验标记仅属于正式型号。 |
| 依赖 | 同步 React/ReactDOM 19.3.1、Electron 44.7.2、sandbox-runtime 0.0.80 及其他上游更新。KaTeX 单独保持 0.16.47，与 `@streamdown/math → rehype-katex` 实际渲染版本一致，防止 0.19 样式与旧 HTML/字体混用。 |

## 五处冲突为何不能自动合并

双方在相同共享业务区域分别新增功能，Git 无法判断应如何组合：

1. `conversation-transcript-compactor.ts`：fork 的原图与分片摘要字段，遇到上游退役序号、检查点身份与 CAS 校验；同时保留两组字段及生效条件。
2. `conversation-transcript-projection.test.ts`：两侧在同一测试尾部新增不同回归；保留双方并补充组合场景。
3. `harness/adapter/tool-runtime.ts`：工具上下文同时新增渠道来源、后台完成回调和交互限制；完整传递三者。
4. `scheduler-store.ts`：上游恢复 Work/Code 与 fork 渠道提醒 Chat 归一化修改同一分支；按任务归属分别恢复，不能整段选一侧。
5. `McpSettingsPanel.tsx`：上游参数校验与 fork 参数序列化修改同一解析流程；合并校验和实际 IPC 配置契约。

这些属于功能语义冲突，不能用 `ours`、`theirs` 或整文件覆盖安全解决。合并后上游 `6094d1b6` 成为 master 的祖先，已同步的这一批提交不会再次形成 behind；未来两边修改同一逻辑仍可能需要人工处理。

## 降低后续同步成本

- 新 Web 宿主行为集中在 `src/server/core/runtime.ts`；共享 bridge 只新增一个可选上下文参数。
- 新验收放独立 `scripts/verify/shared-core-shell.mjs` 和现有 Linux/Web CI，不为新增脚本反复修改上游 package scripts 或 Windows workflow。
- README 贡献者生成区继续仅允许上游仓库回写，fork 不再次生成冲突。
- 保持 pnpm 10.33.0，避免锁文件整体重写；KaTeX 例外有真实公式渲染、样式版本和字体来源回归保护。
- 本地启用 `rerere.enabled=true`、`rerere.autoupdate=false`，复用历史解决方案后仍需审查；不添加跳过核心冲突的合并驱动。
- Linux/Web CI 新增 Shell 完成、任务模式恢复、Learn、MCP 参数和 KaTeX 契约回归，以及真实后台续轮/退出/重启验收。

操作流程见 [上游同步指南](upstream-sync.md)。此类措施能减少重复冲突，不能保证未来 GitHub 永远可以自动合并。

## 验收边界

本地完成的检查：

- pnpm 10.33.0 冻结安装，四项类型检查 `check:main/preload/server/renderer`，Windows `build` 和 `build:web` 均通过；插件 schema 与模型清单生成契约检查通过。
- 默认 forks 配置全量 Vitest：608 个文件、6349 项通过，1 项跳过。没有为通过验收修改测试池配置；此前临时 threads 运行的 17 项错误来自不支持 `process.chdir()`，已在默认 forks 全量复验。
- 认证后的共享业务 34 项、TTS/ASR/MCP 21 项、摘要压缩/归档/重启 9 项、后台记忆失败恢复 4 项，以及新增后台 Shell/Learn 实际验收 5 项均通过。
- Shell 验收实际断开原浏览器、等待服务器自动续轮、变更/删除会话并验证退役；同时存在真实 Shell 进程及等待中的模型续轮时，退出、杀掉子进程、SQLite 标记停止并重启恢复约 2.6 秒，满足 15 秒退出期限。
- 同步预检的 6 项黑盒测试通过，确认预览不改变 HEAD、refs、索引或工作树。
- Windows x64 NSIS 1.3.4-3 编译完成；版本、内置 Git 2.55.0、mpv、截图辅助程序检查通过，7-Zip 完整性检查通过。ASAR 的 22 项检查确认编译内容与当前代码一致，许可证和 fork 更新源完整，没有凭据/聊天数据库/构建工作区。
- Windows 新包隔离实机运行 20 项通过：Electron 44.7.2、两次正常退出、SQLite 写入与重启恢复、设置页面原生滚轮滚动及回滚、5 张截图视觉检查；所检页面无未捕获渲染异常。
- 已跟踪静态源资源的构建改写经忽略行尾差异检查后恢复；保留上游文件原换行，空白检查以 `cr-at-eol` 识别 CRLF，没有整仓换行归一化。

所有模型和渠道自动验收使用隔离数据与本地受控服务，不调用用户付费模型、不向真实联系人发送测试消息，也不自动更新生产 Ubuntu 服务。Windows 运行验收使用新包的 `win-unpacked`，不覆盖本机用户设置；NSIS 安装器另做归档完整性和版本/更新元数据校验。

本地 bundled MCP 浏览器验收显式指向已安装 Chromium；Ubuntu CI 将分别安装 Web 和 MCP 各自锁定的版本并使用默认路径。安装包没有数字签名。未在当前机器运行 NSIS 安装/卸载；Windows 隔离验收的退出卸载阶段有 cursor-position handler 已移除的日志，未造成页面异常或退出失败。

sandbox-runtime 0.0.80 的真实导入、所需导出及 Windows x64 附带程序已检查。其 Windows 沙箱状态存储迁移至 HKLM/ProgramData；本次未安装沙箱、未触发 UAC、未更改机器证书或注册表，旧沙箱配置迁移仍需具备对应权限的环境专项验证。
