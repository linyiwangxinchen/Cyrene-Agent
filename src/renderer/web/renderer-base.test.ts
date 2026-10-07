// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { document.head.querySelector("base")?.remove(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each([
  ["http://localhost:4317/web/", "http://localhost:4317/"],
  ["http://localhost:4317/web/index.html", "http://localhost:4317/"],
  ["file:///app/dist/renderer/react/index.html", "file:///app/dist/renderer/"],
  ["file:///app/dist/renderer/sticker-manager/index.html", "file:///app/dist/renderer/"],
])("resolves public assets from the renderer root for %s", async (url, root) => {
  vi.stubEnv("BASE_URL", "./");
  const base = document.createElement("base"); base.href = url; document.head.append(base);
  const { resolveAsset } = await import("../../shared/renderer-base");
  expect(resolveAsset("avatars/cyrene-avatar.png")).toBe(`${root}avatars/cyrene-avatar.png`);
  expect(resolveAsset("/stickers/peek.gif")).toBe(`${root}stickers/peek.gif`);
});
