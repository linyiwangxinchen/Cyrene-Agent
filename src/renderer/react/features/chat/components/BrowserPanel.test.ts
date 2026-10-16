// @vitest-environment jsdom
import * as React from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserPanel } from "./BrowserPanel";
import { SidebarSearchDialog } from "./SidebarSearchDialog";
import { UserProfileDialog } from "../../../components/ui/UserProfileDialog";

vi.mock("../../../i18n", () => {
  const t = (key: string) => key;
  return { t, useTranslation: () => ({ t }) };
});
let host: HTMLDivElement, root: Root;
let bounds: ReturnType<typeof vi.fn>;
let resize: ResizeObserverCallback;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {} unobserve() {}
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function () {
    return (this.isConnected && !this.closest('[hidden], [style*="display: none"]') ? [{}] : []) as unknown as DOMRectList;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 400, y: 80, left: 400, top: 80, width: 500, height: 600 } as DOMRect);
  bounds = vi.fn().mockResolvedValue(true);
  Object.assign(window, { browserPanel: {
    setBounds: bounds,
    onStateChanged: () => () => {},
    getState: async () => ({ activeTabId: "", tabs: [] }),
  } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as any).browserPanel;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(open: boolean, active = true, kind: "search" | "profile" = "search") {
  const popup = kind === "search"
    ? createElement(SidebarSearchDialog, { open, sessions: [], onClose() {}, onSelect() {} })
    : createElement(UserProfileDialog, { open, onOpenChange() {}, avatarUrl: null });
  await act(async () => root.render(createElement(React.Fragment, null,
    createElement(BrowserPanel, { active }), popup)));
}

describe("BrowserPanel with real dialogs", () => {
  it.each(["search", "profile"] as const)("hides for %s, suppresses resize updates and restores after closing", async (kind) => {
    await render(false, true, kind);
    expect(bounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 500 }));
    await render(true, true, kind);
    expect(bounds).toHaveBeenLastCalledWith(null);
    bounds.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      resize([], {} as ResizeObserver);
    });
    expect(bounds).not.toHaveBeenCalled();
    await render(false, true, kind);
    // jsdom 不执行 CSS 动画；保留真实 Modal，显式完成退出动画。
    if (kind === "search") {
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect(document.querySelector('.ant-zoom-leave-active')).not.toBeNull();
      });
    }
    await act(async () => {
      document.querySelectorAll('.ant-modal, .ant-modal-mask').forEach((node) =>
        ["animationend", "webkitAnimationEnd"].forEach(name => node.dispatchEvent(new Event(name, { bubbles: true }))));
    });
    await vi.waitFor(() => expect(bounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 500 })));
  });
  it("does not restore a browser tab switched away while a dialog is open", async () => {
    await render(true);
    await render(true, false);
    bounds.mockClear();
    await render(false, false);
    expect(bounds).not.toHaveBeenCalled();
  });
  it("keeps an existing dialog above a newly activated browser tab", async () => {
    await render(true, false);
    bounds.mockClear();
    await render(true, true);
    expect(bounds.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(bounds).toHaveBeenCalledWith(null);
  });
});
