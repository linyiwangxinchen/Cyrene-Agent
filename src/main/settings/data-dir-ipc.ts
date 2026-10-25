import { app } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { openUserDataFolder } from "../storage/user-data-folder";

/**
 * 通用设置「数据目录」：只读返回路径 + 在系统文件管理器中打开。
 * 打开动作与聊天区入口共用 openUserDataFolder；失败时返回 { ok: false, error }，
 * 渲染端据此提示，避免按钮静默无效。
 */
export function registerDataDirIpc(ipc: Pick<IpcScope, "handle">): void {
  ipc.handle(IPC.SETTINGS_GET_DATA_DIR, () => app.getPath("userData"));
  ipc.handle(IPC.SETTINGS_OPEN_DATA_DIR, () => openUserDataFolder());
}
