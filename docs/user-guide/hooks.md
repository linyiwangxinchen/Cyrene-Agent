# 用户 Hooks

Hooks 让你在昔涟运行的固定节点执行本机命令：工具执行前拦截或改写参数、工具执行后补充说明、用户消息进入运行前追加上下文或拒绝、运行开始与结束时通知。Hook 是你自己写的脚本，昔涟通过 stdin 把事件 JSON 交给它，再读取 stdout 的 JSON 决定后续行为。

## 配置文件位置

Hooks 只从本机配置文件读取，聊天、工具调用、插件和 Web 界面都不能写入或修改它。

| 运行方式 | 路径 |
| --- | --- |
| 桌面版 | userData 目录下的 `hooks.json`，Windows 通常为 `%APPDATA%\Cyrene\hooks.json` |
| Linux Web 服务 | `$CYRENE_DATA_DIR/hooks.json`，默认 `~/.local/share/cyrene-agent/hooks.json` |

文件不存在时 Hooks 完全关闭，不会启动任何进程。修改文件后无需重启，昔涟会在下一次事件时（至多延迟约 1 秒）重新读取。

## 配置格式

```json
{
  "defaultTimeoutMs": 30000,
  "hooks": {
    "PreToolUse": [
      {
        "name": "禁止危险命令",
        "matcher": "run_shell",
        "command": "node",
        "args": ["C:/cyrene-hooks/guard-shell.js"],
        "timeoutMs": 10000,
        "failClosed": true
      }
    ],
    "PostToolUse": [
      { "matcher": "write_file|edit_file", "command": "node", "args": ["C:/cyrene-hooks/lint-hint.js"] }
    ],
    "UserPromptSubmit": [
      { "command": "python3", "args": ["/opt/cyrene-hooks/prompt_filter.py"] }
    ],
    "SessionStart": [
      { "command": "node", "args": ["C:/cyrene-hooks/today.js"], "env": { "TEAM": "ops" } }
    ],
    "Stop": [
      { "command": "node", "args": ["C:/cyrene-hooks/notify.js"] }
    ]
  }
}
```

单条 Hook 的字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | 可执行文件名或绝对路径。不经过 shell，管道、重定向、`&&` 等写法不生效。 |
| `args` | 否 | 字符串数组，原样作为命令参数。 |
| `name` | 否 | 日志中显示的名称，默认取 `command`。 |
| `matcher` | 否 | 只对 `PreToolUse` / `PostToolUse` 生效，按工具 ID 匹配，规则见下文。默认匹配全部工具。 |
| `timeoutMs` | 否 | 单次超时，默认取顶层 `defaultTimeoutMs`，再默认 30000。取值范围 100～600000。 |
| `failClosed` | 否 | 只对 `PreToolUse` 生效。为 `true` 时，Hook 失败、超时或输出无效都会拒绝该工具。 |
| `cwd` | 否 | 工作目录，默认是 `hooks.json` 所在目录。 |
| `env` | 否 | 额外环境变量，字符串键值对。 |

`matcher` 规则：

- 省略、空字符串或 `"*"`：匹配全部工具。
- 通配：`*` 匹配任意字符，`?` 匹配单个字符，整串匹配。例如 `mcp__*`。
- 多个候选用 `|` 分隔：`write_file|edit_file`。
- 以 `/` 包围表示正则：`/^(write|edit)_/i`。

单条配置无效（缺少 `command`、正则写错等）时只跳过该条并在日志中告警，其余条目照常生效。整个文件不是合法 JSON 时，日志记录一条错误，所有 Hook 按未配置处理，应用不会崩溃。

## 执行规则

- 同一事件的多条 Hook 按数组顺序依次执行。
- 退出码为 0 且 stdout 为空或为 JSON 对象时视为成功；退出码非 0、超时、无法启动、stdout 不是 JSON 对象都视为失败。
- 失败默认不阻断，只写日志。只有配置了 `failClosed: true` 的 `PreToolUse` 会在失败时拒绝工具。
- 超时后昔涟会终止 Hook 的整个进程树。
- 运行被取消时，正在执行的 Hook 也会被终止。
- stdout 上限 256KB，`additionalContext` 每条最多 8000 字，拒绝原因最多 2000 字，超出部分截断。

## 事件

所有事件的 stdin 都包含以下公共字段：

| 字段 | 说明 |
| --- | --- |
| `event` | 事件名 |
| `sessionId` | 会话 ID（渠道绑定桌面会话时为桌面会话 ID） |
| `runId` | 本次运行 ID |
| `channel` | `desktop`、`web`，或渠道名 `wechat`、`feishu`、`qq`、`qqbot` |
| `mode` | 会话模式：`chat`、`work`、`code`、`learn`，可能为 `null` |

进程环境中还有 `CYRENE_HOOK_EVENT`，值为事件名。

### PreToolUse

工具执行前触发，先于权限检查。适用于注册工具（内置文件/命令工具、MCP 工具、插件工具），不包括 `update_todo`、`ask_user`、`task` 等运行内部工具。

额外输入：

```json
{ "toolName": "run_shell", "toolInput": { "command": "git status" } }
```

输出（全部可省略，省略表示放行）：

```json
{ "decision": "deny", "reason": "生产目录禁止执行命令" }
```

```json
{ "updatedInput": { "command": "git status --short" } }
```

- `decision` 为 `"deny"`（也接受 `"block"`）时拒绝。工具不执行，模型收到一条权限拒绝的工具失败结果，其中包含 `reason`，模型可以据此换一种做法。
- `updatedInput` 是改写后的**完整**参数对象，会替换原参数。多条 Hook 时，后一条收到的 `toolInput` 是前一条改写后的结果。
- 改写后的参数会重新经过全部安全检查：未确认副作用拦截、Hooks 配置文件保护、计划模式只读约束和权限系统。改写无法绕过权限，例如把只读命令改成删除命令，仍会按删除命令审批或拒绝。

### PostToolUse

工具真正执行后触发（被拒绝或未执行的调用不触发）。

额外输入：

```json
{
  "toolName": "write_file",
  "toolInput": { "path": "src/a.ts", "content": "..." },
  "toolResult": { "outcome": "success", "output": "已写入 src/a.ts" }
}
```

`toolResult.outcome` 为 `success` 或 `failure`，`output` 最多 100000 字。

输出：

```json
{ "additionalContext": "提醒：该文件需要同步更新 CHANGELOG。" }
```

`additionalContext` 作为工具结果中的 `hookContext` 字段交给模型，不改变工具本身的执行结果。

### UserPromptSubmit

用户消息进入运行前触发，覆盖桌面、Web 以及微信、飞书、QQ 渠道。后台任务完成后的自动续跑、定时任务不是用户提交，不触发。

额外输入：

```json
{ "prompt": "帮我看看今天的日程" }
```

输出：

```json
{ "additionalContext": "用户所在时区为 Asia/Shanghai。" }
```

```json
{ "decision": "deny", "reason": "当前处于维护时间" }
```

- `additionalContext` 以 `[HOOK_CONTEXT]` 段落加入本轮模型上下文。
- 拒绝时本轮不会请求模型：桌面和 Web 显示失败原因，渠道把“本轮消息已被本机 Hook 拒绝：原因”作为回复发出。用户消息仍保留在会话记录里，记忆和表情等成功收尾不会执行。

### SessionStart

每次运行开始、请求模型之前触发（包括后台续跑与定时任务）。

输出：

```json
{ "additionalContext": "今天的值班人是小王。" }
```

与 `UserPromptSubmit` 的上下文合并后一起加入本轮。

### Stop

运行结束时触发，只做通知，不影响结果，输出被忽略。Hook 在后台执行，不会拖慢回复。

额外输入：

```json
{ "status": "success" }
```

`status` 为 `success`、`cancelled`、`timeout` 或 `runtime_error`，部分情况下附带 `reason`。

## 示例脚本

### 拦截危险命令（Node.js）

`guard-shell.js`：

```js
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  const command = String(input.toolInput?.command ?? "");
  if (/\brm\s+-rf\b|Remove-Item\s+.*-Recurse/i.test(command)) {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: "不允许递归删除，请改为列出待删除文件让我确认" }));
    return;
  }
  // 渠道里只允许只读的 git 命令
  if (input.channel !== "desktop" && input.channel !== "web" && !/^git (status|log|diff)\b/.test(command)) {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: `${input.channel} 渠道只允许只读 git 命令` }));
    return;
  }
  process.stdout.write("{}");
});
```

### 过滤用户消息（Python）

`prompt_filter.py`：

```python
import json
import sys

data = json.load(sys.stdin)
prompt = data.get("prompt", "")
if "身份证号" in prompt:
    print(json.dumps({"decision": "deny", "reason": "请不要在聊天中发送身份证号"}, ensure_ascii=False))
else:
    print(json.dumps({"additionalContext": f"消息来自 {data.get('channel')} 渠道"}, ensure_ascii=False))
```

### 运行结束通知（Node.js）

`notify.js`：

```js
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  require("fs").appendFileSync(require("path").join(__dirname, "runs.log"),
    `${new Date().toISOString()} ${input.channel} ${input.runId} ${input.status}\n`);
});
```

Windows 上 `command` 写 `node`、`python` 时依赖 `PATH`；若找不到，请写解释器的绝对路径。`.cmd` / `.bat` 脚本可以直接作为 `command`。

## 安全说明

- **只信任本机文件。** Hooks 配置不能通过聊天、工具调用、插件或 IPC 写入。派发层会拒绝任何非只读工具调用中出现 `hooks.json` 绝对路径（或在工作区内解析到该文件的相对路径）的参数，无论当前是否已有配置。
- **渠道同样生效。** 微信等渠道开启“全部允许”时会跳过权限审批，但 `PreToolUse` 拒绝仍然生效，因为它在权限检查之前执行。
- **不经过 shell。** 命令和参数直接交给操作系统启动，昔涟不会拼接命令行，也不会解释 `$VAR`、`%VAR%`、通配符等。
- **环境变量白名单。** Hook 进程只继承系统运行必需的变量（`PATH`、`HOME`、`USERPROFILE`、`TEMP`、`LANG` 等），模型 API Key、渠道令牌等不会传入。需要的变量请在该条 Hook 的 `env` 中显式配置。
- **敏感参数不外传。** 声明了敏感参数的工具（如邮件发送）不向 Hook 提供 `toolInput`（会标记 `toolInputRedacted: true`），也不接受改写；声明敏感输出的工具在 `PostToolUse` 中 `output` 为 `null`。
- **Hook 以你的账号权限运行。** 请只配置你自己编写或审阅过的脚本，并确保 `hooks.json` 和脚本所在目录只有你自己可写。
- **配置损坏时 Hook 不生效。** 如果你依赖 `failClosed` 守卫，修改配置后请查看日志中的“已加载 Hooks 配置”记录，确认文件被正确读取。

## 已知限制

- 配置文件保护基于参数文本匹配。`run_shell` 中经变量拼接、编码等方式间接写出的路径无法识别，高风险环境请保持命令工具需要审批，或用 `PreToolUse` 自行加一道检查。
- 拥有本机文件访问能力的插件进程不受上述保护。
- 同一轮里多个工具是否并行，按模型原始参数判定。Hook 把只读调用改写成写入调用时，这次调用仍可能与其他只读调用并行执行（权限检查照常进行）。
- 目前没有界面查看或编辑 Hooks，请直接编辑文件并查看应用日志（标签 `Hooks`）。
