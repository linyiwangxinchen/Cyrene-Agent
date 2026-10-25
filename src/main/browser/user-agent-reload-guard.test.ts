import { describe, expect, it, vi } from "vitest";
import { isEditingKeystroke, reloadForUserAgentIfIdle, responseVariesByUserAgent, shouldDeferUserAgentReload } from "./user-agent-reload-guard";

describe("视口身份切换后的自动刷新护栏", () => {
  it("页面空闲时可以刷新", () => {
    expect(shouldDeferUserAgentReload({ controlled: false, picking: false, loading: false })).toBe(false);
  });

  it.each([
    ["Agent 浏览器控制中", { controlled: true, picking: false, loading: false }],
    ["元素选择中", { controlled: false, picking: true, loading: false }],
    ["页面仍在加载", { controlled: false, picking: false, loading: true }],
    ["最近一次导航被用户停止或加载失败", { controlled: false, picking: false, loading: false, interrupted: true }],
    ["当前文档是表单 POST 的响应（刷新会重提交）", { controlled: false, picking: false, loading: false, postDocument: true }],
  ])("%s时延后刷新", (_label, state) => {
    expect(shouldDeferUserAgentReload(state)).toBe(true);
  });
});

describe("键盘编辑判定（覆盖 iframe 内输入）", () => {
  it.each([
    [{ type: "keyDown", key: "a" }],
    [{ type: "keyDown", key: "中" }],
    [{ type: "keyDown", key: " " }],
    [{ type: "keyDown", key: "Backspace" }],
    [{ type: "keyDown", key: "Delete" }],
    [{ type: "keyDown", key: "Enter" }],
    [{ type: "keyDown", key: "v", control: true }],
    [{ type: "keyDown", key: "x", meta: true }],
  ])("会改动内容的按键：%j", (input) => {
    expect(isEditingKeystroke(input)).toBe(true);
  });

  it.each([
    [{ type: "keyUp", key: "a" }],
    [{ type: "char", key: "a" }],
    [{ type: "keyDown", key: "ArrowDown" }],
    [{ type: "keyDown", key: "Tab" }],
    [{ type: "keyDown", key: "PageDown" }],
    [{ type: "keyDown", key: "Shift" }],
    [{ type: "keyDown", key: "c", control: true }],
    [{ type: "keyDown", key: "a", control: true }],
    [{ type: "keyDown", key: "f", alt: true }],
  ])("不改动内容的按键不算：%j", (input) => {
    expect(isEditingKeystroke(input)).toBe(false);
  });
});

describe("缓存响应是否按 User-Agent 区分", () => {
  it.each([
    [{ Vary: ["User-Agent"] }, true],
    [{ vary: ["Accept-Encoding, user-agent"] }, true],
    [{ Vary: ["*"] }, true],
    [{ Vary: ["Accept-Encoding"] }, false],
    [{ "Cache-Control": ["max-age=60"] }, false],
    [undefined, false],
  ])("%j → %s", (headers, expected) => {
    expect(responseVariesByUserAgent(headers)).toBe(expected);
  });
});

describe("带护栏刷新：输入探测返回后重新检查", () => {
  const idle = { controlled: false, picking: false, loading: false, navigationGeneration: 1, inputGeneration: 0, stillNeeded: true };

  it("页面空闲、无输入：刷新一次", async () => {
    const reload = vi.fn();
    await expect(reloadForUserAgentIfIdle({ snapshot: () => idle, hasUserInput: async () => false, reload })).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("探测期间用户从地址栏发起导航（导航代次变化、开始加载）：放弃刷新，不取消那次导航", async () => {
    let state = { ...idle };
    const reload = vi.fn();
    const result = await reloadForUserAgentIfIdle({
      snapshot: () => state,
      hasUserInput: async () => {
        state = { ...state, navigationGeneration: 2, loading: true };
        return false;
      },
      reload,
    });
    expect(result).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("探测期间只换了导航代次（如页面脚本跳转已提交）也放弃刷新", async () => {
    let state = { ...idle };
    const reload = vi.fn();
    await reloadForUserAgentIfIdle({
      snapshot: () => state,
      hasUserInput: async () => { state = { ...state, navigationGeneration: 2 }; return false; },
      reload,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("探测期间 Agent 接管标签、或标签已关闭 / 切走：放弃刷新", async () => {
    for (const change of [{ controlled: true }, null] as const) {
      let state: typeof idle | null = { ...idle };
      const reload = vi.fn();
      await reloadForUserAgentIfIdle({
        snapshot: () => state,
        hasUserInput: async () => { state = change === null ? null : { ...idle, ...change }; return false; },
        reload,
      });
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it("有用户输入或不再需要刷新时不刷新", async () => {
    const reload = vi.fn();
    await reloadForUserAgentIfIdle({ snapshot: () => idle, hasUserInput: async () => true, reload });
    await reloadForUserAgentIfIdle({ snapshot: () => ({ ...idle, stillNeeded: false }), hasUserInput: async () => false, reload });
    expect(reload).not.toHaveBeenCalled();
  });

  it("探测读到「无输入」后、刷新前用户开始输入（输入代次变化）：放弃刷新，不丢刚输入的内容", async () => {
    let state = { ...idle };
    const reload = vi.fn();
    const result = await reloadForUserAgentIfIdle({
      snapshot: () => state,
      // 页面里的探测脚本先读到 false，随后按键才到达：主进程已同步累加输入代次
      hasUserInput: async () => { state = { ...state, inputGeneration: 1 }; return false; },
      reload,
    });
    expect(result).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("用户停止加载后：即使文档仍是旧身份也不刷新", async () => {
    const reload = vi.fn();
    const hasUserInput = vi.fn(async () => false);
    await reloadForUserAgentIfIdle({ snapshot: () => ({ ...idle, interrupted: true }), hasUserInput, reload });
    expect(hasUserInput).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
