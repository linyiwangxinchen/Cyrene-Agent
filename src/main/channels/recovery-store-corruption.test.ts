import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelRecoveryStore } from "./recovery-store";

describe("channel recovery corruption isolation", () => {
  it("quarantines one malformed record and continues listing valid records", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cyrene-channel-recovery-"));
    const store = new ChannelRecoveryStore(directory);
    const valid = path.join(directory, "a".repeat(64) + ".json");
    writeFileSync(valid, JSON.stringify({ kind: "inbox", id: "ok", channel: "wechat", createdAt: 1, updatedAt: 1, message: {}, context: {}, status: "queued" }));
    const invalid = path.join(directory, "b".repeat(64) + ".json");
    writeFileSync(invalid, "{broken");
    expect(store.list().map(record => record.id)).toEqual(["ok"]);
    expect(store.get("missing")).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    const quarantine = path.join(directory, "quarantine");
    expect(readdirSync(quarantine)).toHaveLength(1);
  });
});
