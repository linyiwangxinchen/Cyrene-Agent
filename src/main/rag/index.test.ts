import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EmbeddingProvider } from "./embedding";

const provider: EmbeddingProvider = {
  name: "deterministic",
  dims: 2,
  declaredDimensions: 2,
  async embed(text: string): Promise<number[]> {
    return text.includes("paragraph") ? [0, 1] : [1, 0];
  },
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  },
};

const { userDataDir, appPath } = vi.hoisted(() => ({ userDataDir: { value: "" }, appPath: { value: "" } }));

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir.value,
    getAppPath: () => appPath.value,
  },
}));

vi.mock("./embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedding")>()),
  getEmbeddingProvider: () => provider,
}));

import {
  addL2MemoryVector,
  addMemory,
  deleteUserMemoryVectors,
  disposeVectorMemory,
  getEntriesBySource,
  initRAG,
  initVectorMemory,
  isUserMemoryVectorIndexVerified,
  isUserMemoryVectorStoreReady,
  resetRAG,
  searchMemoryEntries,
} from "./index";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-index-test-"));
  userDataDir.value = tmpDir;
  appPath.value = tmpDir;
  await initRAG();
});

afterEach(() => {
  resetRAG();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("user memory vector store", () => {
  it("reports that user memory vectors are writable after RAG initialization", () => {
    expect(isUserMemoryVectorStoreReady()).toBe(true);
  });

  it("keeps a successful L2 vector across a fresh index instance and rejects a locked destination", async () => {
    expect(isUserMemoryVectorIndexVerified()).toBe(false);
    const vectorId = await addL2MemoryVector("durable", "l2_durable");
    expect(isUserMemoryVectorIndexVerified()).toBe(true);
    resetRAG();
    await initVectorMemory();
    expect(getEntriesBySource("user_memory").map(entry => entry.id)).toEqual([vectorId]);
    const file = path.join(tmpDir, "rag-data", "memory-store.json");
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    await expect(addL2MemoryVector("disk blocked", "l2_unsynced")).rejects.toThrow();
    expect(isUserMemoryVectorIndexVerified()).toBe(false);
    expect(getEntriesBySource("user_memory").map(entry => entry.id)).toEqual([vectorId]);
    fs.rmdirSync(file);
    await disposeVectorMemory();
  });

  it("keeps compatible vectors and backs up legacy mixed-dimension entries for repair", async () => {
    const durable = await addL2MemoryVector("current", "l2_current");
    const index = path.join(tmpDir, "rag-data", "memory-store.json");
    const original = JSON.parse(fs.readFileSync(index, "utf8"));
    const old = { ...original[0], id: "legacy-wrong-dimension", embedding: [1], metadata: { l2Id: "l2_legacy" } };
    fs.writeFileSync(index, JSON.stringify([...original, old]), "utf8");
    resetRAG();
    await initVectorMemory();
    expect(getEntriesBySource("user_memory").map(entry => entry.id)).toEqual([durable]);
    const backups = path.join(tmpDir, "memory-reconcile-backups");
    const vectorBackup = fs.readdirSync(backups).find(name => name.startsWith("memory-store.") && name.endsWith(".json"))!;
    expect(JSON.parse(fs.readFileSync(path.join(backups, vectorBackup), "utf8"))).toHaveLength(2);
    await disposeVectorMemory();
  });
});

describe("user memory retrieval", () => {
  it("creates a distinct vector for every L2 even when contents are identical", async () => {
    const firstId = await addL2MemoryVector("用户喜欢香菇", "l2_first", { source: "test" });
    const secondId = await addL2MemoryVector("用户喜欢香菇", "l2_second", { source: "test" });

    expect(secondId).not.toBe(firstId);
    expect(getEntriesBySource("user_memory").map((entry) => ({ id: entry.id, l2Id: entry.metadata?.l2Id })))
      .toEqual([
        { id: firstId, l2Id: "l2_first" },
        { id: secondId, l2Id: "l2_second" },
      ]);
  });

  it("deletes only the requested user memory vectors", async () => {
    const firstId = await addL2MemoryVector("第一条", "l2_first");
    const secondId = await addL2MemoryVector("第二条", "l2_second");

    expect(deleteUserMemoryVectors([firstId])).toBe(1);
    expect(getEntriesBySource("user_memory").map((entry) => entry.id)).toEqual([secondId]);
  });

  it("returns only consistently mapped, recallable L2 vectors", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    const active = await memoryStore.addL2Memory({
      content: "alpha active memory",
      triggerText: "active",
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    });
    const activeRagId = await addMemory(active.content, "user_memory", { l2Id: active.id });
    await memoryStore.markL2SyncStatus(active.id, "synced", activeRagId);

    const archived = await memoryStore.addL2Memory({
      content: "paragraph archived memory",
      triggerText: "archived",
      sourceConversationId: "test",
      isPinned: false,
      syncStatus: "pending_sync",
    });
    const archivedRagId = await addMemory(archived.content, "user_memory", { l2Id: archived.id });
    await memoryStore.markL2SyncStatus(archived.id, "synced", archivedRagId);
    await memoryStore.updateL2Status([archived.id], "archived");

    const results = await searchMemoryEntries("memory", "user_memory", 5);

    expect(results.map((entry) => entry.id)).toEqual([activeRagId]);
    expect(results.some((entry) => entry.id === archivedRagId)).toBe(false);
  });
});
