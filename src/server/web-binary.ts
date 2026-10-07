/** Restore binary arguments carried over JSON before forwarding to Node IPC. */
export function reviveWebBinary(value: unknown): any {
  if (Array.isArray(value)) return value.map(reviveWebBinary);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.__cyreneBinary !== undefined) {
    if (record.__cyreneBinary !== "base64" || typeof record.data !== "string"
      || record.data.length > 24 * 1024 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)) {
      throw new Error("INVALID_BINARY_PAYLOAD");
    }
    const bytes = Buffer.from(record.data, "base64");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, reviveWebBinary(item)]));
}
