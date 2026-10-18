import { EventEmitter } from "node:events";
import fs from "fs";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultShellKind, resolveShellExecutable } from "./shell-runtime";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe("跨平台 Shell 探测", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("cyrene-bash-probe"));
        child.emit("close", 0);
      });
      return child as never;
    });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("Linux 从服务 PATH 找到原生 bash，不探测 bash.exe", async () => {
    setPlatform("linux");
    vi.stubEnv("PATH", "/opt/tools:/usr/bin");
    vi.spyOn(fs, "existsSync").mockImplementation((file) => file === "/usr/bin/bash");
    expect(getDefaultShellKind()).toBe("bash");
    expect(await resolveShellExecutable("bash")).toEqual({ kind: "bash", executable: "/usr/bin/bash" });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/bash", expect.arrayContaining(["-lc", "printf cyrene-bash-probe"]), expect.any(Object));
  });

  it("systemd PATH 缺失时仍能找到 /bin/bash，且不降级为 cmd", async () => {
    setPlatform("linux");
    vi.stubEnv("PATH", "");
    vi.spyOn(fs, "existsSync").mockImplementation((file) => file === "/bin/bash");
    expect(await resolveShellExecutable("bash")).toEqual({ kind: "bash", executable: "/bin/bash" });
    expect(await resolveShellExecutable("cmd")).toBeNull();
  });

  it("文件存在但解释器无法启动时诚实返回不可用", async () => {
    setPlatform("linux");
    vi.stubEnv("PATH", "/bin");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
      queueMicrotask(() => child.emit("error", new Error("permission denied")));
      return child as never;
    });
    expect(await resolveShellExecutable("bash")).toBeNull();
  });

  it("Windows 保留 cmd 默认解释器和 Git Bash 路径", async () => {
    setPlatform("win32");
    vi.stubEnv("PATH", "C:\\Tools;C:\\Git\\bin");
    vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
    vi.spyOn(fs, "existsSync").mockImplementation((file) => file === "C:\\Git\\bin\\bash.exe");
    expect(getDefaultShellKind()).toBe("cmd");
    expect(await resolveShellExecutable("cmd")).toEqual({ kind: "cmd", executable: process.env.ComSpec });
    expect(await resolveShellExecutable("bash")).toEqual({ kind: "bash", executable: "C:\\Git\\bin\\bash.exe" });
  });
});
