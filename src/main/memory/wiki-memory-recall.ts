import { isForgottenFact, isInvalidDerivedMemorySource, wikiClaimKey } from "./memory-source-policy";
import { memoryStore } from "./memory-store";
import { readWikiMemorySourceConversation } from "./wiki-memory-scheduler";
import type { WikiChatSource, WikiClaim } from "./wiki-types";

/** Each model lookup verifies source revisions against the live transcript, even after a mode switch. */
export function createWikiRecallFilter() {
  const conversations = new Map<string, ReturnType<typeof readWikiMemorySourceConversation>>();
  async function sourceIsActive(source: WikiChatSource, values: string[], state: Awaited<ReturnType<typeof memoryStore.load>>): Promise<boolean> {
    let pending = conversations.get(source.conversationId);
    if (!pending) {
      pending = readWikiMemorySourceConversation(source.conversationId).catch(() => null);
      conversations.set(source.conversationId, pending);
    }
    const conversation = await pending;
    const turn = conversation?.turns.find(({ user, assistants }) => user.sourceId === source.sourceId ||
      assistants.some(assistant => assistant.sourceId === source.sourceId));
    if (!turn) return false;
    return [source.messageId, turn.user.entryId].every(messageId => {
      const location = { conversationId: source.conversationId, messageId };
      return !isInvalidDerivedMemorySource(state, location) && !values.some(value => isForgottenFact(state, location, value));
    });
  }

  return async (pageId: string, claims: readonly WikiClaim[]): Promise<WikiClaim[]> => {
    const state = await memoryStore.load();
    const forgottenClaims = new Set(state.forgetting?.wikiClaimKeys);
    const filtered = await Promise.all(claims.map(async claim => {
      if (claim.status === "revoked" || forgottenClaims.has(wikiClaimKey(pageId, claim.id))) return undefined;
      const values = [claim.value, `${claim.predicate}：${claim.value}`];
      const sources = (await Promise.all(claim.sources.map(async source =>
        source.kind === "manual" || (source.kind === "chat" && await sourceIsActive(source, values, state)) ? source : undefined,
      ))).filter(source => source !== undefined);
      return sources.length ? { ...claim, sources } : undefined;
    }));
    return filtered.filter(claim => claim !== undefined);
  };
}
