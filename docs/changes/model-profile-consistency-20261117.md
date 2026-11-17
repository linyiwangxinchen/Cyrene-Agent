# 修复后台模型与默认档案不一致

日期：2026-11-17。适用于桌面与 Linux/Web 共享核心。

## 问题与修复

用户在模型档案中将默认型号从 `gpt-6-astra` 改为 `gpt-6.1-sol` 后，聊天入口会展开保存的档案，但部分辅助任务直接读取旧的顶层模型镜像。编辑默认档案原先只更新 `modelProfiles`，未同步旧镜像，因此同一实例可能向供应商发送两种型号，连接地址和凭据也可能沿用旧配置。

隔离回归已复现这一配置分歧，不需要真实账号或模型请求。修复包括：

- 编辑默认档案时，在同一次保存中更新对应的兼容镜像；编辑非默认档案不切换默认模型。
- 切换默认档案和随后保存其他设置时，保留模型清单、每型号能力及图片生成配置。
- CITA 语义理解、社交事实提取、朋友圈模型与配图路由、翻译工具、回复后的情绪观察统一展开默认档案，已有旧镜像不再决定这些任务的型号。
- 保存任何已存在的模型档案都广播模型变化，修复默认档案不在列表末项时漏发通知的问题；公开状态显示解析后的默认型号。
- 公共 LLM 客户端的现有 `TIMING ... START` 日志增加 `model` 字段，配合原任务标签区分后台调用。日志不增加连接凭据或提示正文。

## 模型选择规则

普通对话使用该会话选中的型号；已有会话若明确保存了 Astra，只要它仍在绑定档案的可选清单中，就会继续使用 Astra。修改供应商档案的默认型号不会替换这些已有会话的选择。

不属于特定会话的后台任务使用默认档案的默认型号。只在某个聊天窗口切换为 Sol，不等于改变后台默认型号。Wiki/Summary 记忆和世界续写原本已展开默认档案，这次保持其行为。独立视觉模型及显式配置的子智能体模型仍遵从各自设置。

未发现普通回复、主请求重试或流式转非流式会将 Sol 自动降级为 Astra。供应商后台的历史条目仍需结合部署配置、会话选择与请求时间逐笔确认，不能仅凭本地复现断定每一笔 Astra 请求的来源。

## 验证与上线观察

持久化回归先复现“新档案 Sol、旧镜像 Astra”，修复后检查即时读取、重启读取、非默认档案编辑、既有会话选择以及每型号选项保留。辅助任务回归使用假 API 检查真正发出的 JSON `model` 字段，而不只检查界面或调用记录标签。

最终相关回归为 39 个文件、661 项通过，四套 TypeScript 检查通过。测试同时覆盖普通回复、主动消息、会话模型选择、世界续写及后台辅助任务，没有调用真实供应商接口或向真实渠道发消息。本轮没有连接 Linux 线上实例读取配置；上述结果证明本地修复，不能将其当作线上账单逐笔核对结果。

使用仓库固定 pnpm 10.33.0，可复现：

```sh
corepack pnpm exec vitest run src/main/settings/model-profile-persistence.test.ts src/main/services/default-model-consumers.test.ts src/main/services/llm/llm-client.test.ts src/main/moments/moments-service.test.ts src/main/orchestrator/agent-runtime.test.ts src/main/proactive
corepack pnpm run check:main
corepack pnpm run check:server
corepack pnpm run build:server
```

更新 Linux/Web 时，沿用现有账号、`CYRENE_DATA_DIR` 和数据库，按 [Linux 更新说明](../deployment/linux-operations.md#53-更新程序)构建并重新加载服务。本轮本地代码修复不会自动更新线上实例。设置页确认默认档案及其默认型号为 Sol；对于仍需改用 Sol 的已有会话，在聊天模型选择器中修改。

使用 systemd 默认服务名时，可只看带模型标识的公共客户端启动日志：

```sh
journalctl -u cyrene-web --since '15 minutes ago' --no-pager | grep '\[TIMING\].*START.*model='
```

此日志覆盖公共 LLM 客户端调用，不是所有网络请求的完整账单。若同一时间服务器日志发出的型号为 Sol，供应商仍记为 Astra，需要进一步核对供应商路由映射和其他共用账号的实例。本轮不依赖真实供应商调用验收。
