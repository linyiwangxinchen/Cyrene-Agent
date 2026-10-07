import { useEffect, useState } from "react";
import type { ToastItem, ToastPushPayload } from "../../shared/toast-types";
import { IPC } from "../../shared/ipc-channels";
import { ipcRenderer } from "./core-transport";
import avatar from "../toast/assets/toast-avatar.png";
import actionSound from "../toast/assets/toast-action.mp3";
import notifySound from "../toast/assets/toast-notify.mp3";

/** The shared ToastService owns lifecycle, deduplication and navigation. */
export function WebNotifications() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    let active = true;
    const push = (_event: unknown, item: ToastPushPayload) => {
      setItems(previous => [...previous.filter(value => value.id !== item.id), item]);
      if (item.sound) void new Audio(item.tier === "action-pending" ? actionSound : notifySound).play().catch(() => {});
    };
    const remove = (_event: unknown, id: string) => setItems(previous => previous.filter(item => item.id !== id));
    ipcRenderer.on(IPC.TOAST_PUSH, push); ipcRenderer.on(IPC.TOAST_REMOVE, remove);
    void ipcRenderer.invoke(IPC.TOAST_GET_ALL).then(value => { if (active) setItems(value); });
    return () => { active = false; ipcRenderer.off(IPC.TOAST_PUSH, push); ipcRenderer.off(IPC.TOAST_REMOVE, remove); };
  }, []);
  return <aside className="cy-web-notifications" aria-live="polite">{items.map(item => <article key={item.id}>
    <button type="button" onClick={() => ipcRenderer.send(IPC.TOAST_CLICKED, item.id)}><img src={avatar} alt="" /><span><strong>{item.title}</strong><span>{item.summary}</span></span></button>
    <button type="button" aria-label="关闭提醒" onClick={() => ipcRenderer.send(IPC.TOAST_DISMISSED, item.id)}>×</button>
  </article>)}</aside>;
}
