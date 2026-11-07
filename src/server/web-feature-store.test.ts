import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebFeatureStore } from "./web-feature-store";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("WebFeatureStore", () => {
  it("recovers when an earlier write in the chain rejected", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-feature-write-chain-")); directories.push(directory);
    const store = new WebFeatureStore(directory);
    const rejected = Promise.reject(new Error("transient"));
    rejected.catch(() => undefined);
    (store as unknown as { writeChain: Promise<void> }).writeChain = rejected;

    await expect(store.patchProfile({ nickname: "昔涟" })).resolves.toMatchObject({ nickname: "昔涟" });
    const reloaded = new WebFeatureStore(directory);
    await expect(reloaded.getProfile()).resolves.toMatchObject({ nickname: "昔涟" });
  });

  it("does not expose mutable nested state or retain caller-owned objects", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-feature-clone-")); directories.push(directory);
    const store = new WebFeatureStore(directory);
    const patch = { nested: { value: "original" } };
    await store.patchProfile(patch);
    patch.nested.value = "caller mutation";
    const profile = await store.getProfile();
    (profile.nested as { value: string }).value = "read mutation";
    expect((await store.getProfile()).nested).toEqual({ value: "original" });
  });

  it("rejects oversized memory collections before mutating the store", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-feature-limits-")); directories.push(directory);
    const store = new WebFeatureStore(directory);
    await expect(store.patchMemory({ l2: Array.from({ length: 2_001 }, () => ({ text: "x" })) })).rejects.toThrow("MEMORY_ITEM_LIMIT_REACHED");
    expect((await store.getMemory()).l2).toHaveLength(0);
  });
});
