# 小花园合入 master 与上游同步（2026-11-01）

## 基线和保留

- 原 master：`be512f223cd79189e782ef8ee751992d92b33134`。
- 已推送备份：`backup/master-before-garden-upstream-20261101`。
- 小花园：`4a18392adf3c613c7bf6adf229faa4d44fb9f06c`。
- 本次上游：`327f71cc`，相对上次 `8f6f1abd` 新增 13 个提交。
- 集成分支：`integrate/garden-upstream-20261101`。

## 合并内容

1. 将小花园插件、共享人格/任务接口、Web 插件面板修复和 ZIP 导入修复一起纳入 master；无需旧宿主单独导入 ZIP。插件仍默认关闭，不自动登录或发送消息。
2. 保留上游 ExcelJS 原生动态导入修复、PDF TTC 字体选择/失败输出保护、MCP 已连接实例复用与统计、tokenizer_config.json 完整性检测，以及移除未使用的 LanceDB 依赖。
3. 补充上游 PDF 工具的 Linux 字体候选：Noto CJK 和文泉驿；保留 Windows 原有字体和临时输出保护。新增模拟 Linux 环境下真实 PDF 中文 Unicode 映射测试，部署指南补充 fonts-noto-cjk 安装命令。
4. 小花园 README 从开发分支切换为 master 更新流程。

## 冲突和后续同步

本次 Git 三方合并无文本冲突；不代表无需兼容性审查，PDF 字体 Windows 路径限制就是语义缺口。保留完整上游 merge ancestry，插件实现继续独立放在 extensions/bili-garden，宿主只保留必要接口与通用修复。没有改写上游历史、强制推送或替换整棵源码树。以后上游修改相同宿主行时仍可能冲突，不能保证 GitHub 永远自动合并。

## 验收

- pnpm 10.33.0 frozen-lockfile 安装通过。
- Main/Preload/Renderer/Server 类型检查、Web 与 Windows 全量构建通过。
- 上游相关定向回归：69 通过，4 个 POSIX 权限测试在 Windows 跳过。
- 小花园 Node 测试：18 通过。
- 无桌面宿主真实 Agent 链路、认证 Web 插件面板、手机布局与下载检查通过。
- 共享核心 34 项、语音/MCP 21 项通过。
- Electron 44.7.2 / Node 24.21.0 内置插件 ESM、SQLite、IPC、配置和退出验收通过。
- 全量 Vitest：627 个文件，6608 通过，5 跳过（包含原有跳过项及 Windows 上不适用的 POSIX 权限测试）。

本次不发布新的 Windows 安装包、不修改生产服务。没有执行真实 B 站对外投递或扫码登录；本轮 Linux PDF 字体回归使用测试字体映射，实际服务器仍需安装系统中文字体。
