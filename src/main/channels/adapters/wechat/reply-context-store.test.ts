import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WechatReplyContextStore } from "./reply-context-store";

const credentials = { botToken: "secret-bot-token", ilinkBotId: "bot-1", baseUrl: "https://ilinkai.weixin.qq.com", ilinkUserId: "user-1" };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cyrene-reply-context-")); directories.push(directory);
  const file = path.join(directory, "reply.json");
  return { file, store: new WechatReplyContextStore(file) };
}
describe("persistent WeChat reply context", () => {
  it("restores the latest context across instances without plaintext tokens or targets", () => {
    const { file, store } = fixture();
    store.remember(credentials, "wx-private-user", "old-token", 100);
    store.remember(credentials, "wx-private-user", "new-token", 200);
    expect(new WechatReplyContextStore(file).load(credentials, 300)).toEqual([{ targetId: "wx-private-user", token: "new-token", at: 200 }]);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("new-token"); expect(raw).not.toContain("wx-private-user"); expect(raw).not.toContain(credentials.botToken);
  });
  it("does not reuse another bot/account or rotated credentials and clears on logout", () => {
    const { store } = fixture(); store.remember(credentials, "user", "ctx", 100);
    expect(store.load({ ...credentials, ilinkBotId: "bot-2" }, 200)).toEqual([]);
    expect(store.load({ ...credentials, botToken: "changed" }, 200)).toEqual([]);
    store.clear(); expect(store.load(credentials, 200)).toEqual([]);
  });
  it("bounds retention and ignores corrupt encrypted files", () => {
    const { file, store } = fixture(); store.remember(credentials, "user", "ctx", 100);
    expect(store.load(credentials, 100 + 31 * 24 * 60 * 60 * 1000)).toEqual([]);
    const corrupted = JSON.parse(readFileSync(file, "utf8")); corrupted.data = "AAAA";
    require("node:fs").writeFileSync(file, JSON.stringify(corrupted));
    expect(store.load(credentials, 200)).toEqual([]);
  });
});
