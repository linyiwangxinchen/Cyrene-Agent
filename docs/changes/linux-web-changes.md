# Linux / Web 适配修改总览

基准：上游 `Playa-Cyrene/Cyrene-Agent` 的 `63c43efbfe36136afc8a936d15018cd6cb2bd9c3`（v1.3.1）。目标仓库：`linyiwangxinchen/Cyrene-Agent`，保留原 Git 历史、许可与资源声明。本文逐文件列出本次新增/修改的作用，不将上游原有功能标成全新实现。

## 做了哪些修改

1. 新增无 GUI 的 Linux HTTP/WebSocket 服务、首次初始化和单管理员 Cookie 登录。密码使用 scrypt；业务 API、媒体资源和实时连接经过认证。OIDC/OAuth 是后续计划，当前没有通用 OIDC 登录实现。
2. 正式 Web 使用独立 Node worker 运行原 CyreneAgent/CyreneHarness、工具注册器、Skill、插件、Scheduler、记忆/RAG、知识库、试卷、Git 和渠道模块。Electron 在构建时替换为平台端口；Windows 版保留。旧 Web Store/Runtime 用于迁移及回归兼容，不是正式运行时的第二套简化 Agent。
3. Chat/Work/Code/Learn 使用原模式、提示词、身份、风格、用户记忆与关系线索。部署携带完整 prompts；表达风格不覆盖身份和安全/工具规则。任务工作区、shell、Skill、MCP 均指向服务器。
4. 将原 preload API 映射到认证 HTTP invoke 和 WebSocket 事件。恢复消息、工具进度、思考、子代理、队列、编辑/重试和会话导航；修复新建任务被刷新带回旧会话、thinking 错状态与聊天不跟随最新消息。
5. Playwright 用 headless Chromium 提供浏览器页面截图、元素选择与操作。服务器目录选择、上传/下载、通知、音乐、表情管理、插件 sandbox 面板和试卷页改由 Web 宿主承担。
6. 定时任务复用原工作区/权限策略与 Scheduler；长期记忆、主动聊天、动态互动、知识库索引、用量统计和外观设置复用原持久化与 API。试卷保存答案、导航、标记、提交、重试和读取沿用原业务。
7. 微信 iLink、飞书 WSS、QQ NapCat/OneBot 和 QQ 官方机器人接入原渠道生命周期及上下文绑定。修复微信 QR 请求慢/取消、轮询静默超时游标、uint64 ID 精度、晚到消息与启用开关只存设置但不停止实例的问题。飞书/QQ 核心适配器保持原实现，新增 Web 的配置和运行宿主。
8. TTS、ASR、语音通话与 MCP 接入原业务。新增自部署 OpenAI 兼容 ASR，补齐云引擎取消、v2 TTS 缓存、音频格式和 Web 客户端归属。MCP 支持三种传输、表单/JSON、参数/环境/请求头、工作目录、重连、启动恢复和工具执行策略；不是所有远程 MCP 都支持通用 OAuth。
9. 修复动态图片 JSON 二进制不能恢复、巨型请求和桌面图片 scheme 在浏览器不能展示。Web 顺序暂存图片，保留 9 张/每张 15 MiB 限制；失败保留草稿，成功/失败清理本次暂存。
10. 新增手机抽屉导航、设置导航、全宽检查面板、动态/模型清单换行、触控尺寸、16px 输入和动态视口/安全区域。桌面截图、托盘、全局快捷键、Windows 更新器等不进入无桌面 Web；Live2D 源资源继续保留以支持 Windows 构建。
11. 新增构建、功能契约/行为验收脚本、Linux 服务与代理示例，以及跨机器运行包导出。运行包不会包含本地账号、密钥、浏览器和平台依赖；源码目录保留必要源资源，排除所有本次生成的构建缓存和私有验收留痕。

## 验证与实际边界

- 之前已完成 Linux 实机部署、登录后页面/模型聊天验收，以及渠道启停修复的隔离/实机状态检查。
- 动态修复相关本地和 Ubuntu 290 项回归通过；单图旧二进制协议、9 图及 15 MiB 图片实际发布并读取字节一致。真实浏览器带图发布、刷新读取通过。
- 手机浏览器尺寸 320×740、390×844、平板 768×1024 与桌面布局已验收；实体 Android/iOS、软键盘和所有移动浏览器尚未覆盖。
- 真实语音供应商、飞书/QQ 租户权限、模型行为和 MCP 外部服务依赖自己的配置与账号；本地协议/SDK 测试不能代替所有供应商验收。
- Gmail 专用授权流程仍按范围暂缓。OAuth/OIDC 尚未实现。没有将“占位配置可见”作为功能完成证据。
- 本次源代码导出后的独立构建/校验结果记录于本文后续“导出复核”段；临时构建不留在发布源码目录。

## 导出复核

本次检查在导出的源代码副本内进行，所有生成文件和依赖均留在外部临时目录：

- Node 24.x 下，Server、Renderer、Main、Preload 四组 TypeScript 检查通过；服务端、headless 核心及 Web 页面实际构建通过。
- 60 个回归文件、408 项测试通过；新增 PCM 解码另有 9 项测试通过，覆盖 HTTP 二进制还原、旧 Base64、视图切片、无效输入与大小限制。复测包含原有 7 项二进制协议测试。
- 共享核心 28 项端到端执行验收通过，涵盖模式、工具、Skill、插件、子代理、任务、试卷、知识库、记忆、动态、统计、浏览器及登录生命周期。
- TTS/ASR/通话和 MCP 三种传输的 19 项实际协议链路验收通过；修复了 HTTP 还原 PCM 后 ASR 仍仅接受 Base64 的回归。
- 从当前源码提取的 405 项 preload 契约全部得到分类，正式核心注册 298 个处理器；没有未分类的 API 缺口。57 项功能报告由当前验收结果生成，不依赖本机历史报告。
- 导出精简运行包，以锁定的 pnpm 10.33.0 仅安装生产依赖后，实际启动、未登录访问拦截、页面/头像、初始化、登录、WebSocket 及共享核心设置调用均通过。此生产依赖检查运行平台为 Windows，不将其冒称为新的 Linux 实机验收；既有 Ubuntu 部署见前述记录。
- Git 提交目录不包含 node_modules、浏览器下载、生成的 Server/headless/Web JS、用户数据、key.txt 和私有验收报告；保留上游跟踪的源资源。逐文件清单共 179 项，提交按下面 10 个主题组织。

## 提交组织

以下 10 组按功能拆分，提交标题明确说明目的。共享 types、平台宿主和 UI 相互依赖，应按整个系列评审；单独摘取修复时先核对 import/API 依赖，详见 [upstream-sync.md](upstream-sync.md)。

### 1. 共享人格和表达规则

提交主题：`refactor(core): share persona, tone and relationship rules across runtimes`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/main/external-content-paths.test.ts`](../../src/main/external-content-paths.test.ts) | 修改 | 回归测试：headless 读取完整安装提示词、指定提示词目录及数据目录覆盖文件，避免人格资源遗漏。 |
| [`src/main/external-content-paths.ts`](../../src/main/external-content-paths.ts) | 修改 | headless 读取完整安装提示词、指定提示词目录及数据目录覆盖文件，避免人格资源遗漏。 |
| [`src/main/orchestrator/build-options.ts`](../../src/main/orchestrator/build-options.ts) | 修改 | 复用抽离的风格块与渠道表达规则，保持风格不覆盖身份和工具约束。 |
| [`src/main/orchestrator/expression-context-core.ts`](../../src/main/orchestrator/expression-context-core.ts) | 新增 | 抽离渠道回复方式和表达风格纯函数，供两端共用。 |
| [`src/main/orchestrator/mode-prompt-profile-core.ts`](../../src/main/orchestrator/mode-prompt-profile-core.ts) | 新增 | 抽离 Chat/Work/Code/Learn 提示词文件、规则与模式配置，防止 Web 单独弱化人格。 |
| [`src/main/orchestrator/mode-prompt-profile.ts`](../../src/main/orchestrator/mode-prompt-profile.ts) | 修改 | 原桌面提示词入口转为共享模式规则的兼容导出。 |
| [`src/main/orchestrator/tone-injector.ts`](../../src/main/orchestrator/tone-injector.ts) | 修改 | 通过共享语气模块继续保持原桌面调用入口。 |
| [`src/main/orchestrator/tone-rules-core.ts`](../../src/main/orchestrator/tone-rules-core.ts) | 新增 | 语气规则抽成不依赖 Electron 的共享模块。 |
| [`src/main/rag/worldbook.ts`](../../src/main/rag/worldbook.ts) | 修改 | Worldbook 使用公共 logger，避免人格资源读取依赖桌面初始化。 |
| [`src/main/relationship/relationship-log-core.ts`](../../src/main/relationship/relationship-log-core.ts) | 新增 | 关系线索格式化抽为两端共享的纯模块。 |
| [`src/main/relationship/relationship-log.ts`](../../src/main/relationship/relationship-log.ts) | 修改 | 保持原关系记录入口，并复用共享关系线索构建函数。 |
| [`src/main/sticker-text-matcher-core.ts`](../../src/main/sticker-text-matcher-core.ts) | 新增 | 抽离表情文本匹配纯逻辑，让 headless 与桌面同样选择表情。 |
| [`src/main/sticker-text-matcher.ts`](../../src/main/sticker-text-matcher.ts) | 修改 | 保留桌面表情匹配入口并复用共享实现。 |

### 2. 模型测试和设置副作用

提交主题：`fix(models): decouple connection tests and preserve settings side effects`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/main/orchestrator/vendors/anthropic-adapter.ts`](../../src/main/orchestrator/vendors/anthropic-adapter.ts) | 修改 | 连接测试使用宿主传入超时/公共默认值，去掉依赖 Electron 设置单例。 |
| [`src/main/orchestrator/vendors/openai-adapter.ts`](../../src/main/orchestrator/vendors/openai-adapter.ts) | 修改 | OpenAI 兼容连接测试使用显式超时，支持 headless Node。 |
| [`src/main/orchestrator/vendors/responses-adapter.ts`](../../src/main/orchestrator/vendors/responses-adapter.ts) | 修改 | Responses 连接测试使用显式超时，支持 headless Node。 |
| [`src/main/orchestrator/vendors/types.ts`](../../src/main/orchestrator/vendors/types.ts) | 修改 | 模型配置新增宿主传入连接测试超时字段。 |
| [`src/main/settings/settings-ipc.ts`](../../src/main/settings/settings-ipc.ts) | 修改 | 通用/TTS 设置共享副作用处理，正确刷新主动聊天并传入模型测试超时；静态导入模型状态。 |
| [`src/shared/api-endpoint.ts`](../../src/shared/api-endpoint.ts) | 修改 | 只校正已知 MiniMax 预设 Base URL 与协议组合，保留自定义网关。 |

### 3. 渠道连接和启停

提交主题：`fix(channels): enforce enable state and reliable WeChat polling`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/main/channels/adapters/wechat/ilink-bot-adapter.test.ts`](../../src/main/channels/adapters/wechat/ilink-bot-adapter.test.ts) | 修改 | 回归测试：修复微信扫码取消、重定向、长轮询游标/消息 ID、重连和停用后迟到消息/媒体处理。 |
| [`src/main/channels/adapters/wechat/ilink-bot-adapter.ts`](../../src/main/channels/adapters/wechat/ilink-bot-adapter.ts) | 修改 | 修复微信扫码取消、重定向、长轮询游标/消息 ID、重连和停用后迟到消息/媒体处理。 |
| [`src/main/channels/adapters/wechat/ilink-protocol-client.test.ts`](../../src/main/channels/adapters/wechat/ilink-protocol-client.test.ts) | 新增 | 回归测试：为微信普通请求与长轮询设置独立超时，保留静默超时游标，校验 ret/errcode，并无损解析 uint64 消息 ID。 |
| [`src/main/channels/adapters/wechat/ilink-protocol-client.ts`](../../src/main/channels/adapters/wechat/ilink-protocol-client.ts) | 修改 | 为微信普通请求与长轮询设置独立超时，保留静默超时游标，校验 ret/errcode，并无损解析 uint64 消息 ID。 |
| [`src/main/channels/adapters/wechat/ilink-receive.test.ts`](../../src/main/channels/adapters/wechat/ilink-receive.test.ts) | 新增 | 验证微信轮询、精确 ID、去重与消息接收路径。 |
| [`src/main/channels/config-lifecycle.test.ts`](../../src/main/channels/config-lifecycle.test.ts) | 新增 | 回归测试：串行处理渠道配置保存和运行实例切换，仅重启受影响的渠道，使启用开关真正生效。 |
| [`src/main/channels/config-lifecycle.ts`](../../src/main/channels/config-lifecycle.ts) | 新增 | 串行处理渠道配置保存和运行实例切换，仅重启受影响的渠道，使启用开关真正生效。 |
| [`src/main/channels/delivery-service.test.ts`](../../src/main/channels/delivery-service.test.ts) | 修改 | 回归测试：发送前拒绝未启用渠道，防止停用后仍出站。 |
| [`src/main/channels/delivery-service.ts`](../../src/main/channels/delivery-service.ts) | 修改 | 发送前拒绝未启用渠道，防止停用后仍出站。 |
| [`src/main/channels/dispatcher.test.ts`](../../src/main/channels/dispatcher.test.ts) | 修改 | 修正渠道 dispatcher 回归样例，覆盖真实共享业务派发契约。 |
| [`src/main/channels/init.ts`](../../src/main/channels/init.ts) | 修改 | 渠道公开配置隐藏密钥；扫码可取消；配置改变调用统一生命周期并广播权威状态。 |
| [`src/main/channels/manager.ts`](../../src/main/channels/manager.ts) | 修改 | 新增单渠道重启及停止中的派发屏障，不因修改一个渠道重启全部渠道。 |

### 4. 语音识别与合成

提交主题：`feat(voice): add local ASR and cancellable audio sessions`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/main/asr/aliyun-asr-engine.test.ts`](../../src/main/asr/aliyun-asr-engine.test.ts) | 新增 | 回归测试：实现阿里云 AccessKey 签名换取 Token、识别结束等待、取消和错误收敛。 |
| [`src/main/asr/aliyun-asr-engine.ts`](../../src/main/asr/aliyun-asr-engine.ts) | 修改 | 实现阿里云 AccessKey 签名换取 Token、识别结束等待、取消和错误收敛。 |
| [`src/main/asr/asr-config.ts`](../../src/main/asr/asr-config.ts) | 修改 | 增加 local 转写地址、模型和 API Key 配置类型。 |
| [`src/main/asr/asr-dispatcher.ts`](../../src/main/asr/asr-dispatcher.ts) | 修改 | 实际创建 local 引擎，并统一暴露 ASR 取消接口。 |
| [`src/main/asr/local-asr-engine.test.ts`](../../src/main/asr/local-asr-engine.test.ts) | 新增 | 回归测试：实现 PCM→WAV 与 OpenAI 兼容 multipart 转写、超时、长度限制和取消。 |
| [`src/main/asr/local-asr-engine.ts`](../../src/main/asr/local-asr-engine.ts) | 新增 | 实现 PCM→WAV 与 OpenAI 兼容 multipart 转写、超时、长度限制和取消。 |
| [`src/main/asr/minimax-asr-engine.test.ts`](../../src/main/asr/minimax-asr-engine.test.ts) | 新增 | 回归测试：补齐识别结束和取消路径，防止停止后继续回调。 |
| [`src/main/asr/minimax-asr-engine.ts`](../../src/main/asr/minimax-asr-engine.ts) | 修改 | 补齐识别结束和取消路径，防止停止后继续回调。 |
| [`src/main/asr/mossland-asr-engine.test.ts`](../../src/main/asr/mossland-asr-engine.test.ts) | 修改 | 回归测试：识别请求支持 AbortSignal 与取消，避免挂断后返回旧结果。 |
| [`src/main/asr/mossland-asr-engine.ts`](../../src/main/asr/mossland-asr-engine.ts) | 修改 | 识别请求支持 AbortSignal 与取消，避免挂断后返回旧结果。 |
| [`src/main/call/call-manager.test.ts`](../../src/main/call/call-manager.test.ts) | 修改 | 回归测试：补齐 local/MiniMax/Mossland 配置检查、ASR 完成等待、通话代次防迟到、TTS 取消和音频格式。 |
| [`src/main/call/call-manager.ts`](../../src/main/call/call-manager.ts) | 修改 | 补齐 local/MiniMax/Mossland 配置检查、ASR 完成等待、通话代次防迟到、TTS 取消和音频格式。 |
| [`src/main/mossland/api-client.ts`](../../src/main/mossland/api-client.ts) | 修改 | 合并 Mossland 外部取消信号和请求超时信号。 |
| [`src/main/services/tts/tts-session-cache.test.ts`](../../src/main/services/tts/tts-session-cache.test.ts) | 新增 | 验证 v2 会话缓存复用与取消期间不写缓存。 |
| [`src/main/services/tts/tts-synthesis-service.ts`](../../src/main/services/tts/tts-synthesis-service.ts) | 修改 | 从 v2 journal 读取历史音频缓存并透传取消信号，防止重放重复合成和取消后写缓存。 |
| [`src/main/settings/general-settings.ts`](../../src/main/settings/general-settings.ts) | 修改 | 扩展自部署 ASR 的地址、模型、密钥设置定义。 |
| [`src/main/settings/settings-facade.ts`](../../src/main/settings/settings-facade.ts) | 修改 | 提供 local ASR 默认值与输入规范化，使两端保存格式一致。 |
| [`src/main/startup/bootstrap-config.ts`](../../src/main/startup/bootstrap-config.ts) | 修改 | 桌面配置注入也支持 local ASR 和完整 Mossland 通话参数。 |
| [`src/main/tts/custom-cloud-engine.ts`](../../src/main/tts/custom-cloud-engine.ts) | 修改 | 自定义 TTS 合并调用方取消与引擎超时。 |
| [`src/main/tts/gptsovits-engine.ts`](../../src/main/tts/gptsovits-engine.ts) | 修改 | GPT-SoVITS 请求支持调用方取消，取消后停止音频合成等待。 |
| [`src/main/tts/mimo-engine.ts`](../../src/main/tts/mimo-engine.ts) | 修改 | MiMo TTS 请求支持取消，避免挂断/关闭后继续处理。 |
| [`src/main/tts/mossland-engine.ts`](../../src/main/tts/mossland-engine.ts) | 修改 | Mossland TTS 将取消信号传入公共请求。 |
| [`src/main/tts/tts-dispatcher.ts`](../../src/main/tts/tts-dispatcher.ts) | 修改 | 统一将 AbortSignal 传入各 TTS 引擎并保留音频格式。 |
| [`src/main/tts/tts-ipc.ts`](../../src/main/tts/tts-ipc.ts) | 修改 | 增加 Web 音频会话的客户端归属、断连释放及请求校验，拒绝其他连接取消。 |
| [`src/main/tts/tts-session-service.ts`](../../src/main/tts/tts-session-service.ts) | 修改 | 新增批量取消方法，关闭宿主时释放所有音频会话。 |

### 5. MCP 生命周期与策略

提交主题：`feat(mcp): complete reconnection, validation and headless transports`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/main/memory/memory-user-ipc.ts`](../../src/main/memory/memory-user-ipc.ts) | 修改 | 为共享设置/记忆 IPC 补充 MCP 重连业务入口。 |
| [`src/main/orchestrator/mcp-adapter-sse.test.ts`](../../src/main/orchestrator/mcp-adapter-sse.test.ts) | 修改 | 验证真实 SSE MCP 的连接、工具发现、调用与断开行为。 |
| [`src/main/orchestrator/mcp-adapter.ts`](../../src/main/orchestrator/mcp-adapter.ts) | 修改 | 实现 stdio/HTTP/SSE 连接超时与取消、工具名约束、执行策略校验及断线工具清理。 |
| [`src/main/orchestrator/mcp-manager.test.ts`](../../src/main/orchestrator/mcp-manager.test.ts) | 修改 | 回归测试：验证配置、串行增删/重连、原子持久化与 Linux 0600 权限，失败不残留连接。 |
| [`src/main/orchestrator/mcp-manager.ts`](../../src/main/orchestrator/mcp-manager.ts) | 修改 | 验证配置、串行增删/重连、原子持久化与 Linux 0600 权限，失败不残留连接。 |
| [`src/main/sync-mcp-builtin.ts`](../../src/main/sync-mcp-builtin.ts) | 修改 | headless 用 Node 启动 bundled MCP，Playwright 改为 Chromium；桌面维持原 Edge 配置。 |

### 6. 认证服务和共享核心宿主

提交主题：`feat(server): host shared Agent core behind authenticated HTTP and WebSocket`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/main/browser/playwright-page-snapshot.ts`](../../src/main/browser/playwright-page-snapshot.ts) | 修改 | 兼容 pnpm 的 playwright-core 包路径，忽略选中引起的 focus 标记而保持元素身份校验。 |
| [`src/main/chats/chat-ui-ipc.ts`](../../src/main/chats/chat-ui-ipc.ts) | 修改 | 允许宿主显式注入已认证聊天 sender 校验，桌面默认继续验证聊天窗口身份。 |
| [`src/main/orchestrator/conversation-transcript-projection.ts`](../../src/main/orchestrator/conversation-transcript-projection.ts) | 修改 | 导出 replay-safe UI checkpoint 折叠函数，headless 恢复原工具/思考/子代理进度。 |
| [`src/main/plugin-panel-protocol.ts`](../../src/main/plugin-panel-protocol.ts) | 修改 | 插件资源 Response 使用 Uint8Array，兼容 Node/Electron 的 BodyInit 类型。 |
| [`src/main/windows/startup-window-load.ts`](../../src/main/windows/startup-window-load.ts) | 修改 | 修正 Node/DOM 定时器类型兼容，保留桌面启动行为。 |
| [`src/server/auth-store.test.ts`](../../src/server/auth-store.test.ts) | 新增 | 回归测试：scrypt 密码存储、登录节流、Cookie 会话令牌生命周期与注销。 |
| [`src/server/auth-store.ts`](../../src/server/auth-store.ts) | 新增 | scrypt 密码存储、登录节流、Cookie 会话令牌生命周期与注销。 |
| [`src/server/auth-types.ts`](../../src/server/auth-types.ts) | 新增 | 服务器认证、登录状态和会话的序列化类型。 |
| [`src/server/core/browser.ts`](../../src/server/core/browser.ts) | 新增 | headless Chromium 运行原浏览器面板，支持截图/元素定位/交互与任务会话控制权。 |
| [`src/server/core/migrate-web-data.ts`](../../src/server/core/migrate-web-data.ts) | 新增 | 备份并导入旧 Web 模型、会话/队列、记忆、任务、渠道和媒体，保持原权限边界。 |
| [`src/server/core/pcm-audio.test.ts`](../../src/server/core/pcm-audio.test.ts) | 新增 | 回归测试：统一解码 ArrayBuffer、Buffer/TypedArray 的准确切片和旧 Base64 PCM，校验格式、非空、16 位采样对齐及 120 秒上限。 |
| [`src/server/core/pcm-audio.ts`](../../src/server/core/pcm-audio.ts) | 新增 | 统一解码 ArrayBuffer、Buffer/TypedArray 的准确切片和旧 Base64 PCM，校验格式、非空、16 位采样对齐及 120 秒上限。 |
| [`src/server/core/platform.ts`](../../src/server/core/platform.ts) | 新增 | 提供 Node 宿主的 Electron 端口替代：路径、IPC、虚拟客户端窗口、对话框、通知、凭据等。 |
| [`src/server/core/runtime.ts`](../../src/server/core/runtime.ts) | 新增 | 初始化同一 Agent/Harness、工具、技能、插件、Scheduler、记忆/RAG、知识库、考试、Git 和渠道；桥接事件并正常关闭。 |
| [`src/server/core/voice.ts`](../../src/server/core/voice.ts) | 新增 | 浏览器 PCM/语音测试与通话绑定原 ASR/TTS，限制客户端归属并断连释放；兼容 HTTP 还原的二进制和旧 Base64 协议。 |
| [`src/server/core/web-music-player.ts`](../../src/server/core/web-music-player.ts) | 新增 | 以浏览器音频事件替代服务端 mpv 输出，音乐任务仍使用原业务。 |
| [`src/server/core/worker.ts`](../../src/server/core/worker.ts) | 新增 | 在独立 Node 子进程绑定核心启动、RPC 请求、客户端连接和退出处理。 |
| [`src/server/index.test.ts`](../../src/server/index.test.ts) | 新增 | 回归测试：HTTP 静态页、初始化/登录/会话鉴权、同源校验、认证 WebSocket 和核心 RPC/文件/资源/图片上传路由。 |
| [`src/server/index.ts`](../../src/server/index.ts) | 新增 | HTTP 静态页、初始化/登录/会话鉴权、同源校验、认证 WebSocket 和核心 RPC/文件/资源/图片上传路由。 |
| [`src/server/moment-uploads.test.ts`](../../src/server/moment-uploads.test.ts) | 新增 | 回归测试：认证图片暂存、9 张/15 MiB 校验、暂存 ID 路径约束、读取及清理，避免巨型 JSON。 |
| [`src/server/moment-uploads.ts`](../../src/server/moment-uploads.ts) | 新增 | 认证图片暂存、9 张/15 MiB 校验、暂存 ID 路径约束、读取及清理，避免巨型 JSON。 |
| [`src/server/shared-core-client.ts`](../../src/server/shared-core-client.ts) | 新增 | 管理独立核心 worker、advanced 二进制 IPC、客户端端口、事件、启动/关闭与 RPC 超时。 |
| [`src/server/web-binary.test.ts`](../../src/server/web-binary.test.ts) | 新增 | 回归测试：递归解码受限 Base64 二进制标记，传给共享业务的必须是真实 ArrayBuffer。 |
| [`src/server/web-binary.ts`](../../src/server/web-binary.ts) | 新增 | 递归解码受限 Base64 二进制标记，传给共享业务的必须是真实 ArrayBuffer。 |
| [`src/server/web-channel-runtime.ts`](../../src/server/web-channel-runtime.ts) | 新增 | 保留旧 Web 数据/协议迁移测试的渠道适配；正式渠道运行走 shared core。 |
| [`src/server/web-feature-store.ts`](../../src/server/web-feature-store.ts) | 新增 | 保留旧版 Web 记忆/任务/知识库/动态结构用于迁移及兼容测试。 |
| [`src/server/web-media-store.test.ts`](../../src/server/web-media-store.test.ts) | 新增 | 回归测试：管理旧 Web 媒体存储/资源读取和迁移，正式能力复用原业务存储。 |
| [`src/server/web-media-store.ts`](../../src/server/web-media-store.ts) | 新增 | 管理旧 Web 媒体存储/资源读取和迁移，正式能力复用原业务存储。 |
| [`src/server/web-model-service.test.ts`](../../src/server/web-model-service.test.ts) | 新增 | 回归测试：旧传输兼容测试复用原厂商适配、端点和 reasoning 配置。 |
| [`src/server/web-model-service.ts`](../../src/server/web-model-service.ts) | 新增 | 旧传输兼容测试复用原厂商适配、端点和 reasoning 配置。 |
| [`src/server/web-persona-runtime.test.ts`](../../src/server/web-persona-runtime.test.ts) | 新增 | 回归测试：复用共享身份/模式、风格、记忆/关系/表情提示规则，支持兼容数据迁移链路。 |
| [`src/server/web-persona-runtime.ts`](../../src/server/web-persona-runtime.ts) | 新增 | 复用共享身份/模式、风格、记忆/关系/表情提示规则，支持兼容数据迁移链路。 |
| [`src/server/web-store.test.ts`](../../src/server/web-store.test.ts) | 新增 | 回归测试：旧 Web 会话、设置和模型档案持久化，作为迁移输入而非另建正式业务核心。 |
| [`src/server/web-store.ts`](../../src/server/web-store.ts) | 新增 | 旧 Web 会话、设置和模型档案持久化，作为迁移输入而非另建正式业务核心。 |

### 7. Web 页面与传输适配

提交主题：`feat(web): bridge desktop APIs to browser hosts and binary uploads`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/renderer/web/WebAsrTest.tsx`](../../src/renderer/web/WebAsrTest.tsx) | 新增 | 浏览器录音/上传音频转 16kHz 单声道 PCM，调用已配置的服务器 ASR 测试。 |
| [`src/renderer/web/WebAudioOutput.tsx`](../../src/renderer/web/WebAudioOutput.tsx) | 新增 | 接收原 TTS/音乐音频事件并在访问者浏览器播放和控制。 |
| [`src/renderer/web/WebAuthGate.tsx`](../../src/renderer/web/WebAuthGate.tsx) | 新增 | 登录/首次初始化门禁、会话恢复/退出、登录条，以及 VisualViewport 变化的页面高度。 |
| [`src/renderer/web/WebBrowserViewport.tsx`](../../src/renderer/web/WebBrowserViewport.tsx) | 新增 | 展示服务端浏览器截图与输入事件，按视口和 tab 对应交互，不依赖 Linux GUI。 |
| [`src/renderer/web/WebHostDialogs.tsx`](../../src/renderer/web/WebHostDialogs.tsx) | 新增 | 替换原生文件夹/文件对话框，提供服务器目录选择和上传/下载。 |
| [`src/renderer/web/WebNotifications.tsx`](../../src/renderer/web/WebNotifications.tsx) | 新增 | 展示共享核心通知，并支持点击返回对应会话。 |
| [`src/renderer/web/WebTtsPreview.tsx`](../../src/renderer/web/WebTtsPreview.tsx) | 新增 | 提供试听播放状态、可手动播放的浏览器音频预览。 |
| [`src/renderer/web/core-transport.ts`](../../src/renderer/web/core-transport.ts) | 新增 | 浏览器复用 preload API：认证 HTTP invoke、WebSocket 事件/语音、二进制编码、资源映射与动态上传。 |
| [`src/renderer/web/crypto-compat.test.ts`](../../src/renderer/web/crypto-compat.test.ts) | 新增 | 回归测试：为非 secure context 的 HTTP 检查页面提供 UUID 兼容实现；不替代认证随机数。 |
| [`src/renderer/web/crypto-compat.ts`](../../src/renderer/web/crypto-compat.ts) | 新增 | 为非 secure context 的 HTTP 检查页面提供 UUID 兼容实现；不替代认证随机数。 |
| [`src/renderer/web/embedded-host.ts`](../../src/renderer/web/embedded-host.ts) | 新增 | 音乐、表情、通话等子页面在受控父窗口复用 Web API，避免单独创建业务会话。 |
| [`src/renderer/web/index.html`](../../src/renderer/web/index.html) | 新增 | 提供 Web 页面入口和手机 viewport/safe-area/键盘视口配置。 |
| [`src/renderer/web/main.tsx`](../../src/renderer/web/main.tsx) | 新增 | Web 入口加载认证门和原 React 应用。 |
| [`src/renderer/web/moment-upload.test.ts`](../../src/renderer/web/moment-upload.test.ts) | 新增 | 回归测试：动态图片顺序进行原始字节上传，提交暂存引用，成功/失败均清理本次上传。 |
| [`src/renderer/web/moment-upload.ts`](../../src/renderer/web/moment-upload.ts) | 新增 | 动态图片顺序进行原始字节上传，提交暂存引用，成功/失败均清理本次上传。 |
| [`src/renderer/web/renderer-base.test.ts`](../../src/renderer/web/renderer-base.test.ts) | 新增 | 回归测试：识别 Web/嵌入页面目录，修复头像、贴纸、音乐等相对资源根地址。 |
| [`src/renderer/web/styles.css`](../../src/renderer/web/styles.css) | 新增 | Web 宿主与认证样式；修复窄屏溢出，增加手机抽屉、全宽检查面板、设置/动态换行及触控尺寸。 |
| [`src/renderer/web/web-runtime.test.ts`](../../src/renderer/web/web-runtime.test.ts) | 新增 | 回归测试：旧 Web host API 的兼容实现；正式入口安装共享核心传输。 |
| [`src/renderer/web/web-runtime.ts`](../../src/renderer/web/web-runtime.ts) | 新增 | 旧 Web host API 的兼容实现；正式入口安装共享核心传输。 |

### 8. 会话、动态、试卷与手机 UI

提交主题：`fix(ui): restore draft, reasoning, scrolling and responsive feature flows`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`src/preload/index.ts`](../../src/preload/index.ts) | 修改 | 补充 MCP 重连 API 与通话音频格式事件供共享页面使用。 |
| [`src/renderer/call-react/useCallSession.ts`](../../src/renderer/call-react/useCallSession.ts) | 修改 | Web 麦克风 PCM 只在监听时发送；静音工作流、挂断释放、格式播放与嵌入宿主兼容。 |
| [`src/renderer/global.d.ts`](../../src/renderer/global.d.ts) | 修改 | 声明 Web 宿主、试卷、语音与原共享 API 的浏览器类型。 |
| [`src/renderer/learn-exam-entry.tsx`](../../src/renderer/learn-exam-entry.tsx) | 修改 | Web 试卷页面通过父宿主保存答案、导航、提交/重试，关闭页面清理订阅。 |
| [`src/renderer/music/main.tsx`](../../src/renderer/music/main.tsx) | 修改 | 嵌入 Web 宿主后复用原音乐页面和控制逻辑。 |
| [`src/renderer/react/features/chat/components/BrowserPanel.tsx`](../../src/renderer/react/features/chat/components/BrowserPanel.tsx) | 修改 | Web 使用服务端 Playwright 视口/截图交互组件代替 Electron WebContentsView。 |
| [`src/renderer/react/features/chat/components/ChatComposer.tsx`](../../src/renderer/react/features/chat/components/ChatComposer.tsx) | 修改 | 监听表情变更及时更新选择器，Web 不显示桌面截图入口。 |
| [`src/renderer/react/features/chat/components/ChatMessageList.css`](../../src/renderer/react/features/chat/components/ChatMessageList.css) | 修改 | 统一外层滚动容器，禁用浏览器锚定避免流式更新跳动。 |
| [`src/renderer/react/features/chat/components/ChatMessageList.tsx`](../../src/renderer/react/features/chat/components/ChatMessageList.tsx) | 修改 | 采用自动滚动跟随 hook；消除 Bubble 内外双滚动；即时刷新表情。 |
| [`src/renderer/react/features/chat/components/LearnExamsMenu.css`](../../src/renderer/react/features/chat/components/LearnExamsMenu.css) | 新增 | 提供学习试卷列表/操作菜单样式。 |
| [`src/renderer/react/features/chat/components/LearnExamsMenu.tsx`](../../src/renderer/react/features/chat/components/LearnExamsMenu.tsx) | 新增 | 在 Learn 模式提供已持久化试卷列表及浏览器内打开入口。 |
| [`src/renderer/react/features/chat/components/OpenWorkspaceMenu.tsx`](../../src/renderer/react/features/chat/components/OpenWorkspaceMenu.tsx) | 修改 | Web 打开服务端文件浏览而非本地应用，隐藏桌面应用切换。 |
| [`src/renderer/react/features/chat/components/ReasoningControl.tsx`](../../src/renderer/react/features/chat/components/ReasoningControl.tsx) | 修改 | 按实际选中模型加载 thinking 状态，用请求代次过滤旧响应，避免不可调或显示错模型。 |
| [`src/renderer/react/features/chat/components/useChatScrollFollow.test.ts`](../../src/renderer/react/features/chat/components/useChatScrollFollow.test.ts) | 新增 | 回归测试：在切换会话、新用户消息、内容高度变化时跟随最新消息，同时尊重用户上翻历史。 |
| [`src/renderer/react/features/chat/components/useChatScrollFollow.ts`](../../src/renderer/react/features/chat/components/useChatScrollFollow.ts) | 新增 | 在切换会话、新用户消息、内容高度变化时跟随最新消息，同时尊重用户上翻历史。 |
| [`src/renderer/react/features/chat/hooks/useSessionMessages.test.ts`](../../src/renderer/react/features/chat/hooks/useSessionMessages.test.ts) | 修改 | 回归测试：在状态提交时对消息 ID 去重，避免队列领取与历史恢复同批执行导致重复。 |
| [`src/renderer/react/features/chat/hooks/useSessionMessages.ts`](../../src/renderer/react/features/chat/hooks/useSessionMessages.ts) | 修改 | 在状态提交时对消息 ID 去重，避免队列领取与历史恢复同批执行导致重复。 |
| [`src/renderer/react/features/chat/pages/ChatPage.tsx`](../../src/renderer/react/features/chat/pages/ChatPage.tsx) | 修改 | 新建草稿不被后台刷新切换到旧会话；接入试卷入口、手机导航抽屉和可收缩检查面板。 |
| [`src/renderer/react/features/moments/MomentComposer.tsx`](../../src/renderer/react/features/moments/MomentComposer.tsx) | 修改 | 图片读取/发表防重复，失败保留草稿、显示错误，提交期间禁用编辑，正确释放预览 URL。 |
| [`src/renderer/react/features/moments/MomentPostCard.tsx`](../../src/renderer/react/features/moments/MomentPostCard.tsx) | 修改 | Web 动态/表情图片映射为认证 HTTP 资源；保留桌面 scheme 并提供 alt/lazy loading。 |
| [`src/renderer/react/features/moments/MomentsPanel.tsx`](../../src/renderer/react/features/moments/MomentsPanel.tsx) | 修改 | 保留服务端发布失败的具体原因，而非一律隐藏成重试提示。 |
| [`src/renderer/react/features/settings/AppearanceSettingsPage.tsx`](../../src/renderer/react/features/settings/AppearanceSettingsPage.tsx) | 修改 | Web 隐藏桌面专属设置，修复内容滚动并添加手机设置抽屉。 |
| [`src/renderer/react/features/settings/AsrSettingsPanel.tsx`](../../src/renderer/react/features/settings/AsrSettingsPanel.tsx) | 修改 | 提供实际 local ASR 配置及 Web 音频上传/录音测试入口。 |
| [`src/renderer/react/features/settings/ChannelsSettingsPanel.tsx`](../../src/renderer/react/features/settings/ChannelsSettingsPanel.tsx) | 修改 | 扫码加载/取消/迟到状态保护；渠道开关等待保存，失败重载权威配置并反馈。 |
| [`src/renderer/react/features/settings/GeneralSettingsPanel.tsx`](../../src/renderer/react/features/settings/GeneralSettingsPanel.tsx) | 修改 | Web 隐藏桌面 GPU、重启和 Windows 安装器更新项。 |
| [`src/renderer/react/features/settings/McpSettingsPanel.tsx`](../../src/renderer/react/features/settings/McpSettingsPanel.tsx) | 修改 | 实现 MCP 表单/JSON、参数解析、环境/请求头、工作目录、effect 覆盖、重连和状态。 |
| [`src/renderer/react/features/settings/TtsSettingsPanel.tsx`](../../src/renderer/react/features/settings/TtsSettingsPanel.tsx) | 修改 | 使用 Web 音频预览控件处理浏览器播放限制，保留原引擎设置。 |
| [`src/renderer/react/hooks/useAppUpdate.ts`](../../src/renderer/react/hooks/useAppUpdate.ts) | 修改 | Web 不调用 Windows 自动更新宿主；异步失败不破坏页面。 |
| [`src/renderer/react/i18n/en.json`](../../src/renderer/react/i18n/en.json) | 修改 | 补齐英语 Web 工作区、语音测试、MCP 和渠道操作文本。 |
| [`src/renderer/react/i18n/ja-JP.json`](../../src/renderer/react/i18n/ja-JP.json) | 修改 | 补齐日语 Web 工作区、语音测试、MCP 和渠道操作文本。 |
| [`src/renderer/react/i18n/zh-CN.json`](../../src/renderer/react/i18n/zh-CN.json) | 修改 | 补齐中文 Web 工作区、语音测试、MCP 和渠道操作文本。 |
| [`src/renderer/settings/panel-bridge-protocol.ts`](../../src/renderer/settings/panel-bridge-protocol.ts) | 修改 | Web sandbox 面板通过 postMessage 使用适当 target origin，桌面保留独立协议。 |
| [`src/renderer/settings/plugin-panels.ts`](../../src/renderer/settings/plugin-panels.ts) | 修改 | Web 插件使用认证 HTTP 资源和不带 same-origin 的 sandbox，验证已注册窗口及 null origin。 |
| [`src/renderer/settings/shared/types.ts`](../../src/renderer/settings/shared/types.ts) | 修改 | 补齐 MCP 重连/effect 覆盖和微信扫码取消的共享 API 类型。 |
| [`src/renderer/sticker-manager/main.ts`](../../src/renderer/sticker-manager/main.ts) | 修改 | Web 表情管理页面接入父宿主的共享 API。 |
| [`src/renderer/ui/theme.ts`](../../src/renderer/ui/theme.ts) | 修改 | 主题初始化前绑定 Web 嵌入宿主，复用原主题与字体设置。 |
| [`src/shared/browser-resource.test.ts`](../../src/shared/browser-resource.test.ts) | 新增 | 回归测试：Web 将 moment-media/local-sticker 转为认证资源 URL，桌面保留原协议。 |
| [`src/shared/browser-resource.ts`](../../src/shared/browser-resource.ts) | 新增 | Web 将 moment-media/local-sticker 转为认证资源 URL，桌面保留原协议。 |
| [`src/shared/ipc-channels.ts`](../../src/shared/ipc-channels.ts) | 修改 | 增加 MCP 重连、微信扫码取消等两端一致的 IPC channel 常量。 |
| [`src/shared/renderer-base.ts`](../../src/shared/renderer-base.ts) | 修改 | 识别 Web/嵌入页面目录，修复头像、贴纸、音乐等相对资源根地址。 |

### 9. 构建、运行包和验收脚本

提交主题：`build(web): add headless build, portable releases and parity checks`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`package.json`](../../package.json) | 修改 | 新增服务端检查、共享核心构建、Web 启动及功能/语音/MCP 验收命令；继续使用原依赖锁定。 |
| [`scripts/build/headless-core.mjs`](../../scripts/build/headless-core.mjs) | 新增 | 用 Electron 平台别名打包共享核心及知识库 worker，并带入插件面板源资源。 |
| [`scripts/packaging/create-web-runtime.mjs`](../../scripts/packaging/create-web-runtime.mjs) | 新增 | 导出可移植 Web 运行目录，检查入口完整性，带源资源但排除平台依赖、浏览器、映射和测试 JS。 |
| [`scripts/verify/shared-core-contracts.mjs`](../../scripts/verify/shared-core-contracts.mjs) | 新增 | 直接从当前 preload 和 IPC 源码提取 API 契约，与实际注册的处理器比较；不依赖开发机历史报告，干净克隆可执行。 |
| [`scripts/verify/shared-core-feature-report.mjs`](../../scripts/verify/shared-core-feature-report.mjs) | 新增 | 维护 57 项功能目录并结合本次契约及行为验收生成对齐报告，去除对未提交的历史功能报告的依赖。 |
| [`scripts/verify/shared-core-parity.mjs`](../../scripts/verify/shared-core-parity.mjs) | 新增 | 以隔离数据、本地模型和真实原业务验证工具、Skill、子代理、浏览器、任务、试卷、队列等。 |
| [`scripts/verify/shared-core-startup.mjs`](../../scripts/verify/shared-core-startup.mjs) | 新增 | 验证共享核心注册、启动、客户端端口和完整生命周期。 |
| [`scripts/verify/shared-core-voice-mcp.mjs`](../../scripts/verify/shared-core-voice-mcp.mjs) | 新增 | 以本地音频协议与真实 MCP SDK 服务验证语音、所有权、超时取消、MCP 工具和渠道链路。 |
| [`tsconfig.json`](../../tsconfig.json) | 修改 | 公共 TypeScript 配置排除独立 Server 入口，避免 Electron 与 Node 编译上下文混用。 |
| [`tsconfig.renderer.json`](../../tsconfig.renderer.json) | 修改 | 将 Web 入口与相关声明纳入 Renderer 类型检查。 |
| [`tsconfig.server.json`](../../tsconfig.server.json) | 新增 | 新增 Node 服务端独立编译目标、输出目录和测试排除规则。 |
| [`vite.config.mts`](../../vite.config.mts) | 修改 | 新增 Web/试卷页面构建入口，为复用 preload 提供浏览器 IPC 模块别名。 |
| [`vitest.config.mts`](../../vitest.config.mts) | 修改 | 扩大验证范围并为 headless 适配提供测试配置。 |

### 10. 部署文档和修改清单

提交主题：`docs(linux): document operations and every adaptation change`

| 文件 | 类型 | 修改作用 |
| --- | --- | --- |
| [`.gitignore`](../../.gitignore) | 修改 | 忽略 headless/server 构建、Web hash 产物、浏览器下载、凭据和运行包，保留源资源。 |
| [`README.en.md`](../../README.en.md) | 修改 | 为英文首页补充 Linux/Web 分支与文档入口。 |
| [`README.md`](../../README.md) | 修改 | 新增 Linux/Web 分支说明及运维、变更清单、上游同步入口，保留原项目说明。 |
| [`deploy/caddy/Caddyfile.example`](../../deploy/caddy/Caddyfile.example) | 新增 | 提供 Caddy HTTPS 与 WebSocket 反向代理示例。 |
| [`deploy/nginx/cyrene-web.conf.example`](../../deploy/nginx/cyrene-web.conf.example) | 新增 | 提供 Nginx HTTPS/WebSocket/图片上传代理示例。 |
| [`deploy/systemd/cyrene-web.service.example`](../../deploy/systemd/cyrene-web.service.example) | 新增 | 提供非 root systemd、独立数据目录、正常退出和自动重启示例。 |
| [`docs/architecture/linux-web-migration.md`](../../docs/architecture/linux-web-migration.md) | 新增 | 说明共享核心与平台端口架构，并更新语音/MCP 状态及认证范围。 |
| [`docs/changes/linux-web-changes.md`](../../docs/changes/linux-web-changes.md) | 新增 | 汇总全部功能修改、来源、验证边界及逐文件作用清单。 |
| [`docs/changes/upstream-sync.md`](../../docs/changes/upstream-sync.md) | 新增 | 解释提交主题、依赖关系及上游 diff/cherry-pick/format-patch 工作流。 |
| [`docs/deployment/linux-operations.md`](../../docs/deployment/linux-operations.md) | 新增 | 逐步说明 Linux 构建、前台/systemd 执行、停止、HTTPS、异机编译上传和运行依赖。 |
| [`docs/deployment/linux-web.md`](../../docs/deployment/linux-web.md) | 新增 | 记录最终 Web 能力、人格资源、语音/MCP/渠道配置与部署边界。 |

