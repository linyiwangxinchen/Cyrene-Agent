import type { MemorySourceLocator } from "../../shared/memory-governance";
import type { MemoryCandidate, MemoryStore } from "./memory-types";
import type { PendingMemoryTurn } from "./memory-pending-types";
import { createHash } from "node:crypto";
import { validateRecallEventDate } from "./recall-query-plan";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { CHAT_HISTORY_TOOL_IDS } from "./memory-scope";

/** Cross-chat quotations retain their provenance in history, so they cannot seed independent memories. */
export function historyDependentMemoryEntries(entries: readonly TranscriptEntry[]): Set<string> {
  const runs = new Set(entries.flatMap(entry => entry.runId && (
    (entry.kind === "tool_started" && CHAT_HISTORY_TOOL_IDS.has(entry.payload.toolName))
    || (entry.kind === "assistant" && entry.payload.toolCalls?.some(call => CHAT_HISTORY_TOOL_IDS.has(call.name)))
  ) ? [entry.runId] : []));
  return new Set(entries.flatMap(entry => entry.kind === "assistant" && (
    entry.historySourcesIncomplete || entry.historySources?.length || (entry.runId && runs.has(entry.runId))
  ) ? [entry.id] : []));
}

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

export function isInvalidDerivedMemorySource(store: MemoryStore, source: MemorySourceLocator): boolean {
  return isForgottenSource(store, source) || store.forgetting?.derivedSourceKeys?.includes(memorySourceKey(source)) === true;
}

/** Independent facts in the same message deliberately have distinct keys. */
export function memoryFactKey(source: MemorySourceLocator, content: string): string {
  const normalized = content.normalize("NFKC").trim()
    .replace(/^(?:对方|用户|我(?!们))\s*[：:]?\s*/u, "")
    .replace(/[。.!！?？]+$/u, "");
  return createHash("sha256").update(JSON.stringify([source.conversationId, source.messageId, normalized])).digest("hex");
}

export function isForgottenFact(store: MemoryStore, source: MemorySourceLocator, content: string): boolean {
  const keys = store.forgetting?.factKeys;
  return Boolean(keys?.length && keys.includes(memoryFactKey(source, content)));
}

export function isForgottenSocialFact(store: MemoryStore, source: MemorySourceLocator, content: string): boolean {
  const keys = store.forgetting?.socialFactKeys;
  return isForgottenFact(store, source, content) || Boolean(keys?.length && keys.includes(memoryFactKey(source, content)));
}

/** Match only the current batch's user text; repeated quotes are deliberately unlinked. */
export function attachCandidateSources(candidate: MemoryCandidate, conversationId: string, turns: PendingMemoryTurn[]): MemoryCandidate {
  const quotes = [...new Set([candidate.sourceQuote, ...(candidate.evidenceQuotes ?? []), candidate.triggerText].filter((value): value is string => typeof value === "string" && value.trim().length >= 2).map(value => value.trim()))];
  const ids = new Set<string>();
  let eventDate: string | undefined;
  for (const quote of quotes) {
    const matches = turns.filter(turn => turn.conversationId === conversationId && turn.userInput.includes(quote));
    if (matches.length > 1) return { ...candidate, ...(candidate.eventDate !== undefined ? { eventDate: undefined } : {}), sourceConversationId: conversationId, sourceMessageIds: [] };
    if (matches.length === 1) {
      ids.add(matches[0].userEntryId);
      eventDate ??= validateRecallEventDate(candidate.eventDate, quote);
    }
  }
  return { ...candidate, ...(candidate.eventDate !== undefined ? { eventDate } : {}), sourceConversationId: conversationId, sourceMessageIds: [...ids] };
}
