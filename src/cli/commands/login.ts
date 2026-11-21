/**
 * cyrene login / logout — manage the saved Web session.
 *
 * The password comes from --password-stdin, CYRENE_PASSWORD or a hidden TTY
 * prompt; it is never a command-line argument (shell history, process list)
 * and is not written to disk. Only the server's session token is saved.
 */
import readline from "node:readline";
import { Writable } from "node:stream";
import { credentialsPath, findSession, normalizeServer, removeSession, resolveServer, saveSession } from "../remote/credentials.js";
import { loginWithPassword, logoutSession } from "../remote/web-client.js";
import { boolFlag, parseFlags, stringFlag, UsageError, type ParsedFlags } from "../util/flags.js";
import { outLine } from "../util/log.js";
import { EXIT, readAllStdin, reportError } from "./common.js";

const LOGIN_FLAGS = { server: "string", username: "string", "password-stdin": "boolean", help: "boolean" } as const;
const LOGOUT_FLAGS = { server: "string", help: "boolean" } as const;

export function loginHelp(): string {
  return `Usage: cyrene login [--server URL] [--username NAME] [--password-stdin]

Log in to a Cyrene Web service and save the session to ~/.cyrene/credentials.json (mode 600).
The password is read from --password-stdin, CYRENE_PASSWORD, or a hidden prompt.
Remote servers must use https://; plain http:// is accepted only for loopback addresses.

  cyrene logout [--server URL]   Revoke and forget the saved session`;
}

export interface LoginDeps {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}

async function ask(question: string, hidden: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.question(question, (answer) => { if (hidden) process.stderr.write("\n"); resolve(answer); });
      rl.on("SIGINT", () => { rl.close(); reject(new UsageError("已取消登录")); });
      muted = hidden;
    });
  } finally {
    rl.close();
  }
}

export async function cmdLogin(args: readonly string[], deps: LoginDeps = {}): Promise<number> {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args, LOGIN_FLAGS, { "-h": "--help" });
  } catch (error) {
    return reportError("login", error);
  }
  if (boolFlag(parsed, "help")) { outLine(loginHelp()); return EXIT.OK; }
  try {
    if (parsed.positionals.length) throw new UsageError("不要在命令行参数中传入密码；请使用 --password-stdin、CYRENE_PASSWORD 或交互输入");
    const { server } = resolveServer(stringFlag(parsed, "server"));
    const stdin = deps.stdin ?? process.stdin;
    const interactive = Boolean(stdin.isTTY);
    let username = stringFlag(parsed, "username") ?? process.env.CYRENE_USERNAME ?? findSession(server)?.username;
    if (!username) {
      if (!interactive) throw new UsageError("缺少用户名：请使用 --username 或设置 CYRENE_USERNAME");
      username = (await ask("用户名：", false)).trim();
    }
    let password: string | undefined;
    if (boolFlag(parsed, "password-stdin")) password = (await readAllStdin(stdin)).replace(/\r?\n$/, "");
    else if (process.env.CYRENE_PASSWORD) password = process.env.CYRENE_PASSWORD;
    else if (interactive) password = await ask("密码：", true);
    if (!username || !password) throw new UsageError("缺少密码：请使用 --password-stdin、CYRENE_PASSWORD 或在终端中交互输入");
    const token = await loginWithPassword(server, username, password);
    saveSession({ server, username, sessionToken: token, savedAt: new Date().toISOString() });
    outLine(`已登录 ${server}（用户 ${username}）。会话已保存到 ${credentialsPath()}`);
    return EXIT.OK;
  } catch (error) {
    return reportError("login", error);
  }
}

export async function cmdLogout(args: readonly string[]): Promise<number> {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args, LOGOUT_FLAGS, { "-h": "--help" });
  } catch (error) {
    return reportError("logout", error);
  }
  if (boolFlag(parsed, "help")) { outLine(loginHelp()); return EXIT.OK; }
  try {
    const flag = stringFlag(parsed, "server");
    const server = flag ? normalizeServer(flag) : resolveServer(undefined).server;
    const saved = findSession(server);
    if (!saved) { outLine(`没有保存 ${server} 的登录会话。`); return EXIT.OK; }
    await logoutSession(server, saved.sessionToken).catch(() => { /* still forget it locally */ });
    removeSession(server);
    outLine(`已退出 ${server}，本地会话已删除。`);
    return EXIT.OK;
  } catch (error) {
    return reportError("logout", error);
  }
}
