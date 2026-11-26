// ChannelManager —— 渠道注册表 + 生命周期管理。
//
// 设计原则：
//   - Manager 只做"哪个渠道注册了、它们的启停状态"。不知道任何平台协议细节。
//   - 入站消息路径：adapters.onMessage → manager.handleIncoming(msg) → dispatcher。
//     实际转发由 dispatcher 负责；manager 只持有 dispatcher 的入口引用。
//   - 出站消息路径：dispatcher 拿到 outgoing 后调 adapter.send(outgoing)。
//   - Manager 不感知 sessionId、不感知 cap 降级、不感知 tool 调用 —— 全部下放。
import type { ChannelAdapter } from "./adapters/base";
import type { ChannelId, ChannelStatus, IncomingMessage, MessageAcceptance, OutgoingMessage } from "./types";
import { setAdapterHandler } from "./adapters/base";
import { logger, LogTag } from "../logger";

const LOG = "[ChannelManager]";

/** dispatcher 给 manager 的回调 —— 拿到入站消息后返回一个 outgoing 消息 */
export type DispatchFn = (msg: IncomingMessage) => Promise<OutgoingMessage | null>;

export interface PluginChannelRegistrationPort {
  has(id: ChannelId): boolean;
  register(adapter: ChannelAdapter): void;
  unregister(id: ChannelId): Promise<boolean>;
  startOne(id: ChannelId): Promise<void>;
}

export class ChannelManager {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly hostOwner = Symbol("host-channels");
  private readonly owners = new Map<ChannelId, symbol>();
  private dispatchFn: DispatchFn | null = null;
  private acceptFn: MessageAcceptance | null = null;
  /** 启动后已开启的 adapter（start 成功的才会调 stop） */
  private startedAdapters = new Set<ChannelId>();
  private stoppingAdapters = new Set<ChannelId>();
  private stopGeneration = 0;
  private startingAdapters = new Map<ChannelAdapter, { result: Promise<void>; settled: Promise<void>; signal: AbortSignal; cancel(): void }>();

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  /** 注册 adapter（必须在 startAll 之前调用；重复 id 一律拒绝） */
  register(adapter: ChannelAdapter): void {
    this.registerOwned(adapter, this.hostOwner);
  }

  /** A normal plugin cannot manage host channels or another registration port. */
  createPluginPort(): PluginChannelRegistrationPort {
    const owner = Symbol("plugin-channels");
    return {
      has: id => this.has(id),
      register: adapter => this.registerOwned(adapter, owner),
      unregister: id => this.unregisterOwned(id, owner),
      startOne: id => this.startOwned(id, owner),
    };
  }

  private assertOwner(id: ChannelId, owner: symbol): void {
    if (owner !== this.hostOwner && (id === "qq" || id === "qqbot")) {
      throw new Error(`渠道 ${id} 是宿主保留身份，普通插件不可管理`);
    }
    const registeredOwner = this.owners.get(id);
    if (registeredOwner && registeredOwner !== owner) throw new Error(`不能管理不属于当前注册端口的渠道: ${id}`);
  }

  private registerOwned(adapter: ChannelAdapter, owner: symbol): void {
    const id = adapter.id;
    this.assertOwner(id, owner);
    if (this.adapters.has(id)) throw new Error(`渠道 ${id} 已注册，禁止覆盖现有实例`);
    this.adapters.set(id, adapter);
    this.owners.set(id, owner);
  }

  private attachHandlers(channel: ChannelId, adapter: ChannelAdapter): void {
    const generation = this.stopGeneration;
    const usable = (msg: IncomingMessage) => generation === this.stopGeneration
      && this.adapters.get(channel) === adapter && msg.channel === channel
      && !this.stoppingAdapters.has(channel) && adapter.getStatus().enabled;
    setAdapterHandler(adapter, this.makeAdapterHandler(channel, usable));
    const accept = this.acceptFn;
    adapter.onMessageAccepted = accept ? async (msg, trackWork) => {
      if (!usable(msg)) throw new Error("channel_disabled");
      await accept(msg, trackWork); // A transport may retry when durable acceptance fails.
    } : null;
  }

  /** 设置 dispatcher 入口。注册 adapter 时机不限，dispatcher 注入必须早于 startAll。 */
  setDispatcher(fn: DispatchFn, accept?: MessageAcceptance): void {
    this.dispatchFn = fn;
    this.acceptFn = accept ?? null;
    // 给所有已注册的 adapter 注入 handler
    for (const [id, adapter] of this.adapters) {
      this.attachHandlers(id, adapter);
    }
  }

  /** 启动所有已注册 adapter（失败的跳过、记 log） */
  async startAll(): Promise<void> {
    const generation = this.stopGeneration;
    for (const [id, adapter] of this.adapters) {
      if (generation !== this.stopGeneration) break;
      try {
        await this.startAdapter(id, adapter);
      } catch (err) {
        console.error(LOG, `渠道启动失败 [${adapter.id}]:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 注销 adapter：若已启动先 stop，再移除（运行时禁用插件渠道用） */
  async unregister(id: ChannelId): Promise<boolean> {
    return this.unregisterOwned(id, this.hostOwner);
  }

  private async unregisterOwned(id: ChannelId, owner: symbol): Promise<boolean> {
    this.assertOwner(id, owner);
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    this.stoppingAdapters.add(id);
    this.startingAdapters.get(adapter)?.cancel();
    setAdapterHandler(adapter, null);
    adapter.onMessageAccepted = null;
    if (this.startedAdapters.has(id)) {
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
      this.startedAdapters.delete(id);
    }
    this.adapters.delete(id);
    this.owners.delete(id);
    this.stoppingAdapters.delete(id);
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }

  /** 启动单个 adapter（运行时启用插件渠道用） */
  async startOne(id: ChannelId): Promise<void> {
    await this.startOwned(id, this.hostOwner);
  }

  private async startOwned(id: ChannelId, owner: symbol): Promise<void> {
    this.assertOwner(id, owner);
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    return this.startAdapter(id, adapter);
  }

  private startAdapter(id: ChannelId, adapter: ChannelAdapter): Promise<void> {
    const pending = this.startingAdapters.get(adapter);
    if (pending) {
      if (!pending.signal.aborted) return pending.result;
      const generation = this.stopGeneration;
      return pending.settled.catch(() => undefined).then(() => {
        if (generation === this.stopGeneration) return this.startAdapter(id, adapter);
      });
    }
    if (this.adapters.get(id) !== adapter || this.startedAdapters.has(id)) return Promise.resolve();
    const controller = new AbortController();
    const settled = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      if (this.dispatchFn) this.attachHandlers(id, adapter);
      try {
        await adapter.start(controller.signal);
      } finally {
        if (controller.signal.aborted || this.adapters.get(id) !== adapter) await adapter.stop();
      }
      controller.signal.throwIfAborted();
      if (this.adapters.get(id) !== adapter) return;
      this.startedAdapters.add(id);
      logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
    }).finally(() => this.startingAdapters.delete(adapter));
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const result = Promise.race([settled, cancelled]);
    this.startingAdapters.set(adapter, {
      result,
      settled,
      signal: controller.signal,
      cancel: () => controller.abort(new Error(`channel startup cancelled: ${id}`)),
    });
    return result;
  }

  /** 关闭所有已启动的 adapter */
  async restartOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    this.stoppingAdapters.add(id);
    try {
      const starting = this.startingAdapters.get(adapter);
      if (starting) {
        starting.cancel();
        await starting.settled.catch(() => undefined);
      } else {
        await adapter.stop();
      }
      this.startedAdapters.delete(id);
      await this.startOne(id);
    } finally { this.stoppingAdapters.delete(id); }
  }

  async stopAll(): Promise<void> {
    this.stopGeneration++;
    for (const [adapter, entry] of this.startingAdapters) {
      entry.cancel();
      setAdapterHandler(adapter, null);
      adapter.onMessageAccepted = null;
    }
    const started = [...this.startedAdapters];
    this.startedAdapters.clear();
    for (const id of started) {
      const adapter = this.adapters.get(id);
      if (!adapter) continue;
      this.stoppingAdapters.add(id);
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      } finally { this.stoppingAdapters.delete(id); }
    }
  }

  getAdapter(channel: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  listChannels(): ChannelId[] {
    return Array.from(this.adapters.keys());
  }

  /** 给 UI 用：所有渠道的实时状态 */
  getAllStatus(): Record<ChannelId, ChannelStatus> {
    const out: Partial<Record<ChannelId, ChannelStatus>> = {};
    for (const [id, adapter] of this.adapters.entries()) {
      out[id] = adapter.getStatus();
    }
    return out as Record<ChannelId, ChannelStatus>;
  }

  private makeAdapterHandler(channel: ChannelId, usable: (msg: IncomingMessage) => boolean) {
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      if (!usable(msg)) return null;
      if (!this.dispatchFn) {
        console.warn(LOG, `收到入站消息但 dispatcher 未注册 [${channel}]`);
        return null;
      }
      try {
        return await this.dispatchFn(msg);
      } catch (err) {
        console.error(LOG, `dispatcher 处理失败 [${channel}]:`, err);
        return null;
      }
    };
  }

}

/** 进程级单例。index.ts 在 app.whenReady() 里实例化一次。 */
export const channelManager = new ChannelManager();
