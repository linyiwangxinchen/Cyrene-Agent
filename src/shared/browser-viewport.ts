// 内置浏览器的视口模式：
// - auto：面板窄时以手机身份（移动版 User-Agent）访问，百度、必应等按 UA 下发移动版页面；
//   这些站点按 UA 而非窗口宽度决定版式，仅缩窄窗口无法得到移动版。
// - custom：维持原有行为，始终以桌面浏览器身份访问。

export const BROWSER_VIEWPORT_MODES = ["auto", "custom"] as const;
export type BrowserViewportMode = typeof BROWSER_VIEWPORT_MODES[number];
export const DEFAULT_BROWSER_VIEWPORT_MODE: BrowserViewportMode = "auto";

export type BrowserUserAgentKind = "desktop" | "mobile";

/** 窄于此宽度切到移动版。 */
export const MOBILE_MAX_WIDTH = 700;
/** 宽于此宽度切回桌面版；两者之间保持当前身份，避免在临界宽度附近拖动时反复切换。 */
export const DESKTOP_MIN_WIDTH = 760;

export function normalizeBrowserViewportMode(value: unknown): BrowserViewportMode {
  return (BROWSER_VIEWPORT_MODES as readonly unknown[]).includes(value)
    ? value as BrowserViewportMode
    : DEFAULT_BROWSER_VIEWPORT_MODE;
}

export function resolveUserAgentKind(
  mode: BrowserViewportMode,
  width: number,
  current: BrowserUserAgentKind,
): BrowserUserAgentKind {
  if (mode === "custom") return "desktop";
  if (width < MOBILE_MAX_WIDTH) return "mobile";
  if (width > DESKTOP_MIN_WIDTH) return "desktop";
  return current;
}

/** 与内置 Chromium 版本一致的安卓 Chrome UA，站点据此下发移动版页面。 */
export function mobileUserAgent(chromeVersion: string): string {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
}
