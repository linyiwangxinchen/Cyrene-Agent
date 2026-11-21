/**
 * 单次 Hook 进程执行：cross-spawn 启动（不经 shell 拼接），stdin 写入 JSON，
 * 读取 stdout，按退出码与超时判定成败。
 *
 * 环境变量走白名单：只透传系统运行必需的变量，名称疑似密钥的一律剔除，
 * 避免把模型 API Key、渠道令牌等泄露给 Hook 脚本。
 */

import spawn from "cross-spawn";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

const STDOUT_LIMIT_BYTES = 256 * 1024;
const STDERR_LIMIT_BYTES = 16 * 1024;
const KILL_GRACE_MS = 2_000;

/** 透传给 Hook 的系统环境变量（大小写不敏感）。 */
const ENV_ALLOWLIST = new Set([
  "path", "pathext", "systemroot", "systemdrive", "windir", "comspec", "os",
  "home", "homedrive", "homepath", "userprofile", "appdata", "localappdata",
  "programdata", "programfiles", "programfiles(x86)", "programw6432", "public",
  "temp", "tmp", "tmpdir", "lang", "language", "lc_all", "lc_ctype", "lc_messages", "tz",
  "user", "username", "logname", "shell", "number_of_processors", "processor_architecture",
  "xdg_runtime_dir", "xdg_config_home", "xdg_data_home", "xdg_cache_home",
]);
const SECRET_NAME = /(key|token|secret|passw|credential|auth|cookie|session)/i;

export function buildHookEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  eventName: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!ENV_ALLOWLIST.has(name.toLowerCase()) || SECRET_NAME.test(name)) continue;
    env[name] = value;
  }
  // 用户在本机 hooks.json 中显式配置的变量视为可信输入
  Object.assign(env, extra);
  env.CYRENE_HOOK_EVENT = eventName;
  return env;
}

export interface HookProcessInput {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type HookProcessResult =
  | { ok: true; stdout: string; stderr: string; durationMs: number }
  | { ok: false; kind: "timeout" | "exit" | "spawn" | "aborted"; message: string; stderr: string; durationMs: number };

function killTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.on("error", () => { try { child.kill(); } catch { /* 已退出 */ } });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
  }
}

export function runHookProcess(input: HookProcessInput): Promise<HookProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    const finish = (result: HookProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (kind: "timeout" | "exit" | "spawn" | "aborted", message: string) =>
      finish({ ok: false, kind, message, stderr: stderr.trim(), durationMs: Date.now() - startedAt });
    // 终止进程树后等待 close（最多宽限 2s），避免返回后残留进程继续占用文件或执行副作用
    let terminating: { kind: "timeout" | "aborted"; message: string } | undefined;
    const terminate = (kind: "timeout" | "aborted", message: string) => {
      if (settled || terminating) return;
      terminating = { kind, message };
      if (timer) clearTimeout(timer);
      killTree(child);
      const grace = setTimeout(() => fail(kind, message), KILL_GRACE_MS);
      grace.unref?.();
    };
    const onAbort = () => terminate("aborted", "运行已取消");
    if (input.signal?.aborted) {
      fail("aborted", "运行已取消");
      return;
    }
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        // Unix 下自成进程组，超时可整组终止
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      fail("spawn", error instanceof Error ? error.message : String(error));
      return;
    }
    child.on("error", (error) => fail("spawn", error.message));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= STDOUT_LIMIT_BYTES) return;
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= STDERR_LIMIT_BYTES) return;
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signalName) => {
      if (terminating) {
        fail(terminating.kind, terminating.message);
        return;
      }
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        fail("exit", `stdout 超过 ${STDOUT_LIMIT_BYTES} 字节上限`);
        return;
      }
      if (code === 0) {
        finish({ ok: true, stdout, stderr: stderr.trim(), durationMs: Date.now() - startedAt });
        return;
      }
      fail("exit", signalName ? `进程被信号 ${signalName} 终止` : `退出码 ${code}`);
    });
    // 脚本可能不读 stdin 就退出，EPIPE 不算 Hook 失败，以退出码为准
    child.stdin?.on("error", () => {});
    child.stdin?.end(input.stdin, "utf8");
    timer = setTimeout(() => terminate("timeout", `超过 ${input.timeoutMs}ms 未结束`), input.timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
