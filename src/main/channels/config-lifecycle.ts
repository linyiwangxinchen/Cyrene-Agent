import type { ChannelId } from "./types";
import type { ChannelConfigPatch, ChannelsSettings } from "./settings-store";

const CHANNEL_IDS: ChannelId[] = ["wechat", "feishu", "qq", "qqbot"];

/** Serialize settings and connection changes so a saved switch reflects runtime state. */
export function createChannelConfigLifecycle(deps: {
  load(): ChannelsSettings;
  save(patch: ChannelConfigPatch): ChannelsSettings;
  reload(): void;
  restartOne(id: ChannelId): Promise<void>;
  restartAll(): Promise<void>;
  cancelWechatLogin(): void;
  broadcast(): void;
}) {
  let pending: Promise<unknown> = Promise.resolve();
  function run<T>(action: () => Promise<T>): Promise<T> {
    const result = pending.then(action);
    pending = result.catch(() => undefined);
    return result;
  }
  return {
    save(patch: ChannelConfigPatch): Promise<void> {
      return run(async () => {
        const before = deps.load();
        const after = deps.save(patch);
        deps.reload();
        // Cancel even when already disabled: QR login must not enable it later.
        if (patch.wechat?.enabled === false) deps.cancelWechatLogin();
        try {
          for (const id of CHANNEL_IDS) {
            if (typeof patch[id]?.enabled === "boolean" || before[id].enabled !== after[id].enabled) await deps.restartOne(id);
          }
        } finally { deps.broadcast(); }
      });
    },
    restart(): Promise<void> {
      return run(async () => {
        try { await deps.restartAll(); } finally { deps.broadcast(); }
      });
    },
  };
}
