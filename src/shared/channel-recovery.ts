/** Public operational status. Never exposes raw platform payloads, tokens or server file paths. */
export interface ChannelRecoveryItem {
  id: string; kind: "inbox" | "outbox" | "corrupt"; channel: string; createdAt: number; updatedAt: number;
  active: boolean; status: string; conversationId?: string; targetId: string; preview: string; error?: string;
  parts: Array<{ index: number; kind: string; status: string; error?: string }>;
}
export interface ChannelRecoveryApi {
  list(): Promise<ChannelRecoveryItem[]>;
  retry(input: { id: string; confirmed: boolean }): Promise<{ ok: boolean; error?: string }>;
  resolve(input: { id: string; index: number; outcome: "sent" | "not_sent"; confirmed: boolean }): Promise<{ ok: boolean }>;
  cancel(input: { id: string }): Promise<{ ok: boolean }>;
}
