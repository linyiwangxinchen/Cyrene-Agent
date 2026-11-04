# 任务接续、具体跟进与恢复能力

本轮延续统一昔涟改造，在 Windows 与 Linux Web 共用的核心实现。没有更新版本号、合并 master、发布安装包或操作线上数据。

## 用户可见变化

| 功能 | 原问题 | 本轮行为与主要位置 |
| --- | --- | --- |
| 微信等渠道的延时任务 | 到点只能生成聊天式提醒，工具任务与原会话接续不足 | 定时任务可执行冻结范围内的工具，结果回到原会话并发送原渠道。`src/main/scheduler/`、`orchestrator/tools/reminder-tool.ts` |
| 收发恢复 | 进程中断后难以区分未处理、已发送和结果未知 | 收件落盘、按平台消息 ID 去重、冻结绑定、逐段投递；在“连接手机 → 消息恢复与送达确认”核对未知结果。`channels/recovery-store.ts`、`durable-inbox.ts`、`delivery-service.ts` |
| 压缩后接着办事 | Todo 有步骤但缺少目标、约束、产物和下一步 | `update_todo.continuity` 保存工作笔记，随 CTA 活动分支、压缩检查点和重启恢复。`orchestrator/harness/task-continuity.ts` 与 transcript 投影/压缩模块 |
| 具体事项关怀 | 共同目标仅是字符串，无法知道是否已结束 | “昔涟设置 → 具体跟进”可指定会话、最早时间，并完成、暂停、取消或改期。发出后等待回复；未知/部分送达暂停。`relationship/followup-state.ts`、`proactive/followup-opportunities.ts` |
| 情绪线索 | 否定、引用、第三人的情绪可能被套给用户 | 保守识别直接自述，过滤“不累”、代码/引文、第三人称和假设。仍是可删除的推测，不是诊断。`relationship/mood-cues.ts` |
| 记忆删除 | 删除 L2 后，画像、Wiki 或旧消息重新提取可能留下同一事实 | 来源预览显示精确关联；用户勾选画像/Wiki范围；持久忘记标记阻止旧消息重新提取，新消息可重新学习。`memory/memory-governance.ts`、`memory-source-policy.ts`、`wiki-store.ts` |
| Linux 更新 | 在线复制数据不一致，失败后只回退源码可能破坏数据兼容 | 临时工作树先构建，停机后备份，记录确定版本和产物，失败恢复代码/产物/数据。`scripts/deployment/update-linux.mjs` |
| 服务就绪 | HTTP 进程存在不等于共享核心可处理请求 | `/readyz` 检查核心 RPC 和会话数据库读取，未就绪返回 503，关闭/退出后不再报成功。`src/server/readiness.ts`、`shared-core-client.ts` |

## 恢复语义与边界

- 旧纯提醒仍可使用；停机错过默认跳过，需要补执行时明确设置宽限。入队前写运行记录，记录失败不消费一次性计划。排队期间删除、停用或收紧任务配置会取消旧运行。
- 前台、渠道、主动提交和定时任务共享按会话运行守卫。工作笔记不是成功执行的证据，不会提高文件权限或允许重复外部副作用。
- 渠道分片有 pending/sending/sent/failed/unknown/cancelled 状态。重启前处于 sending 的片段转 unknown，核对后才恢复；已送达分片不会重发。消息已写 CTA 但还没有发送计划的极窄中断窗口，会明确要求检查原会话，不盲目重新执行工具。
- 微信游标在消息持久化后推进；关闭渠道会取消排队和正在生成的旧回复，重新启用不使旧发送复活。附件保留独立副本和原文件名。
- 主动消息先保存持久意图和 CTA，再发送固定目标；用户修改关系设置、绑定或目标后，旧意图不再按新目标投递。具体跟进仍受评分、勿扰与主动渠道设置约束，不保证准点。
- 自动结束跟进只识别完整事项名称及明确的完成/停止追问表达；引用、疑问与含糊表达不自动判断。用户可直接在界面修正。
- 旧记忆没有精确来源时，不猜关联。原聊天、附件和外部备份默认保留；它们仍可能作为当前会话上下文出现。Wiki 清理失败会保留禁止召回标记并提示，重启后重试物理清理。
- 更新器不会撤销工作区文件修改或已经发送的消息；手工回退需明确恢复旧数据，新版数据另存以备核对。详见 [Linux 操作指引](../deployment/linux-operations.md#531-已有-clone-目录的原地更新)。

## 数据兼容与可维护性

没有另起一套 Web 业务实现。公共类型、preload、认证 IPC 与设置面板继续共用；新增状态尽量置于独立模块。旧关系数据默认空跟进列表，旧 task_state 可不含 continuity，旧调度任务保持原提醒语义。来源标记按真实消息 ID 隔离，不用相似文本删除其他会话。

新增数据为应用数据目录下的 `channel-recovery/`、原关系 SQLite 中的跟进列表、CTA 工作笔记及 `memory.json` 忘记标记。部署备份应覆盖完整 `CYRENE_DATA_DIR`。升级材料保存在源码目录同级的私有 `.cyrene-updates-<目录名>/`，不提交账号、运行数据或构建产物。

## 验证

本轮包含单元/真实文件持久化测试、更新失败注入、共享核心 HTTP/Cookie/WS 验收和浏览器窄屏操作。自动测试使用临时数据，不读取生产密钥、不调用真实模型、不发送真实渠道消息。

可在依赖已安装的仓库执行：

```bash
pnpm run check:main
pnpm run check:preload
pnpm run check:server
pnpm run check:renderer
pnpm exec vitest run
node --test scripts/verify/linux-update.test.mjs
pnpm run build:main
pnpm run build:preload
pnpm run build:cli
pnpm run build:web
node scripts/verify/shared-core-parity.mjs
node scripts/verify/continuity-flow.mjs
node scripts/verify/companion-flow.mjs --ui
```

浏览器验收需已安装 Playwright Chromium；本机 Windows 可设置 `CYRENE_TEST_BROWSER_CHANNEL=msedge` 使用现有 Edge。Linux CI 已加入本轮新增覆盖；Windows 本地通过不表示已在远端 systemd 或真实微信环境完成验收。
