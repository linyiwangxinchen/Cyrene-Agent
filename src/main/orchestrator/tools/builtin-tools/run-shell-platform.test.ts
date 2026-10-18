import { EventEmitter } from "node:events";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShellTool } from "./run-shell-tool";
import { resolveShellExecutable } from "../../shell-runtime";
import { wrapWithSandbox } from "../../sandbox/sandbox-exec";

vi.mock("../../shell-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shell-runtime")>(),
  resolveShellExecutable: vi.fn(async () => ({ kind: "bash", executable: "/bin/bash" })),
}));
vi.mock("../../sandbox/sandbox-exec", () => ({ wrapWithSandbox: vi.fn() }));
vi.mock("../../../permission", () => ({ getCurrentLevel: () => "read-only" }));
vi.mock("child_process", () => ({ spawn: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("Linux run_shell 执行与权限边界", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    vi.clearAllMocks();
    vi.mocked(wrapWithSandbox).mockResolvedValue({ ok: false, reason: "not_ready" });
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 123, kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("created"));
        child.emit("close", 0);
      });
      return child as never;
    });
  });
  afterEach(() => Object.defineProperty(process, "platform", originalPlatform));

  it("省略 shell 时使用 Bash 执行，完全信任仍遵循原有权限契约", async () => {
    const result = JSON.parse(await runShellTool.execute({ command: "printf created" }, { permissionMode: "allow_all" } as never));
    expect(resolveShellExecutable).toHaveBeenCalledWith("bash");
    expect(spawn).toHaveBeenCalledWith("/bin/bash", ["--noprofile", "--norc", "-lc", "printf created"], expect.any(Object));
    expect(result).toMatchObject({ shell: "bash", exitCode: 0, stdout: "created" });
  });

  it("显式 cmd 返回平台不支持，不尝试 spawn", async () => {
    const result = JSON.parse(await runShellTool.execute({ command: "echo hi", shell: "cmd" }));
    expect(result.errorCode).toBe("SHELL_UNSUPPORTED");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("修复 Bash 发现后，未授权写命令仍不能绕过沙箱", async () => {
    const result = JSON.parse(await runShellTool.execute({ command: "printf no > file.txt" }));
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("沙箱");
    expect(spawn).not.toHaveBeenCalled();
  });
});
