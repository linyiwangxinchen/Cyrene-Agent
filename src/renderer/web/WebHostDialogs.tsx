import { useEffect, useState } from "react";
import { coreRequest, ipcRenderer, uploadFile } from "./core-transport";
import { IPC } from "../../shared/ipc-channels";

interface HostDialog { id: string; kind: "open" | "save" | "message" | "browse"; options: { title?: string; message?: string; detail?: string; defaultPath?: string; buttons?: string[]; properties?: string[]; filters?: Array<{ extensions: string[] }> } }
export function WebHostDialogs() {
  const [dialog, setDialog] = useState<HostDialog | null>(null);
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<Array<{ name: string; path: string; directory: boolean }>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stickers, setStickers] = useState(false);
  const [music, setMusic] = useState(false);
  const [call, setCall] = useState(false);
  async function browse(value: string) {
    setError("");
    try { const result = await fetch(`/api/core/files?path=${encodeURIComponent(value)}`).then(response => response.json()); if (result.error) throw new Error(result.error); setDirectory(result.path); setEntries(result.entries); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取目录"); }
  }
  useEffect(() => {
    const listener = (_event: unknown, next: HostDialog) => {
      setDialog(next); setSelected([]); setError("");
      let initialPath = next.options.defaultPath || "";
      if (next.kind === "save" && initialPath) { setSelected([initialPath]); initialPath = initialPath.replace(/[\\/][^\\/]+$/, ""); }
      if (next.kind !== "message") void browse(initialPath);
    };
    ipcRenderer.on("host:dialog", listener); return () => { ipcRenderer.off("host:dialog", listener); };
  }, []);
  useEffect(() => {
    const file = (_event: unknown, filePath: string) => { window.open(`/api/core/file?path=${encodeURIComponent(filePath)}`, "_blank", "noopener,noreferrer"); };
    const folder = (_event: unknown, filePath: string) => { setDialog({ id: "", kind: "browse", options: { title: "服务器文件浏览" } }); setSelected([]); void browse(filePath); };
    const url = (_event: unknown, value: string) => { window.open(value, "_blank", "noopener,noreferrer"); };
    ipcRenderer.on("host:open-file", file); ipcRenderer.on("host:open-url", url);
    ipcRenderer.on("host:open-directory", folder);
    const openStickers = () => setStickers(true);
    const closeStickers = () => setStickers(false);
    const settings = (_event: unknown, section: string) => { void ipcRenderer.invoke(IPC.SETTINGS_REQUEST_SWITCH_SECTION, section); };
    ipcRenderer.on("host:sticker-manager", openStickers); ipcRenderer.on("host:settings", settings);
    ipcRenderer.on("host:sticker-manager-close", closeStickers);
    const openMusic = () => setMusic(true); ipcRenderer.on("host:music", openMusic);
    const closeMusic = () => setMusic(false); ipcRenderer.on("host:music-close", closeMusic);
    const openCall = () => setCall(true); const closeCall = () => setCall(false);
    ipcRenderer.on("host:call", openCall); ipcRenderer.on("host:call-close", closeCall);
    (window as any).__cyreneCallRelease = () => ipcRenderer.invoke("web:call-release");
    return () => { ipcRenderer.off("host:call", openCall); ipcRenderer.off("host:call-close", closeCall); delete (window as any).__cyreneCallRelease; ipcRenderer.off("host:open-file", file); ipcRenderer.off("host:open-directory", folder); ipcRenderer.off("host:open-url", url); ipcRenderer.off("host:sticker-manager", openStickers); ipcRenderer.off("host:sticker-manager-close", closeStickers); ipcRenderer.off("host:settings", settings); ipcRenderer.off("host:music", openMusic); ipcRenderer.off("host:music-close", closeMusic); };
  }, []);
  if (call && !dialog) return <div className="cy-web-host-dialog__backdrop"><section className="cy-web-host-dialog cy-web-call" role="dialog" aria-modal="true" aria-label="语音通话"><button type="button" onClick={() => { window.call?.stop(); setCall(false); }}>关闭通话</button><iframe title="语音通话" src="/call-react/" allow="microphone; autoplay" /></section></div>;
  if (music && !dialog) return <div className="cy-web-host-dialog__backdrop"><section className="cy-web-host-dialog cy-web-music" role="dialog" aria-modal="true" aria-label="音乐播放器"><button type="button" onClick={() => setMusic(false)}>关闭播放器</button><iframe title="音乐播放器" src="/music/" /></section></div>;
  if (stickers && !dialog) return <div className="cy-web-host-dialog__backdrop"><section className="cy-web-host-dialog cy-web-music" role="dialog" aria-modal="true" aria-label="表情包管理"><button type="button" onClick={() => setStickers(false)}>关闭表情包管理</button><iframe title="表情包管理" src="/sticker-manager/" /></section></div>;
  if (!dialog) return null;
  const chooseDirectory = dialog.options.properties?.includes("openDirectory");
  const multiple = dialog.options.properties?.includes("multiSelections");
  async function finish(value: unknown) { setBusy(true); try { await coreRequest("dialog", { dialogId: dialog!.id, value }); setDialog(null); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
  return <div className="cy-web-host-dialog__backdrop"><section className="cy-web-host-dialog" role="dialog" aria-modal="true" aria-label={dialog.options.title || "选择服务器文件"}>
    <h2>{dialog.options.title || (chooseDirectory ? "选择服务器目录" : "选择服务器文件")}</h2>
    {dialog.kind === "message" ? <><p>{dialog.options.message}</p><p>{dialog.options.detail}</p><div className="cy-web-host-dialog__actions">{(dialog.options.buttons || ["确定"]).map((label, response) => <button type="button" key={label} onClick={() => void finish({ response })}>{label}</button>)}</div></> : <>
      <form onSubmit={event => { event.preventDefault(); void browse(directory); }}><input aria-label="服务器路径" value={directory} onChange={event => setDirectory(event.target.value)} /><button type="submit">打开路径</button></form>
      <div className="cy-web-host-dialog__files">{entries.map(entry => <div key={entry.path}>
        <button type="button" onClick={() => entry.directory ? void browse(entry.path) : dialog.kind === "browse" ? window.open(`/api/core/file?path=${encodeURIComponent(entry.path)}`, "_blank", "noopener,noreferrer") : setSelected(multiple ? selected.includes(entry.path) ? selected.filter(item => item !== entry.path) : [...selected, entry.path] : [entry.path])}>{entry.directory ? "📁" : dialog.kind === "browse" ? "↓" : selected.includes(entry.path) ? "☑" : "□"} {entry.name}</button>
      </div>)}</div>
      {!chooseDirectory && dialog.kind === "open" && <label>从浏览器上传文件<input type="file" multiple={multiple} accept={dialog.options.filters?.flatMap(filter => filter.extensions.map(extension => `.${extension}`)).join(",")} onChange={event => { const files = [...(event.target.files ?? [])]; setBusy(true); void Promise.all(files.map(uploadFile)).then(setSelected).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }} /></label>}
      {dialog.kind === "save" && <input aria-label="保存文件名" placeholder="文件名" onChange={event => setSelected([`${directory.replace(/[\\/]$/, "")}/${event.target.value}`])} />}
      <p>{chooseDirectory ? directory : selected.join("；")}</p>
      {dialog.kind === "browse" ? <div className="cy-web-host-dialog__actions"><button type="button" onClick={() => setDialog(null)}>关闭</button></div> : <div className="cy-web-host-dialog__actions"><button type="button" disabled={busy} onClick={() => void finish({ canceled: true, filePaths: [] })}>取消</button><button type="button" disabled={busy || (!chooseDirectory && !selected.length)} onClick={() => void finish(dialog.kind === "save" ? { canceled: false, filePath: selected[0] } : { canceled: false, filePaths: chooseDirectory ? [directory] : selected })}>选择</button></div>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section></div>;
}
