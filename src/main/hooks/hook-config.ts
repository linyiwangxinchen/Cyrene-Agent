/**
 * 用户 Hooks 配置：解析、校验与工具名匹配。
 *
 * 配置只来自本机文件（userData/hooks.json 或 Linux 数据目录下的 hooks.json），
 * 本模块是纯函数，不读写磁盘，便于两个组合根与测试共用。
 * 单条配置无效时只跳过该条并给出告警，其余条目照常生效。
 */

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"] as const;
export type HookEventName = typeof HOOK_EVENTS[number];

/** 默认单条 Hook 超时。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MIN_HOOK_TIMEOUT_MS = 100;
const MAX_HOOK_TIMEOUT_MS = 10 * 60_000;

export interface HookCommandConfig {
  /** 展示与日志用名称；未配置时用命令名。 */
  name: string;
  /** 可执行文件；不经过 shell。 */
  command: string;
  args: string[];
  cwd?: string;
  /** 额外环境变量（由用户在本机配置中显式写入）。 */
  env: Record<string, string>;
  timeoutMs: number;
  /** 仅 PreToolUse 生效：Hook 失败或超时时拒绝工具。 */
  failClosed: boolean;
  /** 工具名匹配器；仅 PreToolUse / PostToolUse 使用。 */
  matcher?: ToolNameMatcher;
  matcherSource: string;
}

export type HooksConfig = Record<HookEventName, HookCommandConfig[]>;

export interface ParsedHooksConfig {
  config: HooksConfig;
  warnings: string[];
}

export type ToolNameMatcher = (toolName: string) => boolean;

export function emptyHooksConfig(): HooksConfig {
  return { PreToolUse: [], PostToolUse: [], UserPromptSubmit: [], SessionStart: [], Stop: [] };
}

/**
 * 编译工具名匹配器：
 * - 缺省、空串或 "*"：匹配全部工具；
 * - "/pattern/flags"：正则；
 * - 其余：通配（`*` 任意字符、`?` 单个字符），`|` 分隔多个候选，整串匹配。
 */
export function compileToolMatcher(source: string | undefined): ToolNameMatcher {
  const raw = (source ?? "").trim();
  if (!raw || raw === "*") return () => true;
  const regexMatch = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  if (regexMatch) {
    // 去掉有状态的 g / y，避免 test() 结果随调用次数变化
    const flags = regexMatch[2].replace(/[gy]/g, "");
    const pattern = new RegExp(regexMatch[1], flags);
    return (toolName) => pattern.test(toolName);
  }
  const alternatives = raw.split("|").map((part) => part.trim()).filter(Boolean).map((glob) => {
    const escaped = glob.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  });
  return (toolName) => alternatives.some((pattern) => pattern.test(toolName));
}

function clampTimeout(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(MIN_HOOK_TIMEOUT_MS, Math.round(value)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 解析 hooks.json 文本。JSON 本身损坏时抛错，由调用方记录日志并按无 Hook 处理。 */
export function parseHooksConfig(text: string): ParsedHooksConfig {
  const root: unknown = JSON.parse(text);
  if (!isPlainObject(root)) throw new Error("hooks.json 顶层必须是对象");
  const warnings: string[] = [];
  const defaultTimeoutMs = clampTimeout(root.defaultTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
  const hooks = root.hooks;
  if (hooks !== undefined && !isPlainObject(hooks)) throw new Error("hooks 字段必须是对象");
  const config = emptyHooksConfig();
  for (const [eventName, entries] of Object.entries(hooks ?? {})) {
    if (!(HOOK_EVENTS as readonly string[]).includes(eventName)) {
      warnings.push(`未知事件 ${eventName}，已忽略`);
      continue;
    }
    const event = eventName as HookEventName;
    if (!Array.isArray(entries)) {
      warnings.push(`${event} 必须是数组，已忽略`);
      continue;
    }
    entries.forEach((entry, index) => {
      const label = `${event}[${index}]`;
      if (!isPlainObject(entry)) {
        warnings.push(`${label} 必须是对象，已忽略`);
        return;
      }
      if (typeof entry.command !== "string" || !entry.command.trim()) {
        warnings.push(`${label} 缺少 command，已忽略`);
        return;
      }
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string"))) {
        warnings.push(`${label} 的 args 必须是字符串数组，已忽略`);
        return;
      }
      if (entry.env !== undefined && (!isPlainObject(entry.env) || Object.values(entry.env).some((value) => typeof value !== "string"))) {
        warnings.push(`${label} 的 env 必须是字符串键值对，已忽略`);
        return;
      }
      if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
        warnings.push(`${label} 的 cwd 必须是字符串，已忽略`);
        return;
      }
      const matcherSource = typeof entry.matcher === "string" ? entry.matcher : "*";
      const toolEvent = event === "PreToolUse" || event === "PostToolUse";
      let matcher: ToolNameMatcher | undefined;
      if (toolEvent) {
        try {
          matcher = compileToolMatcher(matcherSource);
        } catch (error) {
          warnings.push(`${label} 的 matcher 无效（${error instanceof Error ? error.message : String(error)}），已忽略`);
          return;
        }
      }
      if (entry.failClosed === true && event !== "PreToolUse") {
        warnings.push(`${label} 的 failClosed 只对 PreToolUse 生效，已忽略该字段`);
      }
      config[event].push({
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.command.trim(),
        command: entry.command.trim(),
        args: (entry.args as string[] | undefined) ?? [],
        ...(typeof entry.cwd === "string" && entry.cwd.trim() ? { cwd: entry.cwd.trim() } : {}),
        env: { ...(entry.env as Record<string, string> | undefined) },
        timeoutMs: clampTimeout(entry.timeoutMs, defaultTimeoutMs),
        failClosed: event === "PreToolUse" && entry.failClosed === true,
        ...(matcher ? { matcher } : {}),
        matcherSource,
      });
    });
  }
  return { config, warnings };
}
