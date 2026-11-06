/**
 * 非敏感的模型缓存结构诊断。
 * 只包含指纹和计数，绝不携带提示词、工具参数或工具输出。
 */
export interface CacheDiagnostic {
  runId?: string;
  cacheEpoch: number;
  round: number;
  stablePromptFingerprint: string;
  toolSchemaFingerprint: string;
  messagePrefixFingerprint: string;
  messageCount: number;
}

export function isCacheDiagnostic(value: unknown): value is CacheDiagnostic {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CacheDiagnostic>;
  return Number.isInteger(item.cacheEpoch)
    && Number.isInteger(item.round)
    && typeof item.stablePromptFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(item.stablePromptFingerprint)
    && typeof item.toolSchemaFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(item.toolSchemaFingerprint)
    && typeof item.messagePrefixFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(item.messagePrefixFingerprint)
    && typeof item.messageCount === "number"
    && Number.isInteger(item.messageCount)
    && item.messageCount >= 0
    && (item.runId === undefined || typeof item.runId === "string");
}
