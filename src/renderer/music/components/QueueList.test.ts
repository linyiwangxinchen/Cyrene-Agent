// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueueList from "./QueueList";
import type { Track } from "../types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const tracks = (count: number): Track[] => Array.from({ length: count }, (_, i) => ({
  encryptedId: `song-${i}`, originalId: `${i}`, name: `Song ${i}`, artists: ["Artist"], visible: true,
}));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return { width: 600, height: this.classList.contains("queue-item") ? 48 : 480, top: 0, left: 0, right: 600, bottom: 480, x: 0, y: 0, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () { return this.classList.contains("queue-item") ? 48 : 480; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(queue: Track[], extra = {}) {
  await act(async () => root.render(createElement(QueueList, { queue, onPlay: vi.fn(), ...extra })));
}
async function scroll(top: number) {
  const viewport = host.querySelector(".queue")!;
  await act(async () => { viewport.scrollTop = top; viewport.dispatchEvent(new Event("scroll")); });
}

describe("QueueList virtual rows", () => {
  it("bounds DOM rows for 1000 songs without truncating the scrollable queue", async () => {
    await render(tracks(1000));
    expect(host.querySelectorAll(".queue-item").length).toBeGreaterThan(0);
    expect(host.querySelectorAll(".queue-item").length).toBeLessThan(40);
    await scroll(48 * 990);
    expect(host.textContent).toContain("Song 999");
    expect(host.querySelectorAll(".queue-item").length).toBeLessThan(40);
    await scroll(0);
    expect(host.textContent).toContain("Song 0");
  });
  it("keeps play and remove callbacks attached to the original queue index after scrolling", async () => {
    const queue = tracks(1000); const onPlay = vi.fn(); const onRemove = vi.fn();
    await render(queue, { currentId: "song-500", onPlay, onRemove }); await scroll(48 * 500);
    const row = Array.from(host.querySelectorAll(".queue-item")).find((el) => el.textContent?.includes("Song 500Artist"))!;
    expect(row.classList.contains("is-active")).toBe(true);
    await act(async () => { (row.querySelector(".queue-main") as HTMLButtonElement).click(); (row.querySelector(".queue-remove") as HTMLButtonElement).click(); });
    expect(onPlay).toHaveBeenCalledWith(queue[500]); expect(onRemove).toHaveBeenCalledWith(500);
  });
  it("shows a replacement short queue and recovers after the empty state", async () => {
    await render(tracks(1000)); await scroll(48 * 990);
    await render(tracks(3));
    expect(host.textContent).toContain("Song 0");
    expect(host.textContent).toContain("Song 2");
    await render([]); expect(host.textContent).toBe("队列为空");
    await render(tracks(1000));
    expect(host.textContent).toContain("Song 0");
  });
  it("preserves disabled playback and cache deletion targets", async () => {
    const queue = tracks(1000); queue[500].visible = false; const onPlay = vi.fn(); const onDeleteTrack = vi.fn();
    await render(queue, { onPlay, onDeleteTrack }); await scroll(48 * 500);
    const row = host.querySelector(".queue-item.is-disabled")!;
    await act(async () => { (row.querySelector(".queue-main") as HTMLButtonElement).click(); row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); (row.querySelector(".queue-delete") as HTMLButtonElement).click(); });
    expect(onPlay).not.toHaveBeenCalled(); expect(onDeleteTrack).toHaveBeenCalledWith(queue[500]);
  });
});
