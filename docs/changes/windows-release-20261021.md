# Windows x64 修复版 1.3.4-2（2026-10-21）

本次 Fork 发行在上游 `v1.3.4` 的基础上重新构建 Windows x64 安装包。按版本命名要求，将本次发行从 `1.3.5` 更正为 `1.3.4-2`，独立标签也使用 `1.3.4-2`；不移动或覆盖上游版本标签。应用、安装包文件名及更新元数据使用同一版本。

`1.3.4-2` 按 SemVer 属于预发行版本，排序低于 `1.3.4` 和此前的 `1.3.5`。现有稳定版安装不会把它识别为升级；请从本次 Release 手动下载安装。保留原有稳定版自动更新策略，不自动降级用户安装。

## 相对上次安装包的修复

- Windows 设置界面恢复上下滚动。
- 长会话按模型窗口和输出预算分片压缩，保留会话原记录，报告具体失败步骤。
- 上下文摘要、长期记忆和辅助模型请求兼容仅支持流式的 Responses 中转，完整终态校验后才使用结果。
- Wiki 和摘要长期记忆任务失败不再产生未处理拒绝、导致核心进程退出；失败批次保留以便重试。
- 修正记忆取消和关闭边界；日志记录安全的分类、HTTP 状态及运行时错误码。

详细实现及回归说明见 [上下文压缩](transcript-compaction-20261020.md) 和 [后台记忆恢复](background-memory-recovery-20261020.md)。

## 可复现构建

环境为 Windows x64、Node.js 24、pnpm 10.33.0、Rust stable。在此标签的源码根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:screenshot-helper
pnpm run prepare:mingit
pnpm run prepare:mpv
pnpm exec electron-builder --config electron-builder.fork.yml --win nsis --x64 --publish never
node scripts/verify/installer-artifacts.mjs --expect-version 1.3.4-2 --artifact-name 'Cyrene-Windows-x64-Setup-${version}.exe'
```

更新源为本 Fork 的 `linyiwangxinchen/Cyrene-Agent`。安装包不提供模型 API Key、微信账号、会话数据库或本机配置。没有配置代码签名证书，产物为未签名安装包。

## 本次验收

- 从锁文件安装依赖，重新编译主进程、预加载、CLI、渲染页面和 Rust 截图助手；主进程、渲染端类型检查通过。
- 打包相关 7 项 Node 测试，以及设置迁移和更新配置的 6 项 Vitest 测试通过；安装包、blockmap、`latest.yml` 的版本、长度及 SHA512 相符，内嵌归档完整性通过。
- 包内 21 项静态检查通过，确认数据库与知识库 worker、上下文压缩及后台记忆代码来自本次编译，更新源和许可证正确，未混入账号配置、密钥或会话数据。
- 在隔离用户目录运行打包后的应用，20 项运行检查通过：首次欢迎与协议页、真实鼠标滚轮上下滚动设置页、通过预加载 API 创建和重命名会话、正常退出后读取 SQLite 数据、重启恢复会话和协议状态。两次退出码均为 0，已检查页面无未捕获渲染异常。

运行验收使用调试器和独立用户目录，未修改现有用户资料；为避免工作线程继承调试暂停，仅在验收进程中清除 worker 的调试参数，发行包代码不作此替换。本次未进行真实模型服务和微信账号的联网验收，也未执行安装器向当前 Windows 用户注册程序的步骤；验证对象为 NSIS 归档及其对应的打包应用。
