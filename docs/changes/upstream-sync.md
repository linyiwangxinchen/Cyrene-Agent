# 向上游同步修改

上游地址为 `https://github.com/Playa-Cyrene/Cyrene-Agent.git`，本仓库地址为 `https://github.com/linyiwangxinchen/Cyrene-Agent.git`。当前发布基线为本仓库 `master`，保留上游历史；没有重写或强推上游。

## 修改清单和提交主题

最近一次上游同步：[2026-10-09 集成与验收记录](upstream-integration-20261009.md)。集成分支为 `integrate/upstream-linux-web-20261009`，从共同基点 `a20337d8` 合入上游 `9fcff7a3`，保留 Linux/Web 适配并修复服务端模型压缩器接口变化。此前的 [2026-10-08 集成记录](upstream-integration-20261008.md)仍用于追溯 SQLite 迁移。

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
git fetch upstream --prune
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

`pnpm@10.33.0` 必须显式调用：项目的 `pnpm.overrides` 与锁文件由该版本维护，pnpm 11 会提示忽略该字段并可能报告错误的 lockfile config mismatch。不要在合并验证时并行运行多个 pnpm 安装，否则 Windows 的 `node_modules` 符号链接可能出现 `EEXIST/EBUSY`。

### 为什么 GitHub 不能自动合并

GitHub 的“无法自动合并”来自两个分支在共同基点之后同时修改同一代码行，并不是 Linux 新增文件本身造成的：

- 本仓库在 `a20337d8` 之后新增了 SQLite/Web 兼容改动；上游随后提交了 18 个新提交。
- `src/main/agui-bridge.ts` 同时调整了 Chat 运行记录创建条件；两边语义相同但注释和表达式不同，Git 无法安全选边。
- `src/renderer/react/features/chat/hooks/useSessionMessages.ts` 两边都调整了同批 React 状态追加的去重实现，只有变量名/注释差异，也会被 Git 标为内容冲突。
- 上游比较结果显示删除了本仓库新增的 `deploy/`、`src/server/`、`src/renderer/web/` 和部署文档；这些路径在共同基点上是本仓库后来新增的，正常三方合并应保留，不能用“以 upstream 为准”整体覆盖。

### 便于后续同步的结构约定

1. Linux/Web 专属代码继续放在 `src/server/`、`src/renderer/web/`、`deploy/` 和 `scripts/verify/` 等新增边界内，尽量不改上游核心文件。
2. 必须触及共享核心时，保持小而明确的适配点，并在提交说明中写出 Windows 与 Web 两端都需要的行为；本次 `agui-bridge` 和 `server/core/runtime` 就属于这类适配点。
3. 每次同步都保留独立的 `integrate/upstream-linux-web-YYYYMMDD` 分支和日期报告；验证成功后再快进或合并到 `master`，不要直接在正式运行目录解决冲突。
4. 先用 `git merge-tree --write-tree master upstream/master` 预览冲突，再逐文件处理；禁止用 `git checkout upstream/master -- .` 覆盖整棵树。
5. 每次同步必须同时做 Server/Renderer 类型检查、全量 Vitest、`build:web` 和共享核心/语音-MCP 验收；仅能编译或 GitHub 能合并不表示 Web 运行链路兼容。

特别检查新增上游 IPC 是否已经由平台宿主注册、preload 是否与 Web 桥一致，以及提示词、journal、权限策略、工具效果和渠道生命周期是否继续复用。Windows 版的构建/测试也要按上游要求完成；不得只因 Web 页面可见就判断适配完整。

当前发布目录排除了本次构建 JS、node_modules、浏览器下载、运行数据、SSH key.txt、私有日志和验收截图。上游 `dist/renderer` 中原本跟踪的头像/表情/模型和启动屏属于源资源，必须保留；许可证和原作者声明也保留。
