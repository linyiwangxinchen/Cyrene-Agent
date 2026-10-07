# 向上游同步修改

上游基准是 `63c43efbfe36136afc8a936d15018cd6cb2bd9c3`（v1.3.1），上游地址为 `https://github.com/Playa-Cyrene/Cyrene-Agent.git`。本分支源代码提交到 `https://github.com/linyiwangxinchen/Cyrene-Agent.git` 的 `master`，保留上游历史。没有重写或强推上游。

## 修改清单和提交主题

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

在这个发布仓库执行：

```bash
git remote -v
git log --reverse --oneline 63c43efbfe36136afc8a936d15018cd6cb2bd9c3..master
git diff --stat 63c43efbfe36136afc8a936d15018cd6cb2bd9c3..master
# 具体文件的功能 diff
git diff 63c43efbfe36136afc8a936d15018cd6cb2bd9c3..master -- src/main/channels
# 以新的外部目录保存整组补丁；补丁不是源码提交内容。
git format-patch --output-directory ../cyrene-linux-patches \
  63c43efbfe36136afc8a936d15018cd6cb2bd9c3..master
```

Linux 适配独立分支可先基于这套基准执行 `git am ../cyrene-linux-patches/*.patch`，随后完整检查/构建。需要基于更新后的上游时，在独立集成分支处理冲突，不在正式服务目录直接重置历史。

## 同步上游新代码

```bash
git remote add upstream https://github.com/Playa-Cyrene/Cyrene-Agent.git
# 已有 upstream 时只需要 fetch
git fetch upstream
git switch -c integrate/upstream-linux-web master
git merge upstream/master
# 解决冲突后运行检查和验证，再提交到自己的分支供审查。
pnpm install --frozen-lockfile
pnpm run check:main
pnpm run check:preload
pnpm run check:server
pnpm run check:renderer
pnpm run build:web
pnpm run verify:shared-core
pnpm run verify:voice-mcp
```

特别检查新增上游 IPC 是否已经由平台宿主注册、preload 是否与 Web 桥一致，以及提示词、journal、权限策略、工具效果和渠道生命周期是否继续复用。Windows 版的构建/测试也要按上游要求完成；不得只因 Web 页面可见就判断适配完整。

当前发布目录排除了本次构建 JS、node_modules、浏览器下载、运行数据、SSH key.txt、私有日志和验收截图。上游 `dist/renderer` 中原本跟踪的头像/表情/模型和启动屏属于源资源，必须保留；许可证和原作者声明也保留。
