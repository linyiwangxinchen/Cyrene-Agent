# 2026-10-09 上游同步与 Linux/Web 兼容验收

本次同步分支为 `integrate/upstream-linux-web-20261009`，从本仓库 `master` 的 `866464b7` 开始，合并上游 `upstream/master` 的 `9fcff7a3`。共同基点为 `a20337d8`；上游在基点后有 18 个提交，本仓库有 19 个提交，因此 GitHub 不能直接把两个分支当作可快进分支。

## 上游变化

本次带入上游从 `29350af4` 到 `9fcff7a3` 的 18 个提交，主要包括：

- Moments 迁入 SQLite，保留旧数据只读导入、事务和幂等约束。
- 会话压缩、模型历史、会话标题、消息队列和子代理权限/工具范围修复。
- 统一模型客户端，补充 Claude Haiku 5.5 及其推理/结构化输出规则。
- 询问用户卡片、运行展示、任务会话和消息列表的 Windows UI 回归修复。
- Issue 模板与自动分流规则收紧，以及版本号更新至 v1.3.3。

上游改动没有删除 Linux/Web 适配文件；三方合并保留了本仓库在共同基点之后新增的 Web Server、浏览器桥、部署示例、验证脚本和文档。

## 冲突与兼容修复

| 文件 | 处理 |
| --- | --- |
| [`src/main/agui-bridge.ts`](../../src/main/agui-bridge.ts) | 采用上游“仅无工具 ChatLoop 创建运行记录”的判断，保留本地 SQLite 防重复注释；工具增强 Chat 继续由 Harness 创建记录。 |
| [`src/renderer/react/features/chat/hooks/useSessionMessages.ts`](../../src/renderer/react/features/chat/hooks/useSessionMessages.ts) | 保留上游同批追加去重行为及本地 hydration/队列竞态说明，避免消息重复显示。 |
| [`src/server/core/runtime.ts`](../../src/server/core/runtime.ts) | 适配上游压缩器接口：模型设置改为每次压缩请求传入，不再从全局档案重新读取，避免 Web 会话所选模型被摘要流程覆盖。 |
| [`docs/changes/upstream-sync.md`](upstream-sync.md) | 增加共同基点、冲突原因、`merge-tree` 预览、pnpm 版本固定和后续同步结构约定。 |

## 验收

- `corepack pnpm@10.33.0 install --frozen-lockfile` 成功；未下载 Electron 二进制。
- `check:server` 通过。
- `check:renderer` 通过。
- `build:web` 通过，生成服务端、headless SQLite worker、插件面板和 Web renderer。
- 相关回归测试 188 项通过。
- 全量 Vitest：569 个测试文件，5360 项通过，1 项按测试条件跳过。
- `git diff --check` 通过；构建生成的受跟踪资源变更已恢复，未把构建产物或运行数据带入提交。

## 后续推送与发布

本分支完成验证后合并到本仓库 `master`，再推送 `origin/master`。向上游贡献通用修复时，从本次合并结果提取最小补丁或单独 PR；不要把 Web Server、systemd、Linux 路径和部署文档整体提交到上游核心分支。下次上游同步按 [upstream-sync.md](upstream-sync.md) 的独立集成分支流程执行。
