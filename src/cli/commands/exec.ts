/**
 * cyrene exec "提示" — run one turn non-interactively and stream the reply.
 */
import { openTransport } from "../remote/connect.js";
import { JsonRenderer, processStreams, TextRenderer, type OutputStreams, type TurnRenderer } from "../remote/render.js";
import type { CoreTransport } from "../remote/transport.js";
import { runTurn } from "../remote/turn.js";
import { boolFlag, parseFlags, stringFlag, UsageError, type ParsedFlags } from "../util/flags.js";
import { errLine, outLine } from "../util/log.js";
import {
  CONNECTION_FLAGS, connectOptions, EXIT, exitCodeFor, parseMode, prepareSession, readAllStdin, reportError, withInterrupt,
} from "./common.js";

const EXEC_FLAGS = {
  ...CONNECTION_FLAGS,
  mode: "string",
  session: "string",
  new: "boolean",
  workspace: "string",
  "model-profile": "string",
  json: "boolean",
  reasoning: "boolean",
  help: "boolean",
} as const;

export function execHelp(): string {
  return `Usage: cyrene exec [options] [--] <prompt>
       echo "prompt" | cyrene exec [options] -

Run one turn and stream Cyrene's reply to stdout.

Options:
  --mode chat|work|code      Mode for a new session (default: chat)
  --session ID               Continue an existing session
  --new                      Start a new session (default)
  --workspace DIR            Project directory for work/code sessions
                             (default: current directory; required for remote servers)
  --model-profile ID         Use this model profile for the session
  --json                     Print one JSON event per line
  --reasoning                Also print reasoning text to stderr
  --server URL               Web service (default: CYRENE_SERVER, last login, http://127.0.0.1:4317)
  --local                    Start the headless core directly instead of using a server
  --data-dir DIR             Data directory for --local
  --app-root DIR             Directory containing dist/headless/core.cjs for --local
  --verbose                  Show the local core's logs

Credentials: run \`cyrene login\` first, or set CYRENE_USERNAME and CYRENE_PASSWORD.
Exit codes: 0 success, 1 turn failed, 2 usage error, 3 login/connection error, 130 cancelled.`;
}

export interface ExecDeps {
  io?: OutputStreams;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd?: string;
}

async function resolvePrompt(parsed: ParsedFlags, stdin: ExecDeps["stdin"]): Promise<string> {
  const joined = parsed.positionals.join(" ").trim();
  const input = stdin ?? process.stdin;
  if (joined === "-" || (!joined && !input.isTTY)) return (await readAllStdin(input)).trim();
  return joined;
}

/** Run a single prepared turn and print the result record. Shared with `resume <id> <prompt>`. */
export async function executeTurn(
  transport: CoreTransport,
  session: { id: string; mode: string; created: boolean },
  prompt: string,
  options: { json: boolean; reasoning: boolean; io: OutputStreams },
): Promise<number> {
  const renderer: TurnRenderer = options.json ? new JsonRenderer(options.io) : new TextRenderer(options.io, { reasoning: options.reasoning });
  if (renderer instanceof JsonRenderer) renderer.line({ type: "session", sessionId: session.id, mode: session.mode, created: session.created, target: transport.description });
  const result = await withInterrupt((signal) => runTurn(transport, { sessionId: session.id, prompt, sink: renderer, signal }));
  renderer.end(result);
  const exitCode = exitCodeFor(result.status);
  if (renderer instanceof JsonRenderer) {
    renderer.line({ type: "result", status: result.status, sessionId: session.id, runId: result.runId ?? null, text: result.text, ...(result.error ? { error: result.error } : {}), exitCode });
  } else {
    options.io.err(`会话：${session.id}（继续：cyrene resume ${session.id}）\n`);
  }
  return exitCode;
}

export async function cmdExec(args: readonly string[], deps: ExecDeps = {}): Promise<number> {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args, EXEC_FLAGS, { "-h": "--help" });
  } catch (error) {
    return reportError("exec", error);
  }
  if (boolFlag(parsed, "help")) { outLine(execHelp()); return EXIT.OK; }
  const io = deps.io ?? processStreams;
  let transport: CoreTransport | undefined;
  try {
    const sessionId = stringFlag(parsed, "session");
    if (sessionId && boolFlag(parsed, "new")) throw new UsageError("--session 与 --new 不能同时使用");
    const mode = parseMode(stringFlag(parsed, "mode"));
    const connection = connectOptions(parsed);
    const prompt = await resolvePrompt(parsed, deps.stdin);
    if (!prompt) throw new UsageError("缺少提示内容；用法：cyrene exec \"提示\"，或通过 stdin 传入");
    transport = await openTransport(connection);
    const session = await prepareSession(transport, {
      sessionId, mode, workspace: stringFlag(parsed, "workspace"), modelProfile: stringFlag(parsed, "model-profile"), cwd: deps.cwd,
    });
    return await executeTurn(transport, session, prompt, { json: boolFlag(parsed, "json"), reasoning: boolFlag(parsed, "reasoning"), io });
  } catch (error) {
    const code = reportError("exec", error);
    if (boolFlag(parsed, "json")) io.out(`${JSON.stringify({ type: "result", status: "error", error: error instanceof Error ? error.message : String(error), exitCode: code })}\n`);
    return code;
  } finally {
    await transport?.close().catch((error) => errLine(`cyrene exec: 关闭连接失败：${error instanceof Error ? error.message : String(error)}`));
  }
}
