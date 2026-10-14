import type { ChannelManager } from "./manager";
import type { OutgoingMessage, ChannelSendOptions } from "./types";

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ChannelDeliveryService {
  send(message: OutgoingMessage, options?: ChannelSendOptions): Promise<DeliveryResult>;
}

export function createChannelDeliveryService(
  manager: Pick<ChannelManager, "getAdapter">,
): ChannelDeliveryService {
  return {
    async send(message, options): Promise<DeliveryResult> {
      if (options?.signal?.aborted) return { ok: false, error: "发送已取消" };
      const adapter = manager.getAdapter(message.channel);
      if (!adapter) {
        return { ok: false, error: "adapter_not_found" };
      }
      if (!adapter.getStatus().enabled) return { ok: false, error: "channel_disabled" };

      try {
        const result = await (options ? adapter.send(message, options) : adapter.send(message));
        if (result.ok) return { ok: true };
        return { ok: false, error: result.error || "send_failed" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
