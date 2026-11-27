// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfigProvider } from "antd";
import i18next from "i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalRerankerStatus } from "../../../../shared/local-reranker-status";
import { LocalRerankerControls } from "./LocalRerankerControls";

const missing: LocalRerankerStatus = { modelInstalled: false, enabled: false, ready: false, phase: "idle" };
const installed: LocalRerankerStatus = { ...missing, modelInstalled: true };
const active: LocalRerankerStatus = { modelInstalled: true, enabled: true, ready: true, phase: "complete" };
const downloadLabel = "从魔搭社区下载并启用";

let root: Root;
let container: HTMLDivElement;
let status: LocalRerankerStatus;
const getStatus = vi.fn<() => Promise<LocalRerankerStatus>>();
const setup = vi.fn<(allowDownload: boolean) => Promise<LocalRerankerStatus>>();
const disable = vi.fn<(mode: string) => Promise<boolean>>();

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  await i18next.changeLanguage("zh-CN");
  vi.useFakeTimers();
  status = missing;
  getStatus.mockReset().mockImplementation(async () => status);
  setup.mockReset();
  disable.mockReset();
  Object.assign(window, { settings: {
    getLocalRerankerStatus: getStatus, startLocalRerankerSetup: setup, rerankerSetMode: disable,
  } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as Window & { settings?: unknown }).settings;
  vi.useRealTimers();
});

async function render(...entryIds: string[]) {
  await act(async () => root.render(<ConfigProvider theme={{ token: { motion: false } }}>
    {entryIds.map(id => <LocalRerankerControls key={id} data-settings-search-id={id} />)}
  </ConfigProvider>));
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(button => button.textContent?.replace(/\s/g, "") === label);
}

async function click(label: string) {
  expect(buttons(label)).toHaveLength(1);
  await act(async () => { buttons(label)[0].click(); });
}

it("shares one download request and background status when moving between the two entry points", async () => {
  setup.mockImplementation(async () => { status = { ...missing, phase: "downloading" }; return status; });
  await render("memory-entry", "cyrene-entry");
  expect(getStatus).toHaveBeenCalledOnce();
  const installButtons = buttons(downloadLabel);
  expect(installButtons).toHaveLength(2);
  await act(async () => { installButtons[0].click(); installButtons[1].click(); });
  expect(setup).toHaveBeenCalledExactlyOnceWith(true);
  expect(container.textContent).toContain("离开此页面后会继续");
  expect(buttons(downloadLabel).every(button => button.disabled)).toBe(true);

  status = { ...installed, phase: "activating" };
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(getStatus).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("正在加载并验证本地重排模型");
  await render();
  status = active;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(getStatus).toHaveBeenCalledTimes(2);

  await render("cyrene-entry");
  expect(getStatus).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("本地重排已启用");
  expect(setup).toHaveBeenCalledTimes(1);
});

it("enables and retries an installed model locally, and can turn off a verified reranker", async () => {
  status = installed;
  setup.mockResolvedValueOnce({ ...installed, phase: "activationFailed" }).mockResolvedValueOnce(active);
  disable.mockImplementation(async () => { status = installed; return true; });
  await render("memory-entry");
  expect(buttons(downloadLabel)).toHaveLength(0);
  await click("启用重排");
  expect(container.textContent).toContain("本地重排未能启用");
  await click("重试启用");
  expect(setup.mock.calls).toEqual([[false], [false]]);
  expect(container.textContent).toContain("模型验证通过");
  await click("关闭重排");
  expect(disable).toHaveBeenCalledExactlyOnceWith("none");
  expect(buttons("启用重排")).toHaveLength(1);
});

it("reports a ModelScope download failure and keeps the explicit retry available", async () => {
  setup.mockResolvedValue({ ...missing, phase: "downloadFailed" });
  await render("memory-entry");
  await click(downloadLabel);
  expect(container.textContent).toContain("从魔搭社区下载或校验失败");
  expect(buttons(downloadLabel)[0].disabled).toBe(false);
  await click(downloadLabel);
  expect(setup.mock.calls).toEqual([[true], [true]]);
});
