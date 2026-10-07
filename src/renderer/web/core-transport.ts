import { IPC } from "../../shared/ipc-channels";
import { installRandomUuidFallback } from "./crypto-compat";
import { publishWebMoment } from "./moment-upload";

type Listener = (event: unknown, ...args: any[]) => void;
const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let clientToken = "";
let connecting: Promise<void> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let authenticated = false;

export function dispatch(channel: string, ...args: unknown[]): void {
  for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
}
export async function connectCore(): Promise<void> {
  if (clientToken && socket?.readyState === WebSocket.OPEN) return;
  if (connecting) return connecting;
  connecting = new Promise<void>((resolve, reject) => {
    const ws = socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    const timer = setTimeout(() => { ws.close(); reject(new Error("实时连接超时")); }, 10000);
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") { clientToken = message.clientToken; clearTimeout(timer); resolve(); }
      if (message.type === "CORE_EVENT") dispatch(message.channel, ...mapResources(message.args));
    };
    ws.onclose = () => {
      resetVoiceTransport(); dispatch(IPC.CALL_STATE, { state: "ENDED" });
      clearTimeout(timer); clientToken = ""; socket = null; connecting = null;
      reject(new Error("实时连接已关闭"));
      if (authenticated) reconnectTimer = setTimeout(() => { void connectCore().catch(() => {}); }, 1500);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("无法连接实时服务")); };
  }).finally(() => { connecting = null; });
  return connecting;
}
export async function coreRequest(operation: string, body: unknown): Promise<any> {
  await connectCore();
  const response = await fetch(`/api/core/${operation}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Cyrene-Client": clientToken }, body: JSON.stringify(body, (_key, value) => {
    if (Object.prototype.toString.call(value) !== "[object ArrayBuffer]" && !ArrayBuffer.isView(value)) return value;
    const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
    let binary = ""; for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
    return { __cyreneBinary: "base64", data: btoa(binary) };
  }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return mapResources(payload);
}
function mapResources(value: any): any {
  if (typeof value === "string") {
    if (/^(?:local-sticker|moment-media):\/\//.test(value)) return `/api/core/resource?url=${encodeURIComponent(value)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map(mapResources);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapResources(item)]));
  return value;
}
let voiceQueue = Promise.resolve();
let voiceGeneration = 0;
let queuedVoiceBytes = 0;
function resetVoiceTransport() { voiceGeneration++; clearTimeout(voiceTimer); voiceTimer = undefined; voiceFrames = []; queuedVoiceBytes = 0; voiceQueue = Promise.resolve(); }
let voiceFrames: Uint8Array[] = [];
let voiceTimer: ReturnType<typeof setTimeout> | undefined;
function sendVoice(channel: string, args: unknown[]) {
  const generation = voiceGeneration;
  const size = channel === IPC.CALL_AUDIO_FRAME ? (args[0] as ArrayBuffer).byteLength : 0;
  queuedVoiceBytes += size;
  if (queuedVoiceBytes > 320_000) {
    resetVoiceTransport();
    void coreRequest("invoke", { channel: IPC.CALL_STOP, args: [] }).catch(() => {});
    dispatch(IPC.CALL_ERROR, { message: "语音上传积压，请检查网络后重新通话" }); return;
  }
  voiceQueue = voiceQueue.then(async () => {
    if (generation !== voiceGeneration) return;
    try { await coreRequest("invoke", { channel, args }); }
    finally { if (generation === voiceGeneration) queuedVoiceBytes -= size; }
  }).catch(error => { if (generation === voiceGeneration) dispatch(IPC.CALL_ERROR, { message: error.message }); });
}
function flushVoiceFrames() {
  clearTimeout(voiceTimer); voiceTimer = undefined;
  if (!voiceFrames.length) return;
  const bytes = new Uint8Array(voiceFrames.reduce((size, frame) => size + frame.length, 0));
  let offset = 0; for (const frame of voiceFrames) { bytes.set(frame, offset); offset += frame.length; }
  voiceFrames = []; sendVoice(IPC.CALL_AUDIO_FRAME, [bytes.buffer]);
}
export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => coreRequest("invoke", { channel, args }),
  send(channel: string, ...args: unknown[]) {
    if (channel === IPC.CALL_STOP) { resetVoiceTransport(); void coreRequest("invoke", { channel, args }).catch(error => dispatch(IPC.CALL_ERROR, { message: error.message })); return; }
    if (channel === IPC.CALL_AUDIO_FRAME) { voiceFrames.push(new Uint8Array(args[0] as ArrayBuffer).slice()); voiceTimer ??= setTimeout(flushVoiceFrames, 80); return; }
    if (channel.startsWith("call:")) { flushVoiceFrames(); sendVoice(channel, args); return; }
    void coreRequest("send", { channel, args }).catch(error => console.warn(`[Web IPC] ${channel}:`, error.message));
  },
  on(channel: string, callback: Listener) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(callback); return this; },
  off(channel: string, callback: Listener) { listeners.get(channel)?.delete(callback); return this; },
  removeListener(channel: string, callback: Listener) { return this.off(channel, callback); },
  listenerCount(channel: string) { return listeners.get(channel)?.size ?? 0; },
};
export const contextBridge = { exposeInMainWorld: (name: string, api: unknown) => { (window as any)[name] = api; } };
export const webUtils = { getPathForFile: () => { throw new Error("请先上传浏览器文件到服务器"); } };

export function stopCoreConnection(): void {
  resetVoiceTransport(); authenticated = false; clearTimeout(reconnectTimer); socket?.close(); clientToken = "";
}
export async function resumeCoreConnection(): Promise<void> {
  authenticated = true; await connectCore();
  await ipcRenderer.invoke("web:system-theme", matchMedia("(prefers-color-scheme: dark)").matches);
  const [theme, radius] = await Promise.all([ipcRenderer.invoke(IPC.UI_THEME_GET), ipcRenderer.invoke(IPC.UI_THEME_RADIUS_GET)]);
  dispatch(IPC.UI_THEME_CHANGED, theme); dispatch(IPC.UI_THEME_RADIUS_CHANGED, radius);
  const { applyMessageTypography } = await import("../ui/message-typography");
  applyMessageTypography((await ipcRenderer.invoke(IPC.SETTINGS_GET_GENERAL)).messageTypography);
}
export async function uploadFile(file: File): Promise<string> {
  if (file.size > 12 * 1024 * 1024) throw new Error("单个文件不能超过 12 MB");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file);
  });
  const result = await fetch("/api/core/upload", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, dataUrl }) });
  const payload = await result.json(); if (!result.ok) throw new Error(payload.error); return payload.path;
}
export async function installSharedBridge(): Promise<void> {
  installRandomUuidFallback();
  await import("../../preload/index");
  const moments = (window as any).moments;
  const createPost = moments.createPost;
  moments.createPost = (input: import("../../shared/moments-types").MomentCreatePostInput) => publishWebMoment(input, createPost);
  const api = (window as any).chat;
  api.ingestDroppedFiles = async (files: File[]) => {
    const entries = await Promise.all(files.map(async file => ({ path: await uploadFile(file), mime: file.type })));
    return ipcRenderer.invoke(IPC.CHAT_INGEST_FILES, entries);
  };
  api.pasteClipboardFiles = async () => {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) for (const type of item.types.filter(value => value.startsWith("image/"))) files.push(new File([await item.getType(type)], `clipboard-${Date.now()}.${type.split("/")[1]}`, { type }));
    return api.ingestDroppedFiles(files);
  };
  // The inspector remains the common React UI; native app launch is explicitly omitted on servers.
  (window as any).openInApp.listApps = async () => ({ ok: true, apps: [] });
  (window as any).openInApp.open = async (sessionId: string) => {
    const session = await ipcRenderer.invoke(IPC.CHATS_GET, sessionId);
    const root = session?.workspaceBinding?.workspaceRoot;
    return root ? ipcRenderer.invoke(IPC.CHATS_OPEN_WORKSPACE, root) : { ok: false, error: "Session has no workspace" };
  };
  (window as any).__cyreneWeb = true;
  document.documentElement.dataset.cyreneWeb = "true";
  let lastActivity = 0;
  const reportActivity = () => { if (!authenticated || Date.now() - lastActivity < 5000) return; lastActivity = Date.now(); void ipcRenderer.invoke("web:user-activity").catch(() => {}); };
  window.addEventListener("pointerdown", reportActivity, true); window.addEventListener("keydown", reportActivity, true);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => { if (authenticated) void ipcRenderer.invoke("web:system-theme", event.matches); });
  ipcRenderer.on("web:general-changed", (_event, settings) => { void import("../ui/message-typography").then(module => module.applyMessageTypography(settings.messageTypography)); });
  (window as any).__cyreneExamRequest = (token: string, channel: string, args: unknown[]) => coreRequest("invoke", { channel, args, pageToken: token });
  (window as any).__cyreneExamSubscribe = (callback: (value: unknown) => void) => {
    const listener: Listener = (_event, value) => callback(value);
    ipcRenderer.on(IPC.LEARN_EXAM_PAGE_CHANGED, listener); return () => ipcRenderer.off(IPC.LEARN_EXAM_PAGE_CHANGED, listener);
  };
}
