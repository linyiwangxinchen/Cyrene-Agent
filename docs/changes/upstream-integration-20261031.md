# 2026-10-31 上游同步与兼容性验收

本轮从原 `master` 提交 `bfe8b1b6790946692d14d9f8cbdb8c1c4bfb5d94` 创建并推送 `backup/master-before-upstream-20261031`，在 `integrate/upstream-linux-web-20261031` 集成上游 `8f6f1abde58e234a65e6dff6a1d81c407d8c4211`。共同基点为 `1c0c15e8213e7ed26cf03866dfdf1f66e99af2ad`；同步前 fork 独有 76 个提交，上游新增 21 个提交，实际上游增量涉及 47 个文件。验收跨日于 2026-11-01 完成。

## 合入功能与文件用途

| 领域 | 文件 | 修改作用 |
| --- | --- | --- |
| 请求预算 | `src/main/orchestrator/context-manager.ts`、`context-usage.ts`、`vendors/model-history.ts` | 按实际请求投影计量正文、工具参数及符合来源的私有 reasoning；不重复计算展示副本。损坏的旧工具参数允许预算回退，但真实模型请求仍拒绝无效历史。保留 fork 的流式摘要、重试、分块和图片引用保护。 |
| 预算贯穿 | `src/main/chats/chats-ipc.ts`、`src/main/orchestrator/build-options.ts`、`chat-loop.ts`、`conversation-transcript-compactor.ts`、`harness/compaction.ts`、`harness/cyrene-harness.ts`、`harness/harness-observability.ts` | 将模型来源传入会话计量、压缩切点及快照；额外修复 fork 持久化压缩的尾窗选择、固定提示词差额和压缩后硬预算检查，避免同源 reasoning 被误算为不可压缩开销。保留压缩失败原因与原文保护。 |
| 主动聊天 | `src/main/proactive/proactive-lifecycle.ts`、`proactive-service.ts` | 接入上游冻结投递目标及 Chat 模型档案解析。本地主动会话使用自身模型绑定；微信/飞书沿用普通渠道 Chat 的默认档案解析，不擅自继承桌面绑定会话的模型。保留 fork 时区、评分、可投递状态、微信历史、发送回执及换绑取消。 |
| 网络代理 | `src/main/network/node-request-proxy.ts`、`src/main/application/default-dependencies.ts` | Node 请求读取环境 HTTP(S) 代理或 Electron 系统代理；本机模型直连，保留用户 `NO_PROXY`，代理日志遮蔽凭据，配置失败不阻断启动。 |
| Linux 代理补齐 | `src/server/core/network-proxy.ts`、`src/server/core/runtime.ts` | 无桌面宿主在模型、嵌入及渠道初始化前应用同一代理实现；只使用服务进程的环境代理，无需 Electron session。 |
| 检索 | `src/main/search-jieba.ts`、`rag/retriever.ts`、`rag/text-ranking.ts`、`social-context/retrieval.ts` | 延迟加载原生分词器；原生初始化失败时降级并在后续调用重试，恢复后刷新缓存，三处排名使用一致分词批次。 |
| 模型注册 | `src/shared/vendor-registry/entries/chatgpt.ts`、`catalog-doc.ts`、`docs/references/adapted-models.md`、`adapted-models.en.md` | 同步 GPT-6.1 Terra 声明，修正 GPT-6.1 Sol 的思考参数能力及适配清单。 |
| 本地字体 | `src/renderer/public/fonts/*`、`src/renderer/ui/fonts.css`、`src/main/protocols/learn-exam-csp.ts`、`vite.config.mts`、`THIRD_PARTY_NOTICES.md`、`.gitattributes` | 随 Windows/Web 打包 JetBrains Mono 两种字重、许可及哈希清单；移除字体外网请求和对应 CSP 白名单，字体保持原始字节。 |
| 构建验证 | `scripts/verify/bundled-fonts.mjs`、`fonts-offline.mjs`、`package.json` | 构建后检查字体资源、许可及哈希；离线验证默认使用项目 Chromium，解除系统 Edge 依赖，额外验证 `/web/` 相对资源路径。不改变依赖锁文件和现有版本号。 |
| Linux 回归 | `.github/workflows/linux-web.yml` | 增加代理、分词恢复、主动聊天、上下文预算及字体用例；安装 Chromium 后验离线字体，清理一个不存在的旧测试路径。 |
| 构建输出隔离 | `.gitignore` | 忽略 Vite 从字体源目录复制的 `dist/renderer/fonts/`，避免构建后出现未跟踪产物、重复提交字体。字体源码继续跟踪。 |

对应回归包括上游的 `context-manager.test.ts`、`harness/cyrene-harness.test.ts`、`proactive-lifecycle.test.ts`、`proactive-service.test.ts`、`node-request-proxy.test.ts`、`search-jieba.test.ts`、`fonts.test.ts`，以及 reasoning、模型注册、结构化输出测试。新增的 `harness/compaction.headless.test.ts` 覆盖来源一致的持久化预算，`server/core/network-proxy.test.ts` 使用真实本机 CONNECT 代理验证外部请求和本机模型分流。原 fork 主动聊天测试移入 `proactive-lifecycle.headless.test.ts`，完整保留原来的 6 项边界。`harness/compaction.test.ts` 的工具尾窗断言由 500 调整为 504，额外 4 tokens 来自本次开始计入的工具调用名称和参数。

## 冲突处理及后续同步

本轮有 6 处文本冲突，原因是两侧同时修改了共享业务代码，不能仅凭 ahead/behind 数量判断。

- `build-options.ts`：同时保留 fork 的渠道/语气提示构建和上游模型来源导入。
- `context-manager.ts`：合入请求投影估算，保留 fork 的多模态摘要净化、流式分块、重试和错误诊断。
- `conversation-transcript-compactor.ts`：合入来源感知切点，继续保留 `no_safe_boundary` 等细分错误及持久化保护。
- `proactive-lifecycle.ts`：合入会话模型解析及冻结投递目标，保留渠道行为。
- `proactive-lifecycle.test.ts`：两侧均新增了同名测试。上游测试保留原文件名，fork 用例迁到独立 headless 测试文件，减少后续 add/add 冲突。
- `GeneralSettingsPanel.tsx`：上游仅将换行恢复为 LF，fork 已使用 LF。保留 Web 对窗口、开机启动、GPU、桌面升级控件的条件隐藏，最终无功能差异改写。

本轮上游实际增量没有删除 Linux/Web 文件，也没有改微信适配器。继续把平台实现及其测试放在独立边界，保留上游共享逻辑并使用小型调用适配；不设置 `ours` 合并驱动，不全仓归一化换行。仓库已启用 `rerere`，自动暂存关闭。后续无新文本冲突时 GitHub 可以 Sync fork；未来两侧修改同一业务仍需人工集成及验收。

## 验收结果

- Node `24.16.0`、pnpm `10.33.0`；跳过 Electron 下载的 frozen install 通过，锁文件未变。
- `check:main`、`check:preload`、`check:server`、`check:renderer` 均通过。
- `build:web` 及完整 Windows `build` 通过；模型适配清单与插件 schema 一致性检查通过。
- 全量 Vitest 使用默认 forks：621 个文件通过，6559 项通过、1 项跳过。
- 认证后的 shared core：34/34；voice/MCP：21/21；持久化压缩：9/9；后台记忆：4/4；后台 Shell：5/5；上游预检工具：6/6；安装配置：3/3。
- 项目 Chromium `153.0.8010.12` 的 HTTP 根目录、`/web/` 和 `file:` 字体样张均通过：400/500 字重真实加载，无外网请求和页面异常。
- Windows x64 NSIS 使用 `electron-builder.fork.yml` 及 `--publish never` 编译成功。安装器、blockmap、更新元数据哈希、MinGit、mpv、截图助手及 skills 快照验证通过，更新源确认指向本 fork。
- Windows 本地产物为 `release/Cyrene-Windows-x64-Setup-1.3.4-3.exe`，527136770 字节；SHA-256 为 `f342c1ec0e98836fe3a2201917a7631726042ded2480132f590ac887dcd2fc34`。
- 已确认构建对跟踪 `dist/renderer` 源资源的改写仅有行尾差异，再定向恢复；构建产物、测试数据及私有日志不进入提交。

本次使用隔离的本机 Node/headless 服务和模型/渠道 fixture 做可重复验收，没有操作用户常驻服务。当前 Windows 环境未安装 WSL Linux 发行版，未重新在 Ubuntu 真机执行；GitHub API 状态查询返回 403，未取得远端 CI 结果。外部模型服务、真实微信账号投递、Windows 安装/升级流程不在本轮实机验证范围。安装器未签名；沿用现有版本仅作本地重编译，没有覆盖已经发布的 GitHub Release。

本地日志及字体截图位于工作区外的 `D:/00linux/.build-temp/upstream-20261031/`，不上传仓库。
