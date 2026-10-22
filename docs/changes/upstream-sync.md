# 向上游同步修改

上游地址为 `https://github.com/Playa-Cyrene/Cyrene-Agent.git`，本仓库地址为 `https://github.com/linyiwangxinchen/Cyrene-Agent.git`。当前发布基线为本仓库 `master`，保留上游历史；没有重写或强推上游。

## 修改清单和提交主题

最近一次上游同步：[2026-10-22 集成与验收记录](upstream-integration-20261022.md)。集成分支为 `integrate/upstream-linux-web-20261022`，从共同基点 `13f61493` 合入上游 `6094d1b6` 的 64 个提交，处理 5 处共享业务冲突，并完成后台 Shell/Learn、压缩、任务模式、MCP 和依赖兼容；Windows 发布版本为 `1.3.4-3`。[2026-10-18 集成记录](upstream-integration-20261018.md)保留前一轮图片/微信和 Web 地址栏适配；[2026-10-17 集成记录](upstream-integration-20261017.md)记录 README 自动生成区冲突的处理。此前的 [2026-10-16 集成记录](upstream-integration-20261016.md)、[2026-10-09 集成记录](upstream-integration-20261009.md)和 [2026-10-08 集成记录](upstream-integration-20261008.md)用于追溯后台任务收尾、压缩器适配和 SQLite 迁移。

[linux-web-changes.md](linux-web-changes.md) 给出每一个新增/修改文件的作用。提交按 10 个主题组织，commit body 也逐文件描述用途：

1. `refactor(core)`：两端共用人格、模式、语气、关系和表情规则。
2. `fix(models)`：连接测试取消桌面单例依赖，保留通用设置副作用。
3. `fix(channels)`：微信接收与扫码可靠性、真正生效的渠道启用/停用。
4. `feat(voice)`：自部署 ASR、语音取消、音频格式、v2 缓存和会话归属。
5. `feat(mcp)`：三种传输、配置验证、重连、启动恢复和工具执行边界。
6. `feat(server)`：认证 HTTP/WebSocket 和承载原业务的 Node worker/平台端口。
7. `feat(web)`：复用 preload 的浏览器桥、嵌入页面和图片上传。
8. `fix(ui)`：会话草稿、thinking、滚动、试卷、图片资源与手机交互。
9. `build(web)`：服务端构建、可移植运行包及功能/语音/MCP 回归脚本。
10. `docs(linux)`：部署例子、操作文档、导出忽略规则与逐文件说明。

这些主题组成一个有依赖的系列：平台宿主调用共享规则，Web 调用新增 IPC，UI 导入 Web 组件，构建配置连接各入口。单个中间提交不保证能独立编译。向上游提交完整 Linux 支持时使用整个系列；只提交通用 bug 修复时，用其 diff 提取最小补丁，并带相关测试与必要类型。不要把整个 Linux 宿主误当作一个无依赖的微信修复。

## 查看差异和输出补丁

在这个发布仓库执行。不要用工作区文件状态判断分叉关系，先计算共同基点：

```bash
git remote -v
BASE=$(git merge-base master upstream/master)
git rev-list --left-right --count master...upstream/master
git log --reverse --oneline "$BASE"..master
git diff --stat "$BASE"..master
# 具体文件的功能 diff
git diff "$BASE"..master -- src/main/channels
# 以新的外部目录保存整组补丁；补丁不是源码提交内容。
git format-patch --output-directory ../cyrene-linux-patches \
  "$BASE"..master
```

Linux 适配独立分支可先基于这套基准执行 `git am ../cyrene-linux-patches/*.patch`，随后完整检查/构建。需要基于更新后的上游时，在独立集成分支处理冲突，不在正式服务目录直接重置历史。

## 同步上游新代码

```bash
set -e
git fetch origin --prune
git fetch upstream --prune
node scripts/verify/upstream-sync.mjs master upstream/master
git branch backup/master-before-upstream-YYYYMMDD master
git switch -c integrate/upstream-linux-web-YYYYMMDD master
BASE=$(git merge-base master upstream/master)
git rev-list --left-right --count master...upstream/master
git merge --no-commit --no-ff upstream/master
git diff --check
# 冲突处理完成后确认没有未解决路径，再继续验证
git diff --name-only --diff-filter=U
corepack pnpm@10.33.0 install --frozen-lockfile
corepack pnpm@10.33.0 run check:main
corepack pnpm@10.33.0 run check:preload
corepack pnpm@10.33.0 run check:server
corepack pnpm@10.33.0 run check:renderer
corepack pnpm@10.33.0 run build:web
corepack pnpm@10.33.0 run verify:shared-core
corepack pnpm@10.33.0 run verify:voice-mcp
corepack pnpm@10.33.0 exec vitest run
git commit                         # 保留 merge commit 和冲突说明
git push origin integrate/upstream-linux-web-YYYYMMDD
```

日期分支名应替换为当次日期。预检脚本会拒绝未提交修改，显示共同祖先、两侧提交数、重叠文件及 `merge-tree` 预览结果，并检查 Windows/Linux/Web 关键入口和贡献者工作流的上游仓库限制。它不会 fetch、stash、恢复文件或修改分支、索引、工作树；Git 只会写入临时合并对象。需要 Git 2.38 及以上。退出码 `0` 表示可自动合并且入口保护通过，`2` 表示冲突，`3` 表示适配保护失败，`1` 表示前置检查失败。

预检通过只表示没有文本/结构冲突；上游可能新增 Windows 专用 IPC，仍需检查 Web 对应实现。本次地址栏补全就是这样发现的差异。独立的 `.github/workflows/linux-web.yml` 在 `master`、`integrate/**` 推送及面向 `master` 的 PR 上运行 Ubuntu 类型、构建、渠道/图片测试和认证后的共享业务验收，不修改上游 Windows CI 文件。

`pnpm@10.33.0` 必须显式调用：项目的 `pnpm.overrides` 与锁文件由该版本维护，pnpm 11 会提示忽略该字段并可能报告错误的 lockfile config mismatch。不要在合并验证时并行运行多个 pnpm 安装，否则 Windows 的 `node_modules` 符号链接可能出现 `EEXIST/EBUSY`。

### 为什么 GitHub 不能自动合并

GitHub 的“无法自动合并”来自两个分支在共同基点之后对同一区域作出了不能自动协调的修改，并不是 ahead/behind 数字或 Linux 新增文件本身造成的。

2026-10-17 的唯一文本冲突在 `README.md` 的贡献者头像自动维护区：上游和 fork 都运行相同工作流，但 GitHub 的贡献者统计针对各自仓库，生成的账号、顺序和表格分行不同。两边反复提交同一自动生成区域，就会反复冲突。这次只采用该区域的上游结果，保留 Linux/Web 介绍与文档入口，并将工作流的 job 限制到上游仓库，fork 后续不再回写这段内容。

此前 2026-10-09 的冲突发生在 `agui-bridge.ts` 与 `useSessionMessages.ts` 的相同业务代码行，需要人工协调共享核心逻辑。目录末端之间的 `git diff master..upstream/master` 还会把 fork 新增的 Linux 文件显示为删除，但这不是上游实际删除这些文件；应根据共同基点和三方合并判断，禁止整文件或整目录采用 upstream 覆盖所有适配。

### 后续能否在 GitHub 直接同步

可以在没有新冲突时使用 **Sync fork → Update branch**。本次已消除已知的 README 自动生成冲突来源，后续该区域仅跟随上游。GitHub 仍不会自动解决未来同一业务代码的冲突；遇到冲突时应继续使用集成分支并完成 Windows/Web 验收。

**Sync fork** 是同步上游分支；PR 的 **Enable auto-merge** 是等待审查和必需检查满足后合并 PR，不能替代冲突解决。本次没有配置定时无人值守同步，也没有绕过检查自动选择某一侧代码。参见 [GitHub 同步 fork 文档](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)及 [PR 自动合并文档](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)。

### 便于后续同步的结构约定

1. Linux/Web 专属代码继续放在 `src/server/`、`src/renderer/web/`、`deploy/` 和 `scripts/verify/` 等新增边界内，尽量不改上游核心文件。
2. 必须触及共享核心时，保持小而明确的适配点，并在提交说明中写出 Windows 与 Web 两端都需要的行为；本次 `agui-bridge` 和 `server/core/runtime` 就属于这类适配点。
3. 每次同步都保留独立的 `integrate/upstream-linux-web-YYYYMMDD` 分支和日期报告；验证成功后再快进或合并到 `master`，不要直接在正式运行目录解决冲突。
4. 先用 `git merge-tree --write-tree master upstream/master` 预览冲突，再逐文件处理；禁止用 `git checkout upstream/master -- .` 覆盖整棵树。
5. 每次同步必须同时做 Server/Renderer 类型检查、全量 Vitest、`build:web` 和共享核心/语音-MCP 验收；仅能编译或 GitHub 能合并不表示 Web 运行链路兼容。
6. 版本号、release 配置、依赖和锁文件跟随上游；fork 的新脚本优先放独立文件，不为了挂一个命令反复修改 `package.json`。不要对全仓执行换行归一化，也不要用 `ours` 驱动跳过共享代码冲突。

本地可开启 Git 的冲突解决记录，减少同一冲突反复手工处理；关闭自动暂存，复用结果仍需检查：

```bash
git config rerere.enabled true
git config rerere.autoupdate false
```

构建后如只有已跟踪 `dist/renderer` 的行尾发生变化，按 Linux 更新教程的差异检查恢复这些构建改写后再预检；存在实际修改时应先保留审查。不要为通过预检删除运行数据或执行全仓 `reset --hard` / `clean`。

特别检查新增上游 IPC 是否已经由平台宿主注册、preload 是否与 Web 桥一致，以及提示词、journal、权限策略、工具效果和渠道生命周期是否继续复用。Windows 版的构建/测试也要按上游要求完成；不得只因 Web 页面可见就判断适配完整。

当前发布目录排除了本次构建 JS、node_modules、浏览器下载、运行数据、SSH key.txt、私有日志和验收截图。上游 `dist/renderer` 中原本跟踪的头像/表情/模型和启动屏属于源资源，必须保留；许可证和原作者声明也保留。
