import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const electron = vi.hoisted(() => ({
  openPath: vi.fn(async (_target: string) => ""),
  getPath: vi.fn((name: string) => (name === "userData" ? "C:\\Users\\demo\\AppData\\Roaming\\Cyrene" : "")),
}));

// 只替换 Electron 边界；handler → openUserDataFolder → shell.openPath 走真实代码
vi.mock("electron", () => ({
  app: { getPath: electron.getPath },
  shell: { openPath: electron.openPath },
}));

import { registerDataDirIpc } from "./data-dir-ipc";

function register() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  registerDataDirIpc({ handle: (channel, listener) => { handlers[channel] = listener; } });
  return handlers;
}

afterEach(() => {
  vi.clearAllMocks();
  electron.openPath.mockResolvedValue("");
});

describe("数据目录 IPC", () => {
  it("返回 userData 路径", async () => {
    expect(await register()[IPC.SETTINGS_GET_DATA_DIR]()).toBe("C:\\Users\\demo\\AppData\\Roaming\\Cyrene");
  });

  it("打开成功时返回 ok，并打开 userData 目录", async () => {
    expect(await register()[IPC.SETTINGS_OPEN_DATA_DIR]()).toEqual({ ok: true });
    expect(electron.openPath).toHaveBeenCalledWith("C:\\Users\\demo\\AppData\\Roaming\\Cyrene");
  });

  it("shell.openPath 返回错误文本时透传为 ok:false，而不是吞掉错误", async () => {
    electron.openPath.mockResolvedValue("No application is associated with the specified file");
    expect(await register()[IPC.SETTINGS_OPEN_DATA_DIR]()).toEqual({
      ok: false,
      error: "No application is associated with the specified file",
    });
  });
});
