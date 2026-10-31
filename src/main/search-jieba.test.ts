import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SocialAtom } from "./social-context/types";

const { loadNative, warn } = vi.hoisted(() => ({ loadNative: vi.fn(), warn: vi.fn() }));
vi.mock("../shared/logger", () => ({ logger: { warn } }));
vi.mock("node:module", () => ({ createRequire: () => loadNative }));

function atom(content: string): SocialAtom {
  return {
    id: content, conversationId: "test", content, type: "long_term",
    evidenceTurnId: "turn", evidenceQuote: content, createdAt: 0, status: "active",
  };
}

beforeEach(() => {
  vi.resetModules();
  loadNative.mockReset();
  warn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("optional native search tokenizer", () => {
  it("imports both retrieval paths without loading native bindings", async () => {
    loadNative.mockImplementation(() => { throw new Error("native unavailable"); });
    const rag = await import("./rag/text-ranking");
    await import("./social-context/retrieval");
    expect(rag.tokenizeText("Hello world").map((token) => token.word)).toEqual(["hello", "world"]);
    expect(loadNative).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["load", "constructor"])("retries once per call after %s failure, logs each failure, and keeps fallback ranking", async (failure) => {
    const nested = Object.assign(new Error("native DLL not found"), { code: "ERR_DLOPEN_FAILED" });
    const error = new Error("Failed to load native binding", { cause: [nested] });
    // Real loader errors may contain nested arrays or circular diagnostic data.
    Object.assign(nested, { cause: error });
    const construct = vi.fn(function () { throw error; });
    loadNative.mockImplementation(() => {
      if (failure === "load") throw error;
      return { Jieba: construct };
    });
    const { tokenizeText, rankTextCandidates } = await import("./rag/text-ranking");
    const { rankSocialAtoms } = await import("./social-context/retrieval");
    expect(tokenizeText("海边").map((token) => token.word)).toEqual(["海", "边"]);
    const ranked = rankTextCandidates("海边", [
      { item: "unrelated", text: "爬山" }, { item: "match", text: "喜欢海边" },
    ]);
    expect(ranked[0].item).toBe("match");
    expect(ranked[0].score).toBeGreaterThan(0);
    expect(rankSocialAtoms("海边", [atom("爬山"), atom("喜欢海边")], { now: 0 })
      .map((item) => item.content)).toEqual(["喜欢海边"]);
    // One standalone tokenization, then query + two candidates for each ranker.
    expect(loadNative).toHaveBeenCalledTimes(7);
    expect(loadNative.mock.calls.every(([name]) => name === "@node-rs/jieba")).toBe(true);
    expect(construct).toHaveBeenCalledTimes(failure === "constructor" ? 7 : 0);
    expect(warn).toHaveBeenCalledTimes(7);
    const [tag, label, detail] = warn.mock.calls[0];
    expect(tag).toBe("Search");
    expect(label).toContain("@node-rs/jieba");
    expect(label).toContain("fallback");
    expect(detail).toContain("Failed to load native binding");
    expect(detail).toContain("native DLL not found");
    expect(detail).toContain("ERR_DLOPEN_FAILED");
    expect(detail).toContain("search-jieba.test.ts");
    expect(detail).toContain("Circular");
  });

  it.each(["load", "constructor"])("recovers from %s failure on the next caller and then reuses the instance", async (failure) => {
    const error = new Error("temporarily unavailable");
    const native = {
      cut: vi.fn(() => ["海边"]),
      tag: vi.fn(() => [{ word: "海边", tag: "n" }]),
    };
    let constructionAttempts = 0;
    const construct = vi.fn(function () {
      if (failure === "constructor" && constructionAttempts++ === 0) throw error;
      return native;
    });
    loadNative.mockReturnValue({ Jieba: construct });
    if (failure === "load") loadNative.mockImplementationOnce(() => { throw error; });
    const { tokenizeText } = await import("./rag/text-ranking");
    const { rankSocialAtoms } = await import("./social-context/retrieval");

    expect(tokenizeText("海边").map((token) => token.word)).toEqual(["海", "边"]);
    expect(loadNative).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rankSocialAtoms("海边", [atom("海边")], { now: 0 })).toHaveLength(1);
    expect(tokenizeText("海边")).toEqual([{ word: "海边", tag: "n", isStop: false, isNoun: true }]);
    expect(loadNative).toHaveBeenCalledTimes(2);
    expect(construct).toHaveBeenCalledTimes(failure === "constructor" ? 2 : 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("shares a successful native instance and preserves native tags", async () => {
    const cut = vi.fn(() => ["海边"]);
    const tag = vi.fn(() => [{ word: "海边", tag: "n" }]);
    const construct = vi.fn(function () { return { cut, tag }; });
    loadNative.mockReturnValue({ Jieba: construct });
    const { tokenizeText } = await import("./rag/text-ranking");
    const { rankSocialAtoms } = await import("./social-context/retrieval");
    expect(tokenizeText("海边")).toEqual([{ word: "海边", tag: "n", isStop: false, isNoun: true }]);
    expect(rankSocialAtoms("海边", [atom("海边")], { now: 0 })).toHaveLength(1);
    expect(loadNative).toHaveBeenCalledOnce();
    expect(construct).toHaveBeenCalledOnce();
    expect(cut).toHaveBeenCalledWith("海边", true);
    expect(tag).toHaveBeenCalledWith("海边", true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the existing per-call fallback when native tokenization throws", async () => {
    const cut = vi.fn().mockImplementationOnce(() => { throw new Error("cut failed"); }).mockReturnValue(["海边"]);
    const tag = vi.fn(() => [{ word: "海边", tag: "n" }]);
    loadNative.mockReturnValue({ Jieba: class { cut = cut; tag = tag; } });
    const { tokenizeText } = await import("./rag/text-ranking");
    expect(tokenizeText("海边").map((token) => token.word)).toEqual(["海", "边"]);
    expect(tokenizeText("海边")[0].isNoun).toBe(true);
    expect(loadNative).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["load", "constructor"])("refreshes fallback-prewarmed documents after %s recovery", async (failure) => {
    let available = false;
    const cut = vi.fn((text: string) => [text]);
    const native = { cut, tag: (word: string) => [{ word, tag: "n" }] };
    loadNative.mockImplementation(() => {
      if (!available && failure === "load") throw new Error("temporarily unavailable");
      return { Jieba: class {
        constructor() {
          if (!available) throw new Error("temporarily unavailable");
          return native;
        }
      } };
    });
    const { HybridRetriever } = await import("./rag/retriever");
    const entries = [{ id: "beach", text: "海边", source: "test" }];
    const store = { entries, stats: { total: entries.length } };
    const retriever = new HybridRetriever(store as unknown as import("./rag/vectorstore").JsonVectorStore);
    await retriever.warmupBm25Tokens(entries);
    expect((await retriever.retrieve("海边"))[0].score).toBeGreaterThan(0);
    available = true;
    expect((await retriever.retrieve("海边"))[0].score).toBeGreaterThan(0);
    const callsAfterRecovery = cut.mock.calls.length;
    expect((await retriever.retrieve("海边"))[0].score).toBeGreaterThan(0);
    // Stable documents stay cached; only the new query is tokenized.
    expect(cut).toHaveBeenCalledTimes(callsAfterRecovery + 1);
  });

  it("refreshes an earlier warmup slice after a later slice recovers", async () => {
    let attempts = 0;
    const native = { cut: (text: string) => [text], tag: (word: string) => [{ word, tag: "n" }] };
    loadNative.mockImplementation(() => {
      if (attempts++ < 50) throw new Error("temporarily unavailable");
      return { Jieba: class { constructor() { return native; } } };
    });
    const { HybridRetriever } = await import("./rag/retriever");
    const entries = Array.from({ length: 51 }, (_, index) => ({ id: String(index), text: "海边", source: "test" }));
    const store = { entries, stats: { total: entries.length } };
    const retriever = new HybridRetriever(store as unknown as import("./rag/vectorstore").JsonVectorStore);
    await retriever.warmupBm25Tokens(entries);
    const results = await retriever.retrieve("海边", undefined, entries.length);
    expect(results).toHaveLength(entries.length);
    expect(results.every((result) => result.score > 0 && result.score === results[0].score)).toBe(true);
    expect(loadNative).toHaveBeenCalledTimes(51);
    expect(warn).toHaveBeenCalledTimes(50);
  });

  describe.each(["hybrid", "text", "social"] as const)("%s ranking initialization recovery", (path) => {
    describe.each(["load", "constructor"] as const)("%s failure", (failure) => {
      it.each([0, 1, 2])("keeps tokens coherent after %i failed calls", async (failures) => {
        let attempts = 0;
        const cut = vi.fn((text: string) => [text]);
        const native = { cut, tag: (word: string) => [{ word, tag: "n" }] };
        loadNative.mockImplementation(() => {
          if (failure === "load" && attempts++ < failures) throw new Error("temporarily unavailable");
          return { Jieba: class {
            constructor() {
              if (failure === "constructor" && attempts++ < failures) throw new Error("temporarily unavailable");
              return native;
            }
          } };
        });
        const entries = [{ id: "first", text: "海边", source: "test" }, { id: "second", text: "海边", source: "test" }];
        let rank: () => Promise<number[]>;
        if (path === "hybrid") {
          const { HybridRetriever } = await import("./rag/retriever");
          const store = { entries, stats: { total: entries.length } };
          const retriever = new HybridRetriever(store as unknown as import("./rag/vectorstore").JsonVectorStore);
          rank = async () => (await retriever.retrieve("海边")).map((result) => result.score);
        } else if (path === "text") {
          const { rankTextCandidates } = await import("./rag/text-ranking");
          rank = async () => rankTextCandidates("海边", entries.map((item) => ({ item, text: item.text }))).map((result) => result.score);
        } else {
          const { rankSocialAtoms } = await import("./social-context/retrieval");
          const atoms = entries.map((entry) => ({ ...atom(entry.text), id: entry.id }));
          rank = async () => {
            const ranked = rankSocialAtoms("海边", atoms, { now: 0 });
            expect(ranked.map((item) => item.id)).toEqual(["first", "second"]);
            return ranked.map(() => 1);
          };
        }
        const scores = await rank();
        expect(scores).toHaveLength(2);
        expect(scores.every((score) => score > 0)).toBe(true);
        expect(scores[0]).toBe(scores[1]);
        expect(loadNative).toHaveBeenCalledTimes(failures + 1);
        expect(warn).toHaveBeenCalledTimes(failures);
        // Recovery triggers at most one new batch; HybridRetriever reuses
        // documents already tokenized in the successful generation.
        expect(cut).toHaveBeenCalledTimes(failures === 0 || path === "hybrid" ? 3 : 6 - failures);
        const callsAfterRecovery = cut.mock.calls.length;
        expect(await rank()).toEqual(scores);
        expect(cut).toHaveBeenCalledTimes(callsAfterRecovery + (path === "hybrid" ? 1 : 3));
        expect(loadNative).toHaveBeenCalledTimes(failures + 1);
        expect(warn).toHaveBeenCalledTimes(failures);
      });
    });
  });

});
