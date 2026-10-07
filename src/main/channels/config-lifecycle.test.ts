import { describe, expect, it, vi } from "vitest";
import { createChannelConfigLifecycle } from "./config-lifecycle";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelConfigPatch, ChannelsSettings } from "./settings-store";
import type { ChannelId } from "./types";

function setup() {
  let settings = { wechat: { enabled: true }, feishu: { enabled: false }, qq: { enabled: false }, qqbot: { enabled: false } } as ChannelsSettings;
  const restartOne = vi.fn(async (_id: ChannelId) => {});
  const deps = {
    load: () => structuredClone(settings),
    save: (patch: ChannelConfigPatch) => {
      for (const id of ["wechat", "feishu", "qq", "qqbot"] as const) {
        if (patch[id]) Object.assign(settings[id], patch[id]);
      }
      return structuredClone(settings);
    },
    reload: vi.fn(), restartOne, restartAll: vi.fn(async () => {}),
    cancelWechatLogin: vi.fn(), broadcast: vi.fn(),
  };
  return { deps, lifecycle: createChannelConfigLifecycle(deps) };
}

describe("channel configuration lifecycle", () => {
  it("disables the running connection before acknowledging the switch and preserves other channels", async () => {
    const { deps, lifecycle } = setup();
    const manager = new ChannelManager();
    let running = false;
    const adapter: ChannelAdapter = {
      id: "wechat", displayName: "wechat", capability: {} as never, onMessage: null,
      start: async () => { running = deps.load().wechat.enabled; },
      stop: async () => { running = false; }, send: vi.fn(async () => ({ ok: true })),
      getStatus: () => ({ enabled: running, phase: running ? "running" : "offline" }),
    };
    manager.register(adapter);
    const dispatch = vi.fn(async () => null); manager.setDispatcher(dispatch);
    deps.restartOne.mockImplementation(id => manager.restartOne(id));
    await manager.startAll(); expect(running).toBe(true);
    await lifecycle.save({ wechat: { enabled: false } });
    expect(running).toBe(false);
    expect(deps.restartOne).toHaveBeenCalledExactlyOnceWith("wechat");
    expect(deps.cancelWechatLogin).toHaveBeenCalledOnce();
    await adapter.onMessage?.({ channel: "wechat", chatId: "user", senderId: "user", text: "late message", at: new Date() });
    expect(dispatch).not.toHaveBeenCalled();
    await lifecycle.save({ wechat: { enabled: true } }); expect(running).toBe(true);
  });

  it("also reconciles a disabled setting with a stale running connection", async () => {
    const { deps, lifecycle } = setup();
    deps.save({ wechat: { enabled: false } });
    await lifecycle.save({ wechat: { enabled: false } });
    expect(deps.restartOne).toHaveBeenCalledExactlyOnceWith("wechat");
  });

  it("serializes rapid off/on changes and restart requests", async () => {
    const { deps, lifecycle } = setup();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    deps.restartOne.mockImplementationOnce(async () => { await barrier; });
    const off = lifecycle.save({ wechat: { enabled: false } });
    const on = lifecycle.save({ wechat: { enabled: true } });
    const restart = lifecycle.restart();
    await vi.waitFor(() => expect(deps.restartOne).toHaveBeenCalledTimes(1));
    expect(deps.load().wechat.enabled).toBe(false);
    expect(deps.restartAll).not.toHaveBeenCalled();
    release(); await Promise.all([off, on, restart]);
    expect(deps.load().wechat.enabled).toBe(true);
    expect(deps.restartOne).toHaveBeenCalledTimes(2);
    expect(deps.restartAll).toHaveBeenCalledOnce();
  });

  it("keeps global preference saves from restarting connections and recovers after a lifecycle error", async () => {
    const { deps, lifecycle } = setup();
    await lifecycle.save({ ttsEnabled: false }); expect(deps.restartOne).not.toHaveBeenCalled();
    deps.restartOne.mockRejectedValueOnce(new Error("stop failed"));
    await expect(lifecycle.save({ wechat: { enabled: false } })).rejects.toThrow("stop failed");
    await lifecycle.save({ wechat: { enabled: true } });
    expect(deps.load().wechat.enabled).toBe(true);
    expect(deps.broadcast).toHaveBeenCalledTimes(3);
  });
});
