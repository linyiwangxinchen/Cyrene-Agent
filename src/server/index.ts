import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { AuthStore, hashSessionToken } from "./auth-store";
import type { AuthStatus } from "./auth-types";
import { WebStore } from "./web-store";
import { WebFeatureStore } from "./web-feature-store";
import type { ChatMessage, ConversationMode } from "../shared/chat-types";
import { EMPTY_BROWSER_PANEL_STATE, type BrowserPanelState } from "../shared/browser-panel-types";
import { emptyCodeGitStatus, type CodeGitStatus } from "../shared/code-git-types";
import { WebChannelRuntime } from "./web-channel-runtime";
import type { OutgoingMessage } from "../main/channels/types";
import { WebMediaStore } from "./web-media-store";
import { modelConfig, modelError, requestSessionModel, resolveWebModel, testModel, testVisionModel } from "./web-model-service";
import { getAdapterForConfig } from "../main/orchestrator/vendors";
import { normalizeReasoningPreference } from "../shared/reasoning";
import { resolveVendorRuntimeSettings } from "../main/orchestrator/vendors/runtime-settings";
import { WebPersonaRuntime } from "./web-persona-runtime";
import { SharedCoreClient } from "./shared-core-client";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IPC } from "../shared/ipc-channels";
import { reviveWebBinary } from "./web-binary";
import { receiveMomentImage, removeMomentUploads, resolveMomentUploads } from "./moment-uploads";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = "cyrene_session";
const execFileAsync = promisify(execFile);

export interface WebServerOptions {
  /** Legacy transport exists only for migration regression fixtures. Production uses the shared core. */
  sharedCore?: boolean;
  host?: string;
  port?: number;
  dataDir?: string;
  /** 生产环境应保持 true；本地 HTTP 开发或接口测试可显式设为 false。 */
  secureCookies?: boolean;
  /** 首次初始化令牌；未提供时由服务启动时随机生成并打印一次。 */
  setupToken?: string;
  /** Built Vite output root, usually dist/renderer. Omit to disable static serving. */
  staticRoot?: string;
  /** Original shared prompt assets; defaults to the repository's shipped prompts. */
  promptRoot?: string;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface WebServerHandle {
  server: Server;
  auth: AuthStore;
  /** Only for the local startup process; never sent over HTTP. */
  initialSetupToken: string;
  startChannels(): Promise<void>;
  close(): Promise<void>;
}

function defaultDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return process.env.CYRENE_DATA_DIR || path.join(dataHome, "cyrene-agent");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const raw = headerValue(request.headers.cookie) || "";
  const result: Record<string, string> = {};
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function writeJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function writeNoContent(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(204, headers);
  response.end();
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error("REQUEST_TOO_LARGE");

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON_OBJECT_REQUIRED");
  return parsed as Record<string, unknown>;
}

function validCredentials(payload: Record<string, unknown>): payload is { username: string; password: string } {
  return typeof payload.username === "string" && typeof payload.password === "string";
}

function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

async function serveStatic(
  response: ServerResponse,
  requestPath: string,
  staticRoot: string | undefined,
): Promise<boolean> {
  if (!staticRoot) return false;
  const root = path.resolve(staticRoot);
  const entry = path.join(root, "web", "index.html");
  let relative = requestPath === "/" || requestPath === "/web" || requestPath === "/web/"
    ? path.join("web", "index.html")
    : requestPath.replace(/^\/+/, "");
  try {
    relative = decodeURIComponent(relative);
  } catch {
    return false;
  }
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return false;

  let filePath = candidate;
  try {
    if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    if (path.extname(relative)) { writeJson(response, 404, { error: "ASSET_NOT_FOUND" }); return true; }
    filePath = entry;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": filePath === entry || !/[.-][a-zA-Z0-9_-]{8,}\.[^.]+$/.test(path.basename(filePath)) ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(body);
    return true;
  } catch {
    if (path.extname(relative)) { writeJson(response, 404, { error: "ASSET_NOT_FOUND" }); return true; }
    if (filePath === entry) return false;
    try {
      const body = await readFile(entry);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      response.end(body);
      return true;
    } catch {
      return false;
    }
  }
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function authStatus(auth: AuthStore, request: IncomingMessage): Promise<AuthStatus> {
  const session = auth.getSession(parseCookies(request)[SESSION_COOKIE]);
  return auth.isInitialized().then((initialized) => ({
    initialized,
    authenticated: session !== null,
    ...(session ? { username: session.username } : {}),
  }));
}

function routeParts(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  return rest ? rest.split("/").map((part) => decodeURIComponent(part)) : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function modeValue(value: unknown): ConversationMode {
  return value === "chat" || value === "work" || value === "code" || value === "learn" ? value : "work";
}

async function runGit(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd: root, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
}

async function collectTextFiles(root: string, limit = 1000): Promise<Array<{ path: string; size: number }>> {
  const result: Array<{ path: string; size: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    if (result.length >= limit) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.length >= limit || entry.name.startsWith(".")) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(candidate); continue; }
      if (!entry.isFile() || !/\.(txt|md|mdx|json|ya?ml|toml|ini|cfg|conf|js|jsx|ts|tsx|py|sh|bash|html|css|csv)$/i.test(entry.name)) continue;
      const info = await stat(candidate).catch(() => null); if (info) result.push({ path: candidate, size: info.size });
    }
  };
  await visit(path.resolve(root));
  return result;
}

async function gitStatus(sessionId: string, root: string): Promise<CodeGitStatus> {
  try {
    const [{ stdout: version }, { stdout: porcelain }, { stdout: branches }] = await Promise.all([
      runGit(root, ["--version"]), runGit(root, ["status", "--porcelain=v1", "-b"]), runGit(root, ["branch", "--format=%(refname:short)"]),
    ]);
    const lines = porcelain.split(/\r?\n/).filter(Boolean);
    const header = lines.shift() ?? "";
    const branchMatch = /^##\s+(.+?)(?:\.\.\.(.*))?$/.exec(header);
    const currentRaw = branchMatch?.[1]?.trim() ?? "";
    const detached = currentRaw.startsWith("HEAD (detached");
    const current = detached || !currentRaw ? null : currentRaw;
    const files = lines.map((line) => {
      const x = line[0] ?? " "; const y = line[1] ?? " "; const raw = line.slice(3);
      const renamed = raw.includes(" -> ") ? raw.split(" -> ").map((value) => value.trim()) : [raw];
      const kind = x === "?" || y === "?" ? "added" : x === "D" || y === "D" ? "deleted" : x === "R" || y === "R" ? "renamed" : "modified";
      return { path: renamed[renamed.length - 1], ...(renamed.length > 1 ? { fromPath: renamed[0] } : {}), kind, staged: x !== " " && x !== "?", unstaged: y !== " " && y !== "?", insertions: 0, deletions: 0 } as const;
    });
    const summary = { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 };
    for (const file of files) summary[file.kind] += 1;
    let ahead = 0; let behind = 0;
    if (branchMatch?.[2]) {
      const counts = await runGit(root, ["rev-list", "--left-right", "--count", `${current}...${branchMatch[2].trim()}`]).catch(() => ({ stdout: "", stderr: "" }));
      const values = counts.stdout.trim().split(/\s+/).map(Number); ahead = Number.isFinite(values[0]) ? values[0] : 0; behind = Number.isFinite(values[1]) ? values[1] : 0;
    }
    return { sessionId, state: "ready", executable: { source: "system", version: version.trim() }, branch: { current, detached, branches: branches.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), tracking: branchMatch?.[2]?.trim() ?? null }, files: [...files], summary, lines: { insertions: 0, deletions: 0 }, ahead, behind };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git 状态读取失败";
    return emptyCodeGitStatus(sessionId, /not a git repository/i.test(message) ? "not_repository" : "git_unavailable", message);
  }
}

export function createWebServer(options: WebServerOptions = {}): WebServerHandle {
  const logger = options.logger ?? console;
  const dataDir = options.dataDir ?? defaultDataDir();
  const auth = new AuthStore(dataDir);
  const store = new WebStore(dataDir);
  const features = new WebFeatureStore(dataDir);
  const persona = new WebPersonaRuntime(dataDir, { features, promptRoot: options.promptRoot });
  const media = new WebMediaStore(dataDir);
  const secureCookies = options.secureCookies ?? process.env.CYRENE_SECURE_COOKIES !== "0";
  const setupToken = options.setupToken ?? process.env.CYRENE_SETUP_TOKEN ?? randomSetupToken();
  const sockets = new Set<WebSocket>();
  let nextClientId = 1;
  const socketClients = new Map<WebSocket, { id: number; token: string; sessionToken: string }>();
  const core = options.sharedCore === false ? null : new SharedCoreClient(dataDir, process.env.CYRENE_APP_ROOT || path.resolve(__dirname, "..", "..", ".."), logger);
  const running = new Map<string, { cancelled: boolean; sessionId: string; assistantId: string; controller: AbortController }>();
  const browserStates = new Map<string, BrowserPanelState>();
  const websocketServer = new WebSocketServer({ noServer: true });
  const broadcast = (event: unknown): void => {
    const encoded = JSON.stringify(event);
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(encoded);
  };
  core?.on("event", (event) => {
    const encoded = JSON.stringify({ type: "CORE_EVENT", channel: event.channel, args: event.args });
    for (const [socket, client] of socketClients) {
      if (!auth.getSession(client.sessionToken)) { socket.close(1008, "session expired"); continue; }
      if ((!event.clientId || event.clientId === client.id) && socket.readyState === socket.OPEN) socket.send(encoded);
    }
  });
  store.onChanged((section) => {
    if (section === "sessions") broadcast({ type: "CHAT_SESSIONS_CHANGED" });
    if (section === "sidebar") broadcast({ type: "SIDEBAR_CHANGED" });
  });
  const channels = new WebChannelRuntime(dataDir, {
    channels: {},
    getChannels: () => features.getChannelsRaw(),
    patchChannels: (patch) => features.patchChannels(patch),
  });
  channels.setEventHandler((event) => broadcast(event));
  channels.setMessageHandler(async (message) => {
    const externalSessionId = await channels.rememberIncoming(message);
    let conversationId = await channels.resolveContext(externalSessionId);
    if (!conversationId || !await store.get(conversationId)) {
      const created = await store.create({ identityId: null, mode: message.channel === "feishu" ? "work" : "chat", title: `${message.channel} · ${message.senderName || message.chatId}` });
      conversationId = created.id;
      await channels.bindContext(externalSessionId, conversationId, async (id) => Boolean(await store.get(id)));
    }
    const userMessageId = `channel-${Date.now()}-${randomBytes(6).toString("hex")}`;
    await store.patchMessage(conversationId, userMessageId, {
      role: "user",
      content: message.text,
      at: message.at.getTime(),
      modelContext: message.text,
      channelSource: { channel: message.channel, chatType: message.chatType ?? "private", senderName: message.senderName },
    } as never);
    let text: string;
    try { text = (await requestSessionModel(store, conversationId, message.text, { persona, channel: message.channel })).text; }
    catch (error) { text = `模型请求失败：${modelError(error)}`; }
    await store.addAssistantMessage(conversationId, { id: `channel-${Date.now()}-${randomBytes(6).toString("hex")}`, role: "model", content: text, at: Date.now() });
    const outgoing: OutgoingMessage = { channel: message.channel, chatType: message.chatType, targetId: message.chatId, threadId: message.threadId, parts: [{ kind: "text", text }] };
    await channels.rememberOutgoing(outgoing);
    broadcast({ type: "CHANNEL_MESSAGE", direction: "incoming", sessionId: externalSessionId, conversationId, message: message.text, channel: message.channel });
    return outgoing;
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://cyrene.local");
      const method = request.method || "GET";
      const origin = headerValue(request.headers.origin);
      if (origin && new URL(origin).host !== request.headers.host) { writeJson(response, 403, { error: "ORIGIN_FORBIDDEN" }); return; }
      const cookies = parseCookies(request);
      const session = auth.getSession(cookies[SESSION_COOKIE]);

      if (method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true, service: "cyrene-web", initialized: await auth.isInitialized() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/auth/status") {
        writeJson(response, 200, await authStatus(auth, request));
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/bootstrap") {
        if (await auth.isInitialized()) {
          writeJson(response, 409, { ok: false, error: "ALREADY_INITIALIZED" });
          return;
        }
        if (!sameSecret(headerValue(request.headers["x-cyrene-setup-token"]), setupToken)) {
          writeJson(response, 403, { ok: false, error: "SETUP_TOKEN_REQUIRED" });
          return;
        }
        const payload = await readJson(request);
        if (!validCredentials(payload)) {
          writeJson(response, 400, { ok: false, error: "CREDENTIALS_REQUIRED" });
          return;
        }
        try {
          await auth.bootstrap(payload.username, payload.password);
        } catch (error) {
          const code = error instanceof Error ? error.message : "BOOTSTRAP_FAILED";
          const status = code === "ALREADY_INITIALIZED" ? 409 : 400;
          writeJson(response, status, { ok: false, error: code });
          return;
        }
        writeJson(response, 201, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/login") {
        const payload = await readJson(request);
        if (!validCredentials(payload) || !(await auth.verify(payload.username, payload.password))) {
          writeJson(response, 401, { ok: false, error: "INVALID_CREDENTIALS" });
          return;
        }
        const created = auth.createSession(payload.username);
        logger.info(`[web-auth] login username=${payload.username} session=${hashSessionToken(created.token)}`);
        writeJson(response, 200, { ok: true, username: created.username }, { "Set-Cookie": sessionCookie(created.token, secureCookies) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/auth/logout") {
        auth.revokeSession(cookies[SESSION_COOKIE]);
        for (const [socket, client] of socketClients) if (client.sessionToken === cookies[SESSION_COOKIE]) socket.close(1008, "logged out");
        writeNoContent(response, { "Set-Cookie": clearSessionCookie(secureCookies) });
        return;
      }

      if (method === "GET" && url.pathname === "/api/auth/me") {
        if (!session) {
          writeJson(response, 401, { ok: false, error: "UNAUTHENTICATED" });
          return;
        }
        writeJson(response, 200, { ok: true, username: session.username });
        return;
      }

      if (method === "GET" && !url.pathname.startsWith("/api/") && await serveStatic(response, url.pathname, options.staticRoot)) {
        return;
      }

      if (!session) {
        writeJson(response, 401, { ok: false, error: "UNAUTHENTICATED" });
        return;
      }

      if (core && method === "GET" && url.pathname === "/api/core/files") {
        const directory = await realpath(url.searchParams.get("path") || dataDir);
        if (!(await stat(directory)).isDirectory()) throw new Error("请选择目录路径");
        const entries = await readdir(directory, { withFileTypes: true });
        writeJson(response, 200, { path: directory, entries: [{ name: "..", path: path.dirname(directory), directory: true }, ...entries.filter(entry => !entry.isSymbolicLink()).map(entry => ({ name: entry.name, path: path.join(directory, entry.name), directory: entry.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))] }); return;
      }
      if (core && method === "GET" && url.pathname === "/api/core/file") {
        const file = await realpath(url.searchParams.get("path") || "");
        if (!(await stat(file)).isFile()) throw new Error("请选择文件");
        const size = (await stat(file)).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(headerValue(request.headers.range) || "");
        let start = 0, end = size - 1;
        if (range) { start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])); end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end; }
        if (range && (start > end || start >= size)) { response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return; }
        response.writeHead(range ? 206 : 200, { "Content-Type": contentType(file), "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Accept-Ranges": "bytes", "Content-Length": String(Math.max(0, end - start + 1)), ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
        await pipeline(createReadStream(file, size ? { start, end } : {}), response); return;
      }
      if (core && method === "GET" && url.pathname === "/api/core/audio") {
        const uri = await core.request(0, "invoke", { channel: "web:audio-source", args: [url.searchParams.get("id")] });
        if (typeof uri !== "string") { response.writeHead(404); response.end(); return; }
        if (!/^https?:\/\//.test(uri)) { response.writeHead(302, { Location: `/api/core/file?path=${encodeURIComponent(uri)}` }); response.end(); return; }
        const abort = new AbortController(); response.on("close", () => abort.abort());
        const upstream = await fetch(uri, { signal: abort.signal, headers: { ...(request.headers.range ? { Range: String(request.headers.range) } : {}) } });
        const headers: Record<string, string> = { "Cache-Control": "no-store" };
        for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) if (upstream.headers.has(key)) headers[key] = upstream.headers.get(key)!;
        response.writeHead(upstream.status, headers);
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), response); else response.end(); return;
      }
      if (core && method === "POST" && url.pathname === "/api/core/moment-image") {
        writeJson(response, 200, { id: await receiveMomentImage(dataDir, request) }); return;
      }
      if (core && method === "POST" && url.pathname === "/api/core/moment-image/cleanup") {
        const input = await readJson(request);
        if (!Array.isArray(input.ids)) throw new Error("INVALID_MOMENT_UPLOAD");
        await removeMomentUploads(dataDir, input.ids); writeJson(response, 200, { ok: true }); return;
      }
      if (core && method === "POST" && url.pathname === "/api/core/upload") {
        const input = await readJson(request, 18 * 1024 * 1024);
        const name = path.basename(stringValue(input.name)).replace(/[^\p{L}\p{N}_.-]/gu, "_");
        const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(stringValue(input.dataUrl));
        if (!match || !name || name === "." || name === "..") throw new Error("INVALID_UPLOAD");
        const buffer = Buffer.from(match[2], "base64"); if (buffer.length > 12 * 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
        const directory = path.join(dataDir, "uploads"); await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${randomBytes(12).toString("hex")}-${name}`);
        await writeFile(file, buffer, { flag: "wx", mode: 0o600 }); writeJson(response, 200, { path: file }); return;
      }
      if (core && method === "GET" && url.pathname === "/api/core/resource") {
        if (!/^(?:local-sticker|moment-media):/.test(url.searchParams.get("url") || "")) { writeJson(response, 403, { error: "RESOURCE_SCHEME_FORBIDDEN" }); return; }
        const resource = await core.request(0, "resource", { url: url.searchParams.get("url") });
        response.writeHead(resource.status, { "Content-Type": resource.contentType || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }); response.end(Buffer.from(resource.base64, "base64")); return;
      }
      if (core && method === "GET" && url.pathname.startsWith("/api/plugin-panel/")) {
        const relative = url.pathname.slice("/api/plugin-panel/".length);
        const resource = await core.request(0, "resource", { url: `cyrene-plugin://${relative}` });
        let body = Buffer.from(resource.base64, "base64");
        if (resource.contentType?.includes("text/html")) body = Buffer.from(body.toString("utf8").replace(/(["'])\/\.cyrene\//g, `$1/api/plugin-panel/${relative.split("/")[0]}/.cyrene/`));
        response.writeHead(resource.status, { "Content-Type": resource.contentType || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox allow-scripts; default-src 'self' data:; connect-src 'none'; style-src 'self' 'unsafe-inline'" }); response.end(body); return;
      }
      if (core && url.pathname.startsWith("/api/core/")) {
        if (method !== "POST") { writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
        const clientToken = headerValue(request.headers["x-cyrene-client"]);
        const client = [...socketClients.values()].find(item => item.token === clientToken && item.sessionToken === cookies[SESSION_COOKIE]);
        if (!client) { writeJson(response, 409, { error: "REALTIME_CLIENT_REQUIRED" }); return; }
        const input = await readJson(request, 16 * 1024 * 1024);
        const operation = url.pathname.slice("/api/core/".length);
        if (!["invoke", "send", "capabilities", "dialog"].includes(operation)) { writeJson(response, 404, { error: "CORE_OPERATION_NOT_FOUND" }); return; }
        if ((operation === "invoke" || operation === "send") && (typeof input.channel !== "string" || !Array.isArray(input.args))) throw new Error("INVALID_CORE_REQUEST");
        // Desktop control and deferred subsystems cannot be activated by a remote client.
        if (typeof input.channel === "string" && /^(?:window:|live2d:|app:quit|screenshot:|gmail:)/.test(input.channel)) throw new Error("DESKTOP_OR_DEFERRED_API");
        const restored = reviveWebBinary(input);
        if (restored.channel === IPC.MOMENTS_CREATE_POST) restored.args = await resolveMomentUploads(dataDir, restored.args);
        writeJson(response, 200, await core.request(client.id, operation, restored)); return;
      }

      if (core) { writeJson(response, 410, { error: "LEGACY_WEB_API_RETIRED", message: "请使用共享核心接口 /api/core/invoke" }); return; }
      await store.load();
      await features.load();

      if (method === "POST" && url.pathname === "/api/models/test") { const input = await readJson(request); const settings = await store.getSettings(); writeJson(response, 200, await testModel(input, Number(settings.timeout.testTimeout) || 30_000)); return; }
      if (method === "POST" && url.pathname === "/api/models/test-vision") { const input = await readJson(request); const settings = await store.getSettings(); writeJson(response, 200, await testVisionModel(input, Number(settings.timeout.testTimeout) || 30_000)); return; }
      if (method === "POST" && url.pathname === "/api/models/preview") { const config = modelConfig(await readJson(request)); const built = getAdapterForConfig(config).buildRequest({ model: config.model, messages: [{ role: "user", content: "Hello" }], stream: false }, config); writeJson(response, 200, JSON.parse(built.body)); return; }
      if (method === "POST" && url.pathname === "/api/models/reasoning") {
        const input = await readJson(request); const { settings, profile, config } = await resolveWebModel(store, { sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined, modelProfileId: typeof input.modelProfileId === "string" ? input.modelProfileId : undefined, model: typeof input.model === "string" ? input.model : undefined });
        const runtime = resolveVendorRuntimeSettings({ ...settings.config, provider: config.provider });
        writeJson(response, 200, { providerKey: config.provider, providerId: getAdapterForConfig(config).id, model: config.model, preference: config.reasoning, manualReasoning: config.manualReasoning, transport: config.explicitTransport, modelProfileId: profile.id, thinkingOverride: runtime.thinkingOverride }); return;
      }
      if (method === "PATCH" && url.pathname === "/api/models/reasoning") {
        const input = await readJson(request); const { settings, profile, config } = await resolveWebModel(store, { sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined, modelProfileId: typeof input.modelProfileId === "string" ? input.modelProfileId : undefined });
        const reasoning = normalizeReasoningPreference(input.preference); if (!reasoning || config.provider !== input.providerKey) throw new Error("推理设置或模型档案无效");
        await store.setModelProfiles(settings.modelProfiles.map(item => item.id === profile.id ? { ...item, reasoning } : item), settings.defaultModelProfileId); writeJson(response, 200, { ok: true }); broadcast({ type: "SETTINGS_CHANGED" }); return;
      }
      if (method === "GET" && url.pathname === "/api/stickers") { writeJson(response, 200, await media.list()); return; }
      if (method === "GET" && url.pathname === "/api/stickers/enabled") { writeJson(response, 200, (await media.list()).filter(item => item.enabled)); return; }
      if (method === "POST" && url.pathname === "/api/stickers") { const input = await readJson(request, 12 * 1024 * 1024); writeJson(response, 200, await media.add({ id: stringValue(input.id), description: stringValue(input.description), phrases: Array.isArray(input.phrases) ? input.phrases.map(String) : [], dataUrl: stringValue(input.dataUrl) })); broadcast({ type: "STICKERS_CHANGED" }); return; }
      const stickerParts = routeParts(url.pathname, "/api/stickers/");
      if (stickerParts?.length === 1 && method === "PATCH") { const input = await readJson(request); writeJson(response, 200, await media.setEnabled(stickerParts[0], input.enabled === true)); broadcast({ type: "STICKERS_CHANGED" }); return; }
      if (stickerParts?.length === 1 && method === "DELETE") { writeJson(response, 200, await media.delete(stickerParts[0])); broadcast({ type: "STICKERS_CHANGED" }); return; }
      const avatarParts = routeParts(url.pathname, "/api/media/avatar/");
      if (avatarParts?.length === 1 && (avatarParts[0] === "cyrene" || avatarParts[0] === "user")) {
        const kind = avatarParts[0];
        if (method === "GET") { writeJson(response, 200, { src: await media.avatar(kind) }); return; }
        if (method === "POST") { const input = await readJson(request, 12 * 1024 * 1024); writeJson(response, 200, { ok: true, src: await media.setAvatar(kind, stringValue(input.dataUrl)) }); broadcast({ type: "AVATAR_CHANGED", kind }); return; }
        if (method === "DELETE") { await media.resetAvatar(kind); writeJson(response, 200, { ok: true }); broadcast({ type: "AVATAR_CHANGED", kind }); return; }
      }
      const mediaParts = routeParts(url.pathname, "/api/media/files/");
      if (method === "GET" && mediaParts?.length === 1) { const body = await media.readFile(mediaParts[0]); if (!body) { writeJson(response, 404, { error: "MEDIA_NOT_FOUND" }); return; } response.writeHead(200, { "Content-Type": contentType(mediaParts[0]), "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" }); response.end(body); return; }

      if (method === "GET" && url.pathname === "/api/channels/config") { writeJson(response, 200, await features.getChannelsPublic()); return; }
      if (method === "PATCH" && url.pathname === "/api/channels/config") {
        const patch = await readJson(request);
        await features.patchChannels(patch);
        if (Object.keys(patch).some((key) => ["wechat", "feishu", "qq", "qqbot"].includes(key))) await channels.restart();
        writeJson(response, 200, await features.getChannelsPublic()); return;
      }
      if (method === "GET" && url.pathname === "/api/channels/status") { writeJson(response, 200, channels.getStatuses()); return; }
      if (method === "POST" && url.pathname === "/api/channels/restart") { await channels.restart(); writeJson(response, 200, { ok: true, status: channels.getStatuses() }); return; }
      const channelTestParts = routeParts(url.pathname, "/api/channels/");
      if (channelTestParts?.length === 2 && channelTestParts[1] === "test" && method === "POST") { writeJson(response, 200, await channels.test(channelTestParts[0])); return; }
      if (method === "POST" && url.pathname === "/api/channels/wechat/login") { writeJson(response, 200, await channels.startWechatLogin()); return; }
      if (method === "POST" && url.pathname === "/api/channels/wechat/logout") { writeJson(response, 200, await channels.logoutWechat()); return; }
      if (method === "GET" && url.pathname === "/api/channels/logs") { writeJson(response, 200, await channels.getLogs(Number(url.searchParams.get("limit") ?? 100))); return; }
      if (method === "DELETE" && url.pathname === "/api/channels/logs") { await channels.clearLogs(); writeNoContent(response); return; }
      if (method === "GET" && url.pathname === "/api/channels/context") { writeJson(response, 200, await channels.getContext(await store.list())); return; }
      if (method === "POST" && url.pathname === "/api/channels/context") { const body = await readJson(request); writeJson(response, 200, await channels.bindContext(stringValue(body.sessionId), stringValue(body.conversationId), async (id) => Boolean(await store.get(id)))); return; }
      if (method === "DELETE" && url.pathname === "/api/channels/context") { const body = await readJson(request); writeJson(response, 200, await channels.unbindContext(stringValue(body.sessionId))); return; }
      if (method === "POST" && url.pathname === "/api/channels/qq/auth-requirement") { const body = await readJson(request); writeJson(response, 200, channels.getAuthRequirement({ listenMode: body.listenMode, customHost: body.customHost })); return; }
      if (method === "GET" && url.pathname === "/api/memory") { writeJson(response, 200, await features.getMemory()); return; }
      if (method === "PATCH" && url.pathname === "/api/memory") { writeJson(response, 200, await features.patchMemory(await readJson(request) as never)); return; }
      if (method === "GET" && url.pathname === "/api/profile") { writeJson(response, 200, await features.getProfile()); return; }
      if (method === "PATCH" && url.pathname === "/api/profile") { writeJson(response, 200, await features.patchProfile(await readJson(request))); return; }
      if (method === "GET" && url.pathname === "/api/token-usage") { writeJson(response, 200, await features.getUsage()); return; }
      if (method === "DELETE" && url.pathname === "/api/token-usage") { await features.clearUsage(); writeNoContent(response); return; }

      if (method === "GET" && url.pathname === "/api/knowledge") { writeJson(response, 200, await features.getKnowledge()); return; }
      if (method === "PATCH" && url.pathname === "/api/knowledge") { writeJson(response, 200, await features.setKnowledge(await readJson(request) as never)); return; }
      if (method === "POST" && url.pathname === "/api/knowledge/collections") {
        const body = await readJson(request); writeJson(response, 201, await features.createCollection({ name: stringValue(body.name, "资料集"), scope: stringValue(body.scope) })); return;
      }
      const knowledgeParts = routeParts(url.pathname, "/api/knowledge/collections/");
      if (knowledgeParts?.length === 1 && method === "DELETE") { writeJson(response, (await features.deleteCollection(knowledgeParts[0])) ? 200 : 404, { ok: true }); return; }
      if (knowledgeParts?.length === 1 && method === "PATCH") {
        const updated = await features.updateCollection(knowledgeParts[0], await readJson(request) as never);
        writeJson(response, updated ? 200 : 404, updated ?? { ok: false, error: "COLLECTION_NOT_FOUND" }); return;
      }
      if (knowledgeParts?.length === 2 && method === "PATCH") {
        const updated = await features.updateCollection(knowledgeParts[0], await readJson(request) as never);
        writeJson(response, updated ? 200 : 404, updated ?? { ok: false, error: "COLLECTION_NOT_FOUND" }); return;
      }
      if (knowledgeParts?.length === 2 && knowledgeParts[1] === "documents" && method === "GET") {
        const state = await features.getKnowledge(); const collection = state.collections.find((item) => item.id === knowledgeParts[0]);
        if (!collection) { writeJson(response, 404, { ok: false, error: "COLLECTION_NOT_FOUND" }); return; }
        const documents: Array<Record<string, unknown>> = [];
        for (const source of collection.paths) {
          const info = await stat(source.path).catch(() => null); if (!info) continue;
          if (info.isDirectory()) for (const file of await collectTextFiles(source.path)) documents.push({ id: file.path, path: file.path, name: path.basename(file.path), size: file.size, updatedAt: Date.now() });
          else documents.push({ id: source.path, path: source.path, name: path.basename(source.path), size: info.size, updatedAt: Date.now() });
        }
        await features.updateCollection(collection.id, { fileCount: documents.length, errorCount: 0, scanning: false });
        writeJson(response, 200, { items: documents, total: documents.length }); return;
      }
      if (knowledgeParts?.length === 2 && knowledgeParts[1] === "search" && method === "GET") {
        const query = (url.searchParams.get("q") ?? "").trim().toLowerCase(); const state = await features.getKnowledge(); const collection = state.collections.find((item) => item.id === knowledgeParts[0]);
        if (!collection || !query) { writeJson(response, 200, { items: [], total: 0 }); return; }
        const matches: Array<Record<string, unknown>> = [];
        for (const source of collection.paths) for (const file of await collectTextFiles(source.path, 200)) {
          if (matches.length >= 100) break;
          const content = await readFile(file.path, "utf8").catch(() => ""); const index = content.toLowerCase().indexOf(query); if (index >= 0) matches.push({ path: file.path, name: path.basename(file.path), snippet: content.slice(Math.max(0, index - 120), index + query.length + 240), score: 1 });
        }
        writeJson(response, 200, { items: matches, total: matches.length }); return;
      }

      if (method === "GET" && url.pathname === "/api/scheduler") { writeJson(response, 200, { ok: true, value: await features.listSchedules() }); return; }
      if (method === "POST" && url.pathname === "/api/scheduler") { writeJson(response, 201, { ok: true, value: await features.createSchedule(await readJson(request) as never) }); return; }
      if (method === "GET" && url.pathname === "/api/scheduler/history") { const taskId = url.searchParams.get("taskId"); const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50))); const history = (await features.scheduleHistory()).filter((item) => !taskId || item.taskId === taskId).slice(0, limit); writeJson(response, 200, { ok: true, value: history }); return; }
      const schedulerParts = routeParts(url.pathname, "/api/scheduler/");
      if (schedulerParts?.length === 1 && method === "PATCH") { const item = await features.updateSchedule(schedulerParts[0], await readJson(request) as never); writeJson(response, item ? 200 : 404, item ? { ok: true, value: item } : { ok: false, error: "SCHEDULE_NOT_FOUND" }); return; }
      if (schedulerParts?.length === 1 && method === "DELETE") { writeJson(response, (await features.deleteSchedule(schedulerParts[0])) ? 200 : 404, { ok: true }); return; }
      if (schedulerParts?.length === 2 && schedulerParts[1] === "fire" && method === "POST") {
        const schedules = await features.listSchedules(); const item = schedules.find((entry) => entry.id === schedulerParts[0]);
        if (!item) { writeJson(response, 404, { ok: false, error: "SCHEDULE_NOT_FOUND" }); return; }
        const firedAt = new Date().toISOString(); await features.addScheduleHistory({ id: randomBytes(8).toString("hex"), taskId: item.id, taskTitle: item.title ?? item.name, status: "running", firedAt, effectiveToolIds: [] });
        const updated = await features.updateSchedule(item.id, { lastFiredAt: Date.now(), runCount: (item.runCount ?? 0) + 1 });
        writeJson(response, 200, { ok: true, value: updated ?? item }); return;
      }

      if (method === "GET" && url.pathname === "/api/plugins") {
        const enabled = await features.getPluginEnabled();
        const roots = [path.resolve(process.cwd(), "plugins"), path.join(options.dataDir ?? defaultDataDir(), "plugins")]; const plugins = new Map<string, Record<string, unknown>>();
        for (const root of roots) for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) {
          const manifest: Record<string, unknown> = await readFile(path.join(root, entry.name, "manifest.json"), "utf8").then((value) => JSON.parse(value) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
          const id = typeof manifest.id === "string" ? manifest.id : entry.name; plugins.set(id, { id, name: typeof manifest.name === "string" ? manifest.name : id, description: typeof manifest.description === "string" ? manifest.description : "", enabled: enabled[id] ?? manifest.defaultEnabled !== false, source: root });
        }
        for (const [id, isEnabled] of Object.entries(enabled)) if (!plugins.has(id)) plugins.set(id, { id, name: id, enabled: isEnabled, source: "web" });
        writeJson(response, 200, { plugins: [...plugins.values()], issues: [] }); return;
      }
      if (method === "GET" && url.pathname === "/api/moments") { writeJson(response, 200, await features.listMoments(Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50))))); return; }
      if (method === "POST" && url.pathname === "/api/moments") { writeJson(response, 200, await features.createMoment(await readJson(request))); return; }
      const momentParts = routeParts(url.pathname, "/api/moments/");
      if (momentParts?.length === 1 && method === "GET") { const items = await features.listMoments(100); writeJson(response, 200, items.find((item) => (item.post as Record<string, unknown>)?.id === momentParts[0]) ?? null); return; }
      if (momentParts?.length === 1 && method === "DELETE") { writeJson(response, 200, await features.deleteMoment(momentParts[0])); return; }
      if (momentParts?.length === 2 && momentParts[1] === "comment" && method === "POST") { const body = await readJson(request); writeJson(response, 200, await features.commentMoment({ ...body, postId: momentParts[0] })); return; }
      if (momentParts?.length === 2 && momentParts[1] === "like" && method === "POST") { writeJson(response, 200, await features.toggleMomentLike(momentParts[0])); return; }
      if (method === "PATCH" && url.pathname === "/api/plugins") {
        const body = await readJson(request); const id = stringValue(body.id); if (!id) { writeJson(response, 400, { ok: false, error: "PLUGIN_ID_REQUIRED" }); return; }
        writeJson(response, 200, { ok: true, enabled: await features.setPluginEnabled(id, body.enabled === true) }); return;
      }
      if (method === "GET" && url.pathname === "/api/skills") {
        const roots = [path.resolve(process.cwd(), "skills"), path.resolve(process.cwd(), ".agents", "skills")]; const entries: Array<Record<string, unknown>> = [];
        for (const root of roots) { for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) { const text = await readFile(path.join(root, entry.name, "SKILL.md"), "utf8").catch(() => ""); const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name; const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "服务端技能"; entries.push({ id: entry.name, name, description, enabled: true, source: root, modes: null, references: [] }); } }
        writeJson(response, 200, entries); return;
      }

      const gitParts = routeParts(url.pathname, "/api/code-git/");
      if (gitParts && gitParts.length >= 2) {
        const [sessionId, operation] = gitParts;
        const sessionValue = await store.get(sessionId); const root = sessionValue?.workspaceBinding?.workspaceRoot;
        if (!root) { writeJson(response, 200, { ok: false, error: "NO_WORKSPACE" }); return; }
        if (operation === "status" && method === "GET") { writeJson(response, 200, await gitStatus(sessionId, root)); return; }
        if (operation === "switch" && method === "POST") {
          const body = await readJson(request); const branch = stringValue(body.branch).trim();
          if (!/^[\w./-]{1,120}$/.test(branch)) { writeJson(response, 400, { ok: false, error: "INVALID_BRANCH" }); return; }
          await runGit(root, body.create === false ? ["switch", branch] : ["switch", "-c", branch]); writeJson(response, 200, { ok: true }); broadcast({ type: "CODE_GIT_CHANGED", sessionId }); return;
        }
        if (operation === "commit" && method === "POST") {
          const body = await readJson(request); const message = stringValue(body.message).trim(); if (!message) { writeJson(response, 400, { ok: false, error: "COMMIT_MESSAGE_REQUIRED" }); return; }
          const paths = Array.isArray(body.paths) ? body.paths.map((value) => String(value)).filter((value) => value && !value.includes("..") && !path.isAbsolute(value)) : [];
          await runGit(root, ["add", "--", ...(paths.length ? paths : ["."])]); await runGit(root, ["commit", "-m", message]); writeJson(response, 200, { ok: true }); broadcast({ type: "CODE_GIT_CHANGED", sessionId }); return;
        }
        if (operation === "push" && method === "POST") { await runGit(root, ["push"]); writeJson(response, 200, { ok: true }); broadcast({ type: "CODE_GIT_CHANGED", sessionId }); return; }
      }

      if (method === "GET" && url.pathname === "/api/settings") {
        writeJson(response, 200, await store.getSettings());
        return;
      }
      const settingsParts = routeParts(url.pathname, "/api/settings/");
      if (settingsParts?.length === 1 && method === "PATCH") {
        const section = settingsParts[0];
        if (section !== "general" && section !== "config" && section !== "timeout") {
          writeJson(response, 404, { ok: false, error: "UNKNOWN_SETTINGS_SECTION" });
          return;
        }
        const saved = await store.patchSettings(section, await readJson(request));
        writeJson(response, 200, saved); broadcast({ type: "SETTINGS_CHANGED" });
        return;
      }
      if (method === "GET" && url.pathname === "/api/model-profiles") {
        const settings = await store.getSettings();
        writeJson(response, 200, { profiles: settings.modelProfiles, defaultModelProfileId: settings.defaultModelProfileId });
        return;
      }
      if (method === "PUT" && url.pathname === "/api/model-profiles") {
        const body = await readJson(request);
        const profiles = Array.isArray(body.profiles) ? body.profiles.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
        const settings = await store.setModelProfiles(profiles, typeof body.defaultModelProfileId === "string" ? body.defaultModelProfileId : undefined);
        writeJson(response, 200, { profiles: settings.modelProfiles, defaultModelProfileId: settings.defaultModelProfileId });
        broadcast({ type: "SETTINGS_CHANGED" });
        return;
      }
      if (method === "PATCH" && url.pathname === "/api/permission-level") {
        const body = await readJson(request);
        const level = stringValue(body.level, "ask");
        writeJson(response, 200, { ok: true, level: await store.setPermissionLevel(level) });
        return;
      }
      if (method === "GET" && url.pathname === "/api/permission-level") {
        writeJson(response, 200, { level: (await store.getSettings()).permissionLevel });
        return;
      }

      if (method === "GET" && url.pathname === "/api/chat/sessions") {
        const requestedMode = url.searchParams.get("mode");
        writeJson(response, 200, { sessions: await store.list(requestedMode ? modeValue(requestedMode) : undefined) });
        return;
      }
      if (method === "POST" && url.pathname === "/api/chat/sessions") {
        const body = await readJson(request);
        const created = await store.create({ identityId: null, mode: modeValue(body.mode), title: typeof body.title === "string" ? body.title : undefined });
        writeJson(response, 201, created);
        return;
      }
      const sessionParts = routeParts(url.pathname, "/api/chat/sessions/");
      if (sessionParts?.length === 1) {
        const sessionId = sessionParts[0];
        if (method === "GET") {
          writeJson(response, 200, await store.get(sessionId));
          return;
        }
        if (method === "PATCH") {
          const body = await readJson(request);
          if (typeof body.title === "string") {
            const renamed = await store.rename(sessionId, body.title);
            if (!renamed) { writeJson(response, 404, { ok: false, error: "SESSION_NOT_FOUND" }); return; }
          }
          if (typeof body.pinned === "boolean") await store.setPinned(sessionId, body.pinned);
          const updated = await store.updateSession(sessionId, body);
          if (!updated) { writeJson(response, 404, { ok: false, error: "SESSION_NOT_FOUND" }); return; }
          writeJson(response, 200, updated);
          return;
        }
        if (method === "DELETE") {
          writeJson(response, (await store.delete(sessionId)) ? 204 : 404, {});
          return;
        }
      }
      if (sessionParts?.length === 2) {
        const [sessionId, action] = sessionParts;
        if (action === "pending" && method === "GET") { writeJson(response, 200, { queue: await store.pendingList(sessionId) }); return; }
        if (action === "pending" && method === "POST") {
          const body = await readJson(request);
          const result = await store.enqueue(sessionId, {
            id: stringValue(body.id, randomBytes(12).toString("hex")),
            rawContent: stringValue(body.rawContent),
            visibleContent: stringValue(body.visibleContent, stringValue(body.rawContent)),
            ...(Array.isArray(body.attachments) ? { attachments: body.attachments as never } : {}),
            ...(typeof body.userSticker === "string" ? { userSticker: body.userSticker } : {}),
          });
          writeJson(response, result.ok ? 200 : 404, result); return;
        }
        if (action === "pending-remove" && method === "POST") { const body = await readJson(request); writeJson(response, 200, await store.pendingRemove(sessionId, stringValue(body.messageId))); return; }
        if (action === "pending-edit" && method === "POST") { const body = await readJson(request); writeJson(response, 200, await store.pendingEdit(sessionId, stringValue(body.messageId), { rawContent: stringValue(body.rawContent), visibleContent: stringValue(body.visibleContent, stringValue(body.rawContent)), ...(typeof body.userSticker === "string" ? { userSticker: body.userSticker } : {}) })); return; }
        if (action === "pending-adjust" && method === "POST") { const body = await readJson(request); writeJson(response, 200, await store.pendingAdjust(sessionId, stringValue(body.messageId))); return; }
        if (action === "claim" && method === "POST") { writeJson(response, 200, await store.claim(sessionId)); return; }
        if (action === "dispatch-complete" && method === "POST") { const body = await readJson(request); writeJson(response, 200, await store.completeDispatch(sessionId, stringValue(body.messageId))); return; }
        if (action === "checkpoint" && method === "POST") { const body = await readJson(request); writeJson(response, 200, await store.checkpointPresentation(sessionId, stringValue(body.messageId), stringValue(body.mutationKey), body.patch)); return; }
      }

      if (method === "GET" && url.pathname === "/api/sidebar") { writeJson(response, 200, await store.sidebar()); return; }
      if (method === "PUT" && url.pathname === "/api/sidebar") { const body = await readJson(request); writeJson(response, 200, await store.applySidebar(Number(body.expectedRevision ?? 0), (body.draft ?? body) as never)); return; }
      if (method === "GET" && url.pathname === "/api/workspaces/default") { writeJson(response, 200, { path: process.cwd(), displayName: path.basename(process.cwd()) || process.cwd() }); return; }
      if (method === "GET" && url.pathname === "/api/workspaces/recent") { writeJson(response, 200, { paths: await store.recentProjects() }); return; }
      if (method === "POST" && url.pathname === "/api/workspaces/validate") { const body = await readJson(request); const candidate = stringValue(body.path); const info = await stat(candidate).catch(() => null); writeJson(response, 200, info?.isDirectory() ? { ok: true, path: path.resolve(candidate) } : { ok: false, error: "WORKSPACE_NOT_DIRECTORY" }); return; }
      const workspaceParts = routeParts(url.pathname, "/api/workspaces/");
      if (workspaceParts?.length === 2 && workspaceParts[1] === "learn-init" && method === "POST") {
        const sessionValue = await store.get(workspaceParts[0]); const root = sessionValue?.workspaceBinding?.workspaceRoot;
        if (!root) { writeJson(response, 200, { ok: false, error: "NO_WORKSPACE" }); return; }
        const entries = ["materials", "notes", "exercises", "templates", "learn/progress.md"]; const created: string[] = []; const skipped: string[] = [];
        for (const rel of entries) { const target = path.join(root, rel); const existing = await stat(target).catch(() => null); if (existing) { skipped.push(rel); continue; } if (rel.includes("/")) await mkdir(path.dirname(target), { recursive: true }); else if (!path.extname(rel)) await mkdir(target, { recursive: true }); else await mkdir(path.dirname(target), { recursive: true }); if (path.extname(rel)) await writeFile(target, "# 学习进度\n\n", { flag: "wx" }).catch(() => undefined); created.push(rel); }
        writeJson(response, 200, { ok: true, created, skipped }); return;
      }
      if (workspaceParts?.length === 2 && (method === "GET" || method === "POST")) {
        const [sessionId, operation] = workspaceParts;
        const bound = await store.get(sessionId);
        const root = bound?.workspaceBinding?.workspaceRoot;
        if (!root) { writeJson(response, 200, { ok: false, code: "NO_WORKSPACE" }); return; }
        const relative = operation === "list" ? (url.searchParams.get("path") ?? "") : stringValue((await readJson(request)).path);
        const candidate = path.resolve(root, relative);
        if (candidate !== root && !candidate.startsWith(`${path.resolve(root)}${path.sep}`)) { writeJson(response, 200, { ok: false, code: "OUT_OF_ROOT" }); return; }
        if (operation === "list" && method === "GET") {
          try {
            const entries = await readdir(candidate, { withFileTypes: true });
            writeJson(response, 200, { ok: true, entries: entries.filter((entry) => !entry.name.startsWith(".")).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, relPath: path.relative(root, path.join(candidate, entry.name)).replaceAll(path.sep, "/"), isDir: entry.isDirectory() })) });
          } catch { writeJson(response, 200, { ok: false, code: "LIST_FAILED" }); }
          return;
        }
        if (operation === "read" && method === "POST") {
          try {
            const info = await stat(candidate); if (info.isDirectory()) { writeJson(response, 200, { ok: false, code: "IS_DIRECTORY" }); return; }
            if (info.size > 1024 * 1024) { writeJson(response, 200, { ok: false, code: "TOO_LARGE" }); return; }
            const content = await readFile(candidate, "utf8"); writeJson(response, 200, { ok: true, content, size: info.size });
          } catch { writeJson(response, 200, { ok: false, code: "READ_FAILED" }); }
          return;
        }
      }

      if (method === "POST" && url.pathname === "/api/agui/run") {
        const body = await readJson(request);
        const sessionId = stringValue(body.sessionId);
        const assistantId = stringValue(body.assistantTurnId, randomBytes(12).toString("hex"));
        const user = body.currentUser && typeof body.currentUser === "object" ? body.currentUser as Record<string, unknown> : {};
        const text = stringValue(user.text, stringValue(user.visibleContent));
        if (!await store.get(sessionId)) { writeJson(response, 404, { success: false, error: "SESSION_NOT_FOUND" }); return; }
        const runId = randomBytes(16).toString("hex");
        running.set(runId, { cancelled: false, sessionId, assistantId, controller: new AbortController() });
        await store.patchMessage(sessionId, assistantId, { role: "model", content: "", at: Date.now(), runSnapshot: { runId, status: "running", updatedAt: Date.now() } });
        writeJson(response, 200, { success: true, runId });
        void (async () => {
          // Give the browser time to finish the authenticated WebSocket upgrade
          // before the first AG-UI event is published.
          await new Promise((resolve) => setTimeout(resolve, 100));
          const emit = (event: Record<string, unknown>) => broadcast({ ...event, runId, sessionId });
          emit({ type: "RUN_STARTED" });
          emit({ type: "TEXT_MESSAGE_START", messageId: assistantId });
          let accumulated = "";
          let reasoning = "";
          let reasoningStarted = false;
          const state = running.get(runId)!;
          try {
            const result = await requestSessionModel(store, sessionId, text.trim(), { persona, styleId: body.styleId, legacyStyle: body.style, signal: state.controller.signal, onDelta: (delta) => {
              if (state.cancelled) return;
              if (delta.type === "text_delta") { accumulated += delta.delta; emit({ type: "TEXT_MESSAGE_CONTENT", messageId: assistantId, delta: delta.delta }); }
              if (delta.type === "reasoning_delta") {
                if (!reasoningStarted) { reasoningStarted = true; emit({ type: "REASONING_MESSAGE_START", messageId: `${assistantId}-reasoning` }); }
                reasoning += delta.delta; emit({ type: "REASONING_MESSAGE_CONTENT", messageId: `${assistantId}-reasoning`, delta: delta.delta });
              }
            } });
            if (reasoningStarted) emit({ type: "REASONING_MESSAGE_END", messageId: `${assistantId}-reasoning` });
            const terminalStatus = state.cancelled ? "cancelled" : "success";
            const currentSession = await store.get(sessionId);
            const settings = await store.getSettings();
            const sticker = state.cancelled || currentSession?.mode === "code" ? null : await media.matchReply(result.text, text, {
              enabled: settings.config.stickerEnabled !== false,
              threshold: typeof settings.config.stickerSimilarityThreshold === "number" ? settings.config.stickerSimilarityThreshold : undefined,
            });
            await store.patchMessage(sessionId, assistantId, { content: result.text, reasoning: result.thinking ?? reasoning, sticker, runSnapshot: { runId, status: "terminal", terminalStatus, updatedAt: Date.now() } });
            emit({ type: "TEXT_MESSAGE_END", messageId: assistantId });
            emit({ type: "CUSTOM", name: "cyrene.sticker", value: sticker });
            emit({ type: "RUN_FINISHED", status: terminalStatus, result: { status: terminalStatus, externalEffectsMayContinue: false } });
          } catch (error) {
            const message = modelError(error);
            const terminalStatus = state.cancelled ? "cancelled" : "runtime_error";
            await store.patchMessage(sessionId, assistantId, { content: accumulated || (state.cancelled ? "" : `模型请求失败：${message}`), reasoning, runSnapshot: { runId, status: "terminal", terminalStatus, updatedAt: Date.now() } });
            if (state.cancelled) emit({ type: "RUN_FINISHED", status: "cancelled", result: { status: "cancelled", externalEffectsMayContinue: false } });
            else emit({ type: "RUN_ERROR", message, code: "MODEL_REQUEST_FAILED", result: { status: "runtime_error", reason: message, externalEffectsMayContinue: false } });
          } finally { running.delete(runId); }
        })().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          broadcast({
            type: "RUN_ERROR",
            runId,
            sessionId,
            status: "runtime_error",
            message,
            result: { status: "runtime_error", reason: message, externalEffectsMayContinue: true },
          });
          running.delete(runId);
        });
        return;
      }
      if (method === "POST" && url.pathname === "/api/agui/cancel") { const body = await readJson(request); const runId = stringValue(body.runId); const run = running.get(runId); if (run) { run.cancelled = true; run.controller.abort(); } writeJson(response, 200, { ok: true }); return; }

      if (method === "GET" && url.pathname === "/api/browser/state") { writeJson(response, 200, browserStates.get(session.username) ?? EMPTY_BROWSER_PANEL_STATE); return; }
      if (method === "POST" && url.pathname === "/api/browser/navigate") {
        const body = await readJson(request); const target = stringValue(body.url);
        if (!/^https?:\/\//i.test(target)) { writeJson(response, 200, { ok: false, error: "invalid_url" }); return; }
        const id = randomBytes(8).toString("hex"); const state: BrowserPanelState = { activeTabId: id, tabs: [{ id, kind: "web", url: target, title: target, loading: false, canGoBack: false, canGoForward: false, crashed: false }] };
        browserStates.set(session.username, state); writeJson(response, 200, { ok: true }); broadcast({ type: "BROWSER_STATE", state }); return;
      }
      if (method === "POST" && url.pathname === "/api/browser/new-tab") { const id = randomBytes(8).toString("hex"); const state = browserStates.get(session.username) ?? { activeTabId: id, tabs: [] }; state.tabs.push({ id, kind: "web", url: "", title: "", loading: false, canGoBack: false, canGoForward: false, crashed: false }); state.activeTabId = id; browserStates.set(session.username, state); writeJson(response, 200, { ok: true }); return; }
      if (method === "POST" && url.pathname === "/api/browser/action") { writeJson(response, 200, { ok: true }); return; }

      if (method === "GET" && url.pathname === "/api/runtime") { writeJson(response, 200, { ok: true, platform: "linux-web", username: session.username, live2d: false }); return; }

      writeJson(response, 404, { ok: false, error: "ROUTE_NOT_IMPLEMENTED" });
    } catch (error) {
      const code = error instanceof Error ? error.message : "REQUEST_FAILED";
      const status = code === "REQUEST_TOO_LARGE" ? 413 : code === "E_LEARN_EXAM_PAGE_FORBIDDEN" ? 403 : 400;
      logger.warn(`[web] request failed code=${code}`);
      if (!response.headersSent) writeJson(response, status, { ok: false, error: code }); else response.destroy();
    }
  });

  websocketServer.on("connection", (socket, request) => {
    sockets.add(socket);
    const client = { id: nextClientId++, token: randomBytes(24).toString("base64url"), sessionToken: parseCookies(request)[SESSION_COOKIE] };
    socketClients.set(socket, client);
    socket.send(JSON.stringify({ type: "ready", authenticated: true, clientToken: client.token }));
    const expiry = setInterval(() => { if (!auth.getSession(client.sessionToken)) socket.close(1008, "session expired"); }, 30_000);
    expiry.unref();
    socket.on("close", () => { clearInterval(expiry); sockets.delete(socket); socketClients.delete(socket); core?.disconnect(client.id); });
    logger.info(`[web] websocket connected path=${request.url || "/ws"}`);
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://cyrene.local");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const session = auth.getSession(parseCookies(request)[SESSION_COOKIE]);
    const origin = headerValue(request.headers.origin);
    if (origin && new URL(origin).host !== request.headers.host) { socket.destroy(); return; }
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  return {
    server,
    auth,
    initialSetupToken: setupToken,
    startChannels: () => core ? core.start() : channels.start(),
    close: async () => {
      for (const run of running.values()) { run.cancelled = true; run.controller.abort(); }
      await channels.stop();
      await core?.close();
      for (const socket of sockets) socket.close(1001, "server shutting down");
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? process.env.CYRENE_WEB_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.CYRENE_WEB_PORT || DEFAULT_PORT);
  const staticRoot = options.staticRoot ?? path.resolve(__dirname, "..", "..", "renderer");
  const handle = createWebServer({ ...options, staticRoot });
  if (!(await handle.auth.isInitialized())) {
    const setupToken = options.setupToken ?? process.env.CYRENE_SETUP_TOKEN;
    if (setupToken) {
      (options.logger ?? console).info("[web-auth] server is uninitialized; use CYRENE_SETUP_TOKEN or the configured setup token to bootstrap");
    } else {
      (options.logger ?? console).info("[web-auth] server is uninitialized; one-time setup token:", handle.initialSetupToken);
    }
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      handle.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      handle.server.off("error", onError);
      resolve();
    };
    handle.server.once("error", onError);
    handle.server.once("listening", onListening);
    handle.server.listen(port, host);
  });
  (options.logger ?? console).info(`[web] listening on http://${host}:${port}`);
  // Connector startup is intentionally after the authenticated Web server is listening,
  // so a failed external connection never prevents the browser from opening settings.
  await handle.startChannels();
  return handle;
}

function randomSetupToken(): string {
  return randomBytes(24).toString("base64url");
}

if (require.main === module) {
  void startWebServer().then(handle => {
    let closing = false;
    const shutdown = () => { if (closing) return; closing = true; void handle.close().then(() => process.exit(0), error => { console.error("[web] shutdown failed", error); process.exit(1); }); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  }).catch((error) => {
    console.error("[web] startup failed", error);
    process.exitCode = 1;
  });
}
