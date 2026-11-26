import * as fs from "fs";
import * as path from "path";
import type { L2Memory } from "./memory-types";

export interface ReconciliationVector {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRagReconciliationDeps {
  getMemories(): Promise<L2Memory[]>;
  getVectors(): ReconciliationVector[];
  backup(): Promise<void>;
  addVector(text: string, l2Id: string, metadata: Record<string, unknown>): Promise<string>;
  markSynced(l2Id: string, ragId: string, expected: L2Memory): Promise<unknown>;
  markSyncFailed(l2Id: string, error: unknown, expected: L2Memory): Promise<unknown>;
  deleteVectors(ids: string[]): Promise<unknown> | unknown;
  warn(message: string, error: unknown): void;
  isCurrent?(): boolean;
  persistVectors?(): Promise<void>;
}

export interface MemoryRagReconciliationReport {
  rebuilt: number;
  relinked: number;
  deleted: number;
  failed: number;
  changed: boolean;
}

export function backupMemoryRagFiles(userDataDir: string, timestamp = Date.now(), retention = 3): void {
  const sources = [
    { path: path.join(userDataDir, "memory.json"), prefix: "memory" },
    { path: path.join(userDataDir, "rag-data", "memory-store.json"), prefix: "memory-store" },
    { path: path.join(userDataDir, "rag-data", "memory-store-meta.json"), prefix: "memory-store-meta" },
  ].filter((source) => fs.existsSync(source.path));
  if (sources.length === 0) return;

  const backupDir = path.join(userDataDir, "memory-reconcile-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  for (const source of sources) {
    fs.copyFileSync(source.path, path.join(backupDir, `${source.prefix}.${timestamp}.json`));
    const backups = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith(`${source.prefix}.`) && name.endsWith(".json"))
      .sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - Math.max(1, retention)))) {
      fs.rmSync(path.join(backupDir, stale));
    }
  }
}

function isSemanticallyRecallable(memory: L2Memory): boolean {
  return memory.status === "active" || memory.status === "aging";
}

export async function reconcileMemoryRag(
  deps: MemoryRagReconciliationDeps,
  signal?: AbortSignal,
): Promise<MemoryRagReconciliationReport> {
  function checkCurrent() {
    signal?.throwIfAborted();
    if (deps.isCurrent?.() === false) throw new Error("记忆模式已改变");
  }
  const memories = (await deps.getMemories()).map(memory => ({ ...memory }));
  checkCurrent();
  const vectors = deps.getVectors();
  const vectorsById = new Map(vectors.map((vector) => [vector.id, vector]));
  const vectorsByMemory = new Map<string, ReconciliationVector[]>();
  for (const vector of vectors) {
    const id = vector.metadata?.l2Id;
    if (typeof id !== "string") continue;
    const group = vectorsByMemory.get(id);
    if (group) group.push(vector);
    else vectorsByMemory.set(id, [vector]);
  }
  const validVectorIds = new Set<string>();
  const relink: Array<{ memory: L2Memory; ragId: string }> = [];
  const rebuild: L2Memory[] = [];

  for (const memory of memories) {
    if (!isSemanticallyRecallable(memory)) continue;
    const linked = memory.ragId ? vectorsById.get(memory.ragId) : undefined;
    const vector = linked?.metadata?.l2Id === memory.id && linked.text === memory.content ? linked
      : vectorsByMemory.get(memory.id)?.find(candidate => candidate.text === memory.content);
    if (vector) {
      validVectorIds.add(vector.id);
      if (memory.syncStatus !== "synced" || memory.ragId !== vector.id) relink.push({ memory, ragId: vector.id });
    } else {
      rebuild.push(memory);
    }
  }

  const staleVectorIds = vectors
    .filter((vector) => !validVectorIds.has(vector.id))
    .map((vector) => vector.id);
  const changed = relink.length > 0 || rebuild.length > 0 || staleVectorIds.length > 0;
  const report: MemoryRagReconciliationReport = {
    rebuilt: 0,
    relinked: 0,
    deleted: 0,
    failed: 0,
    changed,
  };
  if (!changed) return report;

  await deps.backup();

  const prepared: Array<{ memory: L2Memory; ragId: string }> = [];
  async function fail(memory: L2Memory, error: unknown) {
    checkCurrent();
    report.failed += 1;
    await deps.markSyncFailed(memory.id, error, memory);
    deps.warn(`Failed to rebuild memory vector ${memory.id}`, error);
  }
  for (const memory of rebuild) {
    checkCurrent();
    try {
      const ragId = await deps.addVector(memory.content, memory.id, {
        source: "memory_reconciliation",
        isSummary: memory.isSummary === true,
        subEntryIds: memory.subEntryIds ?? [],
      });
      checkCurrent();
      prepared.push({ memory, ragId });
    } catch (error) {
      await fail(memory, error);
    }
  }
  const links = [...relink, ...prepared];
  if (links.length && deps.persistVectors) {
    try { await deps.persistVectors(); }
    catch (error) {
      for (const { memory } of links) await fail(memory, error);
      return report;
    }
  }
  for (const [kind, items] of [["relinked", relink], ["rebuilt", prepared]] as const) {
    for (const { memory, ragId } of items) {
      checkCurrent();
      try {
        // Another writer may have linked this same deduplicated vector.
        if (await deps.markSynced(memory.id, ragId, memory) !== null) report[kind] += 1;
      } catch (error) {
        await fail(memory, error);
      }
    }
  }

  checkCurrent();
  if (staleVectorIds.length > 0) {
    try {
      const current = await deps.getMemories();
      checkCurrent();
      const live = new Set(current.filter(memory => isSemanticallyRecallable(memory) && memory.syncStatus === "synced"
        && vectorsById.get(memory.ragId ?? "")?.text === memory.content
        && vectorsById.get(memory.ragId ?? "")?.metadata?.l2Id === memory.id).map(memory => memory.ragId));
      const obsolete = staleVectorIds.filter(id => !live.has(id));
      if (obsolete.length) await deps.deleteVectors(obsolete);
      report.deleted = obsolete.length;
    } catch (error) {
      report.failed += 1;
      deps.warn("Failed to delete stale user memory vectors", error);
    }
  }

  return report;
}
