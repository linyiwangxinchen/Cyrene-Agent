import { describe, expect, it } from "vitest";
import {
  DESKTOP_MIN_WIDTH,
  MOBILE_MAX_WIDTH,
  mobileUserAgent,
  normalizeBrowserViewportMode,
  resolveUserAgentKind,
} from "./browser-viewport";

describe("浏览器视口模式", () => {
  it("默认 auto，非法值回落 auto", () => {
    expect(normalizeBrowserViewportMode(undefined)).toBe("auto");
    expect(normalizeBrowserViewportMode("tablet")).toBe("auto");
    expect(normalizeBrowserViewportMode("custom")).toBe("custom");
  });

  it("custom 始终桌面版（原有行为）", () => {
    expect(resolveUserAgentKind("custom", 320, "mobile")).toBe("desktop");
    expect(resolveUserAgentKind("custom", 1200, "desktop")).toBe("desktop");
  });

  it("auto：窄于阈值切移动版，宽于阈值切桌面版", () => {
    expect(resolveUserAgentKind("auto", MOBILE_MAX_WIDTH - 1, "desktop")).toBe("mobile");
    expect(resolveUserAgentKind("auto", 320, "desktop")).toBe("mobile");
    expect(resolveUserAgentKind("auto", DESKTOP_MIN_WIDTH + 1, "mobile")).toBe("desktop");
  });

  it("auto：两个阈值之间保持当前身份，避免临界宽度附近反复切换", () => {
    for (const width of [MOBILE_MAX_WIDTH, 730, DESKTOP_MIN_WIDTH]) {
      expect(resolveUserAgentKind("auto", width, "mobile")).toBe("mobile");
      expect(resolveUserAgentKind("auto", width, "desktop")).toBe("desktop");
    }
  });

  it("移动版 UA 带 Android 与 Mobile 标记，并沿用内置 Chromium 版本", () => {
    const ua = mobileUserAgent("140.0.7339.41");
    expect(ua).toContain("Android");
    expect(ua).toContain("Chrome/140.0.7339.41 Mobile Safari/537.36");
  });
});
