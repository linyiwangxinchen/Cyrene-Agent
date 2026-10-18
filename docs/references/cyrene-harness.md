# CyreneHarness 核心引擎

> `Work / Code / Learn` 等需要工具调用的会话模式，全部跑在 **CyreneHarness** 之上。
> 源码：[`src/main/orchestrator/harness/cyrene-harness.ts`](../../src/main/orchestrator/harness/cyrene-harness.ts)

CyreneHarness 是 Cyrene Agent 的核心 Agent Loop，负责把**模型决策、工具执行、副作用记账与状态恢复**串成一个可中断、可恢复、可回放的连续循环。

> 会话轨迹由 **CTA（Canonical Transcript Architecture）** 承载：canonical journal 是唯一权威源，
> 模型上下文、UI 投影与渠道消息全部从 transcript 派生；压缩摘要以 checkpoint 形式持久化，
> 热日志归档到 `segments/`，支持跨进程崩溃恢复与编辑 / 重新生成回溯。
> 源码：`src/main/orchestrator/conversation-*.ts`（store / journal-service / compactor / projection 等）

## 关键设计

- **连续的 while + Function Calling 循环** — 每轮调用 LLM，按其返回的 `toolCalls` 进入工具派发，无 `toolCalls` 时由模型主动结束当前 turn。
- **assistantMessage 必写回** — 每轮模型返回的 assistant 消息必须无条件 `push` 进 `messages`，否则下一轮模型会看不到自己上一步的回复，loop 立即崩。
- **Ask 互斥路径** — `ask_user` / `confirm_uncertain_effect` 是用户等待类内置工具，必须独占本轮：其余同轮工具全部以 `not_executed` 协议结果写回，并 `discardProgressBuffer()` 丢弃进度文本。
- **四态 outcome 与 uncertainEffects 拦截** — 工具结果分为 `success / failure / unknown / not_executed`。当 `unknown` 且 `sideEffect === non_idempotent` 时，副作用会被记入 `state.uncertainEffects`，并 `halted = true` 暂停本轮后续同类调用，防止自动重放危险副作用。
- **失败重试** — 工具失败时根据 `classifyToolResultError` + `resolveSideEffect` 决定是否重试；`sleepWithJitter` 退避可被 `AbortSignal` 中断。
- **保守并行调度** — 默认串行，仅“显式声明并发安全的纯读工具”可并行（默认上限 4）；结果始终按模型原始 tool-call 顺序提交；halt / error / cancel 时已执行结果不丢弃，出错槽位以合成失败结果闭合 transcript。
- **双时钟超时** — 执行计时与用户等待计时分离：`ask_user` 等待用户期间暂停执行计时，用户思考多久都不消耗任务超时预算。
- **双层压缩（Mid-loop + Journal Compaction）** — harness 每轮开始时根据 token 预算判断是否需要压缩上下文，超阈值时复用 LLM 做历史摘要，保留 todo 与已确定结果，压缩后 checkpoint 失败立即熔断；构建上下文超预算时再触发 journal 级压缩——摘要以 compaction checkpoint 持久化进 transcript，热日志归档至 `segments/`，二次压缩保留前次摘要，编辑 / 重新生成不能跨压缩边界回溯。
- **前缀缓存体系** — 稳定前缀分层（stablePrefix / sessionPrefix / mode），Todo 等易变状态禁止进入前缀；工具清单在 run 期间冻结；动态事实一次性物化进 transcript 而非每轮拼接；`cacheEpoch` 缓存周期跨压缩 / 恢复推进；Kimi `prompt_cache_key` 等厂商缓存 hints 在请求层统一注入。
- **工具输出双级截断** — 大输出落盘存储（`ToolOutputRef`），模型消息只保留 preview；需要完整内容时由模型调用内置 `read_tool_result` 按需回读，大幅降低上下文占用。
- **上下文容量快照** — 每轮请求前与终态各发一次 `context_usage` 快照事件，驱动 UI 上下文环实时显示。
- **截断可见化** — 输出命中模型长度上限（`finishReason = length`）时在回复尾部追加提示，不静默截断。
- **流式优先与降级** — 仅在零增量且供应商明确不支持 stream + tools 时降级非流式，绝不重放半截流；token 用量记账区分缓存命中。
- **全程 signal-aware** — 几乎每个 `await` 都用 `raceWithSignal` 包裹，`signal.aborted` 时返回 `cancelled()`（`finalAnswer = ''`，**不发 `final_answer` 事件**）。
- **每轮 checkpoint** — 通过 `onCheckpoint` 把 `messages` + `state` + `rounds` 持久化，跨进程崩溃后可恢复；恢复时崩溃孤儿工具按运行状态归为 `unknown`（而非误判 `not_executed`），避免重放外部副作用。

## 四种终止状态

| 状态 | `terminated` | `terminateReason` | 触发条件 |
| :---: | :---: | :---: | --- |
| ✅ success | `false` | `undefined` | 模型不再调用工具，主动结束当前 turn |
| ⚪ cancelled | `true` | `cancelled` | `AbortSignal` 触发（`finalAnswer = ''`） |
| 🟥 error | `true` | `error` | LLM 抛错或 checkpoint 失败 |
| 🟨 timeout | `true` | `timeout` | 超过 `config.totalTimeoutMs` |

## 主流程

![CyreneHarness 主循环](../image/harness.png)

*（示意图：① 初始化 → ② 主循环 → ③ LLM → ④ 工具调度 → ⑤ 状态账本 → ⑥ 终态结算）*

---

[← 返回 README](../../README.md)
