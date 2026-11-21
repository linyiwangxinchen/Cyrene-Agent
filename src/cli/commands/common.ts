/**
 * Helpers shared by exec and resume: exit codes, connection flags, session
 * preparation and Ctrl+C handling.
 */
import path from "node:path";
import { IPC } from "../../shared/ipc-channels.js";
import type { ConnectOptions } from "../remote/connect.js";
import { AuthError, ConnectionError, CoreRequestError, type CoreTransport } from "../remote/transport.js";
import type { TurnStatus } from "../remote/turn.js";
import { boolFlag, stringFlag, UsageError, type FlagSpec, type ParsedFlags } from "../util/flags.js";
import { errLine } from "../util/log.js";

export const EXIT = {
  OK: 0,
  /** The turn ran but failed (model error, timeout) or could not start. */
  FAILED: 1,
  USAGE: 2,
  /** Not logged in, login expired, or the server/core is unreachable. */
  CONNECTION: 3,
  /** Cancelled with Ctrl+C (128 + SIGINT). */
  CANCELLED: 130,
} as const;

export const CONNECTION_FLAGS: FlagSpec = {
  server: "string",
  local: "boolean",
  "data-dir": "string",
  "app-root": "string",
  verbose: "boolean",
};

export type SessionMode = "chat" | "work" | "code";
const MODES = new Set<string>(["chat", "work", "code"]);

export function parseMode(value: string | undefined): SessionMode | undefined {
  if (value === undefined) return undefined;
  if (!MODES.has(value)) throw new UsageError("--mode 只能是 chat、work 或 code");
  return value as SessionMode;
}

export function connectOptions(parsed: ParsedFlags): ConnectOptions {
  const local = boolFlag(parsed, "local");
  if (local && stringFlag(parsed, "server")) throw new UsageError("--local 与 --server 不能同时使用");
  if (!local && (stringFlag(parsed, "data-dir") || stringFlag(parsed, "app-root"))) throw new UsageError("--data-dir / --app-root 只能与 --local 一起使用");
  return {
    server: stringFlag(parsed, "server"),
    local,
    dataDir: stringFlag(parsed, "data-dir"),
    appRoot: stringFlag(parsed, "app-root"),
    verbose: boolFlag(parsed, "verbose"),
  };
}

export function exitCodeFor(status: TurnStatus): number {
  if (status === "success") return EXIT.OK;
  if (status === "cancelled") return EXIT.CANCELLED;
  if (status === "disconnected") return EXIT.CONNECTION;
  return EXIT.FAILED;
}

/** Print an error once and map it to an exit code. */
export function reportError(command: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  errLine(`cyrene ${command}: ${message}`);
  if (error instanceof UsageError) return EXIT.USAGE;
  if (error instanceof AuthError || error instanceof ConnectionError) return EXIT.CONNECTION;
  return EXIT.FAILED;
}

export interface SessionSummary {
  id: string;
  title?: string;
  mode?: string;
  updatedAt?: number;
  messageCount?: number;
  workspaceRoot?: string;
}

interface SessionRecord extends SessionSummary {
  workspaceBinding?: { workspaceRoot?: string } | null;
  messages?: Array<{ role?: string; content?: unknown }>;
}

export interface PrepareSessionOptions {
  sessionId?: string;
  mode?: SessionMode;
  workspace?: string;
  modelProfile?: string;
  cwd?: string;
}

function isAbsoluteAnywhere(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

async function bindWorkspace(transport: CoreTransport, sessionId: string, workspace: string, cwd: string): Promise<void> {
  let root = workspace;
  if (transport.remote) {
    if (!isAbsoluteAnywhere(root)) throw new UsageError("连接远程服务器时 --workspace 必须是服务器上的绝对路径");
  } else {
    root = path.resolve(cwd, root);
  }
  const result = await transport.invoke<{ ok?: boolean; error?: string } | null>(IPC.CHATS_SET_WORKSPACE, { sessionId, workspaceRoot: root });
  if (!result || result.ok === false) throw new CoreRequestError(`工作区绑定失败：${result?.error ?? "未知错误"}（${root}）`);
}

async function applyModelProfile(transport: CoreTransport, sessionId: string, profileId: string): Promise<void> {
  const listed = await transport.invoke<{ profiles?: Array<{ id?: unknown }> } | null>(IPC.SETTINGS_MODEL_PROFILES_LIST);
  // Only ids are read; profile objects may contain API keys and are never printed.
  const ids = (listed?.profiles ?? []).map((profile) => profile.id).filter((id): id is string => typeof id === "string");
  if (!ids.includes(profileId)) {
    throw new UsageError(`模型档案不存在：${profileId}${ids.length ? `；可用档案：${ids.join(", ")}` : "；尚未配置任何模型档案"}`);
  }
  const updated = await transport.invoke(IPC.CHATS_SET_MODEL_PROFILE, { id: sessionId, modelProfileId: profileId });
  if (!updated) throw new CoreRequestError(`无法为会话设置模型档案：${profileId}`);
}

/**
 * Open an existing session or create one, then apply workspace and model
 * profile. A session created here is deleted again if preparation fails.
 */
export async function prepareSession(transport: CoreTransport, options: PrepareSessionOptions): Promise<{ id: string; mode: string; created: boolean }> {
  const cwd = options.cwd ?? process.cwd();
  let session: SessionRecord | null;
  let created = false;
  if (options.sessionId) {
    session = await transport.invoke<SessionRecord | null>(IPC.CHATS_GET, options.sessionId);
    if (!session?.id) throw new UsageError(`会话不存在：${options.sessionId}`);
    if (options.mode && session.mode && session.mode !== options.mode) {
      throw new UsageError(`会话 ${session.id} 是 ${session.mode} 模式，不能用 --mode ${options.mode} 继续`);
    }
  } else {
    session = await transport.invoke<SessionRecord | null>(IPC.CHATS_CREATE, { mode: options.mode ?? "chat" });
    if (!session?.id) throw new CoreRequestError("核心没有返回新会话");
    created = true;
  }
  const mode = session.mode ?? options.mode ?? "chat";
  try {
    const needsWorkspace = mode === "work" || mode === "code" || mode === "learn";
    if (options.workspace && !needsWorkspace) throw new UsageError(`${mode} 模式不绑定工作区，去掉 --workspace 或改用 --mode work/code`);
    const bound = session.workspaceBinding?.workspaceRoot ?? session.workspaceRoot;
    if (needsWorkspace && (options.workspace || !bound)) {
      if (!options.workspace && transport.remote) throw new UsageError(`${mode} 模式需要 --workspace <服务器上的项目目录>`);
      await bindWorkspace(transport, session.id, options.workspace ?? cwd, cwd);
    }
    if (options.modelProfile) await applyModelProfile(transport, session.id, options.modelProfile);
  } catch (error) {
    if (created) await transport.invoke(IPC.CHATS_DELETE, session.id).catch(() => {});
    throw error;
  }
  return { id: session.id, mode, created };
}

/**
 * Run `task` with Ctrl+C mapped to an AbortSignal. A second Ctrl+C while the
 * cancellation is still pending exits immediately.
 */
export async function withInterrupt<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) {
      errLine("cyrene: 再次收到 Ctrl+C，立即退出。");
      process.exit(EXIT.CANCELLED);
    }
    errLine("cyrene: 正在取消本轮…（再按一次 Ctrl+C 立即退出）");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    return await task(controller.signal);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export async function readAllStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}
