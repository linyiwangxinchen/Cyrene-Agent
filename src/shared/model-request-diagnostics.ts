import { isModelFailureInfo, type ModelErrorCategory } from "./model-error";

/** 可写入后台日志的模型请求诊断；不包含供应商正文、地址、凭据或任意异常文本。 */
export interface ModelRequestDiagnostics {
  category?: ModelErrorCategory;
  httpStatus?: number;
  runtimeCode?: string;
}

const RUNTIME_CODES = new Set([
  "E_MODEL_REQUEST_FAILED", "E_MODEL_REQUEST_TIMEOUT", "E_MODEL_HTTP_ERROR", "E_MODEL_RESPONSE_PARSE_FAILED",
]);

export function getModelRequestDiagnostics(cause: unknown): ModelRequestDiagnostics {
  const result: ModelRequestDiagnostics = {};
  const visited = new Set<unknown>();
  let value = cause;
  for (let depth = 0; depth < 8 && value && typeof value === "object" && !visited.has(value); depth++) {
    visited.add(value);
    const error = value as Record<string, unknown>;
    const failure = isModelFailureInfo(error.modelFailure) ? error.modelFailure : undefined;
    if (!result.category && failure?.category !== "UNKNOWN") result.category = failure?.category;
    const status = failure?.status ?? error.status ?? error.statusCode;
    if (result.httpStatus === undefined && typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      result.httpStatus = status;
    }
    if (!result.runtimeCode && typeof error.code === "string" && RUNTIME_CODES.has(error.code)) result.runtimeCode = error.code;
    if (!result.category && (error.name === "TimeoutError" || error.name === "MemoryLlmTimeoutError"
      || error.code === "E_MODEL_REQUEST_TIMEOUT")) result.category = "TIMEOUT";
    if (!result.category && error.name === "AbortError") result.category = "CANCELLED";
    value = error.cause;
  }
  if (!result.category && result.httpStatus !== undefined) {
    const status = result.httpStatus;
    result.category = status === 401 ? "AUTH" : status === 403 ? "PERMISSION" : status === 429 ? "RATE_LIMIT"
      : status === 400 || status === 422 ? "INVALID_REQUEST" : status === 404 ? "NOT_FOUND"
        : status === 402 ? "BILLING" : status === 413 ? "PAYLOAD_TOO_LARGE"
          : status === 408 || status === 504 ? "TIMEOUT" : status >= 500 ? "SERVER_ERROR" : "UNKNOWN";
  }
  return result;
}
