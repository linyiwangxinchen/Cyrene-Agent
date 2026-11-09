import path from "node:path";
import {
  applyConfig,
  loadConfigFile,
  readConfigFile,
  redactDocument,
  resolveConfigDocument,
  summarizeConfig,
  writeTemplate,
  type ConfigTarget,
  type CyreneConfigFile,
} from "../config/config.js";
import { errLine, outLine } from "../util/log.js";

type ConfigAction = "init" | "validate" | "apply" | "show";

interface ParsedConfigArgs {
  action: ConfigAction;
  file?: string;
  target?: ConfigTarget;
  dataDir?: string;
  force: boolean;
  flags: Record<string, string | boolean | string[]>;
}

function nextValue(args: readonly string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 需要一个值`);
  return [value, index + 1];
}

function pushFlag(flags: ParsedConfigArgs["flags"], key: string, value: string | boolean): void {
  const existing = flags[key];
  if (existing === undefined) flags[key] = value;
  else if (Array.isArray(existing)) existing.push(String(value));
  else flags[key] = [String(existing), String(value)];
}

function parseConfigArgs(args: readonly string[]): ParsedConfigArgs {
  const action = (args.find((item) => !item.startsWith("-")) ?? "").toLowerCase() as ConfigAction;
  if (!["init", "validate", "apply", "show"].includes(action)) throw new Error("用法：cyrene config init|validate|apply|show");
  const result: ParsedConfigArgs = { action, force: false, flags: {} };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("-")) continue;
    if (item === "--force") { result.force = true; continue; }
    const equals = item.indexOf("=");
    const flag = equals >= 0 ? item.slice(0, equals) : item;
    const inline = equals >= 0 ? item.slice(equals + 1) : undefined;
    const valueFlags = new Set([
      "--file", "--target", "--data-dir", "--provider", "--display-name", "--base-url", "--model", "--models",
      "--api-key", "--api-key-env", "--transport", "--profile-id", "--context-window", "--image-model",
      "--wechat-credentials-file", "--wechat-bot-token", "--wechat-bot-token-env", "--wechat-bot-id", "--wechat-user-id",
      "--wechat-base-url", "--wechat-tool-sandbox", "--wechat-allowed-users",
    ]);
    const booleanFlags = new Set(["--multimodal", "--no-multimodal", "--wechat-enabled", "--no-wechat"]);
    if (valueFlags.has(flag)) {
      const value = inline ?? nextValue(args, index, flag)[0];
      if (inline === undefined) index += 1;
      if (flag === "--file") result.file = value;
      else if (flag === "--target") result.target = value as ConfigTarget;
      else if (flag === "--data-dir") result.dataDir = value;
      else pushFlag(result.flags, flag.slice(2), value);
      continue;
    }
    if (booleanFlags.has(flag)) {
      pushFlag(result.flags, flag.slice(2), true);
      continue;
    }
    throw new Error(`未知配置选项：${flag}`);
  }
  return result;
}

function asList(value: string | boolean | string[] | undefined): string[] | undefined {
  if (value === undefined || typeof value === "boolean") return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

function boolFlag(flags: ParsedConfigArgs["flags"], key: string): boolean | undefined {
  if (flags[key] === true) return true;
  if (flags[key] === false) return false;
  return undefined;
}

function buildInlineDocument(parsed: ParsedConfigArgs): CyreneConfigFile {
  const flags = parsed.flags;
  const modelFields: Record<string, unknown> = {};
  const modelMap: Array<[string, keyof typeof modelFields]> = [
    ["provider", "provider"], ["display-name", "displayName"], ["base-url", "baseUrl"], ["model", "model"],
    ["api-key", "apiKey"], ["api-key-env", "apiKeyEnv"], ["transport", "explicitTransport"], ["profile-id", "profileId"],
  ];
  for (const [flag, field] of modelMap) if (flags[flag] !== undefined) modelFields[field] = flags[flag];
  const models = asList(flags.models);
  if (models) modelFields.models = models;
  if (flags["context-window"] !== undefined) modelFields.contextWindowTokens = Number(flags["context-window"]);
  const multimodal = boolFlag(flags, "multimodal");
  const noMultimodal = boolFlag(flags, "no-multimodal");
  if (multimodal !== undefined) modelFields.multimodal = multimodal;
  if (noMultimodal) modelFields.multimodal = false;
  if (flags["image-model"] !== undefined) modelFields.imageGeneration = { enabled: true, model: String(flags["image-model"]) };

  const wechatFields: Record<string, unknown> = {};
  const wechatMap: Array<[string, string]> = [
    ["wechat-bot-token", "botToken"], ["wechat-bot-token-env", "botTokenEnv"], ["wechat-bot-id", "ilinkBotId"],
    ["wechat-user-id", "ilinkUserId"], ["wechat-base-url", "baseUrl"],
  ];
  for (const [flag, field] of wechatMap) if (flags[flag] !== undefined) wechatFields[field] = flags[flag];
  if (flags["wechat-credentials-file"] !== undefined) wechatFields.__credentialsFile = flags["wechat-credentials-file"];
  const wechatEnabled = boolFlag(flags, "wechat-enabled");
  const noWechat = boolFlag(flags, "no-wechat");
  const userIds = asList(flags["wechat-allowed-users"]);
  const wechat: Record<string, unknown> = {};
  if (wechatEnabled !== undefined) wechat.enabled = wechatEnabled;
  if (noWechat) wechat.enabled = false;
  if (flags["wechat-tool-sandbox"] !== undefined) wechat.toolSandbox = flags["wechat-tool-sandbox"];
  if (userIds) wechat.allowedUserIds = userIds;
  if (Object.keys(wechatFields).length) {
    const credentialsFile = wechatFields.__credentialsFile;
    delete wechatFields.__credentialsFile;
    if (credentialsFile) wechat.credentialsFile = credentialsFile;
    if (Object.keys(wechatFields).length) wechat.credentials = wechatFields;
  }
  const document: CyreneConfigFile = {
    version: 1,
    ...(parsed.target ? { target: parsed.target } : {}),
    ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
    ...(Object.keys(modelFields).length ? { model: modelFields } : {}),
    ...(Object.keys(wechat).length ? { wechat } : {}),
  };
  if (!document.model && !document.wechat) throw new Error("apply 需要 --file，或至少提供一个模型/微信配置选项");
  return document;
}

function loadInput(parsed: ParsedConfigArgs): { document: CyreneConfigFile; resolved: ReturnType<typeof resolveConfigDocument> } {
  if (parsed.file) {
    const loaded = loadConfigFile(parsed.file);
    return { document: loaded.document, resolved: resolveConfigDocument(loaded.document, path.resolve(parsed.file), parsed.target, parsed.dataDir) };
  }
  const document = buildInlineDocument(parsed);
  return { document, resolved: resolveConfigDocument(document, "<command line>", parsed.target, parsed.dataDir) };
}

function printSummary(summary: ReturnType<typeof summarizeConfig>): void {
  outLine(`target: ${summary.target}`);
  if (summary.dataDir) outLine(`dataDir: ${summary.dataDir}`);
  if (summary.model) {
    outLine(`model: ${summary.model.provider} / ${summary.model.model}`);
    outLine(`baseUrl: ${summary.model.baseUrl}`);
    outLine(`transport: ${summary.model.transport}`);
    outLine(`apiKey: ${summary.model.apiKeyConfigured ? "configured" : "missing"}`);
  }
  if (summary.wechat) {
    outLine(`wechat: ${summary.wechat.enabled ? "enabled" : "disabled"}`);
    outLine(`wechat credentials: ${summary.wechat.credentialsConfigured ? "configured" : "missing"}`);
    if (summary.wechat.botId) outLine(`wechat botId: ${summary.wechat.botId}`);
    outLine(`wechat allowed users: ${summary.wechat.allowedUserCount}`);
  }
}

export async function cmdConfig(args: readonly string[]): Promise<number> {
  try {
    if (args.length === 0) {
      outLine(configHelp());
      return 0;
    }
    const parsed = parseConfigArgs(args);
    if (parsed.action === "init") {
      const file = path.resolve(parsed.file ?? "cyrene.config.json");
      writeTemplate(file, parsed.target ?? "auto", parsed.force);
      outLine(`已写入配置模板：${file}`);
      outLine("请填写模型信息；API Key 和微信 botToken 推荐使用环境变量，再运行 cyrene config validate/apply。");
      return 0;
    }
    if (parsed.action === "show" && parsed.file) {
      outLine(JSON.stringify(redactDocument(readConfigFile(parsed.file).document), null, 2));
      return 0;
    }
    if (!parsed.file && parsed.action !== "apply") throw new Error(`${parsed.action} 需要 --file`);
    const input = loadInput(parsed);
    if (parsed.action === "validate") {
      printSummary(summarizeConfig(input.resolved));
      outLine("配置校验通过；密钥不会显示在输出中。");
      return 0;
    }
    if (parsed.action === "show") {
      outLine(JSON.stringify(redactDocument(input.document), null, 2));
      return 0;
    }
    const applied = applyConfig(input.resolved, parsed.target && parsed.target !== "auto" ? parsed.target : undefined, parsed.dataDir);
    printSummary(applied.summary);
    outLine("配置已写入。重启桌面端或 Web 服务后生效；微信二维码登录仍可在设置页完成。");
    return 0;
  } catch (error) {
    errLine(`cyrene config: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

export function configHelp(): string {
  return `Usage: cyrene config <action> [options]

Actions:
  init       Create a redacted config template
  validate   Validate a config file without writing settings
  show       Print a config file with secrets redacted
  apply      Write model and WeChat settings to the selected data directory

Common options:
  --file PATH                 Config file (default for init: ./cyrene.config.json)
  --target auto|desktop|web   Select the settings store
  --data-dir PATH             Override the target data directory
  --force                     Allow init to overwrite an existing file

Inline apply options:
  --provider NAME --base-url URL --model NAME
  --api-key VALUE | --api-key-env ENV_NAME
  --transport openai|anthropic|responses --profile-id ID
  --multimodal | --no-multimodal --context-window TOKENS
  --wechat-enabled | --no-wechat
  --wechat-credentials-file PATH
  --wechat-bot-token VALUE | --wechat-bot-token-env ENV_NAME
  --wechat-bot-id ID --wechat-user-id ID --wechat-base-url URL
  --wechat-tool-sandbox off|all --wechat-allowed-users ID[,ID]

Secrets are never printed by validate/show. Prefer *_env options for API keys and WeChat bot tokens.`;
}
