import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Isolated process owns the same singleton business services as Windows. */
export class SharedCoreClient extends EventEmitter {
  private child?: ChildProcess;
  private boot?: Promise<void>;
  private requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private dataDir: string, private appRoot: string, private logger: Pick<Console, "info" | "warn" | "error"> = console) { super(); }
  start(): Promise<void> {
    if (this.boot) return this.boot;
    this.boot = new Promise((resolve, reject) => {
      const workerPath = path.join(this.appRoot, "dist", "headless", "core.cjs");
      if (!existsSync(workerPath)) { reject(new Error("共享核心尚未构建，请运行 npm run build:server")); return; }
      const child = this.child = fork(workerPath, [], { env: { ...process.env, CYRENE_HEADLESS: "1", CYRENE_DATA_DIR: this.dataDir, CYRENE_APP_ROOT: this.appRoot }, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
      const timer = setTimeout(() => { reject(new Error("共享核心启动超时")); child.kill(); }, 120_000);
      child.stdout?.on("data", value => this.logger.info(String(value).trimEnd()));
      child.stderr?.on("data", value => this.logger.warn(String(value).trimEnd()));
      child.on("message", (message: any) => {
        if (message.type === "ready") { clearTimeout(timer); resolve(); this.emit("ready", message.capabilities); }
        else if (message.type === "failed") { clearTimeout(timer); reject(new Error(message.error)); }
        else if (message.type === "event") this.emit("event", message);
        else if (message.type === "response") {
          const request = this.requests.get(message.requestId);
          if (!request) return;
          this.requests.delete(message.requestId); clearTimeout(request.timer);
          if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value ?? null);
        }
      });
      const fail = (error: Error) => { clearTimeout(timer); reject(error); for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); } this.requests.clear(); this.emit("unavailable", error.message); };
      child.on("error", fail);
      child.on("exit", code => fail(new Error(`共享核心退出：${code}`)));
    });
    return this.boot;
  }
  async request(clientId: number, type: string, input: Record<string, unknown> = {}): Promise<any> {
    await this.start();
    if (!this.child?.connected || this.child.exitCode !== null) throw new Error("CORE_UNAVAILABLE");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("CORE_REQUEST_TIMEOUT")); }, 360_000);
      this.requests.set(requestId, { resolve, reject, timer });
      this.child!.send({ ...input, type, clientId, requestId }, error => { if (!error) return; this.requests.delete(requestId); clearTimeout(timer); reject(error); });
    });
  }
  disconnect(clientId: number): void { if (this.child?.connected) this.child.send({ type: "disconnect", clientId }); }
  async close(): Promise<void> {
    if (!this.child || !this.child.connected) return;
    const child = this.child;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 15_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.send({ type: "shutdown" });
    });
  }
}
