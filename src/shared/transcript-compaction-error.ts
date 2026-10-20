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

const MODEL_RUNTIME_CODES = new Set([
  "E_MODEL_REQUEST_FAILED", "E_MODEL_REQUEST_TIMEOUT", "E_MODEL_HTTP_ERROR", "E_MODEL_RESPONSE_PARSE_FAILED",
]);
// 不接受任意供应商字符串：这些字段也可能错误地包含正文或凭据。
const SAFE_VENDOR_CODES = new Set([
  "context_length_exceeded", "invalid_request_error", "invalid_request", "unsupported_parameter", "unsupported_value",
  "model_not_found", "insufficient_quota", "rate_limit_exceeded", "invalid_api_key", "authentication_error",
  "permission_error", "billing_error", "content_policy_violation", "server_error", "internal_server_error",
  "overloaded_error", "request_too_large", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN",
]);

export interface TranscriptCompactionDiagnostics {
  category?: ModelErrorCategory;
  httpStatus?: number;
  runtimeCode?: string;
  vendorCode?: string;
  requestId?: string;
}

function httpCategory(status: number | undefined): ModelErrorCategory | undefined {
  switch (status) {
    case 400: case 422: return "INVALID_REQUEST";
    case 401: return "AUTH";
    case 402: return "BILLING";
    case 403: return "PERMISSION";
    case 404: return "NOT_FOUND";
    case 408: case 504: return "TIMEOUT";
    case 409: return "CONFLICT";
    case 413: return "PAYLOAD_TOO_LARGE";
    case 429: return "RATE_LIMIT";
    default: return status !== undefined && status >= 500 ? "SERVER_ERROR" : undefined;
  }
}

/** 日志也只允许固定分类、数值状态及严格白名单元数据，不读取 message/body/headers。 */
export function getTranscriptCompactionDiagnostics(cause: unknown): TranscriptCompactionDiagnostics {
  const result: TranscriptCompactionDiagnostics = {};
  let value = cause;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && value && typeof value === "object" && !visited.has(value); depth++) {
    visited.add(value);
    const error = value as Record<string, unknown>;
    const failure = isModelFailureInfo(error.modelFailure) ? error.modelFailure : undefined;
    if (!result.category && failure?.category !== "UNKNOWN") result.category = failure?.category;
    const status = failure?.status ?? error.status ?? error.statusCode;
    if (result.httpStatus === undefined && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      result.httpStatus = status;
    }
    if (!result.runtimeCode && typeof error.code === "string" && MODEL_RUNTIME_CODES.has(error.code)) result.runtimeCode = error.code;
    if (!result.vendorCode && failure?.vendorCode && SAFE_VENDOR_CODES.has(failure.vendorCode)) result.vendorCode = failure.vendorCode;
    const requestId = failure?.requestId;
    if (!result.requestId && requestId && (/^req_[a-f0-9]{16,64}$/i.test(requestId)
      || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))) {
      result.requestId = requestId;
    }
    if (!result.category && (error.name === "TimeoutError" || error.code === "E_MODEL_REQUEST_TIMEOUT")) result.category = "TIMEOUT";
    if (!result.category && error.name === "AbortError") result.category = "CANCELLED";
    value = error.cause;
  }
  result.category ??= httpCategory(result.httpStatus);
  return result;
}

/** 只映射已知类别，绝不把供应商正文、请求体或原始异常信息发送到界面。 */
function modelFailureMessage(cause: unknown): string | undefined {
  const diagnostics = getTranscriptCompactionDiagnostics(cause);
  let message: string | undefined;
  switch (diagnostics.category) {
    case "AUTH": case "PERMISSION": message = "摘要模型认证或权限校验失败，请检查当前会话的 API 配置。"; break;
    case "BILLING": case "QUOTA": message = "摘要模型的余额或配额不足，请检查模型服务账号。"; break;
    case "RATE_LIMIT": message = "摘要模型请求受到限流，请稍后重试。"; break;
    case "CONTEXT_LIMIT": case "PAYLOAD_TOO_LARGE": message = "摘要请求超过模型的上下文或大小限制，请检查模型上下文配置。"; break;
    case "TIMEOUT": message = "摘要模型请求超时，请检查网络或稍后重试。"; break;
    case "NETWORK": case "OVERLOADED": case "SERVER_ERROR": case "UNAVAILABLE": message = "摘要模型暂时无法连接或服务异常，请稍后重试。"; break;
    case "CANCELLED": message = "摘要请求已取消，可以在会话空闲后重试。"; break;
    case "INVALID_REQUEST": message = "摘要模型拒绝了请求参数，请检查接口协议、模型名称和服务兼容性。"; break;
    case "NOT_FOUND": message = "摘要模型或接口地址不存在，请检查当前会话的模型名称和接口地址。"; break;
    case "CONTENT_POLICY": message = "摘要请求被模型服务的内容策略拦截，请检查服务限制或更换模型。"; break;
    case "CONFLICT": message = "摘要模型服务报告请求冲突，请稍后重试。"; break;
  }
  if (!message && diagnostics.runtimeCode === "E_MODEL_RESPONSE_PARSE_FAILED") {
    message = "摘要模型响应格式不完整或接口协议不兼容，请检查模型服务或更换接口。";
  }
  const details = [
    ...(diagnostics.httpStatus === undefined ? [] : [`HTTP ${diagnostics.httpStatus}`]),
    ...(diagnostics.runtimeCode ? [diagnostics.runtimeCode] : []),
  ];
  return message || details.length
    ? `${message ?? REASON_MESSAGES.model_request_failed}${details.length ? `（${details.join("；")}）` : ""}`
    : undefined;
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
