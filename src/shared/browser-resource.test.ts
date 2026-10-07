import { describe, expect, it } from "vitest";
import { browserResourceUrl } from "./browser-resource";
describe("browser resource URLs", () => {
  it("uses authenticated HTTP URLs for dynamic images and custom stickers on Web", () => {
    for (const url of ["moment-media://moment_1/1.png", "local-sticker://custom/flower.webp"]) {
      const result = browserResourceUrl(url, true);
      expect(new URL(result, "http://server").searchParams.get("url")).toBe(url);
      expect(browserResourceUrl(url, false)).toBe(url);
    }
  });
  it("keeps static assets and already mapped URLs intact", () => {
    for (const url of ["stickers/peek.gif", "/api/core/resource?url=example", "https://example.com/photo.png"]) expect(browserResourceUrl(url, true)).toBe(url);
  });
});
