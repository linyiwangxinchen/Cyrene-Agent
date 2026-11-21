/**
 * 用户 Hooks 运行器。
 *
 * - 配置只从组合根注入的本机文件路径读取；不存在时不启动任何进程（零开销）。
 * - 文件按 mtime/size 变化懒加载，至多每秒 stat 一次；损坏时记录日志并按无 Hook 处理。
 * - 同一事件的多条 Hook 按配置顺序串行执行：PreToolUse 改写后的参数交给下一条，
 *   任一条拒绝即停止；补充上下文按顺序拼接。
 * - 失败或超时默认放行（只记日志），PreToolUse 可按条配置 failClosed。
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";
import { emptyHooksConfig, parseHooksConfig, type HookCommandConfig, type HookEventName, type HooksConfig } from "./hook-config";
import { buildHookEnv, runHookProcess, type HookProcessInput, type HookProcessResult } from "./hook-process";

const LOG_TAG = "Hooks";
const STAT_TTL_MS = 1_000;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_REASON_CHARS = 2_000;
const MAX_RESULT_OUTPUT_CHARS = 100_000;

/** 运行所在宿主；渠道运行以渠道名覆盖。 */
export type HookHost = "desktop" | "web";

export interface HookRunContext {
  sessionId?: string;
  runId?: string;
  /** desktop / web / wechat / feishu / qq / qqbot */
  channel?: string;
  mode?: string;
  signal?: AbortSignal;
}

export interface PreToolUseOutcome {
  decision: "allow" | "deny";
  reason?: string;
  /** Hook 改写后的完整参数；未改写时缺省。 */
  updatedInput?: Record<string, unknown>;
}

export interface UserPromptSubmitOutcome {
  decision: "allow" | "deny";
  reason?: string;
  additionalContext?: string;
}

export interface HookRunnerOptions {
  configPath: string;
  host: HookHost;
  /** 测试注入：替换进程执行。 */
  runProcess?: (input: HookProcessInput) => Promise<HookProcessResult>;
  /** 测试注入：时钟。 */
  now?: () => number;
}

interface LoadedState {
  signature: string;
  config: HooksConfig | null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForCompare(value: string): string {
  const unified = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  return process.platform === "win32" || process.platform === "darwin" ? unified.toLowerCase() : unified;
}

export class HookRunner {
  readonly configPath: string;
  readonly host: HookHost;
  private readonly runProcess: (input: HookProcessInput) => Promise<HookProcessResult>;
  private readonly now: () => number;
  private state: LoadedState = { signature: "", config: null };
  private lastStatAt = Number.NEGATIVE_INFINITY;
  private readonly normalizedConfigPath: string;

  constructor(options: HookRunnerOptions) {
    this.configPath = path.resolve(options.configPath);
    this.host = options.host;
    this.runProcess = options.runProcess ?? runHookProcess;
    this.now = options.now ?? Date.now;
    this.normalizedConfigPath = normalizeForCompare(this.configPath);
  }

  /** 当前生效配置；文件不存在或损坏时为 null。 */
  getConfig(): HooksConfig | null {
    const now = this.now();
    if (now - this.lastStatAt < STAT_TTL_MS) return this.state.config;
    this.lastStatAt = now;
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(this.configPath, { throwIfNoEntry: false });
    } catch (error) {
      this.updateState("stat-error", null, () => logger.warn(LOG_TAG, `无法读取 Hooks 配置 ${this.configPath}:`, error));
      return this.state.config;
    }
    if (!stat) {
      if (this.state.signature !== "missing") this.state = { signature: "missing", config: null };
      return null;
    }
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (signature === this.state.signature) return this.state.config;
    try {
      const parsed = parseHooksConfig(fs.readFileSync(this.configPath, "utf8"));
      for (const warning of parsed.warnings) logger.warn(LOG_TAG, `hooks.json: ${warning}`);
      const total = Object.values(parsed.config).reduce((sum, list) => sum + list.length, 0);
      logger.info(LOG_TAG, `已加载 Hooks 配置 ${this.configPath}，共 ${total} 条`);
      this.state = { signature, config: total > 0 ? parsed.config : null };
    } catch (error) {
      logger.error(LOG_TAG, `Hooks 配置损坏，本次按无 Hook 处理：${this.configPath}:`, error instanceof Error ? error.message : error);
      this.state = { signature, config: null };
    }
    return this.state.config;
  }

  private updateState(signature: string, config: HooksConfig | null, log: () => void): void {
    if (this.state.signature !== signature) log();
    this.state = { signature, config };
  }

  /** 事件是否有可执行的 Hook；没有时调用方应跳过全部构造开销。 */
  hasHooks(event: HookEventName, toolName?: string): boolean {
    return this.matching(event, toolName).length > 0;
  }

  private matching(event: HookEventName, toolName?: string): HookCommandConfig[] {
    const config = this.getConfig();
    if (!config) return [];
    const entries = config[event] ?? emptyHooksConfig()[event];
    if (toolName === undefined) return entries;
    return entries.filter((entry) => {
      try { return entry.matcher ? entry.matcher(toolName) : true; } catch { return false; }
    });
  }

  /**
   * 工具参数是否指向 Hooks 配置文件本身。
   * 用于在派发层拒绝任何非只读工具修改或创建 hooks.json（无论当前是否已有配置）。
   */
  referencesConfigFile(args: Record<string, unknown>, workspaceRoot?: string): boolean {
    const target = this.normalizedConfigPath;
    const basename = path.basename(this.configPath);
    const visit = (value: unknown, key: string | undefined, depth: number): boolean => {
      if (depth > 6) return false;
      if (typeof value === "string") {
        const normalized = normalizeForCompare(value);
        if (normalized.includes(target)) return true;
        // 相对路径参数：按工作区解析后比较
        if (key && /path|file|target|dest|destination/i.test(key) && value.includes(basename)) {
          const resolved = normalizeForCompare(path.resolve(workspaceRoot ?? process.cwd(), value));
          if (resolved === target) return true;
        }
        return false;
      }
      if (Array.isArray(value)) return value.some((item) => visit(item, key, depth + 1));
      if (isPlainObject(value)) return Object.entries(value).some(([childKey, child]) => visit(child, childKey, depth + 1));
      return false;
    };
    return visit(args, undefined, 0);
  }

  private async execute(
    event: HookEventName,
    hook: HookCommandConfig,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; output: Record<string, unknown> } | { ok: false; error: string; aborted: boolean }> {
    const result = await this.runProcess({
      command: hook.command,
      args: hook.args,
      cwd: hook.cwd ?? path.dirname(this.configPath),
      env: buildHookEnv(process.env, hook.env, event),
      stdin: JSON.stringify(payload),
      timeoutMs: hook.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (!result.ok) {
      const detail = result.stderr ? `${result.message}；stderr: ${truncate(result.stderr, 500)}` : result.message;
      if (result.kind !== "aborted") logger.warn(LOG_TAG, `${event} Hook「${hook.name}」失败（${result.kind}）：${detail}`);
      return { ok: false, error: `${result.kind === "timeout" ? "超时" : "执行失败"}：${result.message}`, aborted: result.kind === "aborted" };
    }
    const text = result.stdout.trim();
    if (!text) return { ok: true, output: {} };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) throw new Error("stdout 必须是 JSON 对象");
      return { ok: true, output: parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(LOG_TAG, `${event} Hook「${hook.name}」输出不是有效 JSON：${message}`);
      return { ok: false, error: `输出不是有效 JSON：${message}`, aborted: false };
    }
  }

  private basePayload(event: HookEventName, context: HookRunContext): Record<string, unknown> {
    return {
      event,
      sessionId: context.sessionId ?? null,
      runId: context.runId ?? null,
      channel: context.channel ?? this.host,
      mode: context.mode ?? null,
    };
  }

  async runPreToolUse(
    context: HookRunContext & { toolName: string; toolInput: Record<string, unknown>; inputRedacted?: boolean },
  ): Promise<PreToolUseOutcome> {
    const hooks = this.matching("PreToolUse", context.toolName);
    if (hooks.length === 0) return { decision: "allow" };
    let current = context.toolInput;
    let rewritten = false;
    for (const hook of hooks) {
      if (context.signal?.aborted) return { decision: "deny", reason: "运行已取消" };
      const result = await this.execute("PreToolUse", hook, {
        ...this.basePayload("PreToolUse", context),
        toolName: context.toolName,
        toolInput: context.inputRedacted ? null : current,
        ...(context.inputRedacted ? { toolInputRedacted: true } : {}),
      }, context.signal);
      if (!result.ok) {
        if (result.aborted) return { decision: "deny", reason: "运行已取消" };
        if (hook.failClosed) {
          return { decision: "deny", reason: `Hook「${hook.name}」${result.error}（fail-closed）` };
        }
        continue;
      }
      const decision = result.output.decision;
      if (decision === "deny" || decision === "block") {
        const reason = typeof result.output.reason === "string" && result.output.reason.trim()
          ? truncate(result.output.reason.trim(), MAX_REASON_CHARS)
          : "未说明原因";
        logger.info(LOG_TAG, `PreToolUse Hook「${hook.name}」拒绝工具 ${context.toolName}：${reason}`);
        return { decision: "deny", reason };
      }
      if (result.output.updatedInput !== undefined) {
        if (context.inputRedacted) {
          logger.warn(LOG_TAG, `PreToolUse Hook「${hook.name}」试图改写敏感参数工具 ${context.toolName}，已忽略`);
        } else if (isPlainObject(result.output.updatedInput)) {
          current = result.output.updatedInput;
          rewritten = true;
        } else {
          logger.warn(LOG_TAG, `PreToolUse Hook「${hook.name}」的 updatedInput 不是对象，已忽略`);
          if (hook.failClosed) return { decision: "deny", reason: `Hook「${hook.name}」返回了无效的 updatedInput（fail-closed）` };
        }
      }
    }
    return rewritten ? { decision: "allow", updatedInput: current } : { decision: "allow" };
  }

  async runPostToolUse(
    context: HookRunContext & {
      toolName: string;
      toolInput: Record<string, unknown> | null;
      toolResult: { outcome: string; output: string | null };
    },
  ): Promise<string | undefined> {
    const hooks = this.matching("PostToolUse", context.toolName);
    if (hooks.length === 0) return undefined;
    const output = context.toolResult.output;
    return this.collectContext("PostToolUse", hooks, {
      ...this.basePayload("PostToolUse", context),
      toolName: context.toolName,
      toolInput: context.toolInput,
      toolResult: {
        outcome: context.toolResult.outcome,
        output: output === null ? null : truncate(output, MAX_RESULT_OUTPUT_CHARS),
      },
    }, context.signal);
  }

  async runUserPromptSubmit(context: HookRunContext & { prompt: string }): Promise<UserPromptSubmitOutcome> {
    const hooks = this.matching("UserPromptSubmit");
    if (hooks.length === 0) return { decision: "allow" };
    const contexts: string[] = [];
    const payload = { ...this.basePayload("UserPromptSubmit", context), prompt: context.prompt };
    for (const hook of hooks) {
      if (context.signal?.aborted) break;
      const result = await this.execute("UserPromptSubmit", hook, payload, context.signal);
      if (!result.ok) continue;
      const decision = result.output.decision;
      if (decision === "deny" || decision === "block") {
        const reason = typeof result.output.reason === "string" && result.output.reason.trim()
          ? truncate(result.output.reason.trim(), MAX_REASON_CHARS)
          : "未说明原因";
        logger.info(LOG_TAG, `UserPromptSubmit Hook「${hook.name}」拒绝本轮：${reason}`);
        return { decision: "deny", reason };
      }
      const extra = result.output.additionalContext;
      if (typeof extra === "string" && extra.trim()) contexts.push(truncate(extra.trim(), MAX_CONTEXT_CHARS));
    }
    return contexts.length ? { decision: "allow", additionalContext: contexts.join("\n\n") } : { decision: "allow" };
  }

  async runSessionStart(context: HookRunContext): Promise<string | undefined> {
    const hooks = this.matching("SessionStart");
    if (hooks.length === 0) return undefined;
    return this.collectContext("SessionStart", hooks, this.basePayload("SessionStart", context), context.signal);
  }

  /** 运行结束通知：结果不影响本轮，调用方应 fire-and-forget。 */
  async runStop(context: HookRunContext & { status: string; reason?: string }): Promise<void> {
    const hooks = this.matching("Stop");
    if (hooks.length === 0) return;
    const payload = {
      ...this.basePayload("Stop", context),
      status: context.status,
      ...(context.reason ? { reason: context.reason } : {}),
    };
    for (const hook of hooks) await this.execute("Stop", hook, payload);
  }

  private async collectContext(
    event: HookEventName,
    hooks: HookCommandConfig[],
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const contexts: string[] = [];
    for (const hook of hooks) {
      if (signal?.aborted) break;
      const result = await this.execute(event, hook, payload, signal);
      if (!result.ok) continue;
      const extra = result.output.additionalContext;
      if (typeof extra === "string" && extra.trim()) contexts.push(truncate(extra.trim(), MAX_CONTEXT_CHARS));
    }
    return contexts.length ? contexts.join("\n\n") : undefined;
  }
}

// ── 进程级单例：由两个组合根在启动时初始化 ──

let activeRunner: HookRunner | null = null;

export function initHooks(options: HookRunnerOptions): HookRunner {
  activeRunner = new HookRunner(options);
  // 启动时加载一次，让配置问题尽早出现在日志里
  activeRunner.getConfig();
  return activeRunner;
}

/** 未初始化（测试、早期装配）时返回 null，调用方按无 Hook 处理。 */
export function getHookRunner(): HookRunner | null {
  return activeRunner;
}

/** 仅测试使用。 */
export function __setHookRunnerForTest(runner: HookRunner | null): void {
  activeRunner = runner;
}
