import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileToolMatcher, parseHooksConfig } from "./hook-config";
import { buildHookEnv } from "./hook-process";
import { HookRunner } from "./hook-runner";
import { logger } from "../logger";

let dir: string;
let configPath: string;

function writeScript(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** 读取 stdin JSON 后执行 body（body 可访问 input 变量）。 */
function nodeHook(name: string, body: string): { command: string; args: string[] } {
  const file = writeScript(name, `
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  ${body}
});
`);
  return { command: process.execPath, args: [file] };
}

function writeConfig(hooks: Record<string, unknown[]>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(configPath, JSON.stringify({ ...extra, hooks }), "utf8");
}

function runner(): HookRunner {
  // now 每次递增，绕过 1 秒 stat 节流，确保每个用例读到最新配置
  let tick = 0;
  return new HookRunner({ configPath, host: "desktop", now: () => (tick += 10_000) });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-hooks-"));
  configPath = path.join(dir, "hooks.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("compileToolMatcher", () => {
  it("支持全匹配、通配、多候选与正则", () => {
    expect(compileToolMatcher(undefined)("anything")).toBe(true);
    expect(compileToolMatcher("*")("run_shell")).toBe(true);
    expect(compileToolMatcher("run_shell")("run_shell")).toBe(true);
    expect(compileToolMatcher("run_shell")("run_shell_x")).toBe(false);
    expect(compileToolMatcher("mcp__*")("mcp__github__issue")).toBe(true);
    expect(compileToolMatcher("mcp__*")("read_file")).toBe(false);
    expect(compileToolMatcher("write_file|edit_file")("edit_file")).toBe(true);
    expect(compileToolMatcher("file_?")("file_a")).toBe(true);
    expect(compileToolMatcher("a.b")("axb")).toBe(false);
    expect(compileToolMatcher("/^(write|edit)_/i")("WRITE_file")).toBe(true);
    expect(compileToolMatcher("/^(write|edit)_/")("read_file")).toBe(false);
  });

  it("单条配置无效时跳过该条，其余照常生效", () => {
    const parsed = parseHooksConfig(JSON.stringify({
      hooks: {
        PreToolUse: [{ command: "" }, { command: "node", matcher: "/(/" }, { command: "node", args: ["a"], failClosed: true }],
        Stop: [{ command: "node", failClosed: true }],
        Unknown: [],
      },
    }));
    expect(parsed.config.PreToolUse).toHaveLength(1);
    expect(parsed.config.PreToolUse[0]).toMatchObject({ failClosed: true, timeoutMs: 30_000 });
    expect(parsed.config.Stop[0].failClosed).toBe(false);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(4);
  });
});

describe("HookRunner 配置加载", () => {
  it("配置不存在时零开销：不启动进程", async () => {
    const runProcess = vi.fn();
    const hooks = new HookRunner({ configPath, host: "desktop", runProcess });
    expect(hooks.getConfig()).toBeNull();
    expect(hooks.hasHooks("PreToolUse", "run_shell")).toBe(false);
    await expect(hooks.runPreToolUse({ toolName: "run_shell", toolInput: {} })).resolves.toEqual({ decision: "allow" });
    await expect(hooks.runUserPromptSubmit({ prompt: "hi" })).resolves.toEqual({ decision: "allow" });
    await expect(hooks.runSessionStart({})).resolves.toBeUndefined();
    await hooks.runStop({ status: "success" });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("配置损坏时不崩溃，记录错误并按无 Hook 处理", async () => {
    fs.writeFileSync(configPath, "{ not json", "utf8");
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const runProcess = vi.fn();
    const hooks = new HookRunner({ configPath, host: "desktop", runProcess });
    expect(hooks.getConfig()).toBeNull();
    await expect(hooks.runPreToolUse({ toolName: "x", toolInput: {} })).resolves.toEqual({ decision: "allow" });
    expect(error).toHaveBeenCalledWith("Hooks", expect.stringContaining("Hooks 配置损坏"), expect.anything());
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("配置文件变化后重新加载", () => {
    let now = 0;
    const hooks = new HookRunner({ configPath, host: "desktop", now: () => now });
    expect(hooks.hasHooks("Stop")).toBe(false);
    writeConfig({ Stop: [{ command: "node" }] });
    now += 1_500;
    expect(hooks.hasHooks("Stop")).toBe(true);
  });
});

describe("HookRunner 真实进程", () => {
  it("PreToolUse 按匹配器执行，stdin 携带事件、会话、渠道与参数", async () => {
    const seen = path.join(dir, "seen.json");
    const hook = nodeHook("record.js", `require("fs").writeFileSync(${JSON.stringify(seen)}, raw); process.stdout.write("{}");`);
    writeConfig({ PreToolUse: [{ ...hook, matcher: "run_shell" }] });
    const hooks = runner();
    await hooks.runPreToolUse({ toolName: "read_file", toolInput: {} });
    expect(fs.existsSync(seen)).toBe(false);
    const outcome = await hooks.runPreToolUse({
      toolName: "run_shell", toolInput: { command: "ls" }, sessionId: "s1", runId: "r1", channel: "wechat", mode: "work",
    });
    expect(outcome).toEqual({ decision: "allow" });
    expect(JSON.parse(fs.readFileSync(seen, "utf8"))).toEqual({
      event: "PreToolUse", sessionId: "s1", runId: "r1", channel: "wechat", mode: "work",
      toolName: "run_shell", toolInput: { command: "ls" },
    });
  });

  it("PreToolUse 拒绝时返回原因，改写参数在多条 Hook 间串联", async () => {
    const rewrite = nodeHook("rewrite.js", `process.stdout.write(JSON.stringify({ updatedInput: { ...input.toolInput, safe: true } }));`);
    const guard = nodeHook("guard.js", `
if (input.toolInput.command.includes("rm")) process.stdout.write(JSON.stringify({ decision: "deny", reason: "禁止删除" }));
else process.stdout.write(JSON.stringify({ updatedInput: { ...input.toolInput, checked: input.toolInput.safe === true } }));`);
    writeConfig({ PreToolUse: [rewrite, guard] });
    const hooks = runner();
    await expect(hooks.runPreToolUse({ toolName: "run_shell", toolInput: { command: "rm -rf x" } }))
      .resolves.toEqual({ decision: "deny", reason: "禁止删除" });
    await expect(hooks.runPreToolUse({ toolName: "run_shell", toolInput: { command: "ls" } }))
      .resolves.toEqual({ decision: "allow", updatedInput: { command: "ls", safe: true, checked: true } });
  });

  it("非零退出默认放行，failClosed 时拒绝", async () => {
    const failing = nodeHook("fail.js", `process.stderr.write("boom"); process.exit(3);`);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    writeConfig({ PreToolUse: [failing] });
    await expect(runner().runPreToolUse({ toolName: "t", toolInput: {} })).resolves.toEqual({ decision: "allow" });
    writeConfig({ PreToolUse: [{ ...failing, failClosed: true }] });
    const denied = await runner().runPreToolUse({ toolName: "t", toolInput: {} });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("退出码 3");
    expect(denied.reason).toContain("fail-closed");
  });

  it("超时会终止进程；默认放行，failClosed 时拒绝", async () => {
    const slow = nodeHook("slow.js", `setTimeout(() => process.stdout.write(JSON.stringify({ decision: "deny", reason: "late" })), 10_000);`);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    writeConfig({ PreToolUse: [{ ...slow, timeoutMs: 300 }] });
    const started = Date.now();
    await expect(runner().runPreToolUse({ toolName: "t", toolInput: {} })).resolves.toEqual({ decision: "allow" });
    expect(Date.now() - started).toBeLessThan(5_000);
    writeConfig({ PreToolUse: [{ ...slow, timeoutMs: 300, failClosed: true }] });
    const denied = await runner().runPreToolUse({ toolName: "t", toolInput: {} });
    expect(denied).toMatchObject({ decision: "deny" });
    expect(denied.reason).toContain("超时");
  });

  it("stdout 不是 JSON 视为失败", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    writeConfig({ PreToolUse: [{ ...nodeHook("text.js", `process.stdout.write("hello");`), failClosed: true }] });
    await expect(runner().runPreToolUse({ toolName: "t", toolInput: {} })).resolves.toMatchObject({ decision: "deny" });
  });

  it("UserPromptSubmit / SessionStart 追加上下文，拒绝时停止", async () => {
    writeConfig({
      SessionStart: [nodeHook("start.js", `process.stdout.write(JSON.stringify({ additionalContext: "今天是周五" }));`)],
      UserPromptSubmit: [nodeHook("prompt.js", `
if (input.prompt.includes("密码")) process.stdout.write(JSON.stringify({ decision: "deny", reason: "含敏感词" }));
else process.stdout.write(JSON.stringify({ additionalContext: "渠道=" + input.channel }));`)],
    });
    const hooks = runner();
    await expect(hooks.runSessionStart({})).resolves.toBe("今天是周五");
    await expect(hooks.runUserPromptSubmit({ prompt: "你好", channel: "qq" }))
      .resolves.toEqual({ decision: "allow", additionalContext: "渠道=qq" });
    await expect(hooks.runUserPromptSubmit({ prompt: "我的密码是" }))
      .resolves.toEqual({ decision: "deny", reason: "含敏感词" });
  });

  it("Hook 进程环境不包含 API Key 等密钥变量", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-should-not-leak");
    vi.stubEnv("CYRENE_CHANNEL_TOKEN", "tok-should-not-leak");
    writeConfig({ SessionStart: [{
      ...nodeHook("env.js", `process.stdout.write(JSON.stringify({ additionalContext: JSON.stringify(process.env) }));`),
      env: { MY_HOOK_FLAG: "1" },
    }] });
    const context = await runner().runSessionStart({});
    const env = JSON.parse(context ?? "{}") as Record<string, string>;
    expect(JSON.stringify(env)).not.toContain("should-not-leak");
    expect(env.MY_HOOK_FLAG).toBe("1");
    expect(env.CYRENE_HOOK_EVENT).toBe("SessionStart");
    vi.unstubAllEnvs();
  });
});

describe("buildHookEnv", () => {
  it("只透传白名单变量", () => {
    const env = buildHookEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "x", HOME: "/h", RANDOM_VAR: "y" }, {}, "Stop");
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CYRENE_HOOK_EVENT: "Stop" });
  });
});

describe("referencesConfigFile", () => {
  it("识别绝对路径与按工作区解析的相对路径", () => {
    const hooks = new HookRunner({ configPath, host: "web" });
    expect(hooks.referencesConfigFile({ path: configPath })).toBe(true);
    expect(hooks.referencesConfigFile({ command: `echo {} > "${configPath.replace(/\\/g, "/")}"` })).toBe(true);
    expect(hooks.referencesConfigFile({ path: "hooks.json" }, dir)).toBe(true);
    expect(hooks.referencesConfigFile({ path: "hooks.json" }, path.join(dir, "project"))).toBe(false);
    expect(hooks.referencesConfigFile({ path: path.join(dir, "other.json") })).toBe(false);
  });
});
