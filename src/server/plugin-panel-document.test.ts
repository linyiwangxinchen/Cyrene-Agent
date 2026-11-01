import { describe, expect, it } from "vitest";
import { inlinePluginPanelAssets } from "./plugin-panel-document";
describe("authenticated opaque plugin panels", () => {
  it("embeds local CSS and ordered scripts without enabling same-origin access", async () => {
    const reads: string[] = [];
    const html = await inlinePluginPanelAssets({ html: '<link rel="stylesheet" href="panel.css"><p>Panel</p><script src="/.cyrene/panel-bridge.js"></script><script src="panel.js" defer></script>', url: "cyrene-plugin://test/panel.html", nonce: "test-nonce",
      read: async url => { reads.push(url); return { status: 200, contentType: url.endsWith("css") ? "text/css" : "text/javascript", base64: Buffer.from(url.endsWith("css") ? "body { color: pink }" : `window.value = '${url}'`).toString("base64") }; } });
    expect(reads).toEqual(["cyrene-plugin://test/panel.css", "cyrene-plugin://test/.cyrene/panel-bridge.js", "cyrene-plugin://test/panel.js"]);
    expect(html).toContain("<style>body { color: pink }</style>");
    expect(html.match(/nonce="test-nonce"/g)).toHaveLength(2);
    expect(html).not.toContain("src=");
  });
  it("rejects cross-plugin/network assets and escapes script closing text", async () => {
    const read = async () => ({ status: 200, contentType: "text/javascript", base64: Buffer.from("const value = '</script><img src=x>'").toString("base64") });
    await expect(inlinePluginPanelAssets({ html: '<script src="cyrene-plugin://other/private.js"></script>', url: "cyrene-plugin://test/panel.html", nonce: "n", read })).rejects.toThrow("本插件");
    const html = await inlinePluginPanelAssets({ html: '<script src="panel.js"></script>', url: "cyrene-plugin://test/panel.html", nonce: "n", read });
    expect(html).toContain("<\\/script>");
  });
});
