# 命令行与文件配置

Cyrene 提供一个可选的 `cyrene config` 入口，用于在没有 GUI 的情况下写入模型和微信 iLink 配置。它不会删除已有会话、记忆或其他模型档案；同一个模型档案会按 `profileId` 更新，没有该 ID 时追加为默认档案。

## 安装命令

源码目录中先构建 CLI，并按需链接到全局命令：

```powershell
corepack pnpm@10.33.0 run build:cli
corepack pnpm@10.33.0 link --global
cyrene --help
```

打包版的 `cyrene` 入口随安装包提供；源码运行时也可以直接执行 `node dist/cli/index.js`。

## 配置文件

生成模板：

```powershell
cyrene config init --file .\cyrene.config.json
```

模板不包含密钥。推荐把密钥放在环境变量中：

```json
{
  "version": 1,
  "target": "auto",
  "model": {
    "provider": "OpenAI",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY",
    "explicitTransport": "openai",
    "multimodal": true
  },
  "wechat": {
    "enabled": true,
    "toolSandbox": "off",
    "allowedUserIds": ["微信用户标识"],
    "credentials": {
      "botTokenEnv": "CYRENE_WECHAT_BOT_TOKEN",
      "ilinkBotId": "微信 iLink Bot ID",
      "ilinkUserId": "微信 iLink User ID",
      "baseUrl": "https://ilinkai.weixin.qq.com"
    }
  }
}
```

模型字段：

| 字段 | 作用 |
| --- | --- |
| `provider` | 模型供应商显示名 |
| `baseUrl` | HTTP/HTTPS 模型接口地址 |
| `model` | 默认模型名 |
| `models` | 可选模型列表，默认模型会自动加入列表 |
| `apiKey` / `apiKeyEnv` | API Key，优先使用环境变量名 |
| `explicitTransport` | `openai`、`anthropic` 或 `responses` |
| `multimodal` | 是否让主模型直接接收图片 |
| `contextWindowTokens` | 可选上下文窗口，最小 4096 |
| `imageGeneration` | 可选 `{ "enabled": true, "model": "..." }` |

微信字段：

| 字段 | 作用 |
| --- | --- |
| `enabled` | 是否启动微信 iLink 渠道 |
| `toolSandbox` | 微信后台工具权限：`off` 或 `all` |
| `allowedUserIds` | 工具后台执行白名单；普通聊天仍由渠道运行时处理 |
| `credentialsFile` | 从另一个 JSON 文件导入微信凭据，路径相对于配置文件 |
| `credentials.botToken` / `botTokenEnv` | iLink Bot Token |
| `credentials.ilinkBotId` | iLink Bot ID |
| `credentials.ilinkUserId` | 可选的 iLink 用户 ID |
| `credentials.baseUrl` | 可选的 iLink 服务地址 |

也可以直接把 `botToken` 或 `apiKey` 写入文件，但配置文件和终端历史都可能暴露密钥，建议使用 `apiKeyEnv` / `botTokenEnv`。不要把配置文件提交到 Git。

## 校验、查看与应用

校验只打印供应商、模型、地址、渠道状态和“是否已配置”标记，不打印密钥：

```powershell
cyrene config validate --file .\cyrene.config.json
cyrene config show --file .\cyrene.config.json
```

应用到桌面端：

```powershell
cyrene config apply --file .\cyrene.config.json --target desktop
```

Windows 桌面端默认写入 `%APPDATA%\Cyrene`；也可以显式指定数据目录：

```powershell
cyrene config apply --file .\cyrene.config.json --target desktop --data-dir D:\CyreneData
```

应用到 Linux/Web：

```bash
cyrene config apply --file ./cyrene.config.json \
  --target web \
  --data-dir "${CYRENE_DATA_DIR:-$HOME/.local/share/cyrene-agent}"
```

Web 端会更新 `web-data.json`、`web-features.json` 和 `weixin/credentials.json`，保留已有会话；桌面端会更新 `model-settings.json`、`channels-settings.json` 和 `weixin/credentials.json`。应用后重启桌面程序或 Web 服务。

如果没有微信凭据，仍可只写入 `"enabled": true`，再从桌面设置或 Web 设置页扫码登录。命令行配置不会替代二维码登录流程，也不会自动向微信发送消息。

## 不使用配置文件的命令行方式

`apply` 也接受直接参数：

```bash
cyrene config apply \
  --target web \
  --data-dir "$CYRENE_DATA_DIR" \
  --provider "OpenAI" \
  --base-url "https://api.openai.com/v1" \
  --model "gpt-4o-mini" \
  --api-key-env OPENAI_API_KEY \
  --wechat-enabled \
  --wechat-credentials-file ./wechat-credentials.json
```

直接参数支持 `--provider`、`--base-url`、`--model`、`--api-key` / `--api-key-env`、`--transport`、`--profile-id`、`--multimodal`、`--context-window`，以及 `--wechat-*` 凭据、白名单和工具权限参数。执行 `cyrene config` 可以再次查看完整用法。

## 凭据文件示例

`--wechat-credentials-file` 接受微信 iLink 登录后得到的同结构凭据文件：

```json
{
  "botToken": "从环境变量读取更安全",
  "ilinkBotId": "bot-id",
  "ilinkUserId": "user-id",
  "baseUrl": "https://ilinkai.weixin.qq.com"
}
```

凭据会复制到目标数据目录的 `weixin/credentials.json`，文件权限按私密数据方式创建。Linux 还应确保运行 Web 服务的账号拥有该目录，并让 systemd 与手工启动使用相同的 `CYRENE_DATA_DIR`。

## 在命令行与昔涟对话：exec / resume

`cyrene exec` 执行一轮对话，把昔涟的回复流式输出到 stdout；工具调用、模型重试和错误提示写到 stderr，因此 `cyrene exec "..." > reply.txt` 只保存回复正文。

```bash
cyrene login --server https://cyrene.example.com --username admin   # 交互输入密码
cyrene exec "今天想听什么歌？"
cyrene exec --mode code --workspace /srv/projects/demo "看看这个项目的测试怎么跑"
cyrene exec --session <会话ID> "接着刚才的话题"
echo "把这段话润色一下：……" | cyrene exec -
cyrene exec --json "你好" | jq -c 'select(.type == "result")'
```

| 选项 | 作用 |
| --- | --- |
| `--mode chat\|work\|code` | 新会话的模式，默认 `chat` |
| `--session ID` / `--new` | 继续已有会话 / 新建会话（默认新建） |
| `--workspace DIR` | work/code 会话的项目目录；连接本机服务或 `--local` 时默认当前目录，连接远程服务器时必须是服务器上的绝对路径 |
| `--model-profile ID` | 为会话指定模型档案（只校验 ID，不显示档案内容） |
| `--json` | 每行一个 JSON：`session`、`agui`（原始 AG-UI 事件）、`notice`、`result` |
| `--reasoning` | 把推理内容也输出到 stderr |
| `--server URL` | Web 服务地址，默认依次取 `CYRENE_SERVER`、最近一次 `cyrene login`、`http://127.0.0.1:4317` |
| `--local [--data-dir DIR] [--app-root DIR] [--verbose]` | 不经过 Web 服务，直接启动 headless 核心 |

提示内容以 `-` 开头时，用 `--` 分隔：`cyrene exec -- "-1 的平方根是什么"`。

退出码：`0` 成功，`1` 本轮失败（模型错误、超时、核心拒绝），`2` 参数错误，`3` 未登录、登录过期或连接失败，`130` 用 Ctrl+C 取消。按一次 Ctrl+C 会向核心发送取消请求并等待确认；再按一次立即退出。

`cyrene resume` 列出或继续会话：

```bash
cyrene resume                    # 最近 10 个会话（--limit N，--mode chat，--json）
cyrene resume <会话ID>           # 多轮对话：每行一条消息，/exit 或 Ctrl+D 退出
cyrene resume --last             # 继续最近更新的会话
cyrene resume <会话ID> "提示"     # 单轮，等同 exec --session
```

多轮模式下 Ctrl+C 取消正在进行的这一轮；在输入提示处按 Ctrl+C 退出。也可以通过管道一次送入多行，每行执行一轮。

### 登录与凭据

- `cyrene login [--server URL] [--username NAME] [--password-stdin]`：密码来自 `--password-stdin`、环境变量 `CYRENE_PASSWORD` 或终端隐藏输入，不接受命令行参数。
- 登录后只保存服务器下发的会话令牌，不保存密码，写入 `~/.cyrene/credentials.json`（目录 700、文件 600；权限过宽时下次读取会自动收紧）。Windows 上依赖用户目录本身的访问控制。
- 脚本或 CI 可不登录，直接设置 `CYRENE_USERNAME` 与 `CYRENE_PASSWORD`；这种临时会话不落盘，命令结束时自动注销。
- 远程服务器必须使用 `https://`；明文 `http://` 只允许 `localhost`、`127.0.0.1`、`::1`。
- `cyrene logout [--server URL]` 在服务器端注销并删除本地记录。
- 服务器连续登录失败后会要求验证码，命令行无法完成，请等待约一分钟或先在浏览器登录。

### --local

`--local` 直接启动 `dist/headless/core.cjs`（与 Linux Web 服务使用的是同一个共享核心），不需要登录和网络。它只适用于源码目录或 Web 部署目录：需要先运行 `corepack pnpm run build:server`，且该目录有 `node_modules`；不在该目录运行时用 `--app-root` 指定。数据目录默认与 Web 端相同（`CYRENE_DATA_DIR` 或 `~/.local/share/cyrene-agent`），可用 `--data-dir` 指定。

不要让 `--local` 与正在运行的桌面端或 Web 服务使用同一个数据目录，两个核心会同时写同一份会话和设置。服务已经在运行时，请改用 `--server`。

### 当前限制

- 需要用户确认的操作（权限审批、选择题卡片）无法在命令行处理。命令行会在 stderr 提示，请到桌面端或 Web 界面处理，或按 Ctrl+C 取消。
- 命令行发起的轮次由核心写入会话记录；界面上的过程展示（工具卡片的中间状态等）由界面端写入，命令行发起的轮次没有这部分展示。
- 暂不支持附件和图片输入。

## 环境检查：doctor

```bash
cyrene doctor
cyrene doctor --target web --data-dir "$CYRENE_DATA_DIR" --server https://cyrene.example.com
cyrene doctor --json
```

doctor 依次检查：Node.js 版本（需要 24）、数据目录是否可写、默认模型档案与 apiKey、`node:sqlite` 是否可用、微信渠道是否启用及凭据是否齐全、Web 服务 `/healthz` 与 `/readyz`、已保存的登录会话是否有效。每项显示 `✓`（通过）、`!`（提示，不影响退出码）或 `✗`（失败，附修复建议）。只要有一项 `✗`，退出码就是 1。

apiKey 和微信 botToken 只显示“已配置/缺失”，不显示内容。指向本机地址（如 Ollama）的模型档案可以不配 apiKey。没有指定 `--server`、`CYRENE_SERVER` 或已保存的登录时，doctor 只按本机默认地址探测 Web 服务，探测失败记为提示；只使用桌面端时可以忽略。`--target auto`（默认）在给出 `--data-dir` 或设置了 `CYRENE_DATA_DIR` 时检查 Web 端数据，否则优先检查已存在的桌面端数据目录。

## 未提供的命令

`cyrene init` 和 `cyrene update` 在当前版本中未提供，执行时会给出替代方式并以退出码 2 结束：生成配置模板请用 `cyrene config init`；桌面安装包会自行检查更新，源码部署请 `git pull` 后重新运行 `corepack pnpm run build:cli`（Web 服务另需 `build:server`）。

`cyrene run` 只用于源码目录启动桌面端；当前目录没有 `package.json` 时会报错并以退出码 1 结束。
