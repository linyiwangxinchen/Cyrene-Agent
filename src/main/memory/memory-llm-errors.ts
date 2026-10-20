import { getModelRequestDiagnostics, type ModelRequestDiagnostics } from "../../shared/model-request-diagnostics";

/**
 * Memory LLM 统一错误类型。
 *
 * 所有从 Memory LLM Client 抛出的错误都是这些类型的实例，
 * 让 trace 和用户诊断能区分超时、HTTP 错误、协议错误和配置错误。
 */

export class MemoryLlmTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly operation: string,
  ) {
    super(`Memory LLM [${operation}] timed out after ${timeoutMs}ms`);
    this.name = "MemoryLlmTimeoutError";
  }
}

export class MemoryLlmHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly operation: string,
    public readonly responseBody?: string,
  ) {
    super(`Memory LLM [${operation}] HTTP ${statusCode}`);
    this.name = "MemoryLlmHttpError";
  }
}

export class MemoryLlmProtocolError extends Error {
  readonly diagnostics?: ModelRequestDiagnostics;
  readonly failureCode?: string;
  constructor(
    public readonly operation: string,
    public readonly detail: string,
    options?: { diagnostics?: ModelRequestDiagnostics; failureCode?: string },
  ) {
    super(`Memory LLM [${operation}] protocol error: ${detail}`);
    this.name = "MemoryLlmProtocolError";
    this.diagnostics = options?.diagnostics;
    this.failureCode = options?.failureCode;
  }
}

const OPERATIONS = new Set(["judge", "compress", "reflect", "resolve", "summary", "wiki"]);
const FAILURE_CODES = new Set([
  "MODEL_REQUEST_FAILED", "MODEL_REQUEST_TIMEOUT", "MODEL_HTTP_ERROR", "MODEL_RESPONSE_PARSE_FAILED", "CANCELLED",
  "REFUSED", "CONTENT_FILTERED", "UNEXPECTED_TOOL_CALL", "UNKNOWN_FINISH_REASON", "REPAIR_EXHAUSTED",
  "INSUFFICIENT_REPAIR_BUDGET", "TRUNCATED_OUTPUT",
]);

/** 后台任务可直接记录此摘要；绝不拼接供应商响应体或任意异常消息。 */
export function formatMemoryLlmError(error: unknown): string {
  if (error instanceof MemoryLlmConfigurationError) return "后台记忆模型配置不完整，请检查模型设置。";
  if (!(error instanceof MemoryLlmTimeoutError || error instanceof MemoryLlmHttpError || error instanceof MemoryLlmProtocolError)) {
    return "后台记忆任务失败（详见结构化请求诊断）";
  }
  const operation = OPERATIONS.has(error.operation) ? error.operation : "memory";
  const diagnostics = error instanceof MemoryLlmProtocolError ? error.diagnostics ?? {} : getModelRequestDiagnostics(error);
  // 即使调用者传入被污染的诊断对象，日志也仅使用已校验的固定类别和数值字段。
  const safe = getModelRequestDiagnostics({
    code: diagnostics.runtimeCode,
    status: diagnostics.httpStatus,
    modelFailure: { provider: "memory", model: "memory", category: diagnostics.category ?? "UNKNOWN" },
  });
  const details = [
    ...(error instanceof MemoryLlmProtocolError && error.failureCode && FAILURE_CODES.has(error.failureCode) ? [error.failureCode] : []),
    ...(safe.category ? [safe.category] : []),
    ...(safe.httpStatus === undefined ? [] : [`HTTP ${safe.httpStatus}`]),
    ...(safe.runtimeCode ? [safe.runtimeCode] : []),
  ];
  return `后台记忆任务 [${operation}] 失败${details.length ? `：${details.join("；")}` : "（详见结构化请求诊断）"}`;
}

export class MemoryLlmConfigurationError extends Error {
  constructor(detail: string) {
    super(`Memory LLM configuration error: ${detail}`);
    this.name = "MemoryLlmConfigurationError";
  }
}
