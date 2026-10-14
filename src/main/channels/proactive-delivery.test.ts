import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "./adapters/base";
import {
  createProactiveChannelRecipientRegistry,
  sendProactiveChannelMessage,
  getProactiveChannelAvailability,
} from "./proactive-delivery";
import type { ChannelCapability, IncomingMessage } from "./types";

const capability: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: true,
  maxTextLength: 4000,
};

function incoming(channel: "wechat" | "feishu", senderId: string, chatId = senderId): IncomingMessage {
  return { channel, senderId, chatId, text: "你好", at: new Date() };
}

function fakeAdapter(phase: "running" | "offline" = "running"): ChannelAdapter {
  return {
    id: "wechat",
    displayName: "test",
    capability,
    onMessage: null,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: vi.fn(() => ({ enabled: phase === "running", phase })),
  };
}

describe("proactive channel delivery", () => {
  let registry = createProactiveChannelRecipientRegistry();

  beforeEach(() => {
    registry = createProactiveChannelRecipientRegistry();
  });

  it("keeps the latest recipient independently for each channel", () => {
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    registry.remember(incoming("feishu", "fs-1"), "session-fs-1");
    registry.remember(incoming("wechat", "wx-2", "wx-chat-2"), "session-wx-2");

    expect(registry.get("wechat")).toMatchObject({ targetId: "wx-chat-2", sessionId: "session-wx-2" });
    expect(registry.get("feishu")).toMatchObject({ targetId: "fs-1", sessionId: "session-fs-1" });
  });

  it("cancels while the selected channel is offline", async () => {
    const adapter = fakeAdapter("offline");
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "cancelled", reason: "channel_offline" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("cancels when the channel has no current-process recipient", async () => {
    const adapter = fakeAdapter();
    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "cancelled", reason: "recipient_unavailable" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("sends one complete text part when segmentation is off", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "off",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 1 });
    expect(adapter.send).toHaveBeenCalledWith({
      channel: "wechat",
      targetId: "wx-1",
      parts: [{ kind: "text", text: "第一句。第二句？" }],
    });
  });

  it("sends segmented text sequentially and caps it at ten parts", async () => {
    const adapter = fakeAdapter();
    const order: string[] = [];
    vi.mocked(adapter.send).mockImplementation(async (message) => {
      const part = message.parts[0];
      if (part.kind === "text") order.push(part.text);
      return { ok: true };
    });
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    const text = Array.from({ length: 12 }, (_, index) => `第${index + 1}句。`).join("");

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text,
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 10, totalParts: 10 });
    expect(order).toHaveLength(10);
    expect(order.slice(0, 2)).toEqual(["第1句。", "第2句。"]);
    expect(order[9]).toContain("第12句。");
  });

  it("cancels total failure but commits a partial delivery", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    vi.mocked(adapter.send).mockResolvedValue({ ok: false, error: "failed" });

    const failed = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
    });
    expect(failed).toEqual({ kind: "cancelled", reason: "failed" });

    vi.mocked(adapter.send)
      .mockReset()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "failed" });
    const appendHistory = vi.fn();
    const appendLog = vi.fn();
    const partial = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory,
      appendLog,
    });

    expect(partial).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 2 });
    expect(appendHistory).toHaveBeenCalledWith("session-wx-1", "assistant", "第一句。");
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ text: "第一句。" }));
  });

  it("通过统一传输服务发送并只提交实际送达的片段", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    let attempts = 0;
    let committedText = "";

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      delivery: {
        send: async () => {
          attempts += 1;
          return attempts === 1
            ? { ok: true }
            : { ok: false, error: "send_failed" };
        },
      },
      recipientRegistry: registry,
      appendHistory: (_sessionId, _role, text) => {
        committedText = text;
      },
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 2 });
    expect(committedText).toBe("第一句。");
  });

  it("stops before the next segment when the proactive generation becomes invalid", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    let allowed = true;
    vi.mocked(adapter.send).mockImplementation(async () => {
      allowed = false;
      return { ok: true };
    });

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
      canContinue: () => allowed,
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 2 });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failed segment instead of sending later fragments", async () => {
    const adapter = fakeAdapter();
    registry.remember(incoming("wechat", "wx-1"), "session-wx-1");
    vi.mocked(adapter.send)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "failed" })
      .mockResolvedValueOnce({ ok: true });

    const result = await sendProactiveChannelMessage({
      channel: "wechat",
      text: "第一句。第二句？第三句！",
      mobileMessageSegmentation: "on",
      manager: { getAdapter: () => adapter },
      recipientRegistry: registry,
      appendHistory: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result).toEqual({ kind: "committed", deliveredParts: 1, totalParts: 3 });
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });
});

describe("bound proactive recipient selection", () => {
  const bound = {
    externalChats: [{ sessionId: "wx-bound", channel: "wechat", chatId: "explicit-user", chatType: "private" as const, lastAt: 1 }],
    bindings: [{ sessionId: "wx-bound", conversationId: "local-chat", updatedAt: 1 }],
  };
  it("restores a unique persisted private binding after restart and prioritizes it over recent traffic", () => {
    const registry = createProactiveChannelRecipientRegistry();
    const manager = { getAdapter: () => fakeAdapter() };
    expect(getProactiveChannelAvailability("wechat", manager, registry, bound)).toMatchObject({ available: true, recipient: { targetId: "explicit-user", conversationId: "local-chat" } });
    registry.remember(incoming("wechat", "incidental-user"), "other-session");
    expect(getProactiveChannelAvailability("wechat", manager, registry, bound)).toMatchObject({ recipient: { targetId: "explicit-user" } });
  });
  it("refuses ambiguous private bindings and never remembers a group as a proactive target", () => {
    const registry = createProactiveChannelRecipientRegistry();
    registry.remember({ ...incoming("feishu", "member", "group"), chatType: "group" }, "group-session");
    expect(registry.get("feishu")).toBeNull();
    const bindings = { externalChats: [...bound.externalChats, { ...bound.externalChats[0], sessionId: "other", chatId: "other-user" }], bindings: [...bound.bindings, { sessionId: "other", conversationId: "other-chat", updatedAt: 2 }] };
    expect(getProactiveChannelAvailability("wechat", { getAdapter: () => fakeAdapter() }, registry, bindings)).toEqual({ available: false, reason: "recipient_ambiguous" });
  });
  it("checks both the saved enabled state and protocol-specific reply context", () => {
    const registry = createProactiveChannelRecipientRegistry(); const adapter = fakeAdapter();
    adapter.getProactiveAvailability = () => ({ available: false, reason: "wechat_context_missing" });
    expect(getProactiveChannelAvailability("wechat", { getAdapter: () => adapter }, registry, bound)).toEqual({ available: false, reason: "wechat_context_missing" });
    adapter.getStatus = () => ({ phase: "running", enabled: false });
    expect(getProactiveChannelAvailability("wechat", { getAdapter: () => adapter }, registry, bound)).toEqual({ available: false, reason: "channel_offline" });
  });
  it("journals actual delivered text and does not turn a post-send history failure into a resend", async () => {
    const adapter = fakeAdapter(); const appendHistory = vi.fn(); const recordDelivery = vi.fn(async () => { throw new Error("disk full"); });
    const result = await sendProactiveChannelMessage({ channel: "wechat", text: "考试准备得怎么样啦？", mobileMessageSegmentation: "off", manager: { getAdapter: () => adapter }, recipient: { targetId: "explicit-user", sessionId: "wx-bound", conversationId: "local-chat", updatedAt: 1 }, recordDelivery, appendHistory, appendLog: vi.fn() });
    expect(result.kind).toBe("committed"); expect(adapter.send).toHaveBeenCalledOnce();
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "local-chat" }), "考试准备得怎么样啦？");
    expect(appendHistory).not.toHaveBeenCalled();
  });
});
