import { app } from "electron";
import type { MemorySourceLocator } from "../../shared/memory-governance";
import { getConversationDatabase } from "../storage/conversation-database-client";
import { candidateSources, isForgottenFact, isForgottenSocialFact, memorySourceKey } from "./memory-source-policy";
import type { L2Memory, MemoryStore } from "./memory-types";
import type { SocialAtom } from "../social-context/types";
import { memoryStore } from "./memory-store";

export function activeMemoryUserEntry(conversationId: string, userTurnId: string): Promise<string | undefined> {
  return getConversationDatabase(app.getPath("userData")).call<string | undefined>("memory.activeUserEntry", conversationId, userTurnId);
}

export function activeMemorySourceEntry(conversationId: string, source: { userTurnId: string; assistantEntryId: string }): Promise<string | undefined> {
  return getConversationDatabase(app.getPath("userData"))
    .call<string | undefined>("memory.activeSourcePair", conversationId, source.userTurnId, source.assistantEntryId);
}

export async function activeOwnerSourceKeys(sources: MemorySourceLocator[]): Promise<Set<string>> {
  return activeMemorySourceKeys(sources, true);
}

async function activeMemorySourceKeys(sources: MemorySourceLocator[], ownerOnly: boolean): Promise<Set<string>> {
  if (sources.length === 0) return new Set();
  const uniqueSources = [...new Map(sources.map(source => [memorySourceKey(source), source])).values()];
  const active = await getConversationDatabase(app.getPath("userData"))
    .call<MemorySourceLocator[]>("memory.activeSources", uniqueSources, ownerOnly);
  return new Set(active.map(memorySourceKey));
}

export async function filterActiveSocialAtoms(atoms: SocialAtom[]): Promise<SocialAtom[]> {
  const scoped = atoms.flatMap(atom => atom.sourceEntryId
    ? [{ atom, source: { conversationId: atom.conversationId, messageId: atom.sourceEntryId } }] : []);
  if (scoped.length === 0) return [];
  const active = await activeMemorySourceKeys(scoped.map(({ source }) => source), false);
  const state = await memoryStore.load();
  return scoped.filter(({ source, atom }) => active.has(memorySourceKey(source))
    && !isForgottenSocialFact(state, source, atom.content)).map(({ atom }) => atom);
}

export async function selectOwnerL2Memories(state: MemoryStore, ids?: ReadonlySet<string>): Promise<L2Memory[]> {
  const candidates = state.l2.filter(memory => (!ids || ids.has(memory.id)) && (memory.status === "active" || memory.status === "aging"));
  const active = await activeOwnerSourceKeys(candidates.flatMap(candidateSources));
  return candidates.filter(memory => {
    const sources = candidateSources(memory);
    return sources.length > 0 && sources.every(source => active.has(memorySourceKey(source))
      && !isForgottenFact(state, source, memory.content));
  });
}

export async function selectOwnerProfileFields(state: MemoryStore): Promise<Set<string>> {
  const profiles = Object.entries(state.profileSources ?? {});
  const active = await activeOwnerSourceKeys(profiles.flatMap(([, record]) => record.sources));
  return new Set(profiles.flatMap(([key, record]) => {
    const [layer, field] = key.split(".");
    const profile = layer === "L0" ? state.l0 : layer === "L1" ? state.l1 : undefined;
    return profile && Reflect.get(profile, field) === record.content && (record.ownerManaged === true || (
      record.sources.length > 0 && record.sources.every(source => active.has(memorySourceKey(source))
        && !isForgottenFact(state, source, record.content))
    )) ? [key] : [];
  }));
}
