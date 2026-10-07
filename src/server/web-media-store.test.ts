import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { decodeImage, WebMediaStore } from "./web-media-store";
const directories: string[] = [];
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe("web media", () => {
  it("persists sticker enablement, uploads and avatars independently of Electron", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-media-")); directories.push(directory);
    let store = new WebMediaStore(directory);
    expect((await store.list()).length).toBe(52);
    await store.setEnabled("playful", false);
    await store.add({ id: "fixture", description: "测试", phrases: ["测试"], dataUrl: image });
    const avatar = await store.setAvatar("cyrene", image);
    store = new WebMediaStore(directory);
    expect(await store.avatar("cyrene")).toBe(avatar);
    expect((await store.list()).find(item => item.id === "playful")?.enabled).toBe(false);
    const uploaded = (await store.list()).find(item => item.id === "fixture")!;
    expect(await store.readFile(decodeURIComponent(uploaded.src.split("/").at(-1)!))).toEqual(decodeImage(image).body);
    expect(await store.readFile("../../web-data.json")).toBeNull();
    await expect(store.delete("playful")).rejects.toThrow("内置");
    await store.delete("fixture"); expect((await store.list()).some(item => item.id === "fixture")).toBe(false);
    await store.resetAvatar("cyrene"); expect(await store.avatar("cyrene")).toBeNull();
    await expect(access(path.join(directory, "web-media", avatar!.split("/").at(-1)!))).rejects.toThrow();
  });
  it("uses the desktop sticker matcher and respects enablement, custom phrases, and technical text filtering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-sticker-match-")); directories.push(directory);
    const store = new WebMediaStore(directory);
    expect(await store.matchReply("来，抱抱你", "", { enabled: true })).toBe("hugtight");
    expect(await store.matchReply("来，抱抱你", "", { enabled: false })).toBeNull();
    expect(await store.matchReply("```js\nconsole.log('来，抱抱你')\n```", "", { enabled: true })).toBeNull();
    await store.setEnabled("hugtight", false);
    expect(await store.matchReply("来，抱抱你", "", { enabled: true })).not.toBe("hugtight");
    await store.add({ id: "custom-match", description: "验收图片", phrases: ["uniquephrase999"], dataUrl: image });
    expect(await store.matchReply("uniquephrase999", "", { enabled: true })).toBe("custom-match");
  });
  it("rejects executable data, fake MIME and oversized uploads", () => {
    expect(() => decodeImage("data:image/svg+xml;base64,PHN2Zz4=")).toThrow();
    expect(() => decodeImage("data:image/png;base64,PHNjcmlwdD4=")).toThrow();
    expect(() => decodeImage(`data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`)).toThrow();
  });
});
