import { resolveUserAgentKind, type BrowserUserAgentKind, type BrowserViewportMode } from "../../shared/browser-viewport";

/** 宽度停止变化这么久之后才切换身份并刷新页面。 */
export const USER_AGENT_SWITCH_DELAY_MS = 300;

/**
 * 决定内置浏览器当前该用哪种身份，并在面板宽度「停下来」之后才通知同步。
 *
 * 只要切换还在等待中，任何宽度变化都会重新计时：拖过阈值后继续拖动，
 * 页面不会在拖动途中被刷新，而是在最后一次宽度变化 300ms 后才刷新一次。
 */
export class UserAgentSwitch {
  private current: BrowserUserAgentKind = "desktop";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWidth: number | null = null;

  constructor(
    private readonly onSettled: () => void,
    private readonly delayMs = USER_AGENT_SWITCH_DELAY_MS,
  ) {}

  get kind(): BrowserUserAgentKind {
    return this.current;
  }

  /** 身份已切换、但宽度还没停下来，同步尚未结算。 */
  get pending(): boolean {
    return this.timer !== null;
  }

  update(mode: BrowserViewportMode, width: number): void {
    const widthChanged = width !== this.lastWidth;
    this.lastWidth = width;
    this.settle(resolveUserAgentKind(mode, width, this.current), widthChanged);
  }

  /**
   * 设置里切换模式时调用，不依赖面板当前是否可见：打开设置页时面板被隐藏、尺寸为 0，
   * 仍按最后一次可见宽度重新判断，隐藏期间页面自己发起的跳转也用新模式的身份。
   * 还没有过可见宽度时，custom 直接是桌面版，auto 保持当前身份等首个尺寸。
   */
  changeMode(mode: BrowserViewportMode): void {
    const next = this.lastWidth !== null
      ? resolveUserAgentKind(mode, this.lastWidth, this.current)
      : mode === "custom" ? "desktop" : this.current;
    this.settle(next, false);
  }

  private settle(next: BrowserUserAgentKind, widthChanged: boolean): void {
    if (next !== this.current) {
      this.current = next;
      this.restartTimer();
    } else if (this.timer) {
      if (widthChanged) this.restartTimer();
    } else {
      // 身份未变也同步一次：切到之前在后台、还按旧身份渲染的标签时补刷新
      this.onSettled();
    }
  }

  /**
   * 创建视图前按已知宽度直接确定身份，不计时：此时还没有按旧身份渲染的页面需要同步，
   * 新视图应直接以正确身份首次加载。
   */
  prime(mode: BrowserViewportMode, width: number): void {
    this.lastWidth = width;
    this.current = resolveUserAgentKind(mode, width, this.current);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private restartTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onSettled();
    }, this.delayMs);
  }
}
