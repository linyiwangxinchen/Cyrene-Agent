/** Node host for the shared desktop business services. No Electron runtime is loaded. */
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const dataDir = process.env.CYRENE_DATA_DIR!;
const repository = process.env.CYRENE_APP_ROOT || process.cwd();
const packageVersion: string = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")).version;
if (!dataDir) throw new Error("CYRENE_DATA_DIR is required by the headless core");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
Object.defineProperty(process, "resourcesPath", { value: path.join(repository, "resources"), configurable: true });

export const invocation = new AsyncLocalStorage<WebContents>();
export const ipcMain = Object.assign(new EventEmitter(), {
  handlers: new Map<string, (...args: any[]) => any>(),
  handle(channel: string, listener: (...args: any[]) => any) {
    if (this.handlers.has(channel)) throw new Error(`Duplicate core handler: ${channel}`);
    this.handlers.set(channel, listener);
  },
  removeHandler(channel: string) { this.handlers.delete(channel); },
});
export function emitHost(channel: string, ...args: unknown[]): void {
  process.send?.({ type: "event", channel, args, ...(invocation.getStore() ? { clientId: invocation.getStore()!.id } : {}) });
}
export class WebContents extends EventEmitter {
  destroyed = false;
  constructor(public id: number, private url = "http://cyrene.local/web/") { super(); }
  send(channel: string, ...args: unknown[]): void { process.send?.({ type: "event", channel, args, ...(this.id ? { clientId: this.id } : {}) }); }
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
  setURL(value: string): void { this.url = value; }
  getType(): string { return "window"; }
  destroy(): void { this.destroyed = true; this.emit("destroyed"); this.removeAllListeners(); }
}
const clients = new Map<number, WebContents>();
export function client(id: number): WebContents {
  let value = clients.get(id);
  if (!value) { value = new WebContents(id); clients.set(id, value); }
  return value;
}
export function disconnect(id: number): void { clients.get(id)?.destroy(); clients.delete(id); }
export const webContents = { fromId: (id: number) => clients.get(id), getAllWebContents: () => [...clients.values()] };
export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] { return [chatWindow]; }
  static getFocusedWindow(): BrowserWindow { return chatWindow; }
  static fromWebContents(_sender: WebContents): BrowserWindow { return chatWindow; }
  readonly webContents = new WebContents(0);
  isDestroyed(): boolean { return false; }
  isFocused(): boolean { return clients.size > 0; }
  isVisible(): boolean { return clients.size > 0; }
  show(): void { emitHost("host:focus"); }
  focus(): void { emitHost("host:focus"); }
  close(): void { emitHost("host:close"); }
}
export const chatWindow = new BrowserWindow();
export const app = Object.assign(new EventEmitter(), {
  isPackaged: false, name: "Cyrene", isReady: () => true, whenReady: async () => {},
  getAppPath: () => repository, getName: () => "Cyrene", getVersion: () => packageVersion,
  getPath(name: string): string {
    if (name === "exe") return process.execPath;
    if (name === "home") return os.homedir();
    if (name === "userData" || name === "sessionData") return dataDir;
    const value = path.join(dataDir, name === "downloads" ? "uploads" : name);
    mkdirSync(value, { recursive: true }); return value;
  },
});
let activityAt = Date.now();
export function touchActivity(): void { activityAt = Date.now(); }
export const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => Math.floor((Date.now() - activityAt) / 1000) });
export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
const pendingDialogs = new Map<string, { resolve: (value: any) => void; timer: NodeJS.Timeout; clientId: number }>();
async function askDialog(kind: string, options: unknown): Promise<any> {
  const messageOptions = options as { cancelId?: number; buttons?: string[] };
  const canceledResponse = messageOptions.cancelId ?? (messageOptions.buttons?.length ? messageOptions.buttons.findIndex(label => /^(取消|否|关闭|cancel|no|close)$/i.test(label.trim())) : 0);
  const sender = invocation.getStore();
  if (!sender || sender.isDestroyed()) return kind === "message" ? { response: canceledResponse } : { canceled: true, filePaths: [] };
  const id = randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { pendingDialogs.delete(id); resolve({ canceled: true, filePaths: [], response: canceledResponse }); }, 300_000);
    timer.unref(); pendingDialogs.set(id, { resolve, timer, clientId: sender.id });
    sender.send("host:dialog", { id, kind, options });
  });
}
export function resolveDialog(clientId: number, id: string, value: any): boolean {
  const pending = pendingDialogs.get(id);
  if (!pending || pending.clientId !== clientId) return false;
  pendingDialogs.delete(id); clearTimeout(pending.timer); pending.resolve(value); return true;
}
export const dialog = {
  showOpenDialog: (...args: any[]) => askDialog("open", args.at(-1)),
  showSaveDialog: (...args: any[]) => askDialog("save", args.at(-1)),
  showMessageBox: (...args: any[]) => askDialog("message", args.at(-1)),
};
export const shell = {
  async openExternal(url: string) { if (!/^(https?:\/\/|mailto:)/i.test(url)) throw new Error("Unsupported URL"); emitHost("host:open-url", url); },
  async openPath(filePath: string) { try { emitHost(statSync(filePath).isDirectory() ? "host:open-directory" : "host:open-file", filePath); return ""; } catch (error) { return String(error); } },
  showItemInFolder(filePath: string) { emitHost("host:open-directory", existsSync(filePath) && statSync(filePath).isDirectory() ? filePath : path.dirname(filePath)); },
  async trashItem(_filePath: string) { throw new Error("服务器不提供桌面回收站，请使用工作区删除操作"); },
};
const keyPath = path.join(dataDir, "server-secrets.key");
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
const key = readFileSync(keyPath);
export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "server-file-key",
  encryptString(value: string): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  },
  decryptString(value: Buffer): string {
    const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString("utf8");
  },
};
export const net = { async fetch(input: string, init?: RequestInit) {
  if (!input.startsWith("file:")) return globalThis.fetch(input, init);
  const file = fileURLToPath(input), body = await readFile(file);
  const mime = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" } as Record<string, string>)[path.extname(file)] || "application/octet-stream";
  return new Response(new Uint8Array(body), { headers: { "Content-Type": mime } });
}, isOnline: () => true };
export const protocol = { handlers: new Map<string, any>(), handle(scheme: string, fn: any) { this.handlers.set(scheme, fn); }, unhandle(scheme: string) { this.handlers.delete(scheme); }, isProtocolHandled: async () => false };
export const clipboard = { readBuffer: () => Buffer.alloc(0), readText: () => "" };
export const screen = { getPrimaryDisplay: () => ({ scaleFactor: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }) };
export const nativeImage = { createFromPath: () => { throw new Error("桌面图像接口不在服务器运行"); } };
export const globalShortcut = { unregisterAll() {}, register: () => false, unregister() {} };
export const session = { defaultSession: { protocol }, fromPartition: () => ({ protocol }) };
export class WebContentsView { constructor() { throw new Error("Use the Web browser panel transport on the headless server"); } }
export class Menu { static buildFromTemplate() { throw new Error("桌面菜单不在服务器运行"); } }
export class Tray { constructor() { throw new Error("桌面托盘不在服务器运行"); } }
