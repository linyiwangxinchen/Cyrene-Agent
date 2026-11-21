/**
 * Client for the Cyrene Web service (src/server/index.ts).
 *
 * Authentication mirrors the browser: GET /api/auth/challenge, POST
 * /api/auth/login, then the HttpOnly `cyrene_session` cookie authorizes the
 * /ws upgrade. The socket's `ready` message hands out a clientToken that must
 * accompany every POST /api/core/invoke, and core events for this client
 * arrive on the socket as CORE_EVENT.
 */
import { WebSocket } from "ws";
import { AuthError, ConnectionError, CoreRequestError, Emitter, type CoreTransport } from "./transport.js";

const SESSION_COOKIE = "cyrene_session";
const REQUEST_TIMEOUT_MS = 15_000;
/** AGUI_RUN may compact history before acknowledging; keep the server's own bound. */
const INVOKE_TIMEOUT_MS = 6 * 60_000;

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed = await readBody(response);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new ConnectionError(`无法连接 ${new URL(url).origin}：${reason}`);
  }
}

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function sessionTokenFrom(response: Response): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    try { return decodeURIComponent(value) || undefined; } catch { return undefined; }
  }
  return undefined;
}

/** Log in with a password and return the session token. The password is sent once, in the JSON body. */
export async function loginWithPassword(server: string, username: string, password: string): Promise<string> {
  const challengeResponse = await request(`${server}/api/auth/challenge`);
  const challenge = await readJson(challengeResponse);
  if (!challengeResponse.ok) throw new ConnectionError(`登录准备失败：HTTP ${challengeResponse.status}`);
  if (challenge.captchaRequired === true) {
    throw new AuthError("服务器因多次登录失败要求验证码，命令行无法完成；请稍后重试或先在浏览器登录一次");
  }
  const response = await request(`${server}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, challengeId: challenge.challengeId }),
  });
  const payload = await readJson(response);
  if (response.status === 401) throw new AuthError("用户名或密码错误");
  if (response.status === 429) throw new AuthError(`登录尝试过多，请 ${String(payload.retryAfter ?? 60)} 秒后再试`);
  if (response.status === 426) throw new AuthError("服务器要求 HTTPS 登录");
  if (!response.ok) throw new AuthError(`登录失败：${String(payload.error ?? `HTTP ${response.status}`)}`);
  const token = sessionTokenFrom(response);
  if (!token) throw new AuthError("登录成功但服务器没有返回会话 Cookie");
  return token;
}

/** Returns the username for a valid session, or null when it expired. */
export async function checkSession(server: string, token: string): Promise<string | null> {
  const response = await request(`${server}/api/auth/me`, { headers: { Cookie: cookieHeader(token) } });
  if (response.status === 401) return null;
  const payload = await readJson(response);
  if (!response.ok) throw new ConnectionError(`会话检查失败：HTTP ${response.status}`);
  return typeof payload.username === "string" ? payload.username : "";
}

export async function logoutSession(server: string, token: string): Promise<void> {
  await request(`${server}/api/auth/logout`, { method: "POST", headers: { Cookie: cookieHeader(token) } });
}

export interface ProbeResult {
  reachable: boolean;
  status?: number;
  body?: Record<string, unknown>;
  error?: string;
}

/** Unauthenticated GET used by doctor for /healthz and /readyz. */
export async function probe(url: string, timeoutMs = 3_000): Promise<ProbeResult> {
  try {
    const response = await request(url, { timeoutMs });
    return { reachable: true, status: response.status, body: await readJson(response) };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

class WebCoreTransport implements CoreTransport {
  readonly remote: boolean;
  private events = new Emitter<[string, unknown[]]>();
  private closed = new Emitter<[string]>();
  private closing = false;

  constructor(
    readonly description: string,
    private readonly server: string,
    private readonly token: string,
    private readonly socket: WebSocket,
    private readonly clientToken: string,
    remote: boolean,
  ) {
    this.remote = remote;
    // Errors after the handshake surface as "close"; keep them from crashing the process.
    socket.on("error", () => {});
    socket.on("message", (data) => {
      let message: { type?: string; channel?: unknown; args?: unknown };
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type === "CORE_EVENT" && typeof message.channel === "string") {
        this.events.emit(message.channel, Array.isArray(message.args) ? message.args : []);
      }
    });
    socket.on("close", (code, reason) => {
      if (this.closing) return;
      this.closed.emit(`实时连接已断开（${code}${reason.length ? ` ${reason.toString()}` : ""}）`);
    });
  }

  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const response = await request(`${this.server}/api/core/invoke`, {
      method: "POST",
      timeoutMs: INVOKE_TIMEOUT_MS,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(this.token), "X-Cyrene-Client": this.clientToken },
      body: JSON.stringify({ channel, args }),
    });
    const payload = await readBody(response);
    if (response.status === 401) throw new AuthError("登录会话已失效，请重新运行 cyrene login");
    if (!response.ok) {
      const code = payload && typeof payload === "object" && "error" in payload ? String((payload as { error: unknown }).error) : `HTTP_${response.status}`;
      throw new CoreRequestError(code, response.status);
    }
    return payload as T;
  }

  onEvent(listener: (channel: string, args: unknown[]) => void): () => void { return this.events.add(listener); }
  onClose(listener: (reason: string) => void): () => void { return this.closed.add(listener); }

  async close(): Promise<void> {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 2_000);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.socket.close(1000, "cli done");
    });
  }
}

/** Open the realtime socket and wait for its clientToken. */
export async function connectWebCore(server: string, token: string, options: { remote: boolean; timeoutMs?: number }): Promise<CoreTransport> {
  const wsUrl = `${server.replace(/^http/, "ws")}/ws`;
  const socket = new WebSocket(wsUrl, { headers: { Cookie: cookieHeader(token) }, perMessageDeflate: false });
  const clientToken = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new ConnectionError(`连接 ${wsUrl} 超时`)); }, options.timeoutMs ?? 10_000);
    const fail = (error: Error) => { clearTimeout(timer); socket.removeAllListeners("message"); reject(error); };
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      socket.terminate();
      fail(status === 401 ? new AuthError("登录会话无效或已过期") : new ConnectionError(`实时连接被拒绝：HTTP ${status}`));
    });
    socket.once("error", (error) => fail(new ConnectionError(`无法连接 ${wsUrl}：${error.message}`)));
    socket.on("message", function onReady(data) {
      let message: { type?: string; clientToken?: unknown };
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.type !== "ready" || typeof message.clientToken !== "string") return;
      clearTimeout(timer);
      socket.off("message", onReady);
      resolve(message.clientToken);
    });
  });
  return new WebCoreTransport(server, server, token, socket, clientToken, options.remote);
}
