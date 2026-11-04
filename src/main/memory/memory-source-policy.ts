import type { MemorySourceLocator } from "../../shared/memory-governance";
import type { MemoryCandidate, MemoryStore } from "./memory-types";
import type { PendingMemoryTurn } from "./memory-pending-types";

export function memorySourceKey(source: MemorySourceLocator): string {
  return JSON.stringify([source.conversationId, source.messageId]);
}
export function wikiClaimKey(pageId: string, claimId: string): string { return JSON.stringify([pageId, claimId]); }
export function candidateSources(candidate: Pick<MemoryCandidate, "sourceConversationId" | "sourceMessageIds">): MemorySourceLocator[] {
  return candidate.sourceConversationId ? [...new Set(Array.isArray(candidate.sourceMessageIds) ? candidate.sourceMessageIds : [])].filter(id => typeof id === "string" && Boolean(id) && id.length <= 512).map(messageId => ({ conversationId: candidate.sourceConversationId!, messageId })) : [];
}
export function isForgottenSource(store: MemoryStore, source: MemorySourceLocator): boolean {
  return store.forgetting?.sourceKeys.includes(memorySourceKey(source)) === true;
}

/** Match only the current batch's user text; repeated quotes are deliberately unlinked. */
export function attachCandidateSources(candidate: MemoryCandidate, conversationId: string, turns: PendingMemoryTurn[]): MemoryCandidate {
  const quotes = [...new Set([candidate.sourceQuote, ...(candidate.evidenceQuotes ?? []), candidate.triggerText].filter((value): value is string => typeof value === "string" && value.trim().length >= 2).map(value => value.trim()))];
  const ids = new Set<string>();
  for (const quote of quotes) {
    const matches = turns.filter(turn => turn.conversationId === conversationId && turn.userInput.includes(quote));
    if (matches.length > 1) return { ...candidate, sourceConversationId: conversationId, sourceMessageIds: [] };
    if (matches.length === 1) ids.add(matches[0].userEntryId);
  }
  return { ...candidate, sourceConversationId: conversationId, sourceMessageIds: [...ids] };
}
