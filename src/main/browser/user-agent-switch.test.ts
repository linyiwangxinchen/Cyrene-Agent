import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT_SWITCH_DELAY_MS, UserAgentSwitch } from "./user-agent-switch";

describe("视口身份切换时机", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("跨过阈值后继续拖动，直到最后一次宽度变化 300ms 后才同步一次", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("auto", 900);
    onSettled.mockClear();

    // 拖到 699px 跨过阈值，然后每 200ms 继续拖窄（间隔小于 300ms）
    sw.update("auto", 699);
    for (const width of [680, 650, 620]) {
      vi.advanceTimersByTime(200);
      sw.update("auto", width);
      expect(onSettled).not.toHaveBeenCalled();
    }
    expect(sw.kind).toBe("mobile");

    vi.advanceTimersByTime(USER_AGENT_SWITCH_DELAY_MS - 1);
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("等待期间宽度未变的重复上报不会推迟同步", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("auto", 900);
    onSettled.mockClear();

    sw.update("auto", 650);
    vi.advanceTimersByTime(200);
    sw.update("auto", 650);
    vi.advanceTimersByTime(100);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("拖过阈值又拖回去：身份回到原值，仍只在停下后同步一次（标签已是原身份，不会重载）", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("auto", 900);
    onSettled.mockClear();

    sw.update("auto", 650);
    vi.advanceTimersByTime(100);
    sw.update("auto", 800);
    expect(sw.kind).toBe("desktop");
    vi.advanceTimersByTime(USER_AGENT_SWITCH_DELAY_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("没有待切换时立即同步（切到后台标签时补刷新）", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("auto", 900);
    expect(onSettled).toHaveBeenCalledTimes(1);
    sw.update("auto", 880);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("custom 模式不切到移动版", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("custom", 320);
    expect(sw.kind).toBe("desktop");
  });

  it("跨阈值后到结算前 pending 为真（护栏释放时据此不抢先刷新），结算后为假", () => {
    const sw = new UserAgentSwitch(vi.fn());
    sw.update("auto", 900);
    expect(sw.pending).toBe(false);
    sw.update("auto", 650);
    expect(sw.pending).toBe(true);
    vi.advanceTimersByTime(USER_AGENT_SWITCH_DELAY_MS);
    expect(sw.pending).toBe(false);
  });

  it("dispose 后不再触发同步", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("auto", 900);
    onSettled.mockClear();
    sw.update("auto", 650);
    sw.dispose();
    vi.advanceTimersByTime(USER_AGENT_SWITCH_DELAY_MS * 2);
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("设置里切换模式（面板可能被设置页隐藏）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("窄面板已是移动版，隐藏后切到 custom：按最后可见宽度立即切回桌面并同步一次", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.update("auto", 500);
    vi.advanceTimersByTime(USER_AGENT_SWITCH_DELAY_MS);
    expect(sw.kind).toBe("mobile");
    onSettled.mockClear();

    // 打开设置页时面板 bounds 变为 0，控制器不会再以 0 调用 update
    sw.changeMode("custom");
    expect(sw.kind).toBe("desktop");
    vi.advanceTimersByTime(USER_AGENT_SWITCH_DELAY_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("隐藏期间切回 auto：按最后可见宽度恢复移动版", () => {
    const sw = new UserAgentSwitch(vi.fn());
    sw.update("auto", 500);
    sw.changeMode("custom");
    sw.changeMode("auto");
    expect(sw.kind).toBe("mobile");
  });

  it("从未有过可见宽度：custom 为桌面版，auto 保持当前身份", () => {
    const sw = new UserAgentSwitch(vi.fn());
    sw.changeMode("auto");
    expect(sw.kind).toBe("desktop");
    sw.changeMode("custom");
    expect(sw.kind).toBe("desktop");
  });
});

describe("创建视图前按已知宽度确定身份", () => {
  it("prime 直接确定身份且不触发同步；随后同宽度上报立即同步（无重复切换）", () => {
    const onSettled = vi.fn();
    const sw = new UserAgentSwitch(onSettled);
    sw.prime("auto", 374);
    expect(sw.kind).toBe("mobile");
    expect(onSettled).not.toHaveBeenCalled();
    sw.update("auto", 374);
    expect(sw.kind).toBe("mobile");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("custom 模式 prime 仍为桌面版", () => {
    const sw = new UserAgentSwitch(vi.fn());
    sw.prime("custom", 374);
    expect(sw.kind).toBe("desktop");
  });
});
