import { useEffect, useRef, useState } from "react";
export function WebTtsPreview() {
  const [preview, setPreview] = useState<{ src: string } | null>(null);
  const [hint, setHint] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const show = (event: Event) => {
      const { base64, format } = (event as CustomEvent<{ base64: string; format: string }>).detail;
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      setHint(""); setPreview({ src: URL.createObjectURL(new Blob([bytes], { type: format === "wav" ? "audio/wav" : "audio/mpeg" })) });
    };
    window.addEventListener("cyrene:web-tts-preview", show);
    return () => window.removeEventListener("cyrene:web-tts-preview", show);
  }, []);
  useEffect(() => {
    if (!preview) return;
    void audio.current?.play().catch(() => setHint("浏览器已阻止自动播放，请点击播放器的播放按钮。"));
    return () => { audio.current?.pause(); URL.revokeObjectURL(preview.src); };
  }, [preview]);
  return preview && <section className="cy-settings-section" aria-label="合成音频预览"><h2>合成音频预览</h2><audio ref={audio} controls src={preview.src} aria-label="合成音频预览" onError={() => setHint("音频播放失败，请检查服务返回的格式。")} /><p role="status">{hint || "合成完成，可播放或调整音量。"}</p></section>;
}
