# 上游同步记录（2026-10-17）

## 同步范围

- 上游：`Playa-Cyrene/Cyrene-Agent` `master`，同步到 `8d905897`。
- fork：`linyiwangxinchen/Cyrene-Agent` 原 `master` 为 `dc516d72`。
- 同步前 fork 比上游多 41 个提交、少 22 个提交；本次先纳入 fork 自己的 README 提交，再建立集成分支。
- 三方合并共同基点为 `11c235de`，上游这次净改动及集成提交均为 30 个文件（含 README）。两分支末端比较显示的 279 个差异文件包含既有 Linux/Web 适配，不能当成本次上游改动数量。
- 集成分支：`integrate/upstream-linux-web-20261017`。
- 备份分支：`backup/master-before-upstream-20261017`。

## 冲突与处理

本次只有 README 的贡献者头像自动维护区发生冲突。fork 的贡献者工作流把 fork 账号写入了上游同一段自动维护区域，而上游同期也更新了这段内容，因此 GitHub 无法直接合并。

处理结果：

1. 仅采用上游最新的 README 贡献者列表，保留上游工作流可继续维护的标记区，以及 fork 的 Linux/Web 介绍和四个文档入口。
2. 将 `.github/workflows/contributors.yml` 限制为只在 `Playa-Cyrene/Cyrene-Agent` 运行。fork 的 `master` 不再自动改写 README，后续同步不会因为 fork 专属头像提交反复产生冲突。
3. Linux/Web、Windows Electron 和共享核心代码均保留；上游新增的迁移失败保护、持久化重试、工作区 Git 监视、弹窗避让和 SVG 预览焦点修复已合入。

## 验证

- `corepack pnpm@10.33.0 test`：587 个测试文件通过，5576 个测试通过，1 个跳过。
- `check:main`、`check:renderer`、`check:server`：通过。
- `build:web`：通过。
- `build`：Windows 主进程、预加载、CLI 和共享渲染器构建通过。
- `verify:shared-core`：34 项通过。
- `verify:voice-mcp`：19 项通过。
- 构建产生的 `dist/renderer` 仅有行尾/格式差异，已恢复，未作为同步内容提交。
- 上述验收在本机 Windows 上完成，启动独立的已认证 Web 服务并检查真实业务执行；本次未更新远端 Ubuntu 服务，未向真实社交账号发送消息。

## 后续同步方式

保持 fork `master` 不直接修改上游维护的 README 头像区域；Linux/Web 专属适配继续放在独立文件或明确的共享核心补丁中。后续同步仍应在新的集成分支完成，并在 Windows/Web 检查通过后再快进 `master`。这样可以消除本次已知的 README 冲突来源，但上游与适配同时修改同一业务代码时仍需人工审查，GitHub 无法保证所有未来同步都自动合并。
