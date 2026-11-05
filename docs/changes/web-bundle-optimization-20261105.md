# Web 首屏拆包优化（2026-11-05）

## 问题

Web 入口原先会把聊天页、设置页以及 Markdown/KaTeX/Mermaid/代码高亮依赖拉进同一个大型 `App` chunk。构建产物中的 `App` 主包约 4.5 MB，慢速或低性能设备首次打开时会长时间停在加载页。

## 修改

- `AppRouter` 使用 `React.lazy`，聊天页和设置页只在对应视图需要时加载。
- `StreamdownMessageContent` 使用 `React.lazy`，Markdown、KaTeX、Mermaid 和代码高亮不再阻塞登录和工作区壳加载。
- 把 `MessageStreamingContext` 放入独立模块，避免懒加载正文组件与消息列表形成循环依赖。
- 新增 `verify:web-bundle` 和 `build:renderer` 的首屏 bundle 预算检查，限制入口 JavaScript 总量 400 KB、单个入口文件 300 KB。
- 懒加载完成前保留纯文本回退，避免网络较慢时消息区域空白。

## 验证

当前构建的 `dist/renderer/web/index.html` 首屏 JavaScript 共 10 个文件、250,720 字节，最大文件为 206,789 字节。聊天/Markdown、路由和 WebAuth 相关 24 项测试通过，renderer TypeScript 检查和 `build:renderer` 通过。

大 chunk 仍会在首次进入聊天或首次渲染 Markdown 时按需下载，这是功能依赖本身的体积，不再阻塞 Web 登录首屏。
