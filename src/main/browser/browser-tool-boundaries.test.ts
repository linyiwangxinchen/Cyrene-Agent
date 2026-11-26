import { describe, expect, it, vi } from "vitest";
import { BrowserPanelController } from "./browser-panel-controller";
import { registerBrowserPageTools } from "./browser-page-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import { bindToolScreenshotHandler, createToolResultImageCache, formatToolImageResult, parseToolResultImages } from "../orchestrator/tool-result-images";

vi.mock("electron", () => ({ app: {}, session: {}, shell: {}, Menu: {}, WebContentsView: class {} }));
vi.mock("../protocols/bootstrap", () => ({ getLearnExamPageSession: vi.fn() }));

const owner = { conversationId: "bound-desktop-conversation", runId: "run-a" };

function createPanel() {
  const controller = Object.create(BrowserPanelController.prototype) as BrowserPanelController;
  const contents = {
    isDestroyed: () => false,
    isLoading: () => false,
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({
      isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }), toPNG: () => Buffer.from("png"),
    })),
  };
  const tab = (id: string, kind: "web" | "exam", url: string) => ({
    id, kind, state: { url, title: id }, view: { webContents: contents },
  });
  const web = tab("web", "web", "https://example.test");
  const exam = tab("exam", "exam", "cyrene-exam://paper/private");
  const lease = { conversationId: owner.conversationId, tabId: web.id };
  const activateTab = vi.fn((id: string) => {
    Object.assign(controller, { activeTabId: id });
    return true;
  });
  Object.assign(controller, {
    tabs: [web, exam], activeTabId: web.id, controlLease: lease,
    bounds: { width: 100, height: 100 }, getWindow: () => ({ isDestroyed: () => false, isFocused: () => true }),
    setControlAction: vi.fn(), activateTab, publish: vi.fn(),
  });
  return { controller, contents, lease, web, exam, activateTab, tab };
}

describe("browser tool boundaries", () => {
  it("reports the CSS identity without raw attributes that carry form values", () => {
    const { controller } = createPanel();
    const target = {
      ref: "e1", description: "spinbutton \"Code\"", tag: "input", bounds: [0, 0, 10, 10] as [number, number, number, number],
      inViewport: true, disabled: false, classes: ["field"], attributes: { type: "number" },
    };
    const result = controller["formatElementCssResult"](target, {
      localName: "input",
      attributes: ["type", "number", "class", "field", "value", "private-value", "aria-valuetext", "private-aria"],
    }, {}, {}, {});
    expect(result.element).toMatchObject({ ref: "e1", attributes: { type: "number", class: "field" } });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it.each(["select", "option"])("omits raw selection attributes from CSS inspection of %s", (tag) => {
    const { controller } = createPanel();
    const target = {
      ref: "e2", description: "Payment method", tag, bounds: [0, 0, 10, 10] as [number, number, number, number],
      inViewport: true, disabled: false, classes: ["field"], attributes: {},
    };
    const result = controller["formatElementCssResult"](target, {
      localName: tag,
      attributes: ["id", "payment", "class", "field", "value", "private-token", "selected", "", "aria-selected", "true"],
    }, {}, { computedStyle: [{ name: "color", value: "black" }] }, {});
    expect(result.element).toEqual({
      ref: "e2", tag, description: "Payment method", attributes: { id: "payment", class: "field" },
    });
    expect(result.computedStyle).toEqual([{ name: "color", value: "black" }]);
  });

  it("denies a bound channel at execution while keeping both desktop reads without a lease", async () => {
    const { controller } = createPanel();
    Object.assign(controller, { controlLease: null });
    const snapshot = vi.spyOn(controller, "getActivePageSnapshot").mockResolvedValue({
      ok: true, snapshot: { ariaSnapshot: "desktop content", observationId: "o", elements: [], note: "", totalReferences: 0 },
    });
    const css = vi.spyOn(controller, "getElementCss").mockResolvedValue("desktop css");
    registerBrowserPageTools(controller);
    const context = { userQuery: "inspect page", ...owner };
    const elements = toolRegistry.getById("browser_get_page_elements")!;
    const styles = toolRegistry.getById("browser_get_element_css")!;
    const args = { observationId: "o", ref: "e1" };

    const external = { ...context, channelContext: { channel: "wechat" as const, targetId: "private-chat", sessionId: "channel-session" } };
    await expect(elements.execute({}, external)).rejects.toThrow("外部渠道不能访问工作台浏览器");
    await expect(styles.execute(args, external)).rejects.toThrow("外部渠道不能访问工作台浏览器");
    expect(snapshot).not.toHaveBeenCalled();
    expect(css).not.toHaveBeenCalled();
    expect(await elements.execute({}, { ...context, allowUserInteraction: false })).toContain("desktop content");
    expect(await styles.execute(args, context)).toBe("desktop css");
  });

  it("does not list, bind, screenshot or send a key to an exam tab", async () => {
    const { controller, contents, lease, web, exam, activateTab } = createPanel();
    expect(controller.controlListTabs(owner.conversationId, owner.runId)).not.toContain(exam.state.url);
    expect(controller.controlSelectTab({ ...owner, tabId: exam.id })).toContain("考试");
    expect(activateTab).not.toHaveBeenCalled();
    expect(lease.tabId).toBe(web.id);

    expect(await controller.captureControlScreenshot(owner)).toMatchObject({ ok: true, tabId: web.id });
    expect(await controller.controlPress({ ...owner, key: "Enter" })).toContain("已按下");
    expect(contents.capturePage).toHaveBeenCalledOnce();
    expect(contents.sendInputEvent).toHaveBeenCalledTimes(2);

    // Even an invalid lease cannot bypass the shared action check.
    lease.tabId = exam.id;
    Object.assign(controller, { activeTabId: exam.id });
    expect(await controller.captureControlScreenshot(owner)).toMatchObject({ ok: false });
    expect(await controller.controlPress({ ...owner, key: "Enter" })).toContain("考试");
    expect(contents.capturePage).toHaveBeenCalledOnce();
    expect(contents.sendInputEvent).toHaveBeenCalledTimes(2);
  });

  it("drops an in-flight capture after the browser lease is replaced", async () => {
    const { controller, contents, lease } = createPanel();
    const capture = await contents.capturePage();
    contents.capturePage.mockImplementationOnce(async () => {
      Object.assign(controller, { controlLease: { ...lease } });
      return capture;
    });
    expect(await controller.captureControlScreenshot(owner)).toEqual({
      ok: false, reason: "截图期间标签或控制权发生变化，请重新确认页面。",
    });
  });

  it("does not dispatch screenshots requested by a channel or another conversation", async () => {
    const { controller, contents } = createPanel();
    registerBrowserPageTools(controller);
    const screenshot = toolRegistry.getById("browser_screenshot")!;
    const context = { userQuery: "inspect page", ...owner };
    const external = { ...context, channelContext: { channel: "wechat" as const, targetId: "private-chat", sessionId: "channel-session" } };
    await expect(screenshot.execute({}, external)).rejects.toThrow("外部渠道不能访问工作台浏览器");
    await expect(screenshot.execute({}, { ...context, conversationId: "other-chat" })).resolves.toMatch(/^\[错误\]/);
    expect(contents.capturePage).not.toHaveBeenCalled();
  });

  it("registers its own screenshot tool as a producer without exposing image bytes in its result text", async () => {
    const { controller, contents } = createPanel();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    contents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from(png, "base64"),
    });
    registerBrowserPageTools(controller);
    const screenshot = toolRegistry.getById("browser_screenshot")!;
    const context = { userQuery: "inspect page", ...owner };
    const cache = createToolResultImageCache();
    bindToolScreenshotHandler(context, async ({ base64, description }) =>
      formatToolImageResult(description, cache.remember(base64)!));
    const output = await screenshot.execute({}, context);
    expect(output).toContain("网页视口截图");
    expect(output).not.toContain(png);
    const images = parseToolResultImages(screenshot, output);
    expect(images).toHaveLength(1);
    expect(cache.resolve(images![0])?.data).toBe(png);
    expect(parseToolResultImages({ ...screenshot }, output)).toBeUndefined();
  });

  it("binds the newly created web tab when the user selects an exam during navigation", async () => {
    const { controller, lease, web, exam, tab } = createPanel();
    const newTab = tab("new", "web", "https://example.test/new");
    Object.assign(controller, {
      tabs: [web, exam, newTab],
      openWebTab: async () => {
        controller.activateTab(exam.id);
        return { ok: true, tab: newTab };
      },
    });
    const result = await controller.controlOpenUrl({ ...owner, newTab: true, url: newTab.state.url });
    expect(JSON.parse(result)).toMatchObject({ tabId: newTab.id, web: newTab.state.url });
    expect(lease.tabId).toBe(newTab.id);
    expect(await controller.captureControlScreenshot(owner)).toMatchObject({ ok: false });
  });
});
