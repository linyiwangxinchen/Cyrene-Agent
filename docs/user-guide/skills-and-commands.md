# Skill 自写、安装与斜杠命令

本文介绍三件事：让昔涟把做法写成 Skill（`skill_write`），从 GitHub 安装 Skill（`skill_install`），以及用 Markdown 文件定义自己的斜杠命令。桌面版和 Web 版行为一致。

## 目录位置

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 内置 Skill | 安装目录下的 `skills/` | 随安装包更新，只读 |
| 用户 Skill | `<userData>/skills/<id>/SKILL.md` | 自写、安装、随安装包快照分发的第三方 Skill 都在这里 |
| 用户命令 | `<userData>/commands/*.md` | 所有会话可用 |
| 工作区命令 | `<工作区>/.cyrene/commands/*.md` | 只在绑定了该工作区的会话里可用 |

`<userData>` 是应用数据目录，可以在设置里打开。

## 让昔涟写 Skill（skill_write）

在 Work / Code / Learn 会话里，可以直接说“把刚才这套流程写成 Skill，叫 weekly-report”。昔涟会调用 `skill_write`，写出：

```markdown
---
name: weekly-report
description: 写周报：汇总本周提交、会议和待办
modes:
  - work
---

# 周报
1. ……
```

规则：

- **id**：只能用小写字母、数字和单个短横线连接，例如 `weekly-report`，最长 64 字符。目录名就是 id。
- **frontmatter**：`name`（展示名，缺省等于 id）、`description`（必填，决定昔涟什么时候想到用它）、`modes`（可选，`work` / `code` / `learn`，缺省全部模式可用）。
- **更新**：同名 Skill 已存在时，必须传 `overwrite=true` 才会更新。更新只改 `SKILL.md`，目录里的 `references/` 等文件保留。
- **不能改的 Skill**：内置 Skill 的同名 id 一律拒绝（用户目录的同名 Skill 会覆盖内置，等于改内置）。用户目录里没有来源标记的 Skill（随安装包快照分发的第三方 Skill、你手动放进去的 Skill）也拒绝覆盖，请换一个 id，或者自己编辑文件。
- **生效**：写完自动重新扫描，下一轮对话就能用，也可以用 `/weekly-report` 直接激活。

## 从 GitHub 安装 Skill（skill_install）

对昔涟说“安装 octo/skills 里的 pdf-helper”，或者把仓库链接发给她。支持的来源写法：

- `owner/repo`：仓库根目录就是一个 Skill
- `owner/repo/path/to/skill`：仓库里的某个子目录
- `https://github.com/owner/repo`、`https://github.com/owner/repo/tree/<分支>/<目录>`
- 可选参数 `ref`（分支、标签或提交）、`id`（安装后的 id）、`overwrite`（更新已安装的 Skill）

安装过程：先把分支解析成确定的提交号，再下载该提交的 tarball，在内存里解析并校验，写进暂存目录（`<userData>/.skill-staging/`），最后整体替换到 `<userData>/skills/<id>/`。任何一项校验失败都不会留下半个 Skill：

- 目录根部必须有可解析的 `SKILL.md`（含 `name` 和 `description`）
- 下载不超过 25 MB，解压后不超过 200 MB；Skill 本身不超过 200 个文件、5 MB
- 拒绝符号链接、硬链接和其他特殊文件
- 拒绝 `..`、绝对路径、反斜杠、盘符等路径穿越写法
- 不能覆盖内置 Skill 或未托管的用户 Skill；已安装过的需要 `overwrite=true`

安装后目录里会多一个 `.cyrene-source.json`，记录仓库、仓库内路径、分支和提交号。id 缺省依次取 `SKILL.md` 的 `name`、目录名、仓库名中第一个合法的。

设置页或脚本也可以通过 IPC `skill:install`（preload：`window.settings.installSkill({ source, ref?, id?, overwrite? })`）发起安装，这条路径由用户主动点击，不再额外弹审批。

注意：安装的 Skill 是别人写的提示词，装之前先看一眼仓库内容。GitHub 未登录接口每小时有调用次数限制，遇到 HTTP 403 稍后重试即可。

## 审批与权限

`skill_write` 和 `skill_install` 的风险等级按“文件写入”（fs-write）处理：

- 「只读」类档位下直接拒绝。
- 其他档位下，**每次调用都会弹审批卡**，包括「完全访问」档位。
- 微信、QQ 等渠道后台运行和定时任务没有审批界面，这两个工具不会出现在工具列表里，即使渠道开启了“允许可用工具”自动执行也不会绕过审批。
- 安装用到的网络请求只访问 `api.github.com` 和 `codeload.github.com`，走应用已有的网络与代理设置。

## 斜杠命令

在命令目录里放一个 Markdown 文件，文件名就是命令名。例如 `<userData>/commands/review.md`：

```markdown
---
description: 按团队规范审查一个文件
argument-hint: <文件> [关注点]
mode: [code, work]
---

请按团队代码规范审查 $1，重点关注：$2。

用户原话：$ARGUMENTS
```

输入 `/review src/app.ts "并发 与 边界"` 时，昔涟收到的是展开后的提示：

```
请按团队代码规范审查 src/app.ts，重点关注：并发 与 边界。

用户原话：src/app.ts "并发 与 边界"
```

规则：

- **命令名**：文件名去掉 `.md`，只能用小写字母、数字和短横线，例如 `review`、`daily-report`。大写或下划线的文件会被忽略。
- **frontmatter 全部可选**：`description`（补全菜单里显示）、`argument-hint`（参数提示）、`mode`（`chat` / `work` / `code` / `learn`，可写单个或数组，缺省全部模式）。
- **参数替换**：`$ARGUMENTS` 替换为命令名后的全部文本；`$1`～`$9` 替换为按空白切分的第 N 个参数，用双引号或单引号包住含空格的参数，缺失的位置参数替换为空。正文里一个占位符都没有、但你带了参数时，参数会以“参数：……”追加在末尾。
- **只改本轮**：展开只影响发给模型的这一轮内容，聊天记录里保存的仍是你输入的 `/review ...` 原文。
- **附件**：带附件发送命令时，附件路径列表保留在展开后的提示末尾。
- **补全**：Work / Code / Learn 会话的输入框输入 `/` 会同时列出命令和 Skill，命令带“我的命令”或“工作区命令”标签。Chat 会话没有补全菜单，但命令照样可以展开。
- **大小与安全**：单个命令文件不超过 64 KB；符号链接形式的命令文件会被忽略，防止工作区通过链接读取目录外的文件。工作区命令来自项目仓库，打开不信任的仓库时留意 `.cyrene/commands/` 里的内容。

### 优先级

同一个名字可能同时是工作区命令、用户命令和 Skill。输入 `/名字` 时按下面顺序取第一个可用的：

1. 工作区命令 `<工作区>/.cyrene/commands/<名字>.md`
2. 用户命令 `<userData>/commands/<名字>.md`
3. Skill 斜杠激活（`/<skill-id>` 加载该 Skill 的完整指令）

“可用”指命令的 `mode` 包含当前会话模式。例如工作区的 `plan.md` 只写了 `mode: code`，在 Work 会话里输入 `/plan` 就会用用户目录的 `plan.md`；都不可用时才轮到同名 Skill。命令与 Skill 同名时，补全菜单只显示命令。想重新用 `/名字` 激活 Skill，把命令文件改名即可。

### 保留名

`stop`、`cancel`、`status`、`help` 是渠道控制命令的保留名，同名命令文件不会生效。微信、QQ 等渠道里的 `/stop`、`/取消`、`/status`、`/状态`、`/help`、`/帮助` 由渠道调度器在进入对话之前处理，行为不变。

## 常见问题

- **写完 Skill 没生效？** 看设置 → Skill 里它是否被关掉，或者它的 `modes` 不包含当前会话模式。
- **想删除一个 Skill？** 直接删除 `<userData>/skills/<id>/` 目录，然后在设置 → Skill 点“重新扫描”。
- **命令没展开？** 检查文件名是否全小写、扩展名是否为 `.md`、`mode` 是否包含当前模式；工作区命令还要求当前会话绑定了该工作区。
