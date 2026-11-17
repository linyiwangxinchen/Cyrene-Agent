# 修复翁法罗斯续写失败后的诊断与恢复

日期：2026-11-17。适用于桌面与 Linux/Web 共享核心。

## 问题

页面显示“续写失败，按作息运行”“今日尝试 3/3”“今日世界推演 3/8”时，同一任务实际已经达到自动尝试上限，不会因为还剩每日额度而再次请求。旧提示仍承诺“稍后重试”，且所有请求错误都压成 `request_failed`，无法分辨超时、鉴权、限流或模型接口错误。这段状态本身不能证明线上失败的具体原因。

原来事件结算和重大结果复核共用一个 90 秒计时器，结算耗时较长会挤占复核时间。世界续写原本已解析默认模型档案，此次不切换型号、不引入其他模型兜底。

## 修复

- 明确区分自动尝试上限、每日总额度与下次自动尝试时间。单项自动尝试仍最多 3 次，默认每日总额度仍为 8 次。
- 提供显式手动重试，继续消费当天剩余额度并累计原任务次数；服务端验证冷却、开关、进行中的请求与剩余额度。重启和重复点击不能清空计数或绕过限制。限流遵守服务商的 `Retry-After`。
- 每次规划、结算、复核各自最多等待 180 秒；持久化租约覆盖结算和复核两次请求，避免另一实例提前发起重复调用。取消、跨日和时区校验保留。
- 只持久化模型错误分类及 HTTP 状态，未知旧错误保持未知；主任务状态不会再被同时间的复核子请求覆盖。
- 日志区分 `amphoreus-plan`、`amphoreus-resolve`、`amphoreus-review`，共享 LLM 日志仍记录实际请求型号。

## 验证

相关回归 29 个文件、359 项通过，覆盖真实临时存储重启、旧失败记录的第四次手动恢复、并发去重、每日额度、限流冷却、逐请求超时、默认模型档案、共享 IPC 和界面行为。main、preload、renderer、server 四套类型检查通过，服务端和页面构建通过。测试使用隔离数据与假模型，不调用线上账号。

```sh
corepack pnpm exec vitest run src/main/amphoreus-world src/main/proactive src/main/relationship/companion-lifecycle.test.ts src/main/settings/model-profile-persistence.test.ts src/renderer/react/features/settings/AmphoreusWorldPanel.test.tsx src/server/web-persona-runtime.test.ts --maxWorkers=3
corepack pnpm run check:main
corepack pnpm run check:preload
corepack pnpm run check:renderer
corepack pnpm run check:server
corepack pnpm run build:web
```

## Linux 观察

按现有 [Linux 更新流程](../deployment/linux-operations.md#53-更新程序)构建页面和服务，保留原账号、数据目录与数据库。已达 3 次自动尝试的记录不会被升级清零；有剩余额度时在世界页面点击“重试续写”。

现有旧版本的失败日志可用以下命令筛选；服务名按实际部署替换：

```sh
journalctl -u cyrene-web --since today --no-pager | grep -E '\[TIMING\] amphoreus-.* (TIMEOUT|ERROR|CANCELLED)' | tail -n 6
```

分享日志前只保留错误类型、HTTP 状态和耗时，删除可能出现的凭据和完整地址。本地验证不调用真实服务商，也不代表已经确认或修复某个线上服务商故障。
