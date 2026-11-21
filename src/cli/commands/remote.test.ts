/**
 * exec / resume / login against the real Web server (src/server/index.ts:
 * auth, /ws clientToken, /api/core/invoke allowlist) backed by a fake headless
 * core (src/cli/__fixtures__/fake-core.cjs). No model is called and nothing
 * leaves 127.0.0.1. The same fake core also exercises `--local`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../app";
import { createWebServer, type WebServerHandle } from "../../server/index";
import { credentialsPath, readCredentials } from "../remote/credentials";
import { cmdResume } from "./resume";

vi.setConfig({ testTimeout: 20_000 });

const USERNAME = "cyrene-admin";
const PASSWORD = "fixture-password-不可泄露-123";
const FAKE_CORE = path.resolve(__dirname, "..", "__fixtures__", "fake-core.cjs");

let handle: WebServerHandle;
let base: string;
let dataDir: string;
let appRoot: string;
let tmpHome: string;
let stdout = "";
let stderr = "";
const spies: Array<{ mockRestore(): void }> = [];

function coreLog(dir = dataDir): Array<{ channel: string; args: unknown[] }> {
  const file = path.join(dir, "fake-core-log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function login(): Promise<number> {
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  stdin.end(`${PASSWORD}\n`);
  const { cmdLogin } = await import("./login");
  return cmdLogin(["--server", base, "--username", USERNAME, "--password-stdin"], { stdin });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cyrene-cli-web-data-"));
  appRoot = mkdtempSync(path.join(tmpdir(), "cyrene-cli-app-root-"));
  mkdirSync(path.join(appRoot, "dist", "headless"), { recursive: true });
  copyFileSync(FAKE_CORE, path.join(appRoot, "dist", "headless", "core.cjs"));
  process.env.CYRENE_APP_ROOT = appRoot;
  handle = createWebServer({ dataDir, setupToken: "fixture-setup", secureCookies: false, logger: { info() {}, warn() {}, error() {} } });
  await handle.auth.bootstrap(USERNAME, PASSWORD);
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  base = `http://127.0.0.1:${address.port}`;
  await handle.startChannels();
}, 60_000);

afterAll(async () => {
  await handle?.close();
  delete process.env.CYRENE_APP_ROOT;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(appRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "cyrene-cli-home-"));
  process.env.CYRENE_HOME = tmpHome;
  stdout = "";
  stderr = "";
  spies.push(vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; }));
  spies.push(vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; }));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.CYRENE_HOME;
  delete process.env.CYRENE_USERNAME;
  delete process.env.CYRENE_PASSWORD;
  delete process.env.CYRENE_SERVER;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("cyrene login", () => {
  it("saves only the session token and never prints the password or token", async () => {
    expect(await login()).toBe(0);
    const saved = readCredentials().sessions[base];
    expect(saved).toMatchObject({ server: base, username: USERNAME });
    expect(saved.sessionToken.length).toBeGreaterThan(10);
    const raw = readFileSync(credentialsPath(), "utf8");
    expect(raw).not.toContain(PASSWORD);
    expect(stdout + stderr).not.toContain(PASSWORD);
    expect(stdout + stderr).not.toContain(saved.sessionToken);
  });

  it("reports a wrong password with exit code 3 and saves nothing", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end("wrong-password\n");
    const { cmdLogin } = await import("./login");
    expect(await cmdLogin(["--server", base, "--username", USERNAME, "--password-stdin"], { stdin })).toBe(3);
    expect(stderr).toContain("用户名或密码错误");
    expect(existsSync(credentialsPath())).toBe(false);
    expect(await login()).toBe(0); // resets the server's failure counter for later tests
  });

  it("rejects a password passed as an argument", async () => {
    expect(await main(["login", "--server", base, PASSWORD])).toBe(2);
    expect(stderr).toContain("不要在命令行参数中传入密码");
  });
});

describe("cyrene exec over the Web service", () => {
  it("streams the reply once, sends tool activity to stderr and exits 0", async () => {
    await login();
    stdout = ""; stderr = "";
    const code = await main(["exec", "--server", base, "今天好吗"]);
    expect(code).toBe(0);
    // Candidate text streamed first; the final text only adds the remainder.
    expect(stdout).toBe("你好，我是昔涟。收到：今天好吗\n");
    expect(stderr).toContain("[工具] 读取文件");
    expect(stderr).toMatch(/会话：s-\d+/);
    const run = coreLog().find((entry) => entry.channel === "agui:run");
    expect(run?.args[0]).toMatchObject({ currentUser: { text: "今天好吗", visibleContent: "今天好吗" }, styleId: "style-1" });
  });

  it("emits JSON lines with session, AG-UI events and result", async () => {
    await login();
    stdout = "";
    const code = await main(["exec", "--server", base, "--json", "--", "-json 测试"]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "session", mode: "chat", created: true });
    expect(lines.some((line) => line.type === "agui" && line.event.type === "RUN_STARTED")).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "success", exitCode: 0, text: "你好，我是昔涟。收到：-json 测试" });
  });

  it("logs in from CYRENE_USERNAME/CYRENE_PASSWORD without saving credentials", async () => {
    process.env.CYRENE_USERNAME = USERNAME;
    process.env.CYRENE_PASSWORD = PASSWORD;
    expect(await main(["exec", "--server", base, "你好"])).toBe(0);
    expect(existsSync(credentialsPath())).toBe(false);
    expect(stdout + stderr).not.toContain(PASSWORD);
  });

  it("exits 3 when not logged in", async () => {
    expect(await main(["exec", "--server", base, "你好"])).toBe(3);
    expect(stderr).toContain("尚未登录");
  });

  it("exits 3 when the saved session was revoked", async () => {
    await login();
    const token = readCredentials().sessions[base].sessionToken;
    handle.auth.revokeSession(token);
    expect(await main(["exec", "--server", base, "你好"])).toBe(3);
    expect(stderr).toContain("登录已过期");
  });

  it("exits 1 on RUN_ERROR and prints the error", async () => {
    await login();
    expect(await main(["exec", "--server", base, "fail 一下"])).toBe(1);
    expect(stderr).toContain("模型请求失败：401 invalid key");
  });

  it("binds the workspace for code mode and applies the model profile", async () => {
    await login();
    const workspace = mkdtempSync(path.join(tmpdir(), "cyrene-cli-ws-"));
    try {
      expect(await main(["exec", "--server", base, "--mode", "code", "--workspace", workspace, "--model-profile", "p2", "看看项目"])).toBe(0);
      const log = coreLog();
      expect(log.find((entry) => entry.channel === "chats:set-workspace" && (entry.args[0] as { workspaceRoot: string }).workspaceRoot === workspace)).toBeTruthy();
      expect(log.find((entry) => entry.channel === "chats:set-model-profile" && (entry.args[0] as { modelProfileId: string }).modelProfileId === "p2")).toBeTruthy();
      // Profile objects from the core contain API keys; they must never reach the terminal.
      expect(stdout + stderr).not.toContain("sk-fixture-secret");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an unknown model profile with exit 2, lists only ids, and deletes the new session", async () => {
    await login();
    expect(await main(["exec", "--server", base, "--model-profile", "nope", "你好"])).toBe(2);
    expect(stderr).toContain("可用档案：p1, p2");
    expect(stderr).not.toContain("sk-fixture-secret");
    const created = coreLog().filter((entry) => entry.channel === "chats:create").length;
    const deleted = coreLog().filter((entry) => entry.channel === "chats:delete").length;
    expect(deleted).toBeGreaterThan(0);
    expect(created).toBeGreaterThanOrEqual(deleted);
  });

  it("sends AGUI_CANCEL on Ctrl+C and exits 130", async () => {
    await login();
    const running = main(["exec", "--server", base, "hang 很久"]);
    await waitFor(() => stdout.includes("正在思考"));
    process.emit("SIGINT");
    expect(await running).toBe(130);
    const cancel = coreLog().find((entry) => entry.channel === "agui:cancel");
    const run = coreLog().filter((entry) => entry.channel === "agui:run").at(-1);
    expect(cancel?.args[0]).toMatch(/^run-\d+$/);
    expect(run).toBeTruthy();
    expect(stderr).toContain("已取消本轮");
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("continues an existing session with --session and refuses a mode mismatch", async () => {
    await login();
    expect(await main(["exec", "--server", base, "--session", "seed-chat", "继续"])).toBe(0);
    expect(coreLog().filter((entry) => entry.channel === "agui:run").at(-1)?.args[0]).toMatchObject({ sessionId: "seed-chat" });
    expect(await main(["exec", "--server", base, "--session", "seed-chat", "--mode", "code", "继续"])).toBe(2);
    expect(await main(["exec", "--server", base, "--session", "missing", "继续"])).toBe(2);
  });
});

describe("cyrene resume over the Web service", () => {
  it("lists recent sessions newest first", async () => {
    await login();
    stdout = "";
    expect(await cmdResume(["--server", base, "--json", "--limit", "50"])).toBe(0);
    const sessions = JSON.parse(stdout) as Array<{ id: string; updatedAt: number }>;
    expect(sessions.map((item) => item.id)).toContain("seed-chat");
    const times = sessions.map((item) => item.updatedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("runs one turn per stdin line and stops at /exit", async () => {
    await login();
    const before = coreLog().filter((entry) => entry.channel === "agui:run").length;
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end("第一句\n\n第二句\n/exit\n第三句不会发送\n");
    expect(await cmdResume(["--server", base, "seed-chat"], { stdin })).toBe(0);
    const runs = coreLog().filter((entry) => entry.channel === "agui:run").slice(before);
    expect(runs.map((entry) => (entry.args[0] as { currentUser: { text: string } }).currentUser.text)).toEqual(["第一句", "第二句"]);
    expect(stderr).toContain("聊到了花园里的玫瑰");
    expect(stdout).toContain("收到：第二句");
  });

  it("resume <id> <prompt> runs a single turn", async () => {
    await login();
    expect(await main(["resume", "--server", base, "seed-chat", "单轮", "提问"])).toBe(0);
    expect(stdout).toContain("收到：单轮 提问");
  });
});

describe("cyrene exec --local", () => {
  it("starts the headless core with --data-dir and runs a turn without a server", async () => {
    const localData = mkdtempSync(path.join(tmpdir(), "cyrene-cli-local-"));
    try {
      expect(await main(["exec", "--local", "--data-dir", localData, "--app-root", appRoot, "本地你好"])).toBe(0);
      expect(stdout).toContain("收到：本地你好");
      expect(coreLog(localData).some((entry) => entry.channel === "agui:run")).toBe(true);
    } finally {
      rmSync(localData, { recursive: true, force: true });
    }
  });

  it("explains how to build the core when it is missing", async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "cyrene-cli-empty-root-"));
    try {
      expect(await main(["exec", "--local", "--app-root", emptyRoot, "--data-dir", emptyRoot, "你好"])).toBe(3);
      expect(stderr).toContain("build:server");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
