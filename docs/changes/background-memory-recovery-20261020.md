# 后台长期记忆失败恢复（2026-10-20）

Linux 日志中的 `MemoryLlmProtocolError: Memory LLM [wiki] ... MODEL_REQUEST_FAILED (stage: memory_wiki)` 属于 Wiki 长期记忆提取，与聊天历史的上下文压缩是两条不同链路。模型请求失败本应只暂停本次记忆整理；此次排查发现，调度器还会产生无人处理的 Promise 拒绝，导致 Node.js 退出。

## 修改内容

| 修改位置 | 作用 |
| --- | --- |
| `src/main/memory/wiki-memory-scheduler.ts`、`summary-memory-scheduler.ts` | 修复队列清理的 `finally()` 派生 Promise 没有接收失败的问题。调用者仍能收到错误，后台任务按既有回调报告；任务失败不再使服务退出，也不把失败批次标为已处理。 |
| `summary-memory-scheduler.ts` | 等待异步的会话有效性检查，避免关闭、删除或切换记忆模式后继续写入旧目标。 |
| `src/main/memory/memory-llm-client.ts` | Responses 记忆请求改用现有流式 SDK，在内部收集完整结果，再进行结构化校验。支持仅接受流式请求的中转，保留输出预算、取消、终态校验、用量统计和 JSON 修复。其他协议维持现有调用方式。 |
| `src/main/services/llm/llm-client.ts` | 同步兼容辅助业务的 Responses 完整结果请求；调用方仍在结果完整后一次获得返回值。 |
| `src/main/orchestrator/structured-output/runner.ts`、`memory-llm-errors.ts` | 请求失败保留受限的错误分类、HTTP 状态和运行时错误码；日志不输出供应商错误正文、提示词或凭据。 |
| `src/server/core/runtime.ts`、`src/main/application/default-dependencies.ts` | 修正 Web 后台记忆错误回调参数错位；Windows 和 Web 都记录会话及安全错误原因。 |
| `src/main/orchestrator/vendors/model-runtime.ts` | 关闭 SDK 默认输出完整错误对象的日志；错误仍由流事件抛出。对拒答格式保持校验，避免内部流式收集放宽原有协议边界。 |

## 验证

- Main、Preload、Server、Renderer 四套类型检查与 `pnpm run build:web` 通过。
- 34 个测试文件、370 项测试通过，覆盖记忆、结构化输出、共享模型客户端、SDK、上下文压缩及主动聊天。
- `memory-background-schedulers.test.ts` 使用 `--unhandled-rejections=strict` 的独立 Node 子进程、真实 SQLite 与摘要文件；注入旧 Wiki 和 Summary 队尾行为均可复现退出，修复后失败保留进度，重开后可重试，取消后不落盘，关闭后旧回填不重开数据库。
- `node scripts/verify/shared-core-memory.mjs` 的 3 项验收通过：认证后的真实 Web/共享核心在 Wiki 401 失败后仍可用；重启后经仅支持流式的 Responses 模拟服务补写有来源的记忆；再重启不重复请求、不丢会话。
- 既有共享核心 34 项业务验收、上下文压缩 9 项验收全部通过。新增记忆回归已纳入 Ubuntu CI。

验收使用独立临时数据和本机模拟模型，不访问用户模型账号，也不替代用户运行实例的部署验证。

## 如何恢复

按 [Linux 更新说明](../deployment/linux-operations.md) 更新、重新构建并重启服务即可，不需要删除原会话、数据库、附件或记忆目录。Wiki 启动回填会重新处理没有成功完成的轮次。若模型本身仍有认证、额度或网络问题，本次整理仍会失败，但服务应保持运行，日志会提供具体分类。

排查时使用下面的命令：

```bash
sudo systemctl status cyrene-web --no-pager -l
sudo journalctl -u cyrene-web -n 120 --no-pager -l
curl --fail --max-time 10 http://127.0.0.1:4317/healthz
```

定时脚本最后的 `Successful` 只表示该脚本的退出状态。`/healthz` 目前只检查 Web 主进程；共享核心子进程退出后它仍可能成功。还应登录 Web，确认会话可以打开、聊天和设置能正常使用，没有 `CORE_UNAVAILABLE`。

截图没有展示原始请求的 HTTP 状态，因此不能仅凭截图认定模型请求失败一定由 Responses 非流式兼容引起；未处理拒绝导致退出的缺陷与此相互独立。
