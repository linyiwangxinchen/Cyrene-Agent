import { app } from "electron";
import { getChannelConversationBindingStore } from "../channels/conversation-binding-store";
import { getMemoryModeVersion, isPersonalMemoryEnabled } from "../memory/memory-mode";
import { memoryStore } from "../memory/memory-store";
import { getConversationDatabase } from "../storage/conversation-database-client";
import type { HistoryLookupPolicy, HistoryReadInput, HistoryReadPage, HistorySearchInput, HistorySearchPage } from "../storage/conversation-history-repository";
import { historyWithdrawal, type HistorySourcePointer } from "./history-projection";

function externalIds(): string[] {
  const { externalChats, bindings } = getChannelConversationBindingStore().list();
  return [...new Set([...externalChats.map(chat => chat.sessionId), ...bindings.map(binding => binding.conversationId)])].sort();
}

async function snapshot(destinationId?: string): Promise<HistoryLookupPolicy> {
  const withdrawal = historyWithdrawal(await memoryStore.load());
  return { blockedIds: externalIds(), withdrawal, destinationId };
}

/** SQLite owns the authoritative branch. External bindings and withdrawal are independently mutable. */
async function lookup<T>(destinationId: string | undefined, operation: (policy: HistoryLookupPolicy) => Promise<T>): Promise<T | undefined> {
  const version = getMemoryModeVersion();
  for (let attempt = 0; attempt < 2 && isPersonalMemoryEnabled() && getMemoryModeVersion() === version; attempt++) {
    const policy = await snapshot(destinationId);
    if (getMemoryModeVersion() !== version || !isPersonalMemoryEnabled()) return;
    const result = await operation(policy);
    if (getMemoryModeVersion() !== version || !isPersonalMemoryEnabled()) return;
    if (JSON.stringify(policy) === JSON.stringify(await snapshot(destinationId)) && getMemoryModeVersion() === version) return result;
  }
}

export function searchAutomaticConversationHistory(destinationId: string, input: Omit<HistorySearchInput, keyof HistoryLookupPolicy>) {
  return lookup(destinationId, policy => getConversationDatabase(app.getPath("userData"))
    .call<HistorySearchPage>("history.search", { ...input, ...policy }));
}

export function loadAutomaticConversationHistory(destinationId: string, input: Omit<HistoryReadInput, keyof HistoryLookupPolicy>) {
  if (input.conversationId === destinationId) return;
  return lookup(destinationId, policy => getConversationDatabase(app.getPath("userData"))
    .call<HistoryReadPage | undefined>("history.read", { ...input, ...policy }));
}

export async function filterCurrentHistorySourcePointers(pointers: readonly HistorySourcePointer[], destinationId?: string) {
  if (!pointers.length) return [];
  return await lookup(destinationId, policy => getConversationDatabase(app.getPath("userData"))
    .call<HistorySourcePointer[]>("history.sources", pointers, policy)) ?? [];
}
