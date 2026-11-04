import { extractMemoryKeywords } from "./memory-store-defaults";
import type { MemoryEditCommand, MemoryExplanation } from "../../shared/memory-governance";
import type { MemoryStore, L2Memory } from "./memory-types";

export function cascadeMemoryIds(memories: L2Memory[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const memory of memories) {
      if (!ids.has(memory.id) && memory.subEntryIds?.some(id => ids.has(id))) { ids.add(memory.id); changed = true; }
    }
  }
  return ids;
}

export interface MemoryGovernanceDependencies {
  load(): Promise<MemoryStore>;
  save(state: MemoryStore): Promise<void>;
  sync(id: string, content: string): Promise<void>;
  deleteVectors(ids: string[]): Promise<void>;
}

/** Existing memory store remains authoritative; no second memory database. */
export function createMemoryGovernance(deps: MemoryGovernanceDependencies) {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async explain(id: string): Promise<MemoryExplanation> {
      if (typeof id !== "string") throw new Error("记忆编号无效");
      const state = await deps.load();
      const memory = state.l2.find(item => item.id === id);
      if (!memory) throw new Error("记忆已不存在");
      return { id, content: memory.content, sourceQuote: memory.sourceQuote, conversationId: memory.sourceConversationId, evidence: (state.evidence ?? []).filter(item => item.memoryId === id), confidence: null };
    },
    async export() {
      return JSON.stringify({ format: "cyrene.vector-memory.v1", exportedAt: Date.now(), ...await deps.load() }, null, 2);
    },
    change(command: MemoryEditCommand): Promise<{ ok: true; warning?: string }> {
      const operation = queue.then(async () => {
        if (!command || typeof command.id !== "string" || typeof command.expectedContent !== "string") throw new Error("记忆命令无效");
        if (!["edit", "archive", "delete"].includes(command.action)) throw new Error("未知记忆操作");
        if (command.action === "edit" && (typeof command.content !== "string" || !command.content.trim() || command.content.length > 8000)) throw new Error("记忆内容须为 1–8000 字");
        const current = await deps.load();
        const memory = current.l2.find(item => item.id === command.id);
        if (!memory || memory.content !== command.expectedContent) throw new Error("记忆已变更，请刷新后重试");
        const affected = cascadeMemoryIds(current.l2, command.id);
        const vectors = current.l2.filter(item => affected.has(item.id)).flatMap(item => item.ragId ? [item.ragId] : []);
        // Hide affected derivatives before touching external indexes, so failure is fail-closed.
        const next = structuredClone(current);
        if (command.action === "delete") {
          next.l2 = next.l2.filter(item => !affected.has(item.id));
          next.evidence = next.evidence?.filter(item => !affected.has(item.memoryId));
          next.conflictLogs = next.conflictLogs?.filter(item => !affected.has(item.sourceL2Id) && !affected.has(item.targetL2Id));
          next.l2DmaeStates = next.l2DmaeStates?.filter(item => !affected.has(item.l2Id));
        } else {
          for (const item of next.l2) if (affected.has(item.id)) item.status = "archived";
          for (const item of next.l2DmaeStates ?? []) {
            if (affected.has(item.l2Id) && (command.action === "archive" || item.l2Id !== command.id)) {
              item.state = "archived"; item.activation = 0;
            }
          }
          if (command.action === "edit") {
            const target = next.l2.find(item => item.id === command.id)!;
            target.content = command.content.trim();
            target.syncStatus = "pending_sync";
            target.keywords = extractMemoryKeywords(command.content);
            target.status = memory.status;
          }
        }
        await deps.save(next);
        let warning: string | undefined;
        try { if (vectors.length) await deps.deleteVectors(vectors); }
        catch { warning = "记忆已停止召回；向量清理暂未完成，将由索引一致性检查处理。"; }
        if (command.action === "edit") {
          try { await deps.sync(command.id, command.content.trim()); }
          catch { warning = "正文已保存；向量重建失败，重建完成前该记忆不会参与检索。"; }
        }
        return { ok: true as const, ...(warning ? { warning } : {}) };
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
