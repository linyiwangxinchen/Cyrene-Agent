import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("background memory failure isolation", () => {
  it("keeps Node alive, preserves retry progress, and respects cancellation after a model failure", async () => {
    const root = process.cwd();
    const tempParent = path.join(root, ".build-temp");
    await fs.mkdir(tempParent, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(tempParent, "memory-background-"));
    const outfile = path.join(fixture, "probe.cjs");
    try {
      await build({
        stdin: {
          resolveDir: root,
          loader: "ts",
          contents: `
            import assert from "node:assert/strict";
            import fs from "node:fs/promises";
            import path from "node:path";
            import { setMemoryMode } from "./src/main/memory/memory-mode";
            import { WikiMemoryScheduler, initializeWikiMemoryScheduler, releaseWikiMemorySessionCancellation } from "./src/main/memory/wiki-memory-scheduler";
            import { SummaryMemoryScheduler } from "./src/main/memory/summary-memory-scheduler";
            import { resolveSummaryMemoryPaths } from "./src/main/memory/summary-memory-paths";
            import { enqueueLLMTask } from "./src/main/llm-queue";

            const state = globalThis.__memoryFixture = {
              wikiFail: true, summaryFail: true, summaryCalls: 0, waitForSummary: null,
            };
            const tick = () => new Promise(resolve => setImmediate(resolve));
            async function main() {
              const dataRoot = process.argv[2];
              // The production queue already observes its own tail. Keep that contract.
              await assert.rejects(enqueueLLMTask("failed", async () => { throw new Error("queue failure"); }, { log: false }), /queue failure/);
              assert.equal(await enqueueLLMTask("next", async () => "ok", { log: false }), "ok");
              await tick();

              setMemoryMode("wiki");
              const user = { sourceId: "user-source", logicalId: "u", conversationId: "wiki", entryId: "u", revision: 1, seq: 1, at: 1, role: "user", text: "remember this" };
              const assistant = { ...user, sourceId: "assistant-source", logicalId: "a", entryId: "a", seq: 2, role: "assistant", text: "remembered", isFinalReply: true };
              const conversation = { conversationId: "wiki", mode: "chat", throughSeq: 2, messages: [user, assistant], activeSourceIds: [user.sourceId, assistant.sourceId], turns: [{ user, assistants: [assistant] }] };
              const wikiOptions = { userDataRoot: dataRoot, sourceReader: { listConversationIds: async () => ["wiki"], readConversation: async () => conversation }, onError: () => {} };
              let backfillScans = 0;
              const trackBackfill = scheduler => {
                const scan = scheduler.store.listTombstonedConversations.bind(scheduler.store);
                scheduler.store.listTombstonedConversations = async () => { backfillScans++; return scan(); };
              };
              let wiki = new WikiMemoryScheduler(wikiOptions);
              trackBackfill(wiki);
              await wiki.setEnabled(true);
              await assert.rejects(wiki.flushConversation("wiki", true), /MODEL_REQUEST_FAILED/);
              await tick(); // With the old finally tail, strict Node exits here despite assert.rejects.
              assert.equal(await wiki.store.getProcessedSeq("wiki"), 0);
              await wiki.setEnabled(false);
              wiki = new WikiMemoryScheduler(wikiOptions);
              trackBackfill(wiki);
              await wiki.setEnabled(true);
              assert.equal(await wiki.store.getProcessedSeq("wiki"), 0, "failure must stay pending after reopening the store");
              state.wikiFail = false;
              await wiki.flushConversation("wiki", true);
              assert.equal(await wiki.store.getProcessedSeq("wiki"), 2);
              await wiki.setEnabled(false);

              // The fire-and-forget deletion rollback must observe source-store failure.
              const releaseErrors = [];
              initializeWikiMemoryScheduler({ ...wikiOptions,
                sourceReader: { ...wikiOptions.sourceReader, listConversationIds: async () => { throw new Error("SOURCE_STORE_UNAVAILABLE"); } },
                onError: (id, error) => releaseErrors.push({ id, error }),
              });
              releaseWikiMemorySessionCancellation("deleted");
              await tick();
              assert.equal(releaseErrors.length, 1);
              assert.equal(releaseErrors[0].id, "deleted");

              setMemoryMode("summary");
              const session = { id: "summary", mode: "chat", title: "fixture", identityId: null, schemaVersion: 1, messages: [], createdAt: 1, updatedAt: 1 };
              let pending = [{ assistantEntryId: "a", userText: "goal", assistantText: "answer" }];
              let reads = 0;
              let disappearAfterInitialRead = false;
              const sessions = {
                getSessionRecord: async () => { reads++; return disappearAfterInitialRead && reads > 1 ? null : session; },
                getSummaryMemoryProgress: async () => ({ pendingTurns: pending }),
                appendSummaryMemoryTurn: async () => true,
                markSummaryMemoryProcessed: async () => { pending = []; return true; },
                listSessions: async () => [{ id: "summary" }],
              };
              let summary = new SummaryMemoryScheduler({ userDataRoot: dataRoot, sessions, onError: () => {} });
              summary.setEnabled(true);
              await assert.rejects(summary.flushSummary("summary"), /MODEL_REQUEST_FAILED/);
              await tick(); // Both the workspace and session queue tails must observe failure.
              assert.equal(pending.length, 1);
              const summaryPath = resolveSummaryMemoryPaths({ conversationId: "summary", userDataRoot: dataRoot, session }).sessionPath;
              await assert.rejects(fs.stat(summaryPath), { code: "ENOENT" });
              summary.dispose();
              summary = new SummaryMemoryScheduler({ userDataRoot: dataRoot, sessions, onError: () => {} });
              summary.setEnabled(true);
              state.summaryFail = false;
              await summary.flushSummary("summary");
              assert.equal(pending.length, 0);
              assert.equal(await fs.readFile(summaryPath, "utf8"), "goal preserved");

              // A deleted session discovered by the async guard must never reach the model.
              pending = [{ assistantEntryId: "b", userText: "next", assistantText: "next" }];
              reads = 0;
              disappearAfterInitialRead = true;
              const callsBefore = state.summaryCalls;
              await summary.flushSummary("summary");
              assert.equal(state.summaryCalls, callsBefore);
              assert.equal(pending.length, 1);
              disappearAfterInitialRead = false;

              // A provider may finish successfully after AbortSignal. Cancellation still wins.
              let release;
              state.waitForSummary = new Promise(resolve => { release = resolve; });
              const flushing = summary.flushSummary("summary");
              while (state.summaryCalls === callsBefore) await tick();
              const cancelling = summary.cancelSession("summary");
              release();
              await Promise.all([flushing, cancelling]);
              assert.equal(pending.length, 1, "cancelled work must not be marked processed");
              assert.equal(await fs.readFile(summaryPath, "utf8"), "goal preserved");
              summary.dispose();
              await tick();
              // Both two-second startup backfills belong to closed generations.
              // They must not re-open their SQLite stores after shutdown.
              await new Promise(resolve => setTimeout(resolve, 2100));
              assert.equal(backfillScans, 0);
              console.log("MEMORY_BACKGROUND_FAILURE_ISOLATED");
            }
            main().catch(error => { console.error(error); process.exitCode = 1; });
          `,
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        plugins: [{
          name: "fixture-memory-provider",
          setup(builder) {
            builder.onResolve({ filter: /(?:wiki|summary)-memory-llm$/ }, args => ({ path: args.path, namespace: "fixture-memory-provider" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture-memory-provider" }, args => ({
              contents: args.path.includes("wiki")
                ? `export async function extractWikiClaims() { if (globalThis.__memoryFixture.wikiFail) throw new Error("MODEL_REQUEST_FAILED (stage: memory_wiki)"); return []; }`
                : `export async function summarizeMemory() { const state = globalThis.__memoryFixture; state.summaryCalls++; if (state.summaryFail) throw new Error("MODEL_REQUEST_FAILED (stage: memory_summary)"); if (state.waitForSummary) { await state.waitForSummary; state.waitForSummary = null; } return { sessionSummary: "goal preserved", workspaceSummary: "" }; }`,
              loader: "js",
            }));
          },
        }],
      });
      const result = await execFileAsync(process.execPath, ["--unhandled-rejections=strict", outfile, path.join(fixture, "data")], {
        cwd: root,
        timeout: 15_000,
      });
      expect(result.stdout).toContain("MEMORY_BACKGROUND_FAILURE_ISOLATED");
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 20_000);
});
