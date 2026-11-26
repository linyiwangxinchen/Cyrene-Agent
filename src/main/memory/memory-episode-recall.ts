import { searchMemoryEntries } from "../rag";
import { getMemoryModeVersion, isPersonalMemoryEnabled } from "./memory-mode";
import { activeMemorySourceFacts, selectOwnerL2Memories } from "./memory-owner-recall";
import { createRecallScorer, matchesRecallConversationDate, mergeScopedRecall, presentRecallDetail, recallAlreadyVisible, selectRecallByTopic } from "./recall-presentation";
import { recallEventDateMatches, validateRecallEventDate, verifiedRecallEventDates, type RecallQueryPlan } from "./recall-query-plan";
import { candidateSources, memorySourceKey } from "./memory-source-policy";
import { memoryStore } from "./memory-store";
import type { L2Memory } from "./memory-types";

const MAX_CANDIDATES = 40;

function candidateHasEventDate(memory: L2Memory, plan: RecallQueryPlan, timeZone?: string): boolean {
  return [memory.eventDate, ...verifiedRecallEventDates(memory.content, memory.sourceQuote ?? memory.triggerText)]
    .some(date => recallEventDateMatches(plan, date, timeZone));
}

function memoryDateMatches(memory: L2Memory, plan: RecallQueryPlan, facts: Array<{ at: number; text: string } | undefined>, timeZone?: string): boolean {
  if (plan.timeBasis === "conversation") return facts.some(fact => matchesRecallConversationDate(plan, fact?.at));
  return facts.some(fact => fact && [validateRecallEventDate(memory.eventDate, fact.text), ...verifiedRecallEventDates(memory.content, fact.text)]
    .some(date => recallEventDateMatches(plan, date, timeZone)));
}

/** Vector-body recall and its local fallback share the same selection and source checks. */
export async function readMemoryEpisodes(input: { query: string; plan: RecallQueryPlan; timeZone?: string; semantic?: boolean }): Promise<string[]> {
  if (!isPersonalMemoryEnabled() || input.plan.kind === "recent") return [];
  const version = getMemoryModeVersion();
  if (input.plan.scoped) {
    const grouped = await Promise.all(input.plan.scoped.map(plan => readMemoryEpisodes({ ...input, plan, semantic: false })));
    return getMemoryModeVersion() === version ? mergeScopedRecall(input.plan.scoped, grouped, 4) : [];
  }
  if (input.plan.ambiguousTime) return [];
  const state = await memoryStore.load();
  const match = createRecallScorer(input.plan);
  const candidates = state.l2.filter(item => (item.status === "active" || item.status === "aging")
    && !recallAlreadyVisible(input.plan, item.content, item.sourceQuote, item.triggerText)
    && (input.plan.timeBasis !== "event" || candidateHasEventDate(item, input.plan, input.timeZone)));
  const ranked = candidates.map(item => ({ item, ...match(`${item.slug ?? ""}\n${item.content}`) }));
  if (!ranked.length || getMemoryModeVersion() !== version) return [];
  const local = ranked.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  const localIds = selectRecallByTopic(local, MAX_CANDIDATES).map(({ item }) => item.id);
  // The local clauses give each topic a search surface. Keep the existing one
  // embedding request rather than multiplying network or model calls.
  const semantic = input.semantic && input.plan.from === undefined
    ? await searchMemoryEntries(input.query, "user_memory", 4, {
      allowedL2Ids: new Set(candidates.map(memory => memory.id)), recordRecall: false,
    }).catch(() => []) : [];
  const semanticIds = semantic.flatMap(({ metadata, score }) => typeof metadata?.l2Id === "string" && score >= 0.28 ? [metadata.l2Id] : []);
  const ids = [...new Set([...localIds, ...semanticIds])];
  if (!ids.length || getMemoryModeVersion() !== version) return [];
  const byId = new Map(ranked.map(row => [row.item.id, row]));
  const current = new Map((await selectOwnerL2Memories(await memoryStore.load(), new Set(ids))).map(memory => [memory.id, memory]));
  const facts = new Map<string, { at: number; text: string } | undefined>();
  if (input.plan.from !== undefined) {
    const sources = [...new Map([...current.values()].flatMap(candidateSources).map(source => [memorySourceKey(source), source])).values()];
    (await activeMemorySourceFacts(sources)).forEach((fact, index) => facts.set(memorySourceKey(sources[index]), fact));
  }
  const checked = ids.flatMap(id => {
    const memory = current.get(id);
    const previous = byId.get(id);
    if (!memory || memory.content !== previous?.item.content || (input.plan.from !== undefined
      && !memoryDateMatches(memory, input.plan, candidateSources(memory).map(source => facts.get(memorySourceKey(source))), input.timeZone))) return [];
    const text = presentRecallDetail(memory.content, previous.score, {
      gist: memory.gist, preferGist: !memory.isPinned && memory.status === "aging" && previous.score < 4,
    }) + (memory.conflictWith?.length ? "（存在矛盾记录）" : "");
    return [{ ...previous, text }];
  });
  return getMemoryModeVersion() === version ? selectRecallByTopic(checked, 4).map(item => item.text) : [];
}
