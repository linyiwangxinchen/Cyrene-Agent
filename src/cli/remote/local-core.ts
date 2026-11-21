/**
 * --local: fork the headless shared core (dist/headless/core.cjs) directly,
 * using the same IPC protocol as src/server/shared-core-client.ts. No Web
 * server, login or network is involved; the data directory is the core's
 * userData. Do not point it at a directory a running desktop app or Web
 * service is using: two cores would write the same stores.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { errLine } from "../util/log.js";
import { ConnectionError, CoreRequestError, Emitter, type CoreTransport } from "./transport.js";

const CLIENT_ID = 1;
const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 6 * 60_000;

export interface LocalCoreOptions {
  dataDir: string;
  /** Repository or deployment root that contains dist/headless/core.cjs and node_modules. */
  appRoot: string;
  /** Explicit worker path; defaults to <appRoot>/dist/headless/core.cjs. */
  workerPath?: string;
  /** Forward the core's own logs to stderr. */
  verbose?: boolean;
}

/** dist/cli/index.js lives two levels below the app root. */
export function defaultAppRoot(): string {
  return process.env.CYRENE_APP_ROOT ? path.resolve(process.env.CYRENE_APP_ROOT) : path.resolve(__dirname, "..", "..");
}

class LocalCoreTransport implements CoreTransport {
  readonly remote = false;
  private events = new Emitter<[string, unknown[]]>();
  private closed = new Emitter<[string]>();
  private requests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closing = false;

  constructor(readonly description: string, private readonly child: ChildProcess) {
    child.on("message", (message: { type?: string; requestId?: string; error?: string; value?: unknown; channel?: unknown; args?: unknown; clientId?: number }) => {
      if (message.type === "event" && typeof message.channel === "string" && (!message.clientId || message.clientId === CLIENT_ID)) {
        this.events.emit(message.channel, Array.isArray(message.args) ? message.args : []);
        return;
      }
      if (message.type !== "response" || !message.requestId) return;
      const pending = this.requests.get(message.requestId);
      if (!pending) return;
      this.requests.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CoreRequestError(message.error));
      else pending.resolve(message.value ?? null);
    });
    child.on("exit", (code) => {
      const error = new ConnectionError(`本地核心已退出：${code ?? "signal"}`);
      for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.requests.clear();
      if (!this.closing) this.closed.emit(error.message);
    });
  }

  invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (!this.child.connected) return Promise.reject(new ConnectionError("本地核心不可用"));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new CoreRequestError("CORE_REQUEST_TIMEOUT")); }, REQUEST_TIMEOUT_MS);
      this.requests.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.child.send({ type: "invoke", channel, args, clientId: CLIENT_ID, requestId }, (error) => {
        if (!error) return;
        this.requests.delete(requestId);
        clearTimeout(timer);
        reject(new ConnectionError(error.message));
      });
    });
  }

  onEvent(listener: (channel: string, args: unknown[]) => void): () => void { return this.events.add(listener); }
  onClose(listener: (reason: string) => void): () => void { return this.closed.add(listener); }

  async close(): Promise<void> {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 15_000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (this.child.connected) this.child.send({ type: "shutdown" });
      else this.child.kill();
    });
  }
}

export async function startLocalCore(options: LocalCoreOptions): Promise<CoreTransport> {
  const workerPath = options.workerPath ?? process.env.CYRENE_HEADLESS_CORE ?? path.join(options.appRoot, "dist", "headless", "core.cjs");
  if (!existsSync(workerPath)) {
    throw new ConnectionError(`未找到本地核心 ${workerPath}；请在源码目录运行 corepack pnpm run build:server，或用 --app-root 指向部署目录`);
  }
  const child = fork(workerPath, [], {
    env: { ...process.env, CYRENE_HEADLESS: "1", CYRENE_DATA_DIR: options.dataDir, CYRENE_APP_ROOT: options.appRoot },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  const forward = (value: Buffer) => { if (options.verbose) errLine(String(value).trimEnd()); };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new ConnectionError("本地核心启动超时")); }, START_TIMEOUT_MS);
    const onMessage = (message: { type?: string; error?: string }) => {
      if (message.type === "ready") { cleanup(); resolve(); }
      else if (message.type === "failed") { cleanup(); child.kill(); reject(new ConnectionError(`本地核心启动失败：${message.error ?? "未知错误"}`)); }
    };
    const onExit = (code: number | null) => { cleanup(); reject(new ConnectionError(`本地核心启动时退出：${code ?? "signal"}（加 --verbose 查看日志）`)); };
    const onError = (error: Error) => { cleanup(); reject(new ConnectionError(`无法启动本地核心：${error.message}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return new LocalCoreTransport(`local:${options.dataDir}`, child);
}
