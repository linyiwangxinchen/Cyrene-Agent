# 上游同步、条款与插件面板适配（2026-11-02）

## 基线

- 原 master：`2241671b8353fe451fe6f908c10da52ff72332d6`。
- 已推送备份：`backup/master-before-upstream-20261102`，指向原 master。
- 集成分支：`integrate/upstream-linux-web-20261102`。
- 共同基点：`50f060fee8d719fc66c551dd234fcea4b187bec4`。
- 合入上游 master：`b547d66967723854ddc058f7a0b7815b384330cc`，共 8 个上游提交。

## 上游功能与冲突

1. 应用版本从 `1.3.4-3` 更新为上游的 `1.3.5`；`package.json` 的版本号是本轮唯一的文本冲突，采用上游值。小花园插件版本仍为 `0.1.2`。
2. 表情包管理增加删除用户表情、确认与错误提示，内置表情仍只能禁用；清单写入及删除失败回滚由上游共享存储实现。
3. 同步中、英、日免责声明及使用条款，旧版或缺失的同意记录需要对新条款重新明确确认。
4. 同步完全访问权限的风险说明、倒计时确认和错误处理，以及设置搜索索引、邮件链接处理和相关测试。

## 本分支适配

| 文件/范围 | 修改作用 |
| --- | --- |
| `src/renderer/web/WebConsentGate.tsx`、`WebAuthGate.tsx`、`styles.css` | Web 管理员登录后使用上游欢迎与条款界面；保存并确认当前版本后进入工作区；读取或保存失败可重试；拒绝只注销该浏览器会话，不停止服务器 |
| `src/renderer/react/i18n/{zh-CN,en,ja-JP}.json` | 增加 Web 读取同意状态和退出登录失败提示，保留上游条款及本分支原有翻译 |
| `src/main/protocols/bootstrap.ts` | 已删除或缺失的用户表情图片返回 404，避免 Web 历史消息引用缺失图片时产生服务端异常 |
| `src/renderer/settings/plugin-panels.ts` | 保存已注册的 iframe 窗口用于卸载清理，异步结果只返回发起请求的存活窗口，避免切换设置页后结果误发到旧面板或其他新面板 |
| `WebConsentGate.test.tsx`、`plugin-panels.test.ts` | 覆盖新旧条款、拒绝与保存失败、重复提交、面板卸载及迟到回包 |
| `scripts/verify/shared-core-parity.mjs` | 通过认证 Web 核心验证表情包添加、内置保护、删除、图片 404 及重启后仍保持删除 |
| `scripts/verify/bili-garden-web.mjs` | 在桌面和手机浏览器验证条款、表情包、权限确认、小花园设置切换及既有交互 |
| `.github/workflows/linux-web.yml` | 将本次新增的条款、权限、表情与面板回归测试加入现有 Ubuntu Web 检查 |

Web 的条款确认是与桌面对应的界面流程；服务端已有的后台任务和渠道生命周期不因浏览器退出而停止。更新后已有用户会再次看到条款，需要在浏览器中确认后进入工作区。

## 验证

- Node 24、pnpm 10.33.0，锁文件安装通过；Main、Preload、Server、Renderer 类型检查及 Windows/Web 构建通过。
- 全量 Vitest 647 个测试文件、6804 项通过、5 项跳过；Web 认证浏览器验收通过，覆盖桌面和 390px 手机视口。
- 认证共享核心 34 项、语音/MCP 21 项、会话压缩 10 项、记忆恢复 4 项、后台 shell 5 项通过。
- 小花园 Node 37 项、Python 后端 11 项、模型边界 6 项通过；隔离的 pip 中断续传测试通过。
- 小花园真实无桌面 Agent 夹具、评论诊断面板，以及 Web 页面已使用本地测试数据验证；没有操作真实 B 站、微信或模型账号。

本轮没有部署远程 Linux 服务器或发布安装包，实际 Linux systemd 服务、真实渠道和模型仍需在目标环境验证。

## 后续同步

继续保留两侧历史和备份分支。应用版本跟随 upstream master，避免 fork 固定后缀反复与上游版本变更产生文本冲突；fork 专属标识应放在独立发布元数据中。Web 特有的条款逻辑保留在 `src/renderer/web/`，减少与上游共享引导代码的重叠。自动合并仍不能保证业务兼容，需运行同步预检、两端构建和认证后的 Web 回归。
