# Linux Web 迁移架构

## 已冻结的目标

- Windows Electron 版继续维护。
- 新增无桌面 Linux Server 版，浏览器通过内网 HTTPS 访问。
- 首期为单管理员账号；首次启动初始化本地账号密码，登录后使用 HttpOnly Cookie 会话。
- OIDC/OAuth 作为后续认证提供商，不改变首期本地账号流程。
- 文件、代码工作区、知识库、插件和运行数据全部位于 Linux Server。
- Live2D、桌宠窗口、系统托盘和其他桌面专属能力从 Web 版移除。
- Chat、Work、Code、Learn 和设置页面共享 Windows React UI；业务请求由 REST/WebSocket 适配器转入同一个 Windows 核心模块集合（CyreneAgent、CyreneHarness、工具注册器、Skill/插件运行时、Scheduler、记忆/RAG、Git、知识库、考试和渠道）。知识库、记忆字段、定时任务、Git 工作区、技能目录、插件启停、待发队列、会话恢复和外部渠道状态均持久化在服务端。微信 iLink、飞书 WSS、QQ NapCat OneBot 11 和 QQ 官方机器人网关由原渠道适配器管理生命周期、消息归一化、出站发送、日志和上下文绑定；MCP、TTS/ASR 和语音通话已经接入原业务，Gmail 专用授权仍暂缓，桌面 Live2D、托盘、全局快捷键和本机 GUI 能力不进入无桌面 Web 版。

## 运行时分层

```text
React Web UI / Electron React UI
          │
          ├── Web adapter: REST + WebSocket
          └── Electron adapter: preload + IPC
          │
Platform-neutral Cyrene Core
  Agent / Harness / Chats / Memory / RAG / Tools / Plugins / Channels
          │
Runtime ports
  storage / auth / process / browser / media / notification / workspace
          │
Linux server adapters                 Electron desktop adapters
  node:http + ws                       BrowserWindow + IPC
  Playwright                           WebContentsView
  XDG data directories                 app.getPath(userData)
  browser HTMLAudio + HTTP stream      bundled mpv
```

当前实现通过构建时的 `electron` 平台端口别名运行原业务模块；服务器进程不加载 Electron。平台端口只替换 IPC、路径、对话框、通知、浏览器和音频宿主，Agent/Harness、数据存储及业务规则保持共用。独立 Node worker 隔离原模块的单例与生命周期。后续可继续将这些平台依赖收敛成显式接口。

## Web Server 边界

- HTTP API：认证、设置、会话、工作区、知识库、插件、MCP、渠道和媒体资源。
- WebSocket：AG-UI 流式事件、任务进度、运行状态、通知和语音事件。
- 认证：Node `scrypt` 密码哈希；HttpOnly、Secure、SameSite Cookie；CSRF、防暴力破解和会话撤销。
- 首次初始化：一次性初始化令牌或受控 CLI 初始化；账号创建后关闭初始化接口，避免内网中出现长期开放注册入口。
- 部署：Ubuntu/Debian + systemd；Nginx/Caddy 负责 HTTPS 终止和反向代理。

## 桌面能力替换

| Electron/Windows 能力 | Linux Web 处理 |
| --- | --- |
| Live2D 桌宠、透明窗口、托盘 | 删除；角色状态保留为 Web UI 状态和头像 |
| Preload/IPC | REST + WebSocket typed adapter |
| Electron WebContentsView | Server Playwright + 页面快照/截图/交互事件 |
| Windows 原生截图/全局快捷键 | 删除桌面捕获；支持浏览器上传和 Playwright 页面截图 |
| 本机文件选择器/打开应用 | Server 工作区选择器、下载和在线预览 |
| Electron 语音窗口 | 浏览器麦克风/扬声器与共享 ASR、TTS、通话业务 |
| 独立音乐窗口 | 原音乐页面嵌入 Web 弹层；浏览器音频 + 服务端媒体流 |
| 插件自有 Electron 窗口 | Web 插件面板/iframe 协议 |

## 迁移阶段

1. **基线与契约**：建立 capability matrix，标记 Electron 依赖，固定 REST/WS 错误与事件模型。
2. **核心解耦**：抽取 storage、workspace、process、browser、media、notification 等 runtime ports。
3. **Server/Auth**：实现健康检查、初始化、登录、登出、会话恢复和 WebSocket 鉴权。
4. **Web Shell**：复用现有 React 页面和样式，实现登录门、应用壳、REST/WS 适配器。
5. **核心功能**：迁移 Chat、会话、设置、Work、Code、Learn 和文件工作区。
6. **高级功能**：复用 Playwright 浏览器、RAG、插件、音乐和原渠道适配器；微信、飞书、QQ NapCat、QQ 官方 Bot 已接入。MCP、TTS/ASR 已接入；Gmail 专用授权暂缓。
7. **Linux 发布**：XDG 数据目录、systemd 单元、Nginx/Caddy 示例、备份和恢复。
8. **验收**：流式聊天、工具审批、路径隔离、浏览器控制、音频、认证、重启恢复和 Windows 回归。

## 必须保持的验收条件

- Windows Electron 构建和现有 IPC 测试继续通过。
- Linux Server 无 DISPLAY 时可启动并完成健康检查。
- 未认证请求不能访问任何业务 API 或 WebSocket。
- 单管理员数据、插件、工作区和密钥不会跨请求泄露。
- 刷新页面后会话、流式任务和设置状态可恢复。
- Code/Learn/文件工具只能访问服务器授权工作区。
- 浏览器控制始终绑定明确的会话和任务，任务结束后释放控制权。
