# 微信 iLink 附件收发完善（2026-10-14）

## 原因与行为变化

微信适配器已经实现媒体上传，但智能体没有可调用的渠道附件工具。文档生成只返回本地路径，不会自动变成微信附件，因此会出现“我目前无法直接发送微信附件”。新增 `channel_send_file` 后，智能体可以将生成、下载或收到的文件真正发到当前私聊，而不是只回复路径。

Windows 和 Linux Web 的正式运行环境使用同一工具注册器、渠道管理器与 iLink 适配器；无需在 Linux 安装微信桌面客户端。旧 Web 简化运行时不是正式渠道执行路径。

## 使用

1. 在“连接手机”中启用微信、扫码登录，将“手机端工具权限”设为“允许可用工具”。关闭工具执行时仍只聊天，不开放文件读取、生成或发送工具。
2. 在微信私聊中提出“生成报告，并把文件发给我”“把这个文件发回给我”等请求。文档、压缩包、音频等可作为文件附件；常见图片、视频自动使用对应的媒体消息，也能指定以文件形式发送。
3. 若从 Web/Windows 会话要求“发送到微信”，先在“连接手机”把该微信私聊绑定到当前会话。只允许唯一绑定的私聊，不能猜测收件人或向群聊发送。
4. 文件来自运行端本地磁盘：Linux Web 使用服务器文件，Windows 使用本机文件。文件路径受原有读取权限约束。单个微信媒体文件限制为本程序设定的 64 MiB；文件必须非空。

工具的 `success=true / status=accepted` 表示 iLink 接口接受了发送，不表示手机已读或提供手机端送达回执。连接不可用、缺少回复上下文、文件不可读、上传失败或 API 拒绝都会返回失败。

## 修改清单

| 文件 | 作用 |
| --- | --- |
| `src/main/orchestrator/tools/channel-file-tool.ts` | 新增实际发送工具；可信目标解析、工作区/文件权限、格式选择、文件检查、发送结果和渠道日志。 |
| `src/main/orchestrator/tools/registry/tool-registration.ts` | 在 Windows/Web 共用的注册入口接入发送工具。 |
| `src/main/orchestrator/system-prompt-builder.ts` | 根据实际开放工具说明附件发送能力与成功/失败规则。 |
| `src/main/channels/types.ts`、`adapters/base.ts`、`delivery-service.ts` | 增加不持久化的发送取消信号，并沿统一投递链路传递。 |
| `src/main/channels/adapters/wechat/ilink-bot-adapter.ts` | 补充文件明文长度、图片/视频密文大小；避免文件失败被文字成功掩盖；上传后使用最新回复令牌；修复停用期间凭据加载晚到导致重新连接、登出保留旧收件状态；入站媒体下载随停用取消。 |
| `src/main/channels/adapters/wechat/ilink-protocol-client.ts` | 上传地址申请、文本与附件发送支持取消，保持错误日志不暴露原始服务响应。 |
| `src/main/channels/adapters/wechat/wechat-media-upload.ts` | 返回真实明文/密文大小、限制上传内存、检查普通文件与读取期间变化、加入超时与取消。 |
| `src/main/channels/adapters/wechat/wechat-media-download.ts` | 支持完整 CDN 地址、未加密媒体、传输超时、取消和下载大小限制。 |
| `src/main/channels/adapters/wechat/wechat-media-transfer.ts` | 统一媒体超时与有界流式下载，避免停用时等待媒体无限挂起。 |
| `src/main/channels/adapters/wechat/inbound-media.ts` | 兼容图片独立 AES 密钥、完整 CDN 引用、未加密媒体和微信已提供的语音文字；识别保存到服务器/收件箱，Linux 收件提示使用服务器措辞。 |
| `src/main/channels/dispatcher.ts` | 渠道日志准确标记文件、图片、视频等附件。 |
| `src/main/orchestrator/tools/channel-file-tool.test.ts` | 实际文件读写、AES 加密、上传参数与出站协议串联验收；验证接收文件再发回、Web 绑定、取消、失败与权限边界。 |
| `src/main/channels/adapters/wechat/*.test.ts` | 协议兼容、超时、停用/登出、最新令牌及附件失败回归。 |
| `scripts/verify/shared-core-parity.mjs` | 构建后从认证 Web API 经真实 Agent 工具循环检查附件工具已注册、可执行，未绑定收件人时返回明确错误。 |

媒体字段参照 [Tencent/openclaw-weixin 协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)与其[发送器实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts)核对。64 MiB 是应用传输上限，不宣称为微信平台上限。

## 验证边界

完成 Main、Server、Renderer、Preload 类型检查；构建 Server、headless 核心和 Windows 主进程。渠道与工具回归通过 39 个测试文件、293 项测试；构建后的隔离认证 Web 服务通过 32 项共享核心验收，其中新增附件工具的真实 Agent 调用检查。

本次使用模拟 iLink/CDN 接口验证真实适配器、协议客户端、AES 加解密和本地文件读写。没有连接真实微信账号或发送真实微信消息；部署后仍需在手机完成附件接收验收。更新运行端需重新构建并重启服务，单独刷新页面不会加载新的后端工具。
