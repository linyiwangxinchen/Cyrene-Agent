import type { ChannelAdapter } from "./base";
import type { ChannelCapability, ChannelSendOptions, ChannelStatus, MessageAcceptance, MessageHandler, OutgoingMessage } from "../types";
import { QqModuleManager } from "../../qq-modules/manager";

/** Fixed host-owned qq identity, not a generic plugin adapter or protocol backend.
 * Opt-in only: existing NapCatAdapter remains the active driver in init.ts. */
export class QqModuleAdapter implements ChannelAdapter {
  readonly id = "qq" as const;
  readonly displayName = "QQ（独立模块）";
  constructor(readonly manager: QqModuleManager) {}
  get onMessage(): MessageHandler | null { return this.manager.onMessage; }
  set onMessage(handler: MessageHandler | null) { this.manager.onMessage = handler; }
  get onMessageAccepted(): MessageAcceptance | null { return this.manager.onMessageAccepted; }
  set onMessageAccepted(handler: MessageAcceptance | null) { this.manager.onMessageAccepted = handler; }
  getMemoryAccountId(): string | undefined { return this.manager.getMemoryAccountId(); }
  get capability(): ChannelCapability { return this.manager.getCapabilities().messages; }
  start(): Promise<void> { return this.manager.start(); }
  stop(): Promise<void> { return this.manager.stop(); }
  async send(message: OutgoingMessage, options?: ChannelSendOptions): Promise<{ ok: boolean; error?: string; deliveryState?: "failed" | "unknown" }> {
    const result = await this.manager.send(message, options);
    return result.outcome === "sent" ? { ok: true } : {
      ok: false,
      error: `QQ_MODULE_SEND_${result.outcome.toUpperCase()}`,
      deliveryState: result.outcome === "unknown" || result.outcome === "partial" ? "unknown" : "failed",
    };
  }
  getStatus(): ChannelStatus {
    const state = this.manager.getState();
    const phase = state.phase === "running" ? "running"
      : ["starting", "waiting-backend", "draining"].includes(state.phase) ? "starting"
        : ["module-missing", "config-missing"].includes(state.phase) ? "config_missing"
          : ["disabled", "stopped"].includes(state.phase) ? "offline" : "error";
    return { enabled: state.enabled, phase, message: `QQ_MODULE_${state.phase.toUpperCase().replaceAll("-", "_")}` };
  }
}
