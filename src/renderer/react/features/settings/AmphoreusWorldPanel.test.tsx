// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AmphoreusWorldPanel } from "./AmphoreusWorldPanel";
import { createDefaultXilianWorldData, type XilianWorldView } from "../../../../shared/xilian-world";
import { AMPHOREUS_LOCATIONS } from "../../../../shared/amphoreus-canon";
import { amphoreusView, createAmphoreusState } from "../../../../main/amphoreus-world/engine";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) });
const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element) => computedStyle(element);
let root: Root | undefined;
let host: HTMLDivElement;
let view: XilianWorldView;
const getWorld = vi.fn();
const configureWorld = vi.fn();
const getWorldHistory = vi.fn();
beforeEach(() => {
  const now = Date.parse("2026-11-10T12:30:00Z");
  view = { ...createDefaultXilianWorldData("2026-11-10", now), locations: AMPHOREUS_LOCATIONS, amphoreus: amphoreusView(createAmphoreusState(now), now, "UTC") };
  getWorld.mockReset().mockImplementation(async () => structuredClone(view));
  configureWorld.mockReset().mockImplementation(async ({ narrativeEnabled }) => { view.amphoreus!.narrativeEnabled = narrativeEnabled; });
  getWorldHistory.mockReset().mockResolvedValue({ entries: [] });
  localStorage.clear();
  Object.assign(window, { companion: { getWorld, configureWorld, getWorldHistory } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });
async function render() { await act(async () => { root!.render(createElement(AmphoreusWorldPanel)); }); }
const button = (text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.replace(/\s/g, "") === text)!;
const tab = (text: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => b.textContent === text)!;

it("shows model availability separately from residents’ independent meals and allows a daily-generation toggle", async () => {
  await render();
  expect(host.textContent).toContain("翁法罗斯");
  expect(host.textContent).toContain("等待今日续写");
  await act(async () => tab("居民").click());
  expect(host.querySelectorAll("article").length).toBeGreaterThanOrEqual(19);
  expect(host.textContent).toContain("德墨忒尔");
  expect(host.textContent).toContain("吃午餐");
  await act(async () => (host.querySelector('[role="switch"]') as HTMLElement).click());
  expect(configureWorld).toHaveBeenCalledWith({ narrativeEnabled: false });
  expect(host.textContent).toContain("仅按日常作息运行");
});

it("pauses background polling, refreshes when visible, and cleans up on unmount", async () => {
  vi.useFakeTimers(); await render();
  expect(getWorld).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(getWorld).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(getWorld).toHaveBeenCalledTimes(2);
  await act(async () => root!.unmount()); root = undefined;
  await vi.advanceTimersByTimeAsync(120_000);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(getWorld).toHaveBeenCalledTimes(2);
});

it("offers a retry and keeps provider errors out of the page", async () => {
  getWorld.mockRejectedValueOnce(new Error("secret-provider-url"));
  await render();
  expect(host.textContent).toContain("暂时无法读取世界");
  expect(host.textContent).not.toContain("secret-provider-url");
  await act(async () => button("重试").click());
  expect(host.textContent).toContain("12:30");
  expect(host.textContent).not.toContain("暂时无法读取世界");
});

it("loads history only when opened and applies resident and location filters", async () => {
  await render(); expect(getWorldHistory).not.toHaveBeenCalled();
  await act(async () => tab("居民").click());
  await act(async () => button("查看此人的完整经历").click());
  expect(getWorldHistory).toHaveBeenLastCalledWith(expect.objectContaining({ residentId: "aglaea", limit: 30 }));
  await act(async () => tab("地点").click());
  await act(async () => button("查看此地历史").click());
  expect(getWorldHistory).toHaveBeenLastCalledWith(expect.objectContaining({ locationId: "okhema", residentId: undefined }));
});

it("does not let a late history response replace a newer filter", async () => {
  let resolve!: (value: unknown) => void;
  getWorldHistory.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await render(); await act(async () => tab("世界编年史").click());
  const select = host.querySelector("select")!;
  getWorldHistory.mockResolvedValue({ entries: [{ id: "new", at: Date.now(), kind: "memory", title: "新筛选的经历", text: "新内容", residentIds: ["cyrene"] }] });
  await act(async () => { select.value = "cyrene"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => resolve({ entries: [{ id: "old", at: Date.now(), kind: "memory", title: "旧筛选的经历", text: "旧内容", residentIds: ["aglaea"] }] }));
  expect(host.textContent).toContain("新筛选的经历"); expect(host.textContent).not.toContain("旧筛选的经历");
});
