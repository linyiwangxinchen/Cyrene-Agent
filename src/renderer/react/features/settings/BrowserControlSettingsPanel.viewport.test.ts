// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserControlSettingsPanel } from "./BrowserControlSettingsPanel";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const getComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element) => getComputedStyle(element);

const roots: Root[] = [];

function installSettings(saved: unknown, saveGeneral = vi.fn(async (patch: unknown) => patch)) {
  (window as unknown as { settings: unknown }).settings = {
    getGeneral: vi.fn(async () => ({ browserViewportMode: saved })),
    saveGeneral,
  };
  return saveGeneral;
}

async function renderPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(BrowserControlSettingsPanel)); });
  await act(async () => { await Promise.resolve(); });
  return host;
}

const selected = (host: ParentNode) => host.querySelector(".ant-segmented-item-selected")?.textContent?.trim();

async function choose(host: ParentNode, label: string) {
  const item = Array.from(host.querySelectorAll(".ant-segmented-item")).find((node) => node.textContent?.trim() === label);
  if (!item) throw new Error(`option ${label} not found`);
  await act(async () => { (item.querySelector("input") as HTMLInputElement).click(); });
  await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  vi.restoreAllMocks();
});

describe("浏览器设置：网页显示模式", () => {
  it("显示已保存的模式；未设置时为默认的自动", async () => {
    installSettings("custom");
    expect(selected(await renderPanel())).toBe("自定义");
    document.body.innerHTML = "";
    installSettings(undefined);
    expect(selected(await renderPanel())).toBe("自动");
  });

  it("切换后立即保存，说明文字随模式变化", async () => {
    const saveGeneral = installSettings("auto");
    const host = await renderPanel();
    expect(host.textContent).toContain("面板较窄时以手机版访问网页");

    await choose(host, "自定义");
    expect(saveGeneral).toHaveBeenCalledWith({ browserViewportMode: "custom" });
    expect(host.textContent).toContain("始终以桌面版访问网页");
  });

  it("读到已保存的模式之前禁用切换，迟到的读取不会覆盖用户的选择", async () => {
    let resolveGeneral!: (value: unknown) => void;
    const saveGeneral = vi.fn(async (patch: unknown) => patch);
    (window as unknown as { settings: unknown }).settings = {
      getGeneral: vi.fn(() => new Promise((resolve) => { resolveGeneral = resolve; })),
      saveGeneral,
    };
    const host = await renderPanel();

    // 读取未返回：控件禁用，点击不会保存
    expect(host.querySelectorAll(".ant-segmented-item-disabled").length).toBe(2);
    await choose(host, "自定义");
    expect(saveGeneral).not.toHaveBeenCalled();

    // 读取返回已保存的 custom 后才可切换
    await act(async () => { resolveGeneral({ browserViewportMode: "custom" }); });
    await act(async () => { await Promise.resolve(); });
    expect(selected(host)).toBe("自定义");
    expect(host.querySelectorAll(".ant-segmented-item-disabled").length).toBe(0);
    await choose(host, "自动");
    expect(saveGeneral).toHaveBeenCalledWith({ browserViewportMode: "auto" });
    expect(selected(host)).toBe("自动");
  });

  it("读取失败时保持禁用并提示重试，不把默认值当成已保存设置；重试成功后显示真实值", async () => {
    let attempt = 0;
    const saveGeneral = vi.fn(async (patch: unknown) => patch);
    (window as unknown as { settings: unknown }).settings = {
      getGeneral: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("ipc reset");
        return { browserViewportMode: "custom" };
      }),
      saveGeneral,
    };
    const host = await renderPanel();

    expect(host.querySelectorAll(".ant-segmented-item-disabled").length).toBe(2);
    expect(host.textContent).toContain("设置读取失败");
    await choose(host, "自定义");
    expect(saveGeneral).not.toHaveBeenCalled();

    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.replace(/\s/g, "") === "重试");
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(selected(host)).toBe("自定义");
    expect(host.querySelectorAll(".ant-segmented-item-disabled").length).toBe(0);
    expect(host.textContent).not.toContain("设置读取失败");
  });

  it("保存进行中禁用切换；失败时回滚到最后一次确认保存的值", async () => {
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const saveGeneral = vi.fn(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    installSettings("auto", saveGeneral as never);
    const host = await renderPanel();

    // auto → custom：保存未结算时控件禁用，再点「自动」不会发起第二次保存
    await choose(host, "自定义");
    expect(saveGeneral).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(".ant-segmented-item-disabled").length).toBe(2);
    await choose(host, "自动");
    expect(saveGeneral).toHaveBeenCalledTimes(1);

    // 保存失败：回滚到确认过的 auto，而不是任何未落盘的中间值
    await act(async () => { pending[0].reject(new Error("disk full")); });
    await act(async () => { await Promise.resolve(); });
    expect(selected(host)).toBe("自动");
    expect(host.querySelectorAll(".ant-segmented-item-disabled").length).toBe(0);

    // 再切 custom 并成功，随后切 auto 失败：回滚到最新确认的 custom
    await choose(host, "自定义");
    await act(async () => { pending[1].resolve({}); });
    await act(async () => { await Promise.resolve(); });
    await choose(host, "自动");
    await act(async () => { pending[2].reject(new Error("ipc reset")); });
    await act(async () => { await Promise.resolve(); });
    expect(selected(host)).toBe("自定义");
  });

  it("保存失败时回滚并提示", async () => {
    installSettings("auto", vi.fn(async () => { throw new Error("disk full"); }));
    const host = await renderPanel();
    await choose(host, "自定义");
    expect(selected(host)).toBe("自动");
    expect(host.querySelector(".ant-alert-error")).not.toBeNull();
  });
});
