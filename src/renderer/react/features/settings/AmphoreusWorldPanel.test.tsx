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

it("shows Cyrene's personal projects and known moments without presenting planned outcomes as facts", async () => {
  const now = Date.parse("2026-11-10T12:30:00Z");
  view.amphoreus!.personal = {
    residentId: "cyrene", energy: 77, mood: "想把手边的小事做完", attention: "还想补完那张清单",
    goals: [{ id: "project", title: "整理有趣的街角见闻", progress: 20, status: "active", updatedAt: now, reason: "今天记下了第一处", stage: "收集线索", nextStep: "有空再去看看另一条街" }],
    actions: [
      { id: "future", residentId: "cyrene", goalId: "project", title: "打算整理第二页", intent: "把已经记下的内容分一分类", activity: "study", startsAt: now + 3600_000, endsAt: now + 7200_000, locationId: "okhema", status: "planned", version: 1, stage: "起意", outcome: "不应出现的未来成功", artifact: "不应出现的未来成果" },
      { id: "past", residentId: "cyrene", goalId: "project", title: "整理第一页", intent: "留下今天的小发现", activity: "study", startsAt: now - 3600_000, endsAt: now - 1800_000, locationId: "okhema", status: "completed", version: 2, stage: "整理", outcome: "整理好了一段记录", artifact: "一张写到一半的清单" },
    ],
    experiences: [{ id: "heard", eventId: "news", at: now - 1200_000, kind: "heard", text: "午餐时听到一段有趣的故事", source: "午餐时的交谈", locationId: "okhema" }], changes: [],
  };
  await render();
  const personal = host.querySelector('[aria-label="昔涟的此刻"]')!;
  expect(personal.textContent).toContain("整理有趣的街角见闻");
  expect(personal.textContent).toContain("收集线索");
  expect(personal.textContent).toContain("还想补完那张清单");
  expect(personal.textContent).toContain("午餐时听到一段有趣的故事");
  expect(personal.textContent).toContain("一张写到一半的清单");
  expect(personal.textContent).not.toContain("不应出现的未来");
  expect(personal.textContent).not.toContain("77");
  expect(getWorldHistory).not.toHaveBeenCalled();
  await act(async () => button("查看昔涟的完整经历").click());
  expect(getWorldHistory).toHaveBeenCalledWith(expect.objectContaining({ residentId: "cyrene", limit: 30 }));
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
