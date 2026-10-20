# 长会话上下文压缩修复（2026-10-20）

Linux Web 的 `上下文压缩失败：TRANSCRIPT_COMPACTION_REQUIRED` 是压缩失败的内部错误码，旧版本没有把实际失败步骤传到页面。此次检查发现并修复以下缺陷；用户运行实例的具体失败原因仍需结合该实例日志确定。

| 修改位置 | 修改作用 |
| --- | --- |
| `src/main/orchestrator/context-manager.ts` | 摘要输入保留文字、工具调用参数/结果和附件路径，省略图片编码；按会话模型的上下文容量分片摘要，再合并。保留原记录及图片引用。修复历史含 `$&` 等字符时的字符串替换问题。 |
| 同上 | 为摘要输出和推理预留容量；拒绝空白、拒答或截断的摘要。仅对可重试的网络、限流和服务异常最多重试两次，取消或认证失败立即退出。 |
| `src/main/orchestrator/harness/compaction.ts`、`cyrene-harness.ts` | 按系统提示词、工具定义及本轮环境占用调整近期历史保留量，不拆开工具调用与结果；压缩后检查完整输入是否满足硬容量限制。 |
| `src/shared/transcript-compaction-error.ts`、`conversation-transcript-compactor.ts` | 区分模型未配置、模型请求失败、无有效摘要、无安全边界、历史变化和检查点写入失败。失败时不以占位摘要替代历史。 |
| `build-options.ts`、`src/main/agui-bridge.ts`、`src/main/chats/chats-ipc.ts` | 内部回执保留机器码，用户界面获得安全的具体原因；不透传供应商原始错误正文或凭证。 |
| `src/preload/index.ts`、`ContextUsageRing.tsx` | 手动压缩展示服务器返回的原因，重试清除旧错误。 |
| `src/server/core/runtime.ts` | Web 压缩生命周期事件传递真实上下文用量，压缩完成后更新页面统计。 |
| 对应单元测试、`scripts/verify/shared-core-compaction.mjs`、`.github/workflows/linux-web.yml` | 回归测试覆盖摘要分片、预算、重试、安全边界和失败保留历史；认证后的真实 Web 共享核心验收纳入 Ubuntu CI。 |

## 验证

- Main、Preload、Server、Renderer 四套类型检查及 `pnpm run build:web` 通过。
- 本次相关 10 个测试文件、290 项测试通过。
- 本地隔离启动正式 Web 服务，以模拟模型验证 7 条完整链路：注册压缩 API、长图片/工具历史压缩、认证失败保留、空摘要保留、临时失败重试、Work/Harness 自动压缩后继续流式回复、重启恢复。
- 测试使用独立临时数据，不访问真实模型账号，不修改用户会话；本地通过不等同于已部署到用户 Linux 服务。Ubuntu 原生回归由仓库 CI 执行。

## 更新后恢复已有会话

按 [Linux 更新说明](../deployment/linux-operations.md) 更新源码、重新构建并重启服务。原会话和附件无需删除，回到原会话重新发送或点击上下文面板中的主动压缩即可重试。若模型认证、余额、网络或实际上下文配置仍有问题，新版本会显示相应原因。
