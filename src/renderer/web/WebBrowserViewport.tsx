import { useEffect, useState } from "react";
import { ipcRenderer } from "./core-transport";

export function WebBrowserViewport({ url, tabId, kind, active }: { url: string; tabId: string; kind: "web" | "exam"; active: boolean }) {
  const [frame, setFrame] = useState<{ src: string; width: number; height: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active || kind === "exam" || !url) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const next = await ipcRenderer.invoke("web:browser-screenshot"); if (!cancelled) { setFrame(next); setError(""); } }
      catch (cause) { if (!cancelled) setError(String(cause)); }
      finally { if (!cancelled) timer = setTimeout(() => void refresh(), 700); }
    };
    void refresh(); return () => { cancelled = true; clearTimeout(timer); };
  }, [active, kind, url, tabId]);
  if (kind === "exam") return <iframe src={url} title="学习试卷" style={{ width: "100%", height: "100%", border: 0 }} />;
  return <div tabIndex={0} role="application" aria-label="服务器浏览器" style={{ width: "100%", height: "100%", overflow: "auto" }} onKeyDown={event => {
    if (["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); void ipcRenderer.invoke("web:browser-input", { type: "key", key: event.key }).catch(cause => setError(String(cause))); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) { event.preventDefault(); void ipcRenderer.invoke("web:browser-input", { type: "text", text: event.key }).catch(cause => setError(String(cause))); }
  }} onWheel={event => { event.preventDefault(); void ipcRenderer.invoke("web:browser-input", { type: "wheel", delta: event.deltaY }).catch(cause => setError(String(cause))); }}>
    {error && <p role="alert">{error}</p>}
    {frame && <img src={frame.src} draggable={false} alt="服务器网页" style={{ width: "100%", display: "block" }} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect(); event.currentTarget.parentElement?.focus();
      void ipcRenderer.invoke("web:browser-input", { type: "click", x: (event.clientX - rect.left) / rect.width * frame.width, y: (event.clientY - rect.top) / rect.height * frame.height }).catch(cause => setError(String(cause)));
    }} />}
  </div>;
}
