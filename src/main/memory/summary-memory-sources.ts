import { getConversationDatabase } from "../storage/conversation-database-client";
import { isForgottenSource } from "./memory-source-policy";
import { memoryStore } from "./memory-store";

export interface SummaryMemoryTurnSource {
  conversationId: string;
  userTurnId: string;
  assistantEntryId: string;
  userEntryId: string;
}

export type SummaryMemoryTurnLookup = Omit<SummaryMemoryTurnSource, "userEntryId"> & { userEntryId?: string };

export async function resolveSummaryMemorySources(
  root: string, lookups: readonly SummaryMemoryTurnLookup[],
): Promise<Array<SummaryMemoryTurnSource | undefined>> {
  if (!lookups.length) return [];
  const userEntries = await getConversationDatabase(root).call<Array<string | undefined>>("memory.summarySources", lookups);
  const state = await memoryStore.load();
  return lookups.map((source, index) => {
    const userEntryId = userEntries[index];
    return userEntryId && (!source.userEntryId || source.userEntryId === userEntryId)
      && !isForgottenSource(state, { conversationId: source.conversationId, messageId: userEntryId })
      ? { ...source, userEntryId } : undefined;
  });
}

export async function areSummaryMemorySourcesCurrent(root: string, sources: readonly SummaryMemoryTurnSource[]): Promise<boolean> {
  return (await resolveSummaryMemorySources(root, sources)).every(Boolean);
}
