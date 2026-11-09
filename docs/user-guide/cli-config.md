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
