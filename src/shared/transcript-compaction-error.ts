import { isModelFailureInfo, type ModelErrorCategory } from "./model-error";

export const TRANSCRIPT_COMPACTION_REQUIRED = "TRANSCRIPT_COMPACTION_REQUIRED";

export type TranscriptCompactionFailureReason =
  | "no_safe_boundary"
  | "model_unconfigured"
  | "model_request_failed"
  | "invalid_summary"
  | "history_changed"
  | "checkpoint_write_failed"
  | "unknown";

const REASON_MESSAGES: Record<TranscriptCompactionFailureReason, string> = {
  no_safe_boundary: "没有可安全压缩的旧历史，近期消息或工具结果仍占用过多上下文。请缩短本次内容或新建会话。",
  model_unconfigured: "当前会话的摘要模型未配置完整，请检查模型地址、名称和 API Key。",
  model_request_failed: "摘要模型请求失败，请检查模型服务后重试。",
  invalid_summary: "摘要模型没有返回有效且更短的摘要，请重试压缩或更换模型。",
  history_changed: "生成摘要期间会话历史发生了变化，请在会话空闲后重试。",
  checkpoint_write_failed: "摘要已生成，但未能保存压缩检查点，请检查服务器存储后重试。",
  unknown: "未能完成会话摘要，请重试并检查服务器日志。",
};

/** 只映射已知类别，绝不把供应商正文、请求体或原始异常信息发送到界面。 */
function modelFailureMessage(cause: unknown): string | undefined {
  let value = cause;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 6 && value && typeof value === "object" && !visited.has(value); depth++) {
    visited.add(value);
    const error = value as { modelFailure?: unknown; cause?: unknown; name?: unknown };
    const category: ModelErrorCategory | undefined = isModelFailureInfo(error.modelFailure)
      ? error.modelFailure.category
      : error.name === "TimeoutError" ? "TIMEOUT" : undefined;
    switch (category) {
      case "AUTH": case "PERMISSION": return "摘要模型认证或权限校验失败，请检查当前会话的 API 配置。";
      case "BILLING": case "QUOTA": return "摘要模型的余额或配额不足，请检查模型服务账号。";
      case "RATE_LIMIT": return "摘要模型请求受到限流，请稍后重试。";
      case "CONTEXT_LIMIT": case "PAYLOAD_TOO_LARGE": return "摘要请求超过模型的上下文或大小限制，请检查模型上下文配置。";
      case "TIMEOUT": return "摘要模型请求超时，请检查网络或稍后重试。";
      case "NETWORK": case "OVERLOADED": case "SERVER_ERROR": case "UNAVAILABLE": return "摘要模型暂时无法连接或服务异常，请稍后重试。";
      case "CANCELLED": return "摘要请求已取消，可以在会话空闲后重试。";
    }
    value = error.cause;
  }
  return undefined;
}

export class TranscriptCompactionRequiredError extends Error {
  readonly displayMessage: string;

  constructor(readonly reason: TranscriptCompactionFailureReason, cause?: unknown) {
    super(TRANSCRIPT_COMPACTION_REQUIRED, cause === undefined ? undefined : { cause });
    this.name = "TranscriptCompactionRequiredError";
    const detail = reason === "model_request_failed" ? modelFailureMessage(cause) : undefined;
    this.displayMessage = `上下文压缩失败：${detail ?? REASON_MESSAGES[reason]} 原始会话记录已保留。`;
  }
}

export function isTranscriptCompactionRequiredError(error: unknown): error is Error & {
  reason?: TranscriptCompactionFailureReason;
  displayMessage?: string;
} {
  return error instanceof Error && error.message === TRANSCRIPT_COMPACTION_REQUIRED;
}

export function createTranscriptCompactionRequiredError(
  cause?: unknown,
  reason: TranscriptCompactionFailureReason = "unknown",
): TranscriptCompactionRequiredError {
  // build-options 等边界会再次归一化；保留真正失败步骤及其诊断，不覆盖成 unknown。
  if ((reason === "unknown" || reason === "model_request_failed") && cause instanceof TranscriptCompactionRequiredError) return cause;
  return new TranscriptCompactionRequiredError(reason, cause);
}

/** 对旧版本仅有 machine code 的错误也提供可理解文案；非压缩错误由原调用方处理。 */
export function getTranscriptCompactionDisplayMessage(error: unknown): string | undefined {
  if (!isTranscriptCompactionRequiredError(error)) return undefined;
  return error instanceof TranscriptCompactionRequiredError
    ? error.displayMessage
    : new TranscriptCompactionRequiredError("unknown").displayMessage;
}
