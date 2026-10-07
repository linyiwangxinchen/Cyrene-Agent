// 阿里云实时语音识别 ASR 引擎 —— WebSocket + JSON 协议。
//
// 文档：https://help.aliyun.com/zh/isi/user-guide/websocket
// URL：wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=<token>
// 鉴权：用 AccessKeyId + AccessKeySecret 获取临时 token，拼到 URL 里
// 协议：JSON 文本帧（StartTranscription/StopTranscription）+ 二进制帧（PCM 音频）
// 音频：PCM 16kHz/16bit/mono

import { WebSocket } from "ws";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";

const LOG_PREFIX = "[AliyunASR]";
const NLS_GATEWAY = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1";

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

export function buildAliyunTokenUrl(accessKeyId: string, accessKeySecret: string, nonce = randomUUID(), timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z")): string {
  const params: Record<string, string> = { AccessKeyId: accessKeyId, Action: "CreateToken", Format: "JSON", RegionId: "cn-shanghai", SignatureMethod: "HMAC-SHA1", SignatureNonce: nonce, SignatureVersion: "1.0", Timestamp: timestamp, Version: "2019-02-28" };
  const query = Object.keys(params).sort().map(key => `${percentEncode(key)}=${percentEncode(params[key])}`).join("&");
  const signature = createHmac("sha1", accessKeySecret + "&").update(`GET&%2F&${percentEncode(query)}`).digest("base64");
  return `https://nls-meta.cn-shanghai.aliyuncs.com/?${query}&Signature=${percentEncode(signature)}`;
}

/** 阿里云 ASR 流式识别会话 */
export class AliyunAsrStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private ready = false;
  private finished = false;
  private readonly controller = new AbortController();
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private stopResolve: ((text: string) => void) | null = null;
  private stopReject: ((error: Error) => void) | null = null;
  private stopPromise: Promise<string> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private sentences: string[] = [];
  private audioBuffer = Buffer.alloc(0);
  private taskId = randomUUID().replace(/-/g, "");
  private appKey = "";

  constructor(
    private readonly onPartial: (text: string) => void,
    private readonly onFinal: (text: string) => void,
  ) {}

  /** 开始识别会话：获取 token → 连 WebSocket → 发 StartTranscription */
  async start(appKey: string, accessKeyId: string, accessKeySecret: string, _language: string): Promise<void> {
    this.appKey = appKey;
    console.log(LOG_PREFIX, "获取 ASR token...");
    const token = await this.getToken(accessKeyId, accessKeySecret);
    this.controller.signal.throwIfAborted();
    const url = `${NLS_GATEWAY}?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.startResolve = resolve; this.startReject = reject;
      this.startTimer = setTimeout(() => this.fail(new Error("阿里云 ASR 启动超时")), 20_000);
      this.ws!.on("open", () => this.sendStartTranscription(appKey));
      this.ws!.on("message", (raw: Buffer) => this.handleMessage(raw));
      this.ws!.on("error", err => this.fail(err));
      this.ws!.on("close", () => {
        if (!this.finished) this.fail(new Error("阿里云 ASR 在最终转写完成前关闭连接"));
      });
    });
  }

  cancel(): void {
    this.controller.abort(); this.stopped = true; this.audioBuffer = Buffer.alloc(0);
    this.fail(new Error("ASR 已取消"));
  }
  private fail(error: Error): void {
    this.finished = true; this.stopped = true; this.ready = false; this.audioBuffer = Buffer.alloc(0);
    clearTimeout(this.startTimer); clearTimeout(this.stopTimer);
    this.startReject?.(error); this.stopReject?.(error);
    this.startResolve = null; this.startReject = null; this.stopResolve = null; this.stopReject = null;
    try { this.ws?.terminate(); } catch { /* already closed */ }
  }
  private finishStop(): void {
    this.finished = true; this.stopped = true;
    clearTimeout(this.stopTimer); this.stopResolve?.(this.sentences.join(""));
    this.stopResolve = null; this.stopReject = null; this.ws?.close();
  }

  /** 发送 StartTranscription 指令（JSON 文本帧） */
  private sendStartTranscription(appKey: string): void {
    // NLS language/model is selected by the Appkey project, not a request parameter.
    const msg = {
      header: {
        message_id: randomUUID().replace(/-/g, ""),
        task_id: this.taskId,
        namespace: "SpeechTranscriber",
        name: "StartTranscription",
        appkey: appKey,
      },
      payload: {
        format: "pcm",
        sample_rate: 16000,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
        max_sentence_silence: 800,
      },
    };
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 发送一帧 PCM 音频（攒够 200ms/6400 字节再发） */
  sendAudio(pcmFrame: Buffer): void {
    if (this.stopped) return;
    this.audioBuffer = Buffer.concat([this.audioBuffer, pcmFrame]);
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // 200ms = 16000 * 0.2 * 2 = 6400 字节
    while (this.audioBuffer.length >= 6400) {
      const chunk = this.audioBuffer.subarray(0, 6400);
      this.audioBuffer = this.audioBuffer.subarray(6400);
      this.ws.send(chunk, { binary: true });
    }
  }

  /** 结束识别：发剩余音频 + StopTranscription */
  stop(): Promise<string> {
    if (this.stopPromise) return this.stopPromise;
    if (this.controller.signal.aborted) return Promise.reject(new Error("ASR 已取消"));
    if (!this.ready || this.finished || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("阿里云 ASR 尚未就绪"));
    this.stopPromise = new Promise<string>((resolve, reject) => {
      this.stopResolve = resolve; this.stopReject = reject;
      this.stopTimer = setTimeout(() => this.fail(new Error("阿里云 ASR 等待最终转写超时")), 10_000);
    });
    this.stopped = true;

    // 发剩余音频
    if (this.audioBuffer.length > 0) {
      try { this.ws.send(this.audioBuffer, { binary: true }); } catch (err) { this.fail(err instanceof Error ? err : new Error(String(err))); return this.stopPromise; }
      this.audioBuffer = Buffer.alloc(0);
    }

    // 发 StopTranscription 指令
    const msg = {
      header: {
        message_id: randomUUID().replace(/-/g, ""),
        task_id: this.taskId,
        namespace: "SpeechTranscriber",
        name: "StopTranscription",
        appkey: this.appKey,
      },
    };
    try { this.ws.send(JSON.stringify(msg)); } catch (err) { this.fail(err instanceof Error ? err : new Error(String(err))); }

    return this.stopPromise;
  }

  /** 解析服务端 JSON 响应 */
  private handleMessage(raw: Buffer): void {
    if (this.finished) return;
    try {
      const msg = JSON.parse(raw.toString()) as {
        header?: {
          status?: number;
          status_text?: string;
          task_id?: string;
          name?: string;
        };
        payload?: {
          result?: string;
          index?: number;
          time?: number;
          confidence?: number;
        };
      };

      const status = msg.header?.status;
      const eventName = msg.header?.name;

      if (status !== 20000000 && status !== undefined) {
        this.fail(new Error(`阿里云 ASR 错误: ${status} ${msg.header?.status_text ?? ""}`));
        return;
      }

      if (eventName === "TranscriptionStarted") {
        this.ready = true;
        this.sendAudio(Buffer.alloc(0));
        clearTimeout(this.startTimer); this.startResolve?.(); this.startResolve = null; this.startReject = null;
      } else if (eventName === "TranscriptionResultChanged") {
        // 中间结果
        const text = msg.payload?.result ?? "";
        if (text) this.onPartial(this.sentences.join("") + text);
      } else if (eventName === "SentenceEnd") {
        // 最终结果
        const text = msg.payload?.result ?? "";
        if (text) {
          console.log(LOG_PREFIX, "最终识别:", text);
          this.sentences.push(text); this.onFinal(this.sentences.join(""));
        }
      } else if (eventName === "TranscriptionCompleted") {
        this.finishStop();
      }
    } catch (err) {
      console.error(LOG_PREFIX, "解析响应失败:", err);
    }
  }

  /** 用 AccessKeyId + AccessKeySecret 获取阿里云临时 token */
  private async getToken(accessKeyId: string, accessKeySecret: string): Promise<string> {
    const url = buildAliyunTokenUrl(accessKeyId, accessKeySecret);
    const resp = await fetch(url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as { Token?: { Id?: string }; errmsg?: string };
    if (!data.Token?.Id) throw new Error(data.errmsg || "token 获取失败");
    return data.Token.Id;
  }
}
