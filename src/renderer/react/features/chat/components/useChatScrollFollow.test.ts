// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useChatScrollFollow } from "./useChatScrollFollow";

let root: Root;
let host: HTMLDivElement;
let scroll: ReturnType<typeof useChatScrollFollow>;
let height = 1000;
const observers: Array<() => void> = [];

function Harness(props: { conversationId: string; revision: unknown; latestUserId: string }) {
  scroll = useChatScrollFollow(props);
  return createElement("div", { ref: scroll.containerRef, onScroll: scroll.updateScrollState }, createElement("div", { ref: scroll.contentRef }));
}
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = Math.max(0, Number(options.top) - 300); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness, { conversationId: "a", revision: 1, latestUserId: "user-1" })));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); observers.length = 0; height = 1000; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("follows streamed growth and delayed image/composer resizing in the outer viewport", async () => {
  await mount(); expect(scroll.containerRef.current!.scrollTop).toBe(700);
  height = 1300;
  await act(async () => root.render(createElement(Harness, { conversationId: "a", revision: 2, latestUserId: "user-1" })));
  expect(scroll.containerRef.current!.scrollTop).toBe(1000);
  height = 1600; observers.forEach(callback => callback());
  expect(scroll.containerRef.current!.scrollTop).toBe(1300);
});

it("preserves history reading until a new user turn, a bottom action, or a session switch", async () => {
  await mount(); scroll.containerRef.current!.scrollTop = 200; scroll.updateScrollState();
  height = 1300;
  await act(async () => root.render(createElement(Harness, { conversationId: "a", revision: 2, latestUserId: "user-1" })));
  observers.forEach(callback => callback()); expect(scroll.containerRef.current!.scrollTop).toBe(200);
  await act(async () => root.render(createElement(Harness, { conversationId: "a", revision: 3, latestUserId: "user-2" })));
  expect(scroll.containerRef.current!.scrollTop).toBe(1000);
  scroll.containerRef.current!.scrollTop = 100; scroll.updateScrollState(); scroll.scrollToBottom();
  expect(scroll.containerRef.current!.scrollTop).toBe(1000);
  scroll.containerRef.current!.scrollTop = 100; scroll.updateScrollState();
  await act(async () => root.render(createElement(Harness, { conversationId: "b", revision: 4, latestUserId: "other-user" })));
  expect(scroll.containerRef.current!.scrollTop).toBe(1000);
});
