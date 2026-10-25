# 2026-10-25 上游同步与兼容性验收

本次同步将上游 `Playa-Cyrene/Cyrene-Agent` 的 `master` 从 `6094d1b638613c88f049314f5ddd308d74461576` 更新到 `1c0c15e8213e7ed26cf03866dfdf1f66e99af2ad`，并合并到 `integrate/upstream-linux-web-20261025`。当前 fork 的本地 `master` 在共同基点后有 73 个提交，上游有 24 个提交，因此 GitHub 不能直接自动合并。同步前已创建并推送 `backup/master-before-upstream-20261025`，保留原始 `master` 提交 `8324dc174417adfc9a4dd838921456d15d385df8`。

## 冲突处理

- `src/main/settings/settings-ipc.ts`：保留 Web/主动聊天的状态查询、目标评分失效、MCP 自动同步、TTS 历史设置入口和连接测试超时；接入上游数据目录 IPC 注册及浏览器视口模式刷新。刷新调用使用可选方法，避免 Linux headless 浏览器没有桌面视口控制器时抛异常。
- `src/renderer/react/features/settings/GeneralSettingsPanel.tsx`：接入上游数据目录读取、打开目录失败提示和重试成功后清除旧提示；继续隐藏 Linux Web 不适用的窗口状态、开机启动、GPU 和桌面更新控件。

上游删除的 `src/server/**`、`src/renderer/web/**`、`deploy/**`、Linux Web 工作流、服务端构建脚本以及 fork 专用共享模块均保留，避免把 Linux/Web 运行链路误当成上游删除。上游新增的 Kimi K3.1 Pro/Highspeed 注册、数据目录 API、浏览器自动/移动 UA 与配套测试均进入集成树。

## 验收证据

- `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile`：通过，pnpm `10.33.0`。
- `check:main`、`check:preload`、`check:server`、`check:renderer`：通过。
- `build:web`：通过，生成服务端与 Web renderer；已恢复构建对跟踪 `dist/renderer` 源资源产生的行尾/格式改写。
- 全量 Vitest：615 个测试文件，6447 通过，1 跳过。
- `scripts/verify/upstream-sync.test.mjs`：6/6 通过。
- shared core：34 项通过；voice/MCP：21 项通过；transcript compaction：9 项通过；memory：4 项通过；shell：5 项通过。
- `pnpm run package:win:dir`：通过，Windows x64 `release/win-unpacked` 目录包完成构建；随后 `pnpm exec electron-builder --win nsis --publish never` 生成 `release/Cyrene-Setup-1.3.4-3.exe`，并由 `scripts/verify/installer-artifacts.mjs --expect-version 1.3.4-3` 校验 `latest.yml`、blockmap、MinGit、mpv 和截图助手。构建使用现有 `1.3.4-3` 版本，不覆盖既有 GitHub Release。

集成提交为 `4a3d6ff0`。通过集成分支 CI 后，将其快进到 `master` 并推送；后续同步仍应先使用日期集成分支和 `scripts/verify/upstream-sync.mjs`，不要在正式服务目录直接合并。
