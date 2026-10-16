# 2026-10-16 上游集成与 Linux 退出兼容修复

集成分支：`integrate/upstream-linux-web-20261016`。更新前的 `master` 为 `1ebd6fefcc66937b2f2a18d37e6584f9ce51c67d`，保留在 `backup/master-before-upstream-20261016`。

共同基点为 `a4bd4419bf298e412bd2479c5f7bfa1a3066de00`；合入上游 `11c235de56ce4e36998c14efccaa837f3fdb1b7a`。新增 39 个上游提交（其中 25 个非合并提交），涉及 71 个文件。使用正常合并保留双方历史，没有重写历史。Git 未报告文本冲突，仍对实际功能和宿主生命周期进行验证。

## 上游变化

| 范围 | 行为变化 |
| --- | --- |
| 向量记忆 | 待处理轮次迁入 SQLite；按正式会话来源校验，撤回、重新生成和删除后不继续使用失效回复；保留运行发起用户的归属 |
| 后台命令 | 任务元数据与日志索引持久化，重启可查询历史；异常中断的执行标记为状态未知，不自动重新执行 |
| 聊天交互 | 支持回车翻页/提交、暂不回答、推荐项说明和本地化提交文本 |
| 图片和图表 | 改用工作区预览标签，防止预览被内嵌网页层遮挡，关闭后恢复原标签 |
| 插件市场 | 刷新时同时重新获取当前来源的市场列表 |
| Windows | 过滤 Git refs 根目录元数据事件；修复音乐窗口拖动、歌单滚动、Live2D 动作资源路径和解析；移除模型控制 Live2D 的工具 |
| 数据迁移与测试 | 旧数据迁移增加完成标记和被覆盖数据备份；调整测试超时与异步视图等待 |

## 本仓库额外修改

| 文件 | 修改作用 |
| --- | --- |
| `src/server/core/runtime.ts` | 显式等待后台命令收尾，再关闭 SQLite。其他资源退出失败时仍执行这两项清理；重复关闭复用同一 Promise |
| `src/main/orchestrator/tools/builtin-tools/shell-job-manager.ts` | 记录正在执行的 Windows `taskkill`，正常停止任务及退出时等待进程树清理完成，避免主进程先退出、任务状态已停止但子进程仍存在的竞态；Unix 保留进程组终止 |
| `src/main/orchestrator/tools/builtin-tools/shell-job-persistence.test.ts` | 新增回归：即使任务终态已经保存，只要进程树终止器尚未完成，退出就必须继续等待 |
| `scripts/verify/shared-core-parity.mjs` | 通过认证 Web Agent 启动真实后台 Node 进程，关闭服务后检查 `stopped/app_exiting`、结束时间和进程实际终止，重启后核对历史未被改写为异常恢复；失败也清理测试进程 |
| `dist/renderer/models/cyrene/Cyrene.model3.json` | 同步仓库原已跟踪的静态模型描述文件，与上游源资源一致，将动作文件名中的 `#` 编码为 `%23`，避免构建后产生实质资源差异并阻挡后续更新；不包含生成的 JS 或依赖 |
| `src/renderer/react/i18n/ja-JP.json` | 补齐原生 Responses 兼容设置的两条日语文案，使语言键完整性检查通过 |
| `docs/deployment/linux-operations.md` | 说明数据库版本 8/9 的自动升级、正常停止及完整数据回退要求 |
| 本文、`linux-web-changes.md`、`upstream-sync.md` | 记录来源、每项兼容修改及验收，提供后续同步入口 |

Windows Electron 与 Linux Web 继续复用核心业务。微信 iLink 附件、主动聊天、绑定会话和 GPT Responses 缓存修复保留；本次没有切换模型、账号或渠道配置。

## 验收与运行边界

- Main、Preload、Renderer、Server 类型检查通过；Windows 主进程、预加载、试卷预加载、CLI、Web 页面及 headless 核心实际构建通过。
- 最终全量回归：582 个测试文件全部通过，5537 项测试通过、1 项跳过。首次全量检查发现日语键遗漏，补齐后重新执行全量检查通过。
- 隔离的认证 Web 共享核心验收通过 34 项，包含真实后台任务启动、进程终止、终态落盘和重启保留历史。
- TTS、ASR、语音通话及 MCP 三种传输的隔离协议验收通过 19 项。
- 实际进程验收运行在 Windows 上的无桌面 Web 宿主。此次未登录或更新远端 Ubuntu，也未向真实微信、飞书或 QQ 账号发送消息；不将本机验收表述为新的 Linux 实机部署结果。

## Linux 升级注意

本次会自动增加数据库迁移 8（记忆待处理轮次）和 9（后台任务历史）。按 [Linux 更新步骤](../deployment/linux-operations.md#531-已有-clone-目录的原地更新)停止服务、备份完整数据目录、拉取、构建和重新启动即可；必须继续使用现有 `CYRENE_DATA_DIR`。

正常停止会终止仍在执行的后台命令，不会在重启时自动重跑命令。`kill -9`、断电等强制终止无法执行退出收尾，恢复时会将原运行任务记为 `app_restarted_execution_unknown`，需要人工检查实际执行结果。需要回退时同时恢复升级前的完整数据备份，不能只切换 Git 提交。
