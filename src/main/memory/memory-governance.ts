import { extractMemoryKeywords } from "./memory-store-defaults";
import { createHash } from "node:crypto";
import type { MemoryDeletionPreview, MemoryEditCommand, MemoryExplanation, MemorySourceLocator } from "../../shared/memory-governance";
import type { MemoryStore, L2Memory } from "./memory-types";
import { candidateSources, memorySourceKey, wikiClaimKey } from "./memory-source-policy";

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
  relatedWiki?(sources: MemorySourceLocator[]): Promise<{ available: boolean; claims: MemoryDeletionPreview["wikiClaims"] }>;
  deleteWiki?(claim: { pageId: string; claimId: string }): Promise<void>;
}

/** Existing memory store remains authoritative; no second memory database. */
export function createMemoryGovernance(deps: MemoryGovernanceDependencies) {
  let queue: Promise<unknown> = Promise.resolve();
  async function deletionPreview(state: MemoryStore, memory: L2Memory): Promise<MemoryDeletionPreview> {
    const provenanceIds = new Set([memory.id]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of state.l2) if (provenanceIds.has(item.id)) for (const id of item.subEntryIds ?? []) {
        if (!provenanceIds.has(id)) { provenanceIds.add(id); expanded = true; }
      }
    }
    const sources = state.l2.filter(item => provenanceIds.has(item.id)).flatMap(candidateSources);
    for (const evidence of state.evidence ?? []) {
      if (!provenanceIds.has(evidence.memoryId) || !evidence.conversationId) continue;
      sources.push(...(evidence.messageIds ?? []).map(messageId => ({ conversationId: evidence.conversationId!, messageId })));
    }
    const unique = [...new Map(sources.map(source => [memorySourceKey(source), source])).values()].sort((a, b) => memorySourceKey(a).localeCompare(memorySourceKey(b)));
    const keys = new Set(unique.map(memorySourceKey));
    const affected = cascadeMemoryIds(state.l2, memory.id);
    const profiles = Object.entries(state.profileSources ?? {}).flatMap(([key, value]) => {
      const [layer, field] = key.split(".");
      const record = layer === "L0" ? state.l0 : layer === "L1" ? state.l1 : null;
      if (!record || !Object.hasOwn(record, field) || Reflect.get(record, field) !== value.content || !value.sources.some(source => keys.has(memorySourceKey(source)))) return [];
      return [{ key, content: value.content }];
    }).sort((a, b) => a.key.localeCompare(b.key));
    const wiki = deps.relatedWiki ? await deps.relatedWiki(unique) : { available: false, claims: [] };
    const result: MemoryDeletionPreview = {
      revision: "", memories: state.l2.filter(item => affected.has(item.id)).map(item => ({ id: item.id, content: item.content, summary: item.isSummary === true || Boolean(item.subEntryIds?.length) })).sort((a, b) => a.id.localeCompare(b.id)),
      profiles, wikiClaims: wiki.claims.sort((a, b) => wikiClaimKey(a.pageId, a.claimId).localeCompare(wikiClaimKey(b.pageId, b.claimId))), sources: unique,
      wikiAvailable: wiki.available, notes: ["只关联保存了相同消息编号的记录；未保存来源的历史/回顾画像不会自动关联。", "原聊天、附件、外部导出和手工备份保留；保留的聊天仍可能出现在当前对话上下文中。", ...(unique.length ? [] : ["这条旧记忆未保存精确消息定位，无法关联 Wiki/画像或保证阻止从原聊天重新提取。"]), ...(!wiki.available ? ["Wiki 当前不可用，未检查其关联记录。"] : [])],
    };
    result.revision = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    return result;
  }
  return {
    async explain(id: string): Promise<MemoryExplanation> {
      if (typeof id !== "string") throw new Error("记忆编号无效");
      const state = await deps.load();
      const memory = state.l2.find(item => item.id === id);
      if (!memory) throw new Error("记忆已不存在");
      return { id, content: memory.content, sourceQuote: memory.sourceQuote, conversationId: memory.sourceConversationId, evidence: (state.evidence ?? []).filter(item => item.memoryId === id), confidence: null, related: await deletionPreview(state, memory) };
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
        const preview = command.action === "delete" ? await deletionPreview(current, memory) : undefined;
        const selection = command.action === "delete" ? command.selection : undefined;
        if (selection) {
          if (!preview || selection.revision !== preview.revision) throw new Error("关联记忆已变更，请重新打开来源与管理后确认");
          if (!Array.isArray(selection.memoryIds) || !Array.isArray(selection.profileKeys) || !Array.isArray(selection.wikiClaims) || typeof selection.preventReplay !== "boolean" ||
              selection.memoryIds.some(id => !affected.has(id)) || [...affected].some(id => !selection.memoryIds.includes(id)) ||
              selection.profileKeys.some(key => !preview.profiles.some(item => item.key === key)) ||
              selection.wikiClaims.some(claim => !preview.wikiClaims.some(item => item.pageId === claim.pageId && item.claimId === claim.claimId))) throw new Error("删除范围无效；关联摘要必须随原记忆一起删除");
        }
        const vectors = current.l2.filter(item => affected.has(item.id)).flatMap(item => item.ragId ? [item.ragId] : []);
        // Hide affected derivatives before touching external indexes, so failure is fail-closed.
        const next = structuredClone(current);
        if (command.action === "delete") {
          const forgotten = next.forgetting ??= { memoryIds: [], sourceKeys: [], wikiClaimKeys: [], profileRecords: [] };
          forgotten.memoryIds = [...new Set([...forgotten.memoryIds, ...affected])];
          if (selection?.preventReplay !== false) forgotten.sourceKeys = [...new Set([...forgotten.sourceKeys, ...preview!.sources.map(memorySourceKey)])];
          forgotten.wikiClaimKeys = [...new Set([...forgotten.wikiClaimKeys, ...(selection?.wikiClaims ?? []).map(claim => wikiClaimKey(claim.pageId, claim.claimId))])];
          for (const key of selection?.profileKeys ?? []) {
            const source = next.profileSources?.[key];
            if (source) (forgotten.profileRecords ??= []).push({ key, sourceKeys: source.sources.map(memorySourceKey) });
            const [layer, field] = key.split(".");
            Object.assign(layer === "L0" ? next.l0 : next.l1, { [field]: "" });
            delete next.profileSources?.[key];
          }
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
        const warnings: string[] = [];
        try { if (vectors.length) await deps.deleteVectors(vectors); }
        catch { warnings.push("L2/摘要已停止召回；向量清理暂未完成，将由索引一致性检查处理。"); }
        for (const claim of selection?.wikiClaims ?? []) {
          try { if (!deps.deleteWiki) throw new Error("Wiki unavailable"); await deps.deleteWiki(claim); }
          catch { warnings.push(`Wiki ${claim.pageId} / ${claim.claimId} 已禁止召回，但磁盘清理未完成；重启后会按持久标记重试。`); }
        }
        if (command.action === "edit") {
          try { await deps.sync(command.id, command.content.trim()); }
          catch { warnings.push("正文已保存；向量重建失败，重建完成前该记忆不会参与检索。"); }
        }
        const warning = warnings.join(" ");
        return { ok: true as const, ...(warning ? { warning } : {}) };
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
