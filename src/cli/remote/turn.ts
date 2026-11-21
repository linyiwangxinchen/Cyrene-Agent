/**
 * One conversation turn over a CoreTransport, using the renderer's contract:
 * AGUI_RUN with the current user fact (the core journals history itself),
 * then AG-UI events on AGUI_EVENT until RUN_FINISHED or RUN_ERROR.
 *
 * Events can arrive before the AGUI_RUN acknowledgement returns the runId,
 * so they are buffered and replayed once the runId is known.
 */
import { randomUUID } from "node:crypto";
import { IPC } from "../../shared/ipc-channels.js";
import type { CoreTransport } from "./transport.js";

export type AguiEvent = { type?: string; runId?: string; [key: string]: unknown };

export type TurnStatus = "success" | "cancelled" | "timeout" | "runtime_error" | "start_failed" | "disconnected";

export interface TurnResult {
  status: TurnStatus;
  runId?: string;
  /** Final assistant text (or the streamed candidate text when no final text arrived). */
  text: string;
  error?: string;
}

export interface TurnSink {
  event(event: AguiEvent): void;
  /** Core notifications outside the AG-UI stream that need the user, e.g. approvals. */
  notice?(channel: string, payload: unknown): void;
}

export interface TurnOptions {
  sessionId: string;
  prompt: string;
  sink: TurnSink;
  signal?: AbortSignal;
  /** How long to wait for RUN_FINISHED after AGUI_CANCEL before giving up. */
  cancelGraceMs?: number;
}

const INTERACTIVE_CHANNELS = new Set<string>([IPC.PERMISSION_APPROVAL_REQUEST]);

function candidateDelta(event: AguiEvent): string {
  if (event.type !== "CUSTOM" || event.name !== "cyrene.candidate_text") return "";
  const value = event.value as { action?: unknown; delta?: unknown } | null | undefined;
  return value?.action === "delta" && typeof value.delta === "string" ? value.delta : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runTurn(transport: CoreTransport, options: TurnOptions): Promise<TurnResult> {
  const { sink, signal } = options;
  let runId: string | undefined;
  let finalText = "";
  let candidateText = "";
  const buffered: AguiEvent[] = [];
  let settle!: (result: TurnResult) => void;
  const terminal = new Promise<TurnResult>((resolve) => { settle = resolve; });
  let settled = false;
  const finish = (result: Omit<TurnResult, "text" | "runId">) => {
    if (settled) return;
    settled = true;
    settle({ ...result, runId, text: finalText || candidateText });
  };

  const handle = (event: AguiEvent) => {
    if (settled) return;
    sink.event(event);
    candidateText += candidateDelta(event);
    if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") finalText += event.delta;
    if (event.type === "RUN_FINISHED") {
      const status = (event.result as { status?: unknown } | undefined)?.status ?? event.status ?? "success";
      if (status === "success") finish({ status: "success" });
      else if (status === "cancelled") finish({ status: "cancelled" });
      else if (status === "timeout") finish({ status: "timeout", error: String((event.result as { reason?: unknown } | undefined)?.reason ?? "timeout") });
      else finish({ status: "runtime_error", error: String(status) });
    } else if (event.type === "RUN_ERROR") {
      finish({ status: "runtime_error", error: String(event.message ?? event.error ?? "模型请求失败") });
    }
  };

  const offEvent = transport.onEvent((channel, args) => {
    if (INTERACTIVE_CHANNELS.has(channel)) { sink.notice?.(channel, args[0]); return; }
    if (channel !== IPC.AGUI_EVENT) return;
    const event = args[0] as AguiEvent | undefined;
    if (!event || typeof event !== "object") return;
    if (!runId) { buffered.push(event); return; }
    if (event.runId === undefined || event.runId === runId) handle(event);
  });
  const offClose = transport.onClose((reason) => finish({ status: "disconnected", error: reason }));

  let cancelRequested = false;
  const requestCancel = () => {
    if (cancelRequested || settled) return;
    cancelRequested = true;
    if (!runId) return; // cancelled again once the acknowledgement arrives
    void transport.invoke(IPC.AGUI_CANCEL, runId).catch(() => {});
    const timer = setTimeout(() => finish({ status: "cancelled", error: "取消后未收到核心确认" }), options.cancelGraceMs ?? 10_000);
    timer.unref?.();
  };
  signal?.addEventListener("abort", requestCancel, { once: true });

  try {
    if (signal?.aborted) return { status: "cancelled", text: "" };
    const general = await transport.invoke<{ currentStyleId?: unknown } | null>(IPC.SETTINGS_GET_GENERAL).catch(() => null);
    const styleId = typeof general?.currentStyleId === "string" ? general.currentStyleId : undefined;
    let ack: { success?: boolean; runId?: string; error?: string; duplicate?: boolean } | null;
    try {
      ack = await transport.invoke(IPC.AGUI_RUN, {
        sessionId: options.sessionId,
        currentUser: { turnId: randomUUID(), text: options.prompt, visibleContent: options.prompt, at: Date.now() },
        assistantTurnId: randomUUID(),
        ...(styleId ? { styleId } : {}),
      });
    } catch (error) {
      return { status: "start_failed", text: "", error: errorMessage(error) };
    }
    if (!ack?.success || typeof ack.runId !== "string") {
      return { status: "start_failed", text: "", error: ack?.error ?? "核心没有接受本轮请求" };
    }
    runId = ack.runId;
    for (const event of buffered.splice(0)) if (event.runId === undefined || event.runId === runId) handle(event);
    if (cancelRequested && !settled) { cancelRequested = false; requestCancel(); }
    return await terminal;
  } finally {
    signal?.removeEventListener("abort", requestCancel);
    offEvent();
    offClose();
  }
}
