import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ConfigTarget = "auto" | "desktop" | "web";
export type ModelTransport = "openai" | "anthropic" | "responses";
export type ToolSandbox = "off" | "all";

export interface ModelConfigFile {
  profileId?: string;
  provider?: string;
  displayName?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  apiKey?: string;
  apiKeyEnv?: string;
  explicitTransport?: ModelTransport;
  multimodal?: boolean;
  contextWindowTokens?: number;
  imageGeneration?: { enabled: boolean; model: string };
}

export interface WechatCredentialsFile {
  botToken?: string;
  botTokenEnv?: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
  baseUrl?: string;
}

export interface WechatConfigFile {
  enabled?: boolean;
  toolSandbox?: ToolSandbox;
  allowAnyUser?: boolean;
  allowedUserIds?: string[];
  credentialsFile?: string;
  credentials?: WechatCredentialsFile;
}

export interface CyreneConfigFile {
  version?: 1;
  target?: ConfigTarget;
  dataDir?: string;
  model?: ModelConfigFile;
  wechat?: WechatConfigFile;
}

export interface ResolvedModelConfig {
  profileId: string;
  provider: string;
  displayName?: string;
  baseUrl: string;
  model: string;
  models?: string[];
  apiKey: string;
  apiKeyProvided: boolean;
  explicitTransport: ModelTransport;
  multimodal?: boolean;
  contextWindowTokens?: number;
  imageGeneration?: { enabled: boolean; model: string };
}

export interface WechatCredentials {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
}

export interface ResolvedWechatConfig {
  enabled: boolean;
  toolSandbox?: ToolSandbox;
  allowAnyUser?: boolean;
  allowedUserIds: string[];
  credentials?: WechatCredentials;
}

export interface ResolvedCyreneConfig {
  target: ConfigTarget;
  dataDir?: string;
  model?: ResolvedModelConfig;
  wechat?: ResolvedWechatConfig;
}

export interface ConfigSummary {
  target: ConfigTarget;
  dataDir?: string;
  model?: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
    transport: ModelTransport;
  };
  wechat?: {
    enabled: boolean;
    credentialsConfigured: boolean;
    botId?: string;
    allowedUserCount: number;
  };
}

const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_MODEL_PROVIDER = "OpenAI";
const DEFAULT_MODEL_TRANSPORT: ModelTransport = "openai";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (!result) throw new Error(`${label} 不能为空`);
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

function normalizedIds(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是字符串数组`);
  const values = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  return Array.from(new Set(values));
}

function resolveSecret(value: unknown, envName: unknown, label: string): string {
  const direct = optionalString(value, label);
  const env = optionalString(envName, `${label}Env`);
  if (direct && env) throw new Error(`${label} 与 ${label}Env 只能配置一个`);
  if (env) {
    const resolved = process.env[env];
    if (!resolved) throw new Error(`${label}Env=${env} 未设置或为空`);
    return resolved;
  }
  return direct ?? "";
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${label} 必须是有效的 HTTP/HTTPS 地址`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} 必须使用 HTTP 或 HTTPS`);
  if (url.username || url.password) throw new Error(`${label} 不应把用户名或密码写入 URL`);
  return value.replace(/\/+$/, "");
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 60) || "model";
}

function resolveModel(input: ModelConfigFile): ResolvedModelConfig {
  const provider = optionalString(input.provider, "model.provider") ?? DEFAULT_MODEL_PROVIDER;
  const model = requiredString(input.model, "model.model");
  const baseUrl = validateHttpUrl(requiredString(input.baseUrl, "model.baseUrl"), "model.baseUrl");
  const explicitTransport = input.explicitTransport ?? DEFAULT_MODEL_TRANSPORT;
  if (!["openai", "anthropic", "responses"].includes(explicitTransport)) throw new Error("model.explicitTransport 必须是 openai、anthropic 或 responses");
  if (input.models !== undefined && !Array.isArray(input.models)) throw new Error("model.models 必须是字符串数组");
  const models = input.models === undefined
    ? undefined
    : Array.from(new Set(input.models.map((item, index) => requiredString(item, `model.models[${index}]`))));
  const modelList = models?.includes(model) ? models : models ? [model, ...models] : undefined;
  const contextWindowTokens = input.contextWindowTokens === undefined
    ? undefined
    : Number.isFinite(input.contextWindowTokens) && input.contextWindowTokens >= 4096
      ? Math.round(input.contextWindowTokens)
      : (() => { throw new Error("model.contextWindowTokens 必须是大于等于 4096 的数字"); })();
  const imageGeneration = input.imageGeneration === undefined
    ? undefined
    : (() => {
      const value = asRecord(input.imageGeneration, "model.imageGeneration");
      return {
        enabled: optionalBoolean(value.enabled, "model.imageGeneration.enabled") ?? false,
        model: requiredString(value.model, "model.imageGeneration.model"),
      };
    })();
  const apiKeyProvided = input.apiKey !== undefined || input.apiKeyEnv !== undefined;
  return {
    profileId: optionalString(input.profileId, "model.profileId") ?? `cli-${slug(provider)}-${slug(model)}`,
    provider,
    displayName: optionalString(input.displayName, "model.displayName"),
    baseUrl,
    model,
    ...(modelList ? { models: modelList } : {}),
    apiKey: resolveSecret(input.apiKey, input.apiKeyEnv, "model.apiKey"),
    apiKeyProvided,
    explicitTransport,
    ...(input.multimodal === undefined ? {} : { multimodal: optionalBoolean(input.multimodal, "model.multimodal") }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(imageGeneration ? { imageGeneration } : {}),
  };
}

function readCredentialsFile(configPath: string, credentialsFile: string): WechatCredentialsFile {
  const resolved = path.resolve(path.dirname(configPath), credentialsFile);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(resolved, "utf8")); }
  catch (error) { throw new Error(`无法读取微信凭据文件 ${resolved}：${error instanceof Error ? error.message : String(error)}`); }
  const value = asRecord(parsed, "wechat.credentialsFile");
  return {
    ...(typeof value.botToken === "string" ? { botToken: value.botToken } : {}),
    ...(typeof value.ilinkBotId === "string" ? { ilinkBotId: value.ilinkBotId } : {}),
    ...(typeof value.ilinkUserId === "string" ? { ilinkUserId: value.ilinkUserId } : {}),
    ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
  };
}

function resolveWechat(input: WechatConfigFile, configPath: string): ResolvedWechatConfig {
  if (input.toolSandbox !== undefined && input.toolSandbox !== "off" && input.toolSandbox !== "all") throw new Error("wechat.toolSandbox 必须是 off 或 all");
  const fromFile = input.credentialsFile ? readCredentialsFile(configPath, input.credentialsFile) : {};
  const credentialsInput = { ...fromFile, ...(input.credentials ?? {}) };
  const hasCredentialInput = Object.keys(credentialsInput).length > 0;
  const enabled = input.enabled ?? hasCredentialInput;
  let credentials: WechatCredentials | undefined;
  // A disabled template may contain *_env placeholders for later use. Do not
  // require those environment variables until the user enables WeChat.
  if (hasCredentialInput && (enabled || Boolean(input.credentialsFile))) {
    const botToken = resolveSecret(credentialsInput.botToken, credentialsInput.botTokenEnv, "wechat.credentials.botToken");
    const ilinkBotId = requiredString(credentialsInput.ilinkBotId, "wechat.credentials.ilinkBotId");
    const ilinkUserId = optionalString(credentialsInput.ilinkUserId, "wechat.credentials.ilinkUserId") ?? "";
    const baseUrl = validateHttpUrl(optionalString(credentialsInput.baseUrl, "wechat.credentials.baseUrl") ?? DEFAULT_WECHAT_BASE_URL, "wechat.credentials.baseUrl");
    if (!botToken) throw new Error("wechat.credentials.botToken 不能为空；可改用 botTokenEnv");
    credentials = { botToken, ilinkBotId, ilinkUserId, baseUrl };
  }
  return {
    enabled,
    ...(input.toolSandbox ? { toolSandbox: input.toolSandbox } : {}),
    ...(input.allowAnyUser === undefined ? {} : { allowAnyUser: optionalBoolean(input.allowAnyUser, "wechat.allowAnyUser") }),
    allowedUserIds: normalizedIds(input.allowedUserIds, "wechat.allowedUserIds"),
    ...(credentials ? { credentials } : {}),
  };
}

export function resolveConfigDocument(document: CyreneConfigFile, configPath = "<inline>", targetOverride?: ConfigTarget, dataDirOverride?: string): ResolvedCyreneConfig {
  const target = targetOverride ?? document.target ?? "auto";
  if (!["auto", "desktop", "web"].includes(target)) throw new Error("target 必须是 auto、desktop 或 web");
  if (document.version !== undefined && document.version !== 1) throw new Error("不支持的配置文件 version，仅支持 1");
  if (document.model !== undefined && (!document.model || typeof document.model !== "object" || Array.isArray(document.model))) throw new Error("model 必须是对象");
  if (document.wechat !== undefined && (!document.wechat || typeof document.wechat !== "object" || Array.isArray(document.wechat))) throw new Error("wechat 必须是对象");
  const model = document.model ? resolveModel(document.model) : undefined;
  const wechat = document.wechat ? resolveWechat(document.wechat, configPath) : undefined;
  const dataDir = dataDirOverride ?? optionalString(document.dataDir, "dataDir");
  return { target, ...(dataDir ? { dataDir: path.resolve(dataDir) } : {}), ...(model ? { model } : {}), ...(wechat ? { wechat } : {}) };
}

export function loadConfigFile(filePath: string): { document: CyreneConfigFile; resolved: ResolvedCyreneConfig } {
  const { document, absolute } = readConfigFile(filePath);
  return { document, resolved: resolveConfigDocument(document, absolute) };
}

export function readConfigFile(filePath: string): { document: CyreneConfigFile; absolute: string } {
  const absolute = path.resolve(filePath);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(absolute, "utf8")); }
  catch (error) { throw new Error(`无法读取配置文件 ${absolute}：${error instanceof Error ? error.message : String(error)}`); }
  const value = asRecord(parsed, "配置文件");
  const document: CyreneConfigFile = value as CyreneConfigFile;
  return { document, absolute };
}

export function createTemplate(target: ConfigTarget = "auto"): CyreneConfigFile {
  return {
    version: 1,
    target,
    model: {
      provider: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      explicitTransport: "openai",
      multimodal: true,
    },
    wechat: {
      enabled: false,
      toolSandbox: "off",
      allowedUserIds: [],
      credentials: {
        botTokenEnv: "CYRENE_WECHAT_BOT_TOKEN",
        ilinkBotId: "",
        ilinkUserId: "",
        baseUrl: DEFAULT_WECHAT_BASE_URL,
      },
    },
  };
}

export function resolveDesktopDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.CYRENE_USER_DATA_DIR) return path.resolve(process.env.CYRENE_USER_DATA_DIR);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cyrene");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Cyrene");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cyrene");
}

export function resolveWebDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.CYRENE_DATA_DIR) return path.resolve(process.env.CYRENE_DATA_DIR);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "cyrene-agent");
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try { return asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath); }
  catch (error) { throw new Error(`配置数据文件 ${filePath} 无法解析：${error instanceof Error ? error.message : String(error)}`); }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function profileForWeb(model: ResolvedModelConfig): Record<string, unknown> {
  return {
    id: model.profileId,
    provider: model.provider,
    displayName: model.displayName,
    baseUrl: model.baseUrl,
    model: model.model,
    ...(model.models ? { models: model.models } : {}),
    ...(model.apiKeyProvided ? { apiKey: model.apiKey } : {}),
    explicitTransport: model.explicitTransport,
    ...(model.multimodal === undefined ? {} : { multimodal: model.multimodal }),
    ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
    ...(model.imageGeneration ? { imageGeneration: model.imageGeneration } : {}),
  };
}

function mergeProfile(profiles: unknown, profile: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(profiles) ? profiles.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
  const index = list.findIndex((item) => item.id === profile.id);
  if (index >= 0) list[index] = { ...list[index], ...profile };
  else list.push(profile);
  return list;
}

function applyModelDesktop(dataDir: string, model: ResolvedModelConfig): void {
  const filePath = path.join(dataDir, "model-settings.json");
  const current = readJsonObject(filePath);
  const profile = {
    ...profileForWeb(model),
    provider: model.provider,
    baseUrl: model.baseUrl,
    model: model.model,
    ...(model.apiKeyProvided ? { apiKey: model.apiKey } : {}),
  };
  const perProvider = asRecord(current.perProvider ?? {}, "model-settings.perProvider");
  perProvider[model.provider] = { ...asRecord(perProvider[model.provider] ?? {}, `model-settings.perProvider.${model.provider}`), ...profile };
  const next = {
    ...current,
    mode: "manual",
    schemaVersion: 5,
    provider: model.provider,
    displayName: model.displayName,
    baseUrl: model.baseUrl,
    model: model.model,
    ...(model.apiKeyProvided ? { apiKey: model.apiKey } : {}),
    explicitTransport: model.explicitTransport,
    perProvider,
    modelProfiles: mergeProfile(current.modelProfiles, profile),
    defaultModelProfileId: model.profileId,
    multimodal: model.multimodal ?? current.multimodal ?? true,
    contextWindowTokens: model.contextWindowTokens ?? current.contextWindowTokens ?? 256000,
  };
  writeJson(filePath, next);
}

function applyModelWeb(dataDir: string, model: ResolvedModelConfig): void {
  const filePath = path.join(dataDir, "web-data.json");
  const current = readJsonObject(filePath);
  const settings = asRecord(current.settings ?? {}, "web-data.settings");
  writeJson(filePath, {
    ...current,
    version: 1,
    settings: {
      ...settings,
      modelProfiles: mergeProfile(settings.modelProfiles, profileForWeb(model)),
      defaultModelProfileId: model.profileId,
    },
    sessions: Array.isArray(current.sessions) ? current.sessions : [],
  });
}

function applyWechat(dataDir: string, wechat: ResolvedWechatConfig, target: "desktop" | "web"): void {
  const credentialsPath = path.join(dataDir, "weixin", "credentials.json");
  if (wechat.credentials) writeJson(credentialsPath, wechat.credentials);
  if (target === "desktop") {
    const filePath = path.join(dataDir, "channels-settings.json");
    const current = readJsonObject(filePath);
    const existing = asRecord(current.wechat ?? {}, "channels-settings.wechat");
    writeJson(filePath, {
      ...current,
      wechat: {
        ...existing,
        enabled: wechat.enabled,
        ...(wechat.toolSandbox ? { toolSandbox: wechat.toolSandbox } : {}),
        ...(wechat.allowAnyUser === undefined ? {} : { allowAnyUser: wechat.allowAnyUser }),
        allowedUserIds: wechat.allowedUserIds,
      },
    });
  } else {
    const filePath = path.join(dataDir, "web-features.json");
    const current = readJsonObject(filePath);
    const channels = asRecord(current.channels ?? {}, "web-features.channels");
    const existing = asRecord(channels.wechat ?? {}, "web-features.channels.wechat");
    writeJson(filePath, {
      ...current,
      channels: {
        ...channels,
        wechat: {
          ...existing,
          enabled: wechat.enabled,
          ...(wechat.toolSandbox ? { toolSandbox: wechat.toolSandbox } : {}),
          ...(wechat.allowAnyUser === undefined ? {} : { allowAnyUser: wechat.allowAnyUser }),
          allowedUserIds: wechat.allowedUserIds,
        },
      },
    });
  }
}

export function applyConfig(config: ResolvedCyreneConfig, explicitTarget?: "desktop" | "web", explicitDataDir?: string): { target: "desktop" | "web"; dataDir: string; summary: ConfigSummary } {
  const target = explicitTarget ?? (config.target === "auto" ? (explicitDataDir || config.dataDir || process.env.CYRENE_DATA_DIR ? "web" : "desktop") : config.target);
  const dataDir = path.resolve(explicitDataDir ?? config.dataDir ?? (target === "web" ? resolveWebDataDir() : resolveDesktopDataDir()));
  fs.mkdirSync(dataDir, { recursive: true });
  if (config.model) target === "web" ? applyModelWeb(dataDir, config.model) : applyModelDesktop(dataDir, config.model);
  if (config.wechat) applyWechat(dataDir, config.wechat, target);
  return { target, dataDir, summary: summarizeConfig({ ...config, target, dataDir }) };
}

export function summarizeConfig(config: ResolvedCyreneConfig): ConfigSummary {
  return {
    target: config.target,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    ...(config.model ? { model: { provider: config.model.provider, model: config.model.model, baseUrl: config.model.baseUrl, apiKeyConfigured: Boolean(config.model.apiKey), transport: config.model.explicitTransport } } : {}),
    ...(config.wechat ? { wechat: { enabled: config.wechat.enabled, credentialsConfigured: Boolean(config.wechat.credentials), ...(config.wechat.credentials ? { botId: config.wechat.credentials.ilinkBotId } : {}), allowedUserCount: config.wechat.allowedUserIds.length } } : {}),
  };
}

export function redactDocument(document: CyreneConfigFile): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const model = clone.model as Record<string, unknown> | undefined;
  if (model?.apiKey) model.apiKey = "<redacted>";
  const wechat = clone.wechat as Record<string, unknown> | undefined;
  const credentials = wechat?.credentials as Record<string, unknown> | undefined;
  if (credentials?.botToken) credentials.botToken = "<redacted>";
  return clone;
}

export function fileExists(filePath: string): boolean { return fs.existsSync(filePath); }
export function writeTemplate(filePath: string, target: ConfigTarget, force = false): void {
  const absolute = path.resolve(filePath);
  if (fileExists(absolute) && !force) throw new Error(`文件已存在：${absolute}；如需覆盖请添加 --force`);
  writeJson(absolute, createTemplate(target));
}
