// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "antd";
import { ChannelRecoveryPanel } from "./ChannelRecoveryPanel";
import type { ChannelRecoveryApi, ChannelRecoveryItem } from "../../../../shared/channel-recovery";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
let root: Root | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); });
const item: ChannelRecoveryItem = { id: "outbox-1", kind: "outbox", channel: "wechat", createdAt: 1, updatedAt: 2, active: false, status: "unknown", targetId: "微信联系人", conversationId: "原会话", preview: "报告正文", parts: [{ index: 0, kind: "text", status: "sent" }, { index: 1, kind: "file", status: "unknown" }] };
describe("channel recovery panel", () => {
  it("requires the unknown part to be reviewed before enabling resume and does not poll repeatedly", async () => {
    let records = [structuredClone(item)];
    const api: ChannelRecoveryApi = {
      list: vi.fn(async () => records), retry: vi.fn(async () => ({ ok: true })), cancel: vi.fn(async () => ({ ok: true })),
      resolve: vi.fn(async () => { records = [{ ...item, status: "pending", parts: [item.parts[0], { ...item.parts[1], status: "failed" }] }]; return { ok: true }; }),
    };
    let confirm: (() => unknown) | undefined;
    vi.spyOn(Modal, "confirm").mockImplementation(options => { confirm = options.onOk as () => unknown; return { destroy() {}, update() {} }; });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(ChannelRecoveryPanel, { api })));
    const button = (label: string) => Array.from(host.querySelectorAll("button")).find(node => node.textContent?.replace(/\s/g, "") === label)!;
    expect(button("恢复").disabled).toBe(true); expect(api.list).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("报告正文"); expect(host.textContent).toContain("原会话");
    await act(async () => button("确认未送达").click());
    expect(api.resolve).not.toHaveBeenCalled();
    await act(async () => { await confirm!(); });
    expect(api.resolve).toHaveBeenCalledWith({ id: "outbox-1", index: 1, outcome: "not_sent", confirmed: true });
    expect(button("恢复").disabled).toBe(false);
    await act(async () => button("显示已完成").click()); expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => button("恢复").click()); expect(api.retry).not.toHaveBeenCalled();
    await act(async () => { await confirm!(); }); expect(api.retry).toHaveBeenCalledWith({ id: "outbox-1", confirmed: true });
  });
});
