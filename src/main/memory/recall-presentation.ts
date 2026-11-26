import { tokenizeRecallText, type RecallQueryPlan } from "./recall-query-plan";

const GIST_LIMIT = 160;

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function sentenceKey(text: string): string {
  return normalize(text).replace(/[。！？.!?]+$/u, "");
}

/** Accept a complete sentence from the current detail, so a stale or invented gist cannot surface. */
export function validMemoryGist(value: unknown, detail: string): string | undefined {
  if (typeof value !== "string") return;
  const gist = value.trim();
  if (!gist || Array.from(gist).length > GIST_LIMIT) return;
  const sentences = [detail, ...detail.split(/(?<=[。！？.!?])\s*/u)];
  if (sentences.some(sentence => sentenceKey(sentence) === sentenceKey(gist))) return gist;
}

function truncate(text: string, limit: number): string {
  const chars = Array.from(text.trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : chars.join("");
}

export function presentRecallDetail(text: string, score: number, options?: { gist?: string; maxDetail?: number; preferGist?: boolean }): string {
  if (score >= 2 && !options?.preferGist) return truncate(text, options?.maxDetail ?? 400);
  const gist = validMemoryGist(options?.gist, text);
  return `（简短线索）${gist ?? truncate(text, GIST_LIMIT)}`;
}

interface RecallMatch { score: number; topics: number[] }

function exactRecallPhrase(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${/^[a-z0-9]/u.test(phrase) ? "(?<![a-z0-9])" : ""}${escaped}${/[a-z0-9]$/u.test(phrase) ? "(?![a-z0-9])" : ""}`, "u");
}

export function createRecallScorer(plan: RecallQueryPlan): (text: string) => RecallMatch {
  if (plan.kind === "recent" || plan.ambiguousTime) return () => ({ score: 0, topics: [] });
  const clauses = plan.clauses.map(clause => ({ phrase: clause.toLowerCase(), terms: tokenizeRecallText(clause, "query") }))
    .filter(({ phrase, terms }) => terms.length || /[\p{L}\p{N}]/u.test(phrase))
    .map(({ phrase, terms }) => ({ phrase: exactRecallPhrase(phrase), terms }));
  if (!clauses.length) return () => ({ score: plan.from === undefined ? 0 : 2, topics: [] });
  return text => {
    const normalized = normalize(text);
    const indexed = new Set(tokenizeRecallText(normalized, "document"));
    const scores = clauses.map(({ phrase, terms }) => {
      if (phrase.test(normalized)) return 4;
      const matches = terms.filter(term => indexed.has(term)).length;
      if (matches >= 2 && (matches / Math.min(terms.length, 8)) >= 0.5) return 2 + matches / terms.length;
      return matches ? Math.min(1, matches / terms.length) : 0;
    });
    return { score: Math.max(0, ...scores), topics: scores.flatMap((score, index) => score >= 2 ? [index] : []) };
  };
}

export function createRecallMatcher(plan: RecallQueryPlan): (text: string) => number {
  const match = createRecallScorer(plan);
  return text => match(text).score;
}

/** Reserve one strong result per matched topic, then fill in ranked order. */
export function selectRecallByTopic<T extends RecallMatch>(ranked: readonly T[], limit: number): T[] {
  const selected = new Set<T>();
  const topics = new Set<number>();
  for (const item of ranked) {
    if (item.topics.every(topic => topics.has(topic))) continue;
    selected.add(item);
    item.topics.forEach(topic => topics.add(topic));
    if (selected.size === limit) return [...selected];
  }
  for (const item of ranked) {
    selected.add(item);
    if (selected.size === limit) break;
  }
  return [...selected];
}

/** Round-robin independent dates under the original per-store budget. */
export function mergeScopedRecall(plans: readonly RecallQueryPlan[], groups: readonly (readonly string[])[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const depth = Math.max(0, ...groups.map(items => items.length));
  for (let index = 0; index < depth; index += 1) {
    for (const [scope, items] of groups.entries()) {
      const item = items[index];
      if (!item) continue;
      const plan = plans[scope];
      const basis = plan.timeBasis === "event" ? "事件日" : "会话日";
      const key = `${basis}:${plan.dateLabel}:${sentenceKey(item.replaceAll("（简短线索）", ""))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(`【${basis} ${plan.dateLabel}】${item}`);
      if (result.length === limit) return result;
    }
  }
  return result;
}

export function matchesRecallConversationDate(plan: RecallQueryPlan, at: number | undefined): boolean {
  return typeof at === "number" && plan.from !== undefined && plan.to !== undefined && at >= plan.from && at < plan.to;
}

export function recallAlreadyVisible(plan: RecallQueryPlan, ...evidence: Array<string | undefined>): boolean {
  const current = (plan.recentVisible ?? []).map(sentenceKey);
  return evidence.some(text => {
    if (!text) return false;
    const key = sentenceKey(text);
    return key.length >= 8 && current.some(present => present.includes(key));
  });
}
