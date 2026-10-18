import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../../main/application/ipc-scope";
import type { ExamPaperStore } from "../../main/learn/exam-paper-store";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  launch: vi.fn(),
  goto: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("./platform", () => ({
  app: { getPath: () => mocks.dataDir },
  chatWindow: { webContents: { send: mocks.publish } },
  WebContents: class { constructor(public id: number) {} },
}));
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock("../../main/browser/browser-panel-runtime", () => ({ setBrowserPanelController: vi.fn() }));
vi.mock("../../main/browser/browser-page-tools", () => ({ registerBrowserPageTools: vi.fn() }));
vi.mock("../../main/learn/exam-page-authority", () => ({ registerExamPageSource: vi.fn() }));

import { HeadlessBrowser, registerHeadlessBrowser } from "./browser";

describe("Web 地址栏与 Agent 导航边界", () => {
  const browsers: HeadlessBrowser[] = [];
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-web-browser-"));
    let currentUrl = "about:blank";
    const page = {
      on: vi.fn(), isClosed: () => false,
      url: () => currentUrl, title: async () => "fixture",
      goto: mocks.goto.mockImplementation(async (url: string) => { currentUrl = url; }),
    };
    mocks.launch.mockResolvedValue({ newPage: async () => page, close: vi.fn() });
  });
  afterEach(async () => {
    await Promise.all(browsers.splice(0).map(browser => browser.close()));
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function register() {
    const handlers = new Map<string, (...args: any[]) => any>();
    const ipc = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as IpcScope;
    const browser = registerHeadlessBrowser(ipc, {} as ExamPaperStore);
    browsers.push(browser);
    return { browser, invoke: (channel: string, input?: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input) };
  }

  it.each([
    ["google.com/path", "https://google.com/path"],
    ["localhost:3000", "http://localhost:3000/"],
    ["１９２．１６８．１．１：８０８０", "http://192.168.1.1:8080/"],
    ["printer.home.arpa/status", "http://printer.home.arpa/status"],
    ["100.64.0.1:3000", "http://100.64.0.1:3000/"],
  ])("地址栏 %s 实际导航到 %s 并持久化规范地址", async (input, expected) => {
    const { browser, invoke } = register();
    expect(await invoke(IPC.BROWSER_PANEL_NAVIGATE, input)).toEqual({ ok: true });
    expect(mocks.goto).toHaveBeenLastCalledWith(expected, expect.any(Object));
    expect(browser.getState().tabs[0].url).toBe(expected);
    const restored = new HeadlessBrowser(); browsers.push(restored);
    expect(restored.getState().tabs[0].url).toBe(expected);
  });

  it.each([
    ["javascript:alert(1)", "unsupported_protocol"],
    ["file:///etc/passwd", "unsupported_protocol"],
    ["data:text/html,unsafe", "unsupported_protocol"],
    ["https://", "unsupported_protocol"],
    ["nas:8080", "invalid_url"],
    ["user@example.com", "invalid_url"],
    ["cyrene agent", "invalid_url"],
  ])("拒绝 %s，保持上游错误语义且不启动浏览器", async (input, error) => {
    const { browser, invoke } = register();
    const before = browser.getState();
    expect(await invoke(IPC.BROWSER_PANEL_NAVIGATE, input)).toEqual({ ok: false, error });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(browser.getState()).toEqual(before);
  });

  it("地址栏补全不扩展 Agent 工具或新标签 IPC 的输入契约", async () => {
    const { browser, invoke } = register();
    expect(await browser.navigate("google.com")).toEqual({ ok: false, error: "invalid_url" });
    expect(await invoke(IPC.BROWSER_PANEL_OPEN_IN_NEW_TAB, "localhost:3000")).toEqual({ ok: false, error: "invalid_url" });
    expect(mocks.launch).not.toHaveBeenCalled();

    await browser.startControl({ conversationId: "chat", runId: "run" });
    expect(await browser.controlOpenUrl({ conversationId: "chat", runId: "run", url: "google.com" })).toBe("打开网页失败。");
    expect(mocks.goto).not.toHaveBeenCalled();
    expect(await browser.controlOpenUrl({ conversationId: "chat", runId: "run", url: "https://example.com/" })).toContain("已打开网页");
    expect(mocks.goto).toHaveBeenLastCalledWith("https://example.com/", expect.any(Object));
  });

  it("页面加载失败时结束加载状态并保留可重试目标", async () => {
    const { browser, invoke } = register();
    mocks.goto.mockRejectedValueOnce(new Error("fixture network failure"));
    expect(await invoke(IPC.BROWSER_PANEL_NAVIGATE, "example.com")).toEqual({ ok: false, error: "unavailable" });
    expect(browser.getState().tabs[0]).toMatchObject({ url: "https://example.com/", loading: false, error: "fixture network failure" });
  });
});
