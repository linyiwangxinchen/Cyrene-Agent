import { describe, expect, it, vi } from "vitest";
import { createMemoryGovernance } from "./memory-governance";
import { createDefaultMemoryStore } from "./memory-store-defaults";
import type { L2Memory } from "./memory-types";
function fixture() {
  let state = createDefaultMemoryStore();
  const item = (id: string, subEntryIds?: string[]): L2Memory => ({ id, content: id, triggerText: "source", sourceConversationId: "chat", createdAt: 1, lastAccessedAt: 1, accessCount: 0, weight: 30, isPinned: false, status: "active", syncStatus: "synced", ragId: `rag-${id}`, subEntryIds });
  state.l2 = [item("one"), item("summary", ["one"]), item("nested", ["summary"]), item("other")];
  state.l2DmaeStates = state.l2.map(memory => ({ l2Id: memory.id, activation: 0.5, intrinsicValue: 0.5, userSilence: 0, modelSilence: 0, recentUserHits: [], state: "active" }));
  state.evidence = [{ id: "e", memoryId: "one", quoteSnippet: "original", createdAt: 1, sourceStatus: "active" }];
  const deps = { load: async () => state, save: async (value: typeof state) => { state = value; }, sync: vi.fn(async () => {}), deleteVectors: vi.fn(async () => {}) };
  return { deps, service: createMemoryGovernance(deps), state: () => state };
}
describe("memory governance", () => {
  it("explains provenance without inventing confidence", async () => {
    const f = fixture(); const detail = await f.service.explain("one");
    expect(detail.evidence[0].quoteSnippet).toBe("original"); expect(detail.confidence).toBeNull();
    expect(JSON.parse(await f.service.export()).l2).toHaveLength(4);
  });
  it("deletes transitive summaries and evidence and purges their indexes", async () => {
    const f = fixture(); await f.service.change({ action: "delete", id: "one", expectedContent: "one" });
    expect(f.state().l2.map(item => item.id)).toEqual(["other"]); expect(f.state().evidence).toEqual([]);
    expect(f.deps.deleteVectors).toHaveBeenCalledWith(["rag-one", "rag-summary", "rag-nested"]);
  });
  it("fails closed when an external index is offline", async () => {
    const f = fixture(); f.deps.deleteVectors.mockRejectedValueOnce(new Error("offline"));
    const result = await f.service.change({ action: "archive", id: "one", expectedContent: "one" });
    expect(result.warning).toContain("停止召回");
    expect(f.state().l2.filter(item => item.status === "active").map(item => item.id)).toEqual(["other"]);
  });
  it("invalidates old vectors and derived summaries before rebuilding corrected content", async () => {
    const f = fixture(); f.deps.sync.mockImplementationOnce(async () => {
      expect(f.state().l2.find(item => item.id === "one")).toMatchObject({ content: "corrected", syncStatus: "pending_sync" });
      expect(f.state().l2.find(item => item.id === "summary")?.status).toBe("archived");
      expect(f.state().l2DmaeStates?.find(item => item.l2Id === "one")?.state).toBe("active");
      expect(f.state().l2DmaeStates?.find(item => item.l2Id === "summary")?.state).toBe("archived");
    });
    await f.service.change({ action: "edit", id: "one", expectedContent: "one", content: "corrected" });
    await expect(f.service.change({ action: "delete", id: "one", expectedContent: "one" })).rejects.toThrow("变更");
  });
  it("rejects invalid changes before any write", async () => {
    const f = fixture();
    await expect(f.service.change({ action: "edit", id: "one", expectedContent: "one", content: "" })).rejects.toThrow();
    expect(f.state().l2[0].content).toBe("one");
    expect(f.deps.deleteVectors).not.toHaveBeenCalled();
  });
});
