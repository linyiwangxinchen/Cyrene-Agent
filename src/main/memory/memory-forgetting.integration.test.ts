import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCandidateSources } from "./memory-source-policy";
import { pageRelativePath } from "./wiki-paths";
import type { MemoryCandidate } from "./memory-types";
import type { WikiClaimCandidate } from "./wiki-types";

const fixture = vi.hoisted(() => ({ root: "", reflect: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("./obsidian-exporter", () => ({ notifyMemoryChanged: vi.fn() }));
vi.mock("../rag/index", () => ({ addL2MemoryVector: vi.fn(async () => "vector"), searchMemoryEntries: vi.fn(async () => []), deleteUserMemoryVectors: vi.fn(), getEntriesBySource: vi.fn(() => []) }));
vi.mock("./memory-llm-client", () => ({ invokeMemoryLlm: vi.fn(), invokeMemoryStructuredOutput: fixture.reflect, getDefaultMaxOutputTokens: () => 1024 }));
const closing: Array<() => Promise<void>> = [];
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-forgetting-")); fixture.reflect.mockReset(); vi.resetModules(); });
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  await vi.dynamicImportSettled();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function candidate(entry = "u1", conversation = "chat"): MemoryCandidate {
  return { layer: "L2", content: "用户喜欢画画", triggerText: "我喜欢画画", sourceQuote: "我喜欢画画", confidence: 0.9, sourceConversationId: conversation, sourceMessageIds: [entry] };
}
function wikiCandidate(entry = "u1"): WikiClaimCandidate {
  return { subject: "用户", predicate: "兴趣", value: "喜欢画画", scope: { kind: "global" }, statementKind: "assertion", pageType: "person", sourceText: "我喜欢画画", source: { kind: "chat", conversationId: "chat", messageId: entry, revision: "1", assertedAt: 1, evidenceQuote: "我喜欢画画" } };
}

async function context() {
  const { memoryStore } = await import("./memory-store");
  const { memoryManager } = await import("./memory-manager");
  const { WikiStore } = await import("./wiki-store");
  const { createMemoryGovernance } = await import("./memory-governance");
  const wiki = new WikiStore(fixture.root, { readForgetting: async () => (await memoryStore.load()).forgetting });
  closing.push(() => wiki.close());
  const erase = vi.fn((claim: { pageId: string; claimId: string }) => wiki.eraseGovernedClaim(claim));
  const governance = createMemoryGovernance({
    load: () => memoryStore.load(), save: state => memoryStore.save(state), sync: async () => {}, deleteVectors: async () => {},
    relatedWiki: async sources => ({ available: true, claims: await wiki.findClaimsBySources(sources) }), deleteWiki: erase,
  });
  return { memoryStore, memoryManager, wiki, erase, governance };
}

describe("provenance-bound forgetting", () => {
  it("links only one exact user entry in this conversation, never duplicate text or assistant speculation", () => {
    const turn = { conversationId: "chat", userEntryId: "entry1", userTurnId: "turn1", assistantEntryId: "a1", seq: 1, userInput: "我喜欢画画", assistantReply: "你可能喜欢旅行" };
    expect(attachCandidateSources(candidate(), "chat", [turn]).sourceMessageIds).toEqual(["entry1"]);
    expect(attachCandidateSources(candidate(), "chat", [turn, { ...turn, userEntryId: "entry2" }]).sourceMessageIds).toEqual([]);
    expect(attachCandidateSources(candidate(), "different", [turn]).sourceMessageIds).toEqual([]);
    expect(attachCandidateSources({ ...candidate(), triggerText: "你可能喜欢旅行", sourceQuote: "你可能喜欢旅行" }, "chat", [turn]).sourceMessageIds).toEqual([]);
  });

  it("previews exact cross-store relations, keeps unchecked records and original messages", async () => {
    const f = await context();
    await f.memoryManager.writeMemory([candidate(), candidate("u2", "other-chat"), { ...candidate(), layer: "L0", field: "longTermInterests", certainty: "explicit", attribution: "user_explicit" }]);
    const memory = (await f.memoryStore.getAllL2())[0];
    await f.memoryStore.addL2Batch([{ content: "画画摘要", triggerText: "summary", sourceConversationId: "chat", subEntryIds: [memory.id], isSummary: true, isPinned: false }]);
    await f.wiki.applyClaims([wikiCandidate()]);
    fs.writeFileSync(path.join(fixture.root, "original-chat.json"), JSON.stringify({ entry: "u1", text: "我喜欢画画" }));
    const preview = (await f.governance.explain(memory.id)).related!;
    expect(preview.memories).toHaveLength(2); expect(preview.profiles.map(item => item.key)).toEqual(["L0.longTermInterests"]); expect(preview.wikiClaims).toHaveLength(1);
    const summaryPreview = (await f.governance.explain(preview.memories.find(item => item.summary)!.id)).related!;
    expect(summaryPreview.sources).toEqual(preview.sources); expect(summaryPreview.wikiClaims).toEqual(preview.wikiClaims);
    await f.governance.change({ action: "delete", id: memory.id, expectedContent: memory.content, selection: { revision: preview.revision, memoryIds: preview.memories.map(item => item.id), profileKeys: [], wikiClaims: [], preventReplay: true } });
    expect((await f.memoryStore.getAllL2()).map(item => item.sourceConversationId)).toEqual(["other-chat"]);
    expect((await f.memoryStore.getL0()).longTermInterests).toBe("用户喜欢画画");
    expect((await f.wiki.findPage("用户", { kind: "global" }))?.claims).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root, "original-chat.json"), "utf8")).text).toBe("我喜欢画画");
  });

  it("durably suppresses replay after restart, retries Wiki cleanup and permits a newly stated fact", async () => {
    const f = await context();
    await f.memoryManager.writeMemory([candidate(), { ...candidate(), layer: "L0", field: "longTermInterests", certainty: "explicit", attribution: "user_explicit" }]);
    await f.wiki.applyClaims([wikiCandidate()]);
    const memory = (await f.memoryStore.getAllL2())[0], staleWriter = structuredClone(await f.memoryStore.load());
    const preview = (await f.governance.explain(memory.id)).related!;
    f.erase.mockRejectedValueOnce(new Error("Markdown disk failure"));
    const result = await f.governance.change({ action: "delete", id: memory.id, expectedContent: memory.content, selection: { revision: preview.revision, memoryIds: preview.memories.map(item => item.id), profileKeys: preview.profiles.map(item => item.key), wikiClaims: preview.wikiClaims, preventReplay: true } });
    expect(result.warning).toContain("磁盘清理未完成");
    expect((await f.wiki.findPage("用户", { kind: "global" }))?.claims).toHaveLength(0);
    expect(await f.wiki.search("画画")).toHaveLength(0);
    await f.memoryStore.save(staleWriter);
    expect(await f.memoryStore.getAllL2()).toHaveLength(0); expect((await f.memoryStore.getL0()).longTermInterests).toBe("");
    await f.wiki.close(); await vi.dynamicImportSettled(); vi.resetModules();
    const restarted = await context();
    await restarted.memoryManager.writeMemory([candidate(), { ...candidate(), layer: "L0", field: "longTermInterests", certainty: "explicit", attribution: "user_explicit" }]);
    await restarted.wiki.applyClaims([wikiCandidate()]);
    expect(await restarted.memoryStore.getAllL2()).toHaveLength(0);
    const page = await restarted.wiki.findPage("用户", { kind: "global" });
    expect(page?.claims).toHaveLength(0);
    const wikiFile = path.join(restarted.wiki.root, pageRelativePath(page!.id));
    expect(fs.readFileSync(wikiFile, "utf8")).not.toContain("喜欢画画");
    await restarted.memoryManager.writeMemory([candidate("new-user-entry")]);
    await restarted.wiki.applyClaims([wikiCandidate("new-user-entry")]);
    expect(await restarted.memoryStore.getAllL2()).toHaveLength(1);
    expect((await restarted.wiki.findPage("用户", { kind: "global" }))?.claims).toHaveLength(1);
  });

  it("rejects stale previews and arbitrary unrelated deletion targets before mutation", async () => {
    const f = await context(); await f.memoryManager.writeMemory([candidate()]);
    const memory = (await f.memoryStore.getAllL2())[0], preview = (await f.governance.explain(memory.id)).related!;
    await expect(f.governance.change({ action: "delete", id: memory.id, expectedContent: memory.content, selection: { revision: preview.revision, memoryIds: [memory.id], profileKeys: ["L0.permanentNote"], wikiClaims: [], preventReplay: true } })).rejects.toThrow("范围无效");
    await f.wiki.applyClaims([wikiCandidate()]);
    await expect(f.governance.change({ action: "delete", id: memory.id, expectedContent: memory.content, selection: { revision: preview.revision, memoryIds: [memory.id], profileKeys: [], wikiClaims: [], preventReplay: true } })).rejects.toThrow("关联记忆已变更");
    expect(await f.memoryStore.getAllL2()).toHaveLength(1);
  });

  it("rejects a stale reflection and a late compression derived from deleted memory", async () => {
    const f = await context();
    await f.memoryManager.writeMemory([candidate(), { ...candidate(), layer: "L0", field: "longTermInterests", certainty: "explicit", attribution: "user_explicit" }]);
    const memory = (await f.memoryStore.getAllL2())[0], preview = (await f.governance.explain(memory.id)).related!;
    let release!: (value: unknown) => void;
    fixture.reflect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { runMemoryCompression } = await import("./memory-compressor");
    const pending = runMemoryCompression();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.governance.change({ action: "delete", id: memory.id, expectedContent: memory.content, selection: { revision: preview.revision, memoryIds: [memory.id], profileKeys: ["L0.longTermInterests"], wikiClaims: [], preventReplay: true } });
    release([{ layer: "L0", field: "longTermInterests", content: "用户依旧喜欢画画", confidence: 0.9 }]);
    await pending;
    expect((await f.memoryStore.getL0()).longTermInterests).toBe("");
    await expect(f.memoryStore.addL2Memory({ content: "晚到的画画摘要", triggerText: "summary", sourceConversationId: "chat", isPinned: false, isSummary: true, subEntryIds: [memory.id] })).rejects.toThrow("MEMORY_SOURCE_FORGOTTEN");
    expect(await f.memoryStore.getAllL2()).toHaveLength(0);
  });
});
