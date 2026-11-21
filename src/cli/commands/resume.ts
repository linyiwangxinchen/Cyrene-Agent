/**
 * cyrene resume — list recent sessions, or continue one.
 *
 *   cyrene resume                  list recent sessions
 *   cyrene resume <id>             interactive multi-turn chat (reads stdin line by line)
 *   cyrene resume --last           continue the most recently updated session
 *   cyrene resume <id> "提示"       one turn, same as exec --session <id>
 */
import readline from "node:readline";
import { IPC } from "../../shared/ipc-channels.js";
import { openTransport } from "../remote/connect.js";
import { processStreams, TextRenderer, type OutputStreams } from "../remote/render.js";
import type { CoreTransport } from "../remote/transport.js";
import { runTurn } from "../remote/turn.js";
import { boolFlag, parseFlags, stringFlag, UsageError, type ParsedFlags } from "../util/flags.js";
import { errLine, outLine } from "../util/log.js";
import { CONNECTION_FLAGS, connectOptions, EXIT, prepareSession, reportError, type SessionSummary } from "./common.js";
import { executeTurn } from "./exec.js";

const RESUME_FLAGS = {
  ...CONNECTION_FLAGS,
  last: "boolean",
  limit: "string",
  mode: "string",
  json: "boolean",
  reasoning: "boolean",
  help: "boolean",
} as const;

export function resumeHelp(): string {
  return `Usage: cyrene resume [options] [<session-id> [prompt]]

Without a session id, list recent sessions. With an id, continue that session:
interactively (one message per line, /exit or Ctrl+D to quit), or for a single
turn when a prompt is given.

Options:
  --last                 Continue the most recently updated session
  --limit N              Number of sessions to list (default: 10)
  --mode chat|work|code  Only list sessions of this mode
  --json                 JSON output (session list, or JSON events for a single turn)
  --reasoning            Also print reasoning text to stderr
  --server URL | --local [--data-dir DIR] [--app-root DIR] [--verbose]
                         Same connection options as cyrene exec`;
}

export interface ResumeDeps {
  io?: OutputStreams;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

async function listSessions(transport: CoreTransport, mode: string | undefined): Promise<SessionSummary[]> {
  const listed = await transport.invoke<SessionSummary[] | null>(IPC.CHATS_LIST, mode ? { mode } : undefined);
  return (Array.isArray(listed) ? listed : [])
    .filter((session) => typeof session?.id === "string")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function formatTime(value: number | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function printSessionList(sessions: SessionSummary[], io: OutputStreams): void {
  if (!sessions.length) {
    io.out("还没有会话。用 cyrene exec \"你好\" 开始第一段对话。\n");
    return;
  }
  for (const session of sessions) {
    const title = (session.title || "(未命名)").replace(/\s+/g, " ").slice(0, 60);
    io.out(`${session.id}  ${(session.mode ?? "-").padEnd(5)}  ${formatTime(session.updatedAt)}  ${title}\n`);
  }
  io.out("\n继续某个会话：cyrene resume <会话ID>\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  return "";
}

async function printRecentMessages(transport: CoreTransport, sessionId: string, io: OutputStreams): Promise<void> {
  const session = await transport.invoke<{ title?: string; messages?: Array<{ role?: string; content?: unknown }> } | null>(IPC.CHATS_GET, sessionId);
  const messages = (session?.messages ?? []).filter((message) => message.role === "user" || message.role === "model" || message.role === "assistant");
  io.err(`继续会话 ${sessionId}${session?.title ? `「${session.title}」` : ""}，输入 /exit 或 Ctrl+D 退出。\n`);
  for (const message of messages.slice(-4)) {
    const text = textOf(message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    io.err(`${message.role === "user" ? "你" : "昔涟"}：${text.length > 200 ? `${text.slice(0, 200)}…` : text}\n`);
  }
}

/** Interactive loop: one line per turn. Ctrl+C cancels the running turn; at the prompt it exits. */
async function interactive(transport: CoreTransport, sessionId: string, deps: ResumeDeps, reasoning: boolean): Promise<number> {
  const io = deps.io ?? processStreams;
  const input = deps.stdin ?? process.stdin;
  const tty = Boolean(input.isTTY);
  await printRecentMessages(transport, sessionId, io);
  const rl = readline.createInterface({ input, output: tty ? process.stdout : undefined, terminal: tty });
  let active: AbortController | undefined;
  const onSigint = () => {
    if (active) { errLine("cyrene: 正在取消本轮…"); active.abort(); return; }
    rl.close();
  };
  rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);
  const lines = rl[Symbol.asyncIterator]();
  try {
    // The iterator still yields lines buffered before stdin ended; rl.close() ends it.
    for (;;) {
      if (tty) { rl.setPrompt("你> "); rl.prompt(); }
      const next = await lines.next();
      if (next.done) break;
      const line = next.value.trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      active = new AbortController();
      const renderer = new TextRenderer(io, { reasoning });
      const result = await runTurn(transport, { sessionId, prompt: line, sink: renderer, signal: active.signal });
      active = undefined;
      renderer.end(result);
      if (result.status === "disconnected") return EXIT.CONNECTION;
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
  return EXIT.OK;
}

export async function cmdResume(args: readonly string[], deps: ResumeDeps = {}): Promise<number> {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args, RESUME_FLAGS, { "-h": "--help" });
  } catch (error) {
    return reportError("resume", error);
  }
  if (boolFlag(parsed, "help")) { outLine(resumeHelp()); return EXIT.OK; }
  const io = deps.io ?? processStreams;
  let transport: CoreTransport | undefined;
  try {
    const last = boolFlag(parsed, "last");
    // With --last every positional is prompt text; otherwise the first one is the session id.
    const explicitId = last ? undefined : parsed.positionals[0];
    const promptParts = last ? parsed.positionals : parsed.positionals.slice(1);
    const limitText = stringFlag(parsed, "limit");
    const limit = limitText === undefined ? 10 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError("--limit 必须是 1 到 200 之间的整数");
    const mode = stringFlag(parsed, "mode");
    if (mode && !["chat", "work", "code", "learn"].includes(mode)) throw new UsageError("--mode 只能是 chat、work、code 或 learn");
    transport = await openTransport(connectOptions(parsed));

    if (!explicitId && !last) {
      const sessions = (await listSessions(transport, mode)).slice(0, limit);
      if (boolFlag(parsed, "json")) io.out(`${JSON.stringify(sessions.map(({ id, title, mode: m, updatedAt, messageCount }) => ({ id, title, mode: m, updatedAt, messageCount })))}\n`);
      else printSessionList(sessions, io);
      return EXIT.OK;
    }

    let sessionId = explicitId;
    if (!sessionId) {
      sessionId = (await listSessions(transport, mode))[0]?.id;
      if (!sessionId) throw new UsageError("还没有可以继续的会话");
    }
    const session = await prepareSession(transport, { sessionId });
    const prompt = promptParts.join(" ").trim();
    if (prompt) return await executeTurn(transport, session, prompt, { json: boolFlag(parsed, "json"), reasoning: boolFlag(parsed, "reasoning"), io });
    if (boolFlag(parsed, "json")) throw new UsageError("交互模式不支持 --json；单轮请使用 cyrene resume <id> \"提示\" --json");
    return await interactive(transport, session.id, deps, boolFlag(parsed, "reasoning"));
  } catch (error) {
    return reportError("resume", error);
  } finally {
    await transport?.close().catch(() => {});
  }
}
