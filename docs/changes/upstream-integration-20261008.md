# 2026-10-08 上游集成与 Windows / Web 验收

集成分支：`integrate/upstream-linux-web-20261008`。从本仓库 `fb327bf09bf0eef81115841fa1b92b5904c281e9` 创建，合入上游 `a20337d8495c3465d84d065d1605eed7425bc0f5`，保留双方提交历史，无强推。

## 合入的上游提交

| 提交 | 上游修改 |
| --- | --- |
| `4873729d` | 会话存储迁移到 SQLite，事务与请求幂等冲突隔离 |
| `528451dd` | 子任务及 Token 用量迁入 SQLite，退役 checkpoint 全量快照 |
| `6f508e05` | 退役不再读取的 projection_json 全量投影写路径 |
| `49329353` | 项目消息日期与标题改为竖排，修复长标题布局 |
| `a20337d8` | 新 Issue 标签分流工作流，不自动评论或关闭 Issue |

上游修改涉及 119 个文件。本次额外修复围绕两端共同使用的新存储契约和 headless worker；没有撤回 Linux/Web 功能。

## 冲突处理及额外兼容修改

| 文件 | 修改作用 |
| --- | --- |
| [`.gitignore`](../../.gitignore) | 合并双方规则：保留凭据、浏览器、验收与构建忽略，增加 SQLite 主文件、WAL/SHM 等伴随文件忽略 |
| [`tts-synthesis-service.ts`](../../src/main/services/tts/tts-synthesis-service.ts) | 冲突处使用异步 `getSessionRecord`，保留从 v2 journal 读取 TTS presentation 缓存；保留取消检查，避免已缓存语音在关闭供应商后不能播放 |
| [`headless-core.mjs`](../../scripts/build/headless-core.mjs) | 构建独立 `conversation-database-worker.js`，使打包后的数据库客户端能直接启动 worker，生产环境无需源码编译回退 |
| [`create-web-runtime.mjs`](../../scripts/packaging/create-web-runtime.mjs) | 导出前检查数据库 worker，拒绝不完整的生产包 |
| [`runtime.ts`](../../src/server/core/runtime.ts) | 等待异步会话初始化，再注册业务；停用生产者并完成持久化处理后关闭 SQLite worker |
| [`agui-bridge.ts`](../../src/main/agui-bridge.ts) | 工具增强 Chat 由 Harness 将 prepared 运行切换到 running，桥层只为无工具 ChatLoop 启动运行，修复重复 create 导致 HARNESS_RUN_EXISTS；同一修复适用于 Windows 和 Web |
| [`ChatComposer.tsx`](../../src/renderer/react/features/chat/components/ChatComposer.tsx) | 检查 window 是否存在再判断 Web 标记，恢复 Node 环境中的 React 渲染及桌面组件回归 |
| [`McpSettingsPanel.tsx`](../../src/renderer/react/features/settings/McpSettingsPanel.tsx) | 普通参数保持可读文本，复杂参数用 JSON 数组保存；表单/JSON 切换不丢失空参数、引号、Windows 路径、空白与换行 |
| [`McpSettingsPanel.config.test.ts`](../../src/renderer/react/features/settings/McpSettingsPanel.config.test.ts) | 添加复杂 MCP 参数无损往返的回归 |
| [`tts-session-cache.test.ts`](../../src/main/services/tts/tts-session-cache.test.ts) | 将会话读取样例更新为异步，继续覆盖 v1/v2、缓存版本、自动播放与取消 |
| [`shared-core-parity.mjs`](../../scripts/verify/shared-core-parity.mjs) | 子任务和打开存储目录检查改为 SQLite；增加旧会话/子任务/用量只读导入、无工具 Chat、重复请求幂等、重启后持久化与回执保留验收 |
| [`linux-operations.md`](../deployment/linux-operations.md) | 明确数据库 worker 必需产物、SQLite/WAL 完整备份和旧版本回退方法 |
| [`linux-web.md`](../deployment/linux-web.md) | 更新生产包组成，包含 SQLite worker |
| [`linux-web-changes.md`](linux-web-changes.md) | 为原始迁移清单增加本次上游集成记录入口，原始 179 项清单仍对应初始适配系列 |
| [`upstream-sync.md`](upstream-sync.md) | 链接本次集成记录，方便按日期追踪后续上游同步 |
| 本文 | 记录上游来源、每项兼容修复、实际验证与边界 |

## 验收结果

所有构建和临时依赖位于发布源码目录之外，正式账号、会话和渠道配置没有用于这些测试。

- **类型检查**：Main、Preload、Renderer、Server 全部通过。
- **Windows 构建**：Main、Preload、试卷 preload、CLI、Renderer 实际构建通过；Web Server 与 headless 核心/两个 worker 构建通过。
- **全量回归**：567 个文件，5262 项通过，1 项跳过。包含上游新增 SQLite、会话幂等、子任务、用量、UI 与已有 Linux/Web 回归。
- **Windows Electron 实际执行**：Electron 44.4.3 / 内置 Node 24.21.0 加载编译后的数据库 worker，实际验证会话、子任务、用量写入以及关闭/重新打开持久化。没有仅用 Node 模拟 Electron 的这部分运行环境。
- **Windows 上的 Web 执行**：31 项共享核心端到端检查、19 项语音/MCP 检查通过；405 项 preload 契约分类无缺口，298 个业务处理器注册，生成 57 项功能报告。
- **仅生产依赖运行包**：使用 pnpm 10.33.0 `--prod --frozen-lockfile` 安装并实际启动，鉴权、HTML/头像、初始化、登录、WebSocket 及原业务设置调用通过。包内已包含数据库 worker，无需 esbuild 回退。
- **Ubuntu 实机**：Node 24.16.0，在独立目录使用资源受限的临时测试进程；6 个文件、70 项存储/音频回归通过，同样的 31 项共享核心和 19 项语音/MCP 执行检查全部通过。既有正式程序与数据未被替换。
- **迁移专项**：旧会话、旧子任务和旧用量导入后原文件字节语义不变；会话历史、子任务、统计在服务器关闭并重新启动后保留；重复同一请求不产生第二次模型调用，重启后回执仍然有效。

全量测试中的 1 项跳过按测试自身条件保留，没有为了消除失败而跳过测试。语音/MCP 使用本地协议服务和真实 SDK；实际云供应商账号及第三方租户权限仍依赖自己的配置。Windows 完整安装包、Live2D 交互和所有手机实体设备没有在本次重新逐项验收。

## 后续部署

本次提交并推送集成分支，便于审查后合入本仓库 `master`。正式升级前按 [Linux 操作指南](../deployment/linux-operations.md) 备份完整数据目录，携带新的数据库 worker；不要把旧版本运行包的 `core.cjs` 单独替换为新版本。

上游再次更新时，应重新取最新提交检查异步读写、worker 产物及关闭生命周期，而不能仅依靠 Git 自动合并和 TypeScript 检查判断对话可以运行。
