const IDENTITY_FAILURE = "could not resolve bot identity via /open-apis/bot/v3/info — required for channel to function";
const MISSING_OPEN_ID = "bot/v3/info response missing open_id: ";
const NETWORK_CODES = new Set(["EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

// Some SDK clients replace the numeric fatal level (0) with their default.
// Their logger can receive raw Axios requests, including credentials.
export const silentFeishuSdkLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

type SdkError = Error & {
  code?: unknown;
  config?: { url?: unknown };
  response?: { status?: unknown; data?: { code?: unknown } };
};

function asError(value: unknown): SdkError | undefined {
  return value instanceof Error ? value : undefined;
}

function businessCodeFromIdentityError(message: string): number | undefined {
  const json = message.slice(MISSING_OPEN_ID.length);
  try {
    const response: { code?: unknown } | null = JSON.parse(json);
    const code = response?.code;
    return typeof code === "number" && Number.isSafeInteger(code) && code !== 0 ? code : undefined;
  } catch {
    // SDK truncates the original JSON after 200 characters.
    const code = Number(json.match(/^\{\s*"code"\s*:\s*(-?\d+)\s*[,}]/u)?.[1]);
    return Number.isSafeInteger(code) && code !== 0 ? code : undefined;
  }
}

/** Only stable codes and fixed labels leave the SDK boundary. Axios errors may carry credentials. */
export function formatFeishuConnectionError(error: unknown): string {
  const outer = asError(error);
  const cause = asError(outer?.cause) ?? outer;
  const causeMessage = cause?.message ?? "";
  const requestUrl = typeof cause?.config?.url === "string" ? cause.config.url : "";
  const tokenFailure = causeMessage.startsWith("failed to get tenant_access_token, code: ");
  const tokenCode = causeMessage.match(/^failed to get tenant_access_token, code: (-?\d+), msg:/u)?.[1];
  const missingOpenId = causeMessage.startsWith(MISSING_OPEN_ID);
  const stage = tokenFailure || requestUrl.endsWith("/open-apis/auth/v3/tenant_access_token/internal")
    ? "token"
    : outer?.message === IDENTITY_FAILURE || missingOpenId || requestUrl.endsWith("/open-apis/bot/v3/info")
      ? "identity"
      : outer?.message.startsWith("WebSocket connect failed:") || outer?.message.startsWith("WebSocket handshake did not complete")
        ? "websocket"
        : undefined;

  const status = cause?.response?.status;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const code = cause?.response?.data?.code;
  const feishuCode = typeof code === "number" && Number.isSafeInteger(code) && code !== 0
    ? code : tokenCode ? Number(tokenCode) : missingOpenId ? businessCodeFromIdentityError(causeMessage) : undefined;
  const networkCode = typeof cause?.code === "string" && NETWORK_CODES.has(cause.code) ? cause.code : undefined;
  const labels = [
    httpStatus !== undefined && `HTTP ${httpStatus}`,
    Number.isSafeInteger(feishuCode) && `飞书错误码 ${feishuCode}`,
    networkCode,
  ].filter(Boolean);
  const detail = labels.length > 0 ? `（${labels.join("，")}）` : "";

  if (stage === "token") {
    const verifyCredentials = feishuCode === 10014 || feishuCode === 10015 || feishuCode === 20002;
    return `获取飞书租户访问凭证失败${detail}${verifyCredentials ? "。请核对同一应用的 App ID、App Secret 和应用状态。" : ""}`;
  }
  if (stage === "identity") {
    if (missingOpenId && !labels.length) return "获取飞书机器人身份失败（响应没有机器人 Open ID）。请核对机器人能力和应用发布状态。";
    return detail ? `获取飞书机器人身份失败${detail}` : IDENTITY_FAILURE;
  }
  if (stage === "websocket") return `飞书 WebSocket 握手失败${detail}`;
  return `飞书连接失败${detail}`;
}
