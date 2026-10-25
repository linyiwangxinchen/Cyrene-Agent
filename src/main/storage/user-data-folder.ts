import { app, shell } from "electron";

export type OpenUserDataFolderResult = { ok: true } | { ok: false; error: string };

/**
 * 在系统文件管理器中打开应用数据目录（userData）。
 * shell.openPath 失败时不抛异常而是返回错误文本，这里转成 { ok: false, error }，
 * 设置页与聊天区两个入口共用，失败时都能提示而不是静默无效。
 */
export async function openUserDataFolder(): Promise<OpenUserDataFolderResult> {
  const error = await shell.openPath(app.getPath("userData"));
  return error ? { ok: false, error } : { ok: true };
}
