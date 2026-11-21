import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import { HookRunner } from "../../hooks/hook-runner";
import type { HookProcessInput, HookProcessResult } from "../../hooks/hook-process";
import { dispatchToolCall } from "./tool-dispatcher";
import type { AgentState } from "./types";

let dir: string;
let configPath: string;

function state(): AgentState {
  return { todoItems: [], uncertainEffects: [] };
}

function shellTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    id: "run_shell",
    name: "执行命令",
    description: "shell",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    effectKind: "write",
    execute,
  };
}

function call(args: Record<string, unknown>) {
  return { id: "call-1", name: "run_shell", arguments: JSON.stringify(args) };
}

/** 假进程：按 stdin 决定 stdout，记录每次调用。 */
function fakeRunner(respond: (payload: Record<string, unknown>) => Record<string, unknown> | HookProcessResult) {
  const calls: Array<Record<string, unknown>> = [];
  const runProcess = vi.fn(async (input: HookProcessInput): Promise<HookProcessResult> => {
    const payload = JSON.parse(input.stdin) as Record<string, unknown>;
    calls.push(payload);
    const out = respond(payload);
    if ("ok" in out && typeof out.ok === "boolean") return out as HookProcessResult;
    return { ok: true, stdout: JSON.stringify(out), stderr: "", durationMs: 1 };
  });
  let tick = 0;
  const hooks = new HookRunner({ configPath, host: "desktop", runProcess, now: () => (tick += 10_000) });
  return { hooks, calls, runProcess };
}

function writeConfig(hooks: Record<string, unknown[]>): void {
  fs.writeFileSync(configPath, JSON.stringify({ hooks }), "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dispatch-hooks-"));
  configPath = path.join(dir, "hooks.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("dispatchToolCall 用户 Hooks", () => {
  it("PreToolUse 拒绝作为工具失败反馈给模型，工具与权限检查都不执行", async () => {
    writeConfig({ PreToolUse: [{ command: "guard", matcher: "run_*" }] });
    const { hooks } = fakeRunner(() => ({ decision: "deny", reason: "生产目录禁止执行" }));
    const execute = vi.fn(async () => "ran");
    const checkPermission = vi.fn(async () => true);
    const result = await dispatchToolCall(call({ command: "deploy" }), {
      state: state(), tools: [shellTool(execute)], hooks, checkPermission,
    });
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(result.message).toContain("生产目录禁止执行");
    expect(execute).not.toHaveBeenCalled();
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it("匹配器不命中时不启动 Hook", async () => {
    writeConfig({ PreToolUse: [{ command: "guard", matcher: "write_file" }] });
    const { hooks, runProcess } = fakeRunner(() => ({ decision: "deny" }));
    const execute = vi.fn(async () => "ran");
    const result = await dispatchToolCall(call({ command: "ls" }), { state: state(), tools: [shellTool(execute)], hooks });
    expect(result.outcome).toBe("success");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("改写后的参数重新经过权限检查，不能借改写绕过权限", async () => {
    writeConfig({ PreToolUse: [{ command: "rewrite" }] });
    const { hooks } = fakeRunner(() => ({ updatedInput: { command: "rm -rf /" } }));
    const execute = vi.fn(async () => "ran");
    const checkPermission = vi.fn(async (_id: string, args: Record<string, unknown>) => args.command === "ls");
    const result = await dispatchToolCall(call({ command: "ls" }), {
      state: state(), tools: [shellTool(execute)], hooks, checkPermission,
    });
    expect(checkPermission).toHaveBeenCalledWith("run_shell", { command: "rm -rf /" });
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("改写被权限放行时工具以新参数执行", async () => {
    writeConfig({ PreToolUse: [{ command: "rewrite" }] });
    const { hooks } = fakeRunner(() => ({ updatedInput: { command: "ls -la" } }));
    const execute = vi.fn(async (args: Record<string, unknown>) => `ran ${String(args.command)}`);
    const result = await dispatchToolCall(call({ command: "ls" }), {
      state: state(), tools: [shellTool(execute)], hooks, checkPermission: async () => true,
    });
    expect(execute.mock.calls[0]?.[0]).toEqual({ command: "ls -la" });
    expect(result.output).toBe("ran ls -la");
  });

  it("改写不能让工具指向 Hooks 配置文件", async () => {
    writeConfig({ PreToolUse: [{ command: "rewrite" }] });
    const { hooks } = fakeRunner(() => ({ updatedInput: { command: `echo {} > ${configPath}` } }));
    const execute = vi.fn(async () => "ran");
    const result = await dispatchToolCall(call({ command: "ls" }), {
      state: state(), tools: [shellTool(execute)], hooks, checkPermission: async () => true,
    });
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("渠道 allow_all 运行同样受 PreToolUse 拒绝约束，payload 标明渠道", async () => {
    writeConfig({ PreToolUse: [{ command: "guard" }] });
    const { hooks, calls } = fakeRunner((payload) => payload.channel === "wechat"
      ? { decision: "deny", reason: "微信渠道禁止执行命令" }
      : {});
    const execute = vi.fn(async () => "ran");
    // allow_all：权限系统总是放行
    const result = await dispatchToolCall(call({ command: "ls" }), {
      state: state(),
      tools: [shellTool(execute)],
      hooks,
      checkPermission: async () => true,
      toolContext: {
        userQuery: "",
        conversationId: "conv-1",
        runId: "run-1",
        permissionMode: "allow_all",
        channelContext: { channel: "wechat", targetId: "wx-1", sessionId: "wechat:wx-1" },
      },
    });
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(result.message).toContain("微信渠道禁止执行命令");
    expect(execute).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ event: "PreToolUse", channel: "wechat", sessionId: "conv-1", runId: "run-1", toolName: "run_shell" });
  });

  it("PreToolUse 失败默认放行，failClosed 拒绝", async () => {
    const failure: HookProcessResult = { ok: false, kind: "exit", message: "退出码 1", stderr: "", durationMs: 1 };
    writeConfig({ PreToolUse: [{ command: "guard" }] });
    const open = fakeRunner(() => failure);
    const execute = vi.fn(async () => "ran");
    await expect(dispatchToolCall(call({ command: "ls" }), { state: state(), tools: [shellTool(execute)], hooks: open.hooks }))
      .resolves.toMatchObject({ outcome: "success" });
    writeConfig({ PreToolUse: [{ command: "guard", failClosed: true }] });
    const closed = fakeRunner(() => failure);
    const denied = await dispatchToolCall(call({ command: "ls" }), { state: state(), tools: [shellTool(execute)], hooks: closed.hooks });
    expect(denied).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(denied.message).toContain("fail-closed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("PostToolUse 拿到结果并追加给模型的补充说明", async () => {
    writeConfig({ PostToolUse: [{ command: "post", matcher: "run_shell" }] });
    const { hooks, calls } = fakeRunner(() => ({ additionalContext: "提醒：输出里有警告" }));
    const result = await dispatchToolCall(call({ command: "ls" }), {
      state: state(), tools: [shellTool(async () => "warning: x")], hooks,
    });
    expect(result.hookContext).toBe("提醒：输出里有警告");
    expect(calls[0]).toMatchObject({
      event: "PostToolUse", toolName: "run_shell", toolInput: { command: "ls" },
      toolResult: { outcome: "success", output: "warning: x" },
    });
  });

  it("无配置时即使没有 Hook 也拒绝写入 Hooks 配置文件", async () => {
    const { hooks, runProcess } = fakeRunner(() => ({}));
    const execute = vi.fn(async () => "ran");
    const result = await dispatchToolCall(call({ command: `echo {"hooks":{}} > "${configPath}"` }), {
      state: state(), tools: [shellTool(execute)], hooks, checkPermission: async () => true,
    });
    expect(result).toMatchObject({ outcome: "failure", category: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("真实 Hook 进程拒绝工具", async () => {
    const script = path.join(dir, "deny.js");
    fs.writeFileSync(script, `
let raw = ""; process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  process.stdout.write(JSON.stringify({ decision: "deny", reason: "真实进程拒绝 " + input.toolInput.command }));
});`, "utf8");
    writeConfig({ PreToolUse: [{ command: process.execPath, args: [script], timeoutMs: 10_000 }] });
    const hooks = new HookRunner({ configPath, host: "desktop" });
    const execute = vi.fn(async () => "ran");
    const result = await dispatchToolCall(call({ command: "whoami" }), { state: state(), tools: [shellTool(execute)], hooks });
    expect(result.message).toContain("真实进程拒绝 whoami");
    expect(execute).not.toHaveBeenCalled();
  });
});
