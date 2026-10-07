import type { LocalAsrConfig } from "./asr-config";
import { encodePcm16MonoWav } from "./mossland-asr-engine";

/** OpenAI-compatible transcription endpoint, e.g. a self-hosted Whisper service. */
export class LocalAsrStream {
  private frames: Buffer[] = [];
  private readonly controller = new AbortController();
  private result: Promise<string> | null = null;
  constructor(private readonly config: LocalAsrConfig, private readonly onFinal: (text: string) => void) {}
  async start(): Promise<void> {
    const url = new URL(this.config.endpointUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("ASR 地址必须使用 HTTP 或 HTTPS");
    if (!this.config.model.trim()) throw new Error("请填写 ASR 模型名称");
    this.controller.signal.throwIfAborted();
  }
  sendAudio(frame: Buffer): void {
    if (!this.result && !this.controller.signal.aborted) this.frames.push(Buffer.from(frame));
  }
  cancel(): void { this.controller.abort(); this.frames = []; }
  stop(): Promise<string> { return this.result ??= this.finish(); }
  private async finish(): Promise<string> {
    this.controller.signal.throwIfAborted();
    if (!this.frames.length) return "";
    const wav = encodePcm16MonoWav(Buffer.concat(this.frames));
    this.frames = [];
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("model", this.config.model);
    form.append("response_format", "json");
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(120_000)]);
    const response = await fetch(this.config.endpointUrl, {
      method: "POST", body: form, signal,
      headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {},
    });
    if (!response.ok) throw new Error(`ASR 转写失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const data = await response.json() as { text?: unknown };
    if (typeof data.text !== "string") throw new Error("ASR 服务未返回 text 字段");
    signal.throwIfAborted();
    const text = data.text.trim();
    if (text) this.onFinal(text);
    return text;
  }
}
