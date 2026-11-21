/**
 * Saved Web sessions at ~/.cyrene/credentials.json.
 *
 * Only the server-issued session token is stored, never the password. The
 * file is created with 0600 inside a 0700 directory; a file that has become
 * group/world readable is tightened on the next read. On Windows the POSIX
 * mode is advisory and the file relies on the user profile ACL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../util/flags.js";
import { errLine } from "../util/log.js";

export interface SavedSession {
  server: string;
  username: string;
  sessionToken: string;
  savedAt: string;
}

export interface CredentialsFile {
  version: 1;
  defaultServer?: string;
  sessions: Record<string, SavedSession>;
}

export const DEFAULT_SERVER = "http://127.0.0.1:4317";

export function credentialsPath(): string {
  const home = process.env.CYRENE_HOME ?? os.homedir();
  return path.join(home, ".cyrene", "credentials.json");
}

function emptyFile(): CredentialsFile {
  return { version: 1, sessions: {} };
}

function isSavedSession(value: unknown): value is SavedSession {
  const item = value as SavedSession;
  return Boolean(item) && typeof item.server === "string" && typeof item.username === "string"
    && typeof item.sessionToken === "string" && item.sessionToken.length > 0 && typeof item.savedAt === "string";
}

/** Read saved sessions. Missing or unreadable files behave as "not logged in". */
export function readCredentials(): CredentialsFile {
  const file = credentialsPath();
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { return emptyFile(); }
  if (process.platform !== "win32") {
    try {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077) {
        fs.chmodSync(file, 0o600);
        errLine(`cyrene: ${file} 的权限过宽（${mode.toString(8)}），已收紧为 600。`);
      }
    } catch { /* stat/chmod failures are not fatal for reading */ }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    const sessions: Record<string, SavedSession> = {};
    for (const [key, value] of Object.entries(parsed.sessions ?? {})) if (isSavedSession(value)) sessions[key] = value;
    return {
      version: 1,
      ...(typeof parsed.defaultServer === "string" ? { defaultServer: parsed.defaultServer } : {}),
      sessions,
    };
  } catch {
    errLine(`cyrene: ${file} 无法解析，已按未登录处理。`);
    return emptyFile();
  }
}

export function writeCredentials(value: CredentialsFile): void {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

export function findSession(server: string): SavedSession | undefined {
  return readCredentials().sessions[server];
}

export function saveSession(session: SavedSession, makeDefault = true): void {
  const current = readCredentials();
  current.sessions[session.server] = session;
  if (makeDefault) current.defaultServer = session.server;
  writeCredentials(current);
}

export function removeSession(server: string): boolean {
  const current = readCredentials();
  if (!current.sessions[server]) return false;
  delete current.sessions[server];
  if (current.defaultServer === server) delete current.defaultServer;
  writeCredentials(current);
  return true;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Normalize a server URL to its origin. Plain HTTP is accepted only for
 * loopback addresses, matching the server, which refuses password logins over
 * remote HTTP; the CLI refuses earlier so neither the password nor the
 * session cookie leaves the machine unencrypted.
 */
export function normalizeServer(input: string): string {
  let url: URL;
  try { url = new URL(input.includes("://") ? input : `http://${input}`); }
  catch { throw new UsageError(`无效的服务器地址：${input}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError("服务器地址必须使用 http:// 或 https://");
  if (url.username || url.password) throw new UsageError("不要把用户名或密码写进服务器地址；请使用 cyrene login 或环境变量");
  if (url.pathname !== "/" && url.pathname !== "") throw new UsageError("服务器地址只需要协议、主机和端口，例如 https://cyrene.example.com");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new UsageError(`远程服务器必须使用 HTTPS：${url.origin}（明文 HTTP 只允许本机回环地址）`);
  }
  return url.origin;
}

/** Server precedence: explicit flag, CYRENE_SERVER, last `cyrene login`, local default. */
export function resolveServer(flag: string | undefined): { server: string; explicit: boolean } {
  if (flag) return { server: normalizeServer(flag), explicit: true };
  if (process.env.CYRENE_SERVER) return { server: normalizeServer(process.env.CYRENE_SERVER), explicit: true };
  const saved = readCredentials().defaultServer;
  if (saved) return { server: normalizeServer(saved), explicit: true };
  return { server: DEFAULT_SERVER, explicit: false };
}
