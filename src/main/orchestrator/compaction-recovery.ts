import type { ConversationTranscriptStore } from "./conversation-transcript-store";
import type { TranscriptEntry, TranscriptCompactionRecoveryState } from "./conversation-transcript-types";
import { buildFullModelContext, latestValidCompaction, type CompactionRecoveryFallback, type TranscriptRunReader } from "./conversation-transcript-projection";

// Old checkpoints did not save execution state. Read their archived prefix once,
// cache only the small recovery state, and never put old history back in the prompt.
const caches = new WeakMap<ConversationTranscriptStore, Map<string, Promise<TranscriptCompactionRecoveryState>>>();

export async function recoverLegacyCompactionState(
  store: ConversationTranscriptStore, conversationId: string, entries: TranscriptEntry[], runReader: TranscriptRunReader,
): Promise<CompactionRecoveryFallback | undefined> {
  const checkpoint = latestValidCompaction(entries);
  if (!checkpoint || checkpoint.payload.recoveryState) return undefined;
  let cache = caches.get(store);
  if (!cache) { cache = new Map(); caches.set(store, cache); }
  const key = `${conversationId}\0${checkpoint.id}\0${checkpoint.payload.sourceDigest}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const audit = await store.readAuditEntries(conversationId);
      // Operational rows can follow their assistant while remaining outside the
      // text-summary boundary. Recover state as of the checkpoint, not the last message.
      const prefix = audit.filter(entry => entry.seq < checkpoint.seq);
      const recovered = buildFullModelContext(prefix, runReader);
      return { ...(recovered.todoItems !== undefined ? { todoItems: recovered.todoItems } : {}), uncertainEffects: recovered.uncertainEffects };
    })();
    cache.set(key, pending);
    while (cache.size > 64) cache.delete(cache.keys().next().value!);
    void pending.catch(() => { if (cache!.get(key) === pending) cache!.delete(key); });
  }
  return { checkpointId: checkpoint.id, state: structuredClone(await pending) };
}
