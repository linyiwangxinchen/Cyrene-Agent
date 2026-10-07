import { useEffect, useRef, useState } from "react";
import { ipcRenderer } from "./core-transport";

/** Audio renders on the browser computer, while the shared service owns the queue. */
export function WebAudioOutput() {
  const audio = useRef<HTMLAudioElement>(null);
  const sourceId = useRef("");
  const [track, setTrack] = useState("");
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = audio.current!;
    const report = () => { if (sourceId.current) void ipcRenderer.invoke("web:audio-state", { sourceId: sourceId.current, loaded: element.readyState >= 1, paused: element.paused, position: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : 0, volume: element.volume * 100, eofReached: element.ended }).catch(() => {}); };
    const play = () => { void element.play().then(() => setBlocked(false)).catch(() => { setBlocked(true); report(); }); };
    const command = (_event: unknown, input: any) => {
      if (!input || (!input.sourceId && input.command === "state")) return;
      setTrack(input.track?.name || "音乐");
      if (input.sourceId && sourceId.current !== input.sourceId) { sourceId.current = input.sourceId; element.src = input.src; element.volume = input.volume / 100; play(); }
      if (input.command === "play") play();
      if (input.command === "pause") element.pause();
      if (input.command === "seek" && element.readyState) element.currentTime = Math.max(0, input.value);
      if (input.command === "volume") element.volume = input.value / 100;
      if (input.command === "stop") { element.pause(); element.removeAttribute("src"); element.load(); sourceId.current = ""; setTrack(""); }
    };
    const events = ["loadedmetadata", "play", "pause", "seeked", "volumechange", "ended", "error"];
    for (const event of events) element.addEventListener(event, report);
    const tick = setInterval(report, 1000);
    ipcRenderer.on("web:audio-command", command);
    void ipcRenderer.invoke("web:audio-get").then(value => { if (value) command({}, { ...value, command: "state" }); }).catch(() => {});
    return () => { clearInterval(tick); element.pause(); ipcRenderer.off("web:audio-command", command); for (const event of events) element.removeEventListener(event, report); };
  }, []);
  return <div className="cy-web-audio" hidden={!track}><span>{track}</span>{blocked && <span>浏览器需要你点击播放</span>}<audio ref={audio} controls preload="metadata" /></div>;
}
