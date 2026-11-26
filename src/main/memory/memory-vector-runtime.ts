import {
  addL2MemoryVector, deleteUserMemoryVectors, flushRAGStore, getEntriesBySource, isUserMemoryVectorStoreReady,
} from "../rag";
import { getMemoryModeVersion, isMemoryEnabled } from "./memory-mode";
import { backupMemoryRagFiles, reconcileMemoryRag, type MemoryRagReconciliationReport } from "./memory-rag-reconciliation";
import { candidateSources, isForgottenFact, isForgottenSource } from "./memory-source-policy";
import { memoryStore } from "./memory-store";

const pending = new Map<string, Promise<MemoryRagReconciliationReport>>();

/** Both hosts recover failed or interrupted vector writes from the durable memory text. */
export async function reconcileUserMemoryIndex(root: string, signal?: AbortSignal): Promise<MemoryRagReconciliationReport | undefined> {
  if (!isMemoryEnabled() || !isUserMemoryVectorStoreReady()) return undefined;
  const version = getMemoryModeVersion();
  const key = JSON.stringify([root, version]);
  const existing = pending.get(key);
  if (existing) return existing;
  const task = async () => {
    const report = await reconcileMemoryRag({
      getMemories: async () => {
        const state = await memoryStore.load();
        return state.l2.filter(memory => !candidateSources(memory)
          .some(source => isForgottenSource(state, source) || isForgottenFact(state, source, memory.content)));
      },
      getVectors: () => getEntriesBySource("user_memory"),
      backup: async () => backupMemoryRagFiles(root),
      addVector: (text, id, metadata) => addL2MemoryVector(text, id, metadata, signal, true),
      persistVectors: () => flushRAGStore(true),
      markSynced: (id, ragId, expected) => memoryStore.markL2SyncStatus(id, "synced", ragId, undefined, expected),
      markSyncFailed: (id, error, expected) => memoryStore.markL2SyncStatus(id, "sync_failed", undefined, error, expected),
      deleteVectors: ids => deleteUserMemoryVectors(ids),
      warn: (message, error) => console.warn(`[Memory/RAG] ${message}:`, error),
      isCurrent: () => getMemoryModeVersion() === version,
    }, signal);
    if (report.changed && !report.failed && getMemoryModeVersion() === version) await flushRAGStore(true);
    return report;
  };
  const repair = task().finally(() => pending.delete(key));
  pending.set(key, repair);
  return repair;
}
