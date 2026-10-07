import { useEffect, useRef, useState } from "react";
import { coreRequest } from "./core-transport";
import { Card } from "../react/components/ui/Card";

/** Audio stays in the browser until the user explicitly records or chooses a file. */
export function WebAsrTest() {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => {
    alive.current = false; clearTimeout(timer.current);
    recorder.current?.stream.getTracks().forEach(track => track.stop());
    if (recorder.current?.state === "recording") recorder.current.stop();
  }; }, []);
  async function transcribe(blob: Blob) {
    if (pending.current || !alive.current) return;
    pending.current = true; setBusy(true); setError(""); setText("");
    let context: AudioContext | undefined;
    try {
      if (blob.size > 12 * 1024 * 1024) throw new Error("音频文件不能超过 12 MB");
      context = new AudioContext();
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (!decoded.length || decoded.duration > 120) throw new Error("请选择 120 秒以内的音频");
      const target = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = target.createBufferSource(); source.buffer = decoded; source.connect(target.destination); source.start();
      const mono = (await target.startRendering()).getChannelData(0);
      const pcm = new ArrayBuffer(mono.length * 2); const view = new DataView(pcm);
      mono.forEach((sample, index) => view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
      if (!alive.current) return;
      const result = await coreRequest("invoke", { channel: "web:asr-transcribe", args: [pcm] });
      if (alive.current) setText(result.text || "未识别到语音，请检查音频内容或麦克风音量。");
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { await context?.close(); pending.current = false; if (alive.current) setBusy(false); }
  }
  async function record() {
    if (recording) { recorder.current?.stop(); return; }
    setError(""); setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) throw new Error("麦克风需要 HTTPS（本机 localhost 也可使用），并需要浏览器授权。");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!alive.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const next = new MediaRecorder(stream); recorder.current = next;
      let failed = false;
      const chunks: BlobPart[] = [];
      next.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      next.onstop = () => { clearTimeout(timer.current); stream.getTracks().forEach(track => track.stop()); recorder.current = null; if (alive.current) { setRecording(false); if (!failed) void transcribe(new Blob(chunks, { type: next.mimeType })); } };
      next.onerror = () => { failed = true; clearTimeout(timer.current); stream.getTracks().forEach(track => track.stop()); if (next.state === "recording") next.stop(); if (alive.current) { setRecording(false); setError("录音失败，请检查麦克风权限"); } };
      next.start(); setRecording(true); timer.current = setTimeout(() => next.state === "recording" && next.stop(), 120_000);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setStarting(false); }
  }
  return <section className="cy-settings-section">
    <div className="cy-settings-section__heading"><h2>识别测试</h2><p>使用当前 ASR 配置识别麦克风录音或音频文件，最长 120 秒。</p></div>
    <Card><div className="cy-web-asr-actions"><button type="button" disabled={busy || starting} onClick={() => void record()}>{starting ? "等待麦克风授权…" : recording ? "停止录音并识别" : "开始录音测试"}</button><label>选择音频测试<input aria-label="选择音频测试" type="file" accept="audio/*" disabled={busy || recording || starting} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void transcribe(file); }} /></label></div>
      {recording && <p role="status">正在录音…</p>}{busy && <p role="status">正在识别…</p>}{error && <p role="alert">{error}</p>}{text && <p aria-label="识别结果">{text}</p>}
    </Card>
  </section>;
}
