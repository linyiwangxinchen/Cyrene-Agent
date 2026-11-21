/**
 * Turn output.
 *
 * Text mode: Cyrene's reply streams to stdout; tool activity, retries and
 * errors go to stderr so `cyrene exec ... > reply.txt` captures only the
 * reply. The harness streams candidate text and later sends the authoritative
 * final text for the same round, so the already printed prefix is not
 * repeated. Reasoning is hidden unless requested.
 *
 * JSON mode: one JSON object per line. `{"type":"agui","event":...}` carries
 * the raw AG-UI event; the CLI adds `session`, `notice` and `result` records.
 */
import { IPC } from "../../shared/ipc-channels.js";
import type { AguiEvent, TurnResult, TurnSink } from "./turn.js";

export interface OutputStreams {
  out(text: string): void;
  err(text: string): void;
}

export const processStreams: OutputStreams = {
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
};

export interface TurnRenderer extends TurnSink {
  /** Called after the turn settles, before the CLI prints its own summary. */
  end(result: TurnResult): void;
}

function noticeText(channel: string): string {
  if (channel === IPC.PERMISSION_APPROVAL_REQUEST) return "昔涟请求执行需要确认的操作；命令行不能批准，请在桌面端或 Web 界面中处理，或 Ctrl+C 取消。";
  if (channel === "cyrene.choice") return "昔涟提出了选择题；命令行不能作答，请在桌面端或 Web 界面中选择，或 Ctrl+C 取消。";
  return `核心请求交互：${channel}`;
}

export class TextRenderer implements TurnRenderer {
  private streamed = "";
  private wroteText = false;
  private lastChar = "\n";
  private finalStarted = false;

  constructor(private readonly io: OutputStreams, private readonly options: { reasoning?: boolean } = {}) {}

  private write(text: string): void {
    if (!text) return;
    this.io.out(text);
    this.wroteText = true;
    this.lastChar = text[text.length - 1];
  }

  private newline(): void {
    if (this.wroteText && this.lastChar !== "\n") this.write("\n");
  }

  /** stderr notice on its own line, without adding anything to stdout. */
  private note(text: string): void {
    const midLine = this.wroteText && this.lastChar !== "\n";
    this.io.err(`${midLine ? "\n" : ""}${text}\n`);
  }

  /** Print authoritative text without repeating what candidate streaming already showed. */
  private writeAuthoritative(content: string): void {
    if (this.streamed && content.startsWith(this.streamed)) this.write(content.slice(this.streamed.length));
    else { if (this.streamed) this.newline(); this.write(content); }
    this.streamed = "";
  }

  event(event: AguiEvent): void {
    const value = event.value as Record<string, unknown> | null | undefined;
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        this.finalStarted = false;
        return;
      case "TEXT_MESSAGE_CONTENT":
        if (typeof event.delta !== "string") return;
        if (!this.finalStarted) { this.finalStarted = true; this.writeAuthoritative(event.delta); }
        else this.write(event.delta);
        return;
      case "REASONING_MESSAGE_CONTENT":
        if (this.options.reasoning && typeof event.delta === "string") this.io.err(event.delta);
        return;
      case "REASONING_MESSAGE_END":
        if (this.options.reasoning) this.io.err("\n");
        return;
      case "TOOL_CALL_START":
        this.note(`[工具] ${String(event.toolCallDisplayName ?? event.toolCallName ?? "工具")}`);
        return;
      case "TOOL_CALL_RESULT":
        if (event.status === "failed") this.note(`[工具失败] ${String(event.content ?? "").slice(0, 200)}`);
        return;
      case "RUN_ERROR":
        this.note(`昔涟遇到错误：${String(event.message ?? event.error ?? "模型请求失败")}`);
        return;
      case "CUSTOM":
        break;
      default:
        return;
    }
    if (event.name === "cyrene.candidate_text") {
      if (value?.action === "delta" && typeof value.delta === "string") {
        this.streamed += value.delta;
        this.write(value.delta);
      } else if (value?.action === "discard") {
        // The streamed round became process text; keep it and start a fresh line.
        this.newline();
        this.streamed = "";
      }
    } else if (event.name === "cyrene.process_text" && typeof value?.content === "string") {
      this.writeAuthoritative(value.content);
      this.newline();
    } else if (event.name === "cyrene.model.retry") {
      this.note("[模型重试中]");
    } else if (event.name === "cyrene.choice") {
      this.note(noticeText("cyrene.choice"));
    }
  }

  notice(channel: string): void {
    this.note(noticeText(channel));
  }

  end(result: TurnResult): void {
    this.newline();
    if (result.status === "start_failed" || result.status === "disconnected") this.io.err(`cyrene: ${result.error ?? "本轮未能开始"}\n`);
    else if (result.status === "cancelled") this.io.err("已取消本轮。\n");
    else if (result.status === "timeout") this.io.err(`本轮超时：${result.error ?? "timeout"}\n`);
  }
}

export class JsonRenderer implements TurnRenderer {
  constructor(private readonly io: OutputStreams) {}
  line(record: Record<string, unknown>): void { this.io.out(`${JSON.stringify(record)}\n`); }
  event(event: AguiEvent): void { this.line({ type: "agui", event }); }
  notice(channel: string, payload: unknown): void { this.line({ type: "notice", channel, payload }); }
  end(): void { /* the command prints the `result` record with its exit code */ }
}
