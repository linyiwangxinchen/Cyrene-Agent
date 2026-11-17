// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreferencesSettingsPanel } from "./PreferencesSettingsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) });
const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element) => computedStyle(element);
let root: Root;
let host: HTMLDivElement;
let config: Record<string, unknown>;
const saveGeneral = vi.fn();
beforeEach(() => {
  config = { proactiveChatMode: "on", proactiveDensity: "quiet", proactiveDailyLimit: 7, proactiveTargetScore: 73, proactiveQuietStartMinute: 21 * 60, proactiveQuietEndMinute: 9 * 60 };
  saveGeneral.mockReset().mockImplementation(async (patch) => { Object.assign(config, patch); });
  Object.assign(window, { settings: {
    getGeneral: async () => ({ ...config }), saveGeneral,
    channelsGetStatus: async () => ({}),
    getProactiveStatus: async () => ({ candidateScore: 83, targetScore: 73, sceneId: "life:private-source", evaluatedAt: Date.now(), state: "candidate" }),
  } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; });
async function render() { await act(async () => { root.render(createElement(PreferencesSettingsPanel)); }); }

it("changes willingness to share without raising a saved daily cap or changing quiet hours", async () => {
  await render();
  const densityRow = host.querySelector('[data-settings-search-id="settingsPage.preferences.proactiveDensity"]')!.closest(".cy-settings-row")!;
  const active = Array.from(densityRow.querySelectorAll("label")).find((label) => label.textContent === "活跃")!;
  await act(async () => active.click());
  const save = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.replace(/\s/g, "") === "保存偏好")!;
  await act(async () => save.click());
  expect(saveGeneral).toHaveBeenCalledWith(expect.objectContaining({
    proactiveDensity: "active", proactiveDailyLimit: 7, proactiveTargetScore: 73,
    proactiveQuietStartMinute: 21 * 60, proactiveQuietEndMinute: 9 * 60,
  }));
  expect(host.textContent).toContain("这是上限，不是每日目标");
});

it("keeps scheduling diagnostics collapsed and defaults old preferences to active without raising the cap", async () => {
  delete config.proactiveDensity;
  config.proactiveDailyLimit = 3;
  await render();
  const diagnostics = host.querySelector<HTMLDetailsElement>(".cy-settings-proactive-diagnostics")!;
  expect(diagnostics.open).toBe(false);
  expect(diagnostics.textContent).toContain("life:private-source");
  expect(diagnostics.querySelector('[data-settings-search-id="settingsPage.preferences.proactiveTargetScore"]')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[aria-label="每日主动开场上限"]')!.value).toBe("3");
  const save = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.replace(/\s/g, "") === "保存偏好")!;
  await act(async () => save.click());
  expect(saveGeneral).toHaveBeenCalledWith(expect.objectContaining({ proactiveDensity: "active", proactiveDailyLimit: 3 }));
});
