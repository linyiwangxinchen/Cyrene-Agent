import { createHash } from "node:crypto";
import { createHistoryVisibility, HISTORY_ENTRY_KINDS, historyMessages, historyMessageVersion, historySourcePointer, projectAutomaticHistory } from "../chats/history-projection";
import type { AutomaticHistory, HistoryMessage, HistorySourcePointer, HistoryWithdrawal } from "../chats/history-projection";
import { tokenizeRecallText, type RecallQueryPlan } from "../memory/recall-query-plan";
import type { ConversationDatabase } from "./conversation-database";

const BATCH_SIZE = 64;
const INDEX_ENTRY_BUDGET = 8_000;
const MAX_CANDIDATES = 128;
const FTS_NAME = "history_index_fts";
const FTS_VOCAB = "history_index_vocab";
const PAGE_CONTENT_BYTES = 9_000;
const MIN_TERM_COVERAGE = 0.65;
const WORD_TOKEN = /[\p{Script=Latin}\p{N}]/u;

export interface HistoryLookupPolicy {
  blockedIds: string[];
  destinationId?: string;
  withdrawal: HistoryWithdrawal;
}

export interface HistorySearchInput extends HistoryLookupPolicy {
  plan: RecallQueryPlan;
  offset: number;
  limit: number;
  horizon?: number;
  skipIds?: string[];
  candidateIds?: string[];
}

export interface HistoryMatch {
  conversationId: string;
  title: string;
  updatedAt: number;
  score: number;
  before?: number;
  matchedAt?: number;
  anchor?: HistoryAnchor;
  sources: HistorySourcePointer[];
}

export interface HistoryAnchor { seq: number; entryId: string; version: string; throughSeq?: number }

export interface HistoryReadInput extends HistoryLookupPolicy {
  conversationId: string;
  limit: number;
  before?: number;
  anchor?: HistoryAnchor;
  older?: boolean;
}

export type HistoryReadPage = { error: "stale" } | {
  conversationId: string;
  title: string;
  updatedAt: number;
  messages: Pick<HistoryMessage, "role" | "text" | "at">[];
  pointers: HistorySourcePointer[];
  titlePointer?: HistorySourcePointer;
  nextAnchor?: HistoryAnchor;
  nextBefore: number | null;
};

export interface HistorySearchPage {
  hits: HistoryMatch[];
  horizon: number;
  nextOffset: number | null;
  legacyNextOffset: number | null;
  coverage: "complete" | "partial" | "degraded";
  scannedIds: string[];
}

type ImportTranscript = (id: string) => Promise<void>;

const SCOPED_CHATS = `c.rowid<=? AND c.deleted=0 AND c.record_json IS NOT NULL
  AND json_extract(c.record_json,'$.mode')='chat' AND json_extract(c.record_json,'$.purpose') IS NULL
  AND (json_extract(c.record_json,'$.messageCount')>0 OR c.max_seq>0 OR json_array_length(c.record_json,'$.messages')>0)
  AND c.id NOT LIKE 'channel:%' AND c.id NOT IN (SELECT value FROM json_each(?))`;
const RECENT_ORDER = `ORDER BY CAST(json_extract(c.record_json,'$.updatedAt') AS INTEGER) DESC, c.id ASC`;

function isLocalChat(database: ConversationDatabase, id: string, blockedIds: ReadonlySet<string>): boolean {
  if (blockedIds.has(id) || id.startsWith("channel:")) return false;
  const record = database.record(id);
  return record?.mode === "chat" && !record.purpose;
}

function projectedHistory(database: ConversationDatabase, id: string): AutomaticHistory | undefined {
  const record = database.record(id);
  if (record?.mode !== "chat" || record.purpose) return;
  const runUsers = new Map<string, string>();
  for (const row of database.db.prepare(`SELECT run_id,dispatch_json,payload_json FROM conversation_requests
    WHERE conversation_id=? AND run_id IS NOT NULL`).all(id)) {
    const facts = JSON.parse((row.dispatch_json ?? row.payload_json) as string);
    const turnId = facts.currentUser?.turnId ?? facts.turnId;
    if (typeof turnId === "string") runUsers.set(row.run_id as string, turnId);
  }
  const runStatuses = new Map(database.db.prepare("SELECT run_id,status FROM runs WHERE conversation_id=?")
    .all(id).map(row => [row.run_id as string, row.status as string]));
  return projectAutomaticHistory(record, database.entries(id, true, HISTORY_ENTRY_KINDS), runUsers, runStatuses);
}

function createLookup(database: ConversationDatabase, policy: HistoryLookupPolicy) {
  const blocked = new Set(policy.blockedIds);
  const projected = new Map<string, AutomaticHistory | undefined>();
  const failed = new Set<string>();
  const load = (id: string) => {
    if (!projected.has(id)) {
      let history: AutomaticHistory | undefined;
      try {
        if (isLocalChat(database, id, blocked)) history = projectedHistory(database, id);
      } catch { failed.add(id); }
      projected.set(id, history);
    }
    return projected.get(id);
  };
  return { load, failed, visibility: createHistoryVisibility(load, policy.withdrawal) };
}

function nextHorizon(database: ConversationDatabase): number {
  return Number(database.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM conversations").get()!.n);
}

function eligibleDestination(database: ConversationDatabase, policy: HistoryLookupPolicy): boolean {
  return !policy.destinationId || isLocalChat(database, policy.destinationId, new Set(policy.blockedIds));
}

function ensureFts(database: ConversationDatabase): void {
  const table = database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  if (table.get(FTS_NAME)) {
    if (!table.get(FTS_VOCAB)) database.db.exec(`CREATE VIRTUAL TABLE ${FTS_VOCAB} USING fts5vocab(${FTS_NAME},'row')`);
    return;
  }
  database.transaction(() => {
    database.db.exec(`CREATE VIRTUAL TABLE ${FTS_NAME} USING fts5(tokens,content='',contentless_delete=1,tokenize='unicode61 remove_diacritics 0');
      INSERT INTO ${FTS_NAME}(${FTS_NAME},rank) VALUES('secure-delete',1);
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_VOCAB} USING fts5vocab(${FTS_NAME},'row');
      DELETE FROM history_index_docs; DELETE FROM history_index_state; DELETE FROM history_index_links; DELETE FROM history_index_external;`);
  });
}

function removeDocs(database: ConversationDatabase, id: string): void {
  database.db.prepare(`DELETE FROM ${FTS_NAME} WHERE rowid IN (SELECT doc_id FROM history_index_docs WHERE conversation_id=?)`).run(id);
  database.db.prepare("DELETE FROM history_index_docs WHERE conversation_id=?").run(id);
}

export function purgeConversationHistoryIndex(database: ConversationDatabase, id: string): void {
  if (!database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(FTS_NAME)) return;
  database.transaction(() => {
    removeDocs(database, id);
    database.db.prepare("DELETE FROM history_index_state WHERE conversation_id=?").run(id);
    database.db.prepare("DELETE FROM history_index_links WHERE dependent_id=?").run(id);
  });
}

/** Source-key changes invalidate only the affected conversation. Legacy fact hashes are checked again on every read. */
function withdrawalsById(withdrawal: HistoryWithdrawal): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const key of withdrawal.sourceKeys) {
    try {
      const [id] = JSON.parse(key) as [unknown];
      if (typeof id !== "string") continue;
      const keys = groups.get(id) ?? [];
      keys.push(key);
      groups.set(id, keys);
    } catch { /* Invalid legacy history keys cannot identify a conversation. */ }
  }
  return new Map([...groups].map(([id, keys]) => [id, createHash("sha256").update(keys.sort().join("\n")).digest("hex")]));
}

function dirtyIndexRows(database: ConversationDatabase, horizon: number, blocked: string, limit: number) {
  return database.db.prepare(`SELECT c.id,c.max_seq,c.transcript_imported FROM conversations c LEFT JOIN history_index_state s ON c.id=s.conversation_id
    WHERE ${SCOPED_CHATS} AND (s.dirty IS NULL OR s.dirty=1) ${RECENT_ORDER} LIMIT ?`)
    .all(horizon, blocked, limit).map(row => ({ id: row.id as string, entries: Number(row.max_seq), imported: row.transcript_imported === 1 }));
}

function rebuildConversation(database: ConversationDatabase, id: string, history: AutomaticHistory | undefined,
  dependencyIds: ReadonlySet<string>, key: string): void {
  database.transaction(() => {
    removeDocs(database, id);
    database.db.prepare("DELETE FROM history_index_links WHERE dependent_id=?").run(id);
    const link = database.db.prepare("INSERT INTO history_index_links(source_id,dependent_id) VALUES(?,?)");
    for (const sourceId of dependencyIds) link.run(sourceId, id);
    const doc = database.db.prepare("INSERT INTO history_index_docs(conversation_id,at,kind) VALUES(?,?,?) RETURNING doc_id");
    const fts = database.db.prepare(`INSERT INTO ${FTS_NAME}(rowid,tokens) VALUES(?,?)`);
    const index = (text: string, at: number | null, kind: string) => {
      const tokens = tokenizeRecallText(text, "document");
      if (!tokens.length) return;
      const row = doc.get(id, at, kind)!;
      fts.run(row.doc_id!, tokens.join(" "));
    };
    if (history?.turns.length) {
      // Title and each message are separate so term overlap does not fabricate a match across unrelated turns.
      if (history.title !== "旧会话") index(history.title, null, "title");
      for (const message of historyMessages(history)) index(message.text, message.at, message.role);
    }
    database.db.prepare(`INSERT INTO history_index_state(conversation_id,dirty,withdrawn_key) VALUES(?,0,?)
      ON CONFLICT(conversation_id) DO UPDATE SET dirty=0,withdrawn_key=excluded.withdrawn_key`).run(id, key);
  });
}

async function refreshIndex(database: ConversationDatabase, importTranscript: ImportTranscript, input: HistorySearchInput, horizon: number) {
  ensureFts(database);
  const isolated = JSON.stringify(input.blockedIds);
  const retired = database.db.prepare(`SELECT s.conversation_id FROM history_index_state s JOIN conversations c ON c.id=s.conversation_id
    WHERE c.deleted=1 OR c.id IN (SELECT value FROM json_each(?)) OR (s.dirty<>0 AND (
      json_extract(c.record_json,'$.mode') IS NOT 'chat' OR json_extract(c.record_json,'$.purpose') IS NOT NULL)) LIMIT ?`)
    .all(isolated, BATCH_SIZE);
  if (retired.length) database.transaction(() => {
    for (const row of retired) purgeConversationHistoryIndex(database, row.conversation_id as string);
  });
  const externalChanges = database.db.prepare(`SELECT conversation_id AS id FROM history_index_external
    WHERE conversation_id NOT IN (SELECT value FROM json_each(?)) UNION
    SELECT value AS id FROM json_each(?) WHERE value NOT IN (SELECT conversation_id FROM history_index_external)`).all(isolated, isolated);
  const mark = database.db.prepare(`WITH RECURSIVE affected(id) AS (
    SELECT ? UNION SELECT l.dependent_id FROM history_index_links l JOIN affected a ON a.id=l.source_id
  ) UPDATE history_index_state SET dirty=1 WHERE conversation_id IN (SELECT id FROM affected)`);
  if (externalChanges.length) database.transaction(() => {
    for (const { id } of externalChanges) mark.run(id!);
    database.db.exec("DELETE FROM history_index_external");
    database.db.prepare("INSERT INTO history_index_external SELECT value FROM json_each(?)").run(isolated);
  });
  const keys = withdrawalsById(input.withdrawal);
  if (keys.size) {
    const changed = database.db.prepare(`SELECT 1 FROM conversations c LEFT JOIN history_index_state s ON c.id=s.conversation_id
      WHERE c.id=? AND c.deleted=0 AND s.withdrawn_key IS NOT ?`);
    const remember = database.db.prepare(`INSERT INTO history_index_state(conversation_id,dirty,withdrawn_key) VALUES(?,1,?)
      ON CONFLICT(conversation_id) DO UPDATE SET dirty=1,withdrawn_key=excluded.withdrawn_key`);
    const isolatedIds = new Set(input.blockedIds);
    database.transaction(() => {
      for (const [id, key] of keys) {
        if (isolatedIds.has(id) || !changed.get(id, key)) continue;
        mark.run(id);
        remember.run(id, key);
      }
    });
  }
  const blocked = JSON.stringify([...input.blockedIds, ...(input.destinationId ? [input.destinationId] : [])]);
  const ids = dirtyIndexRows(database, horizon, blocked, BATCH_SIZE + 1);
  let resumable = ids.length > BATCH_SIZE;
  let uncertain = false;
  const imported: string[] = [];
  const unreadable: string[] = [];
  const markUnreadable = database.db.prepare(`INSERT INTO history_index_state(conversation_id,dirty) VALUES(?,2)
    ON CONFLICT(conversation_id) DO UPDATE SET dirty=2`);
  let remainingEntries = INDEX_ENTRY_BUDGET;
  for (const [index, { id, entries, imported: alreadyImported }] of ids.slice(0, BATCH_SIZE).entries()) {
    // Import size is unknown until legacy files are read. Give one such source
    // a batch of its own. A single large imported source can also use a whole batch.
    if (index > 0 && (!alreadyImported || remainingEntries < entries)) { resumable = true; break; }
    try { await importTranscript(id); imported.push(id); }
    catch { unreadable.push(id); }
    remainingEntries -= entries;
    if (!alreadyImported) { resumable ||= index + 1 < ids.length; break; }
  }
  if (imported.length || unreadable.length) {
    const { load, failed, visibility } = createLookup(database, input);
    database.transaction(() => {
      for (const id of imported) {
        const source = load(id);
        if (failed.has(id)) { unreadable.push(id); continue; }
        const dependencies = new Set(source?.turns.flatMap(turn => turn.dependencies.map(pointer => pointer.conversationId)));
        rebuildConversation(database, id, source && visibility.visible(source), dependencies, keys.get(id) ?? "");
      }
      for (const id of unreadable) markUnreadable.run(id);
    });
    uncertain = failed.size > 0 || visibility.incomplete;
  }
  const unreadableRows = database.db.prepare(`SELECT 1 FROM history_index_state s JOIN conversations c ON c.id=s.conversation_id
    WHERE s.dirty=2 AND ${SCOPED_CHATS} LIMIT 1`).get(horizon, blocked);
  return { resumable, uncertain: uncertain || !!unreadableRows };
}

function literalIncludes(text: string, needle: string): boolean {
  if (!needle) return false;
  const latin = /[\p{Script=Latin}\p{N}]/u;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
    if ((!latin.test(needle[0]) || !latin.test(text[index - 1] ?? ""))
      && (!latin.test(needle.at(-1)!) || !latin.test(text[index + needle.length] ?? ""))) return true;
  }
  return false;
}

function lexicalMatcher(plan: RecallQueryPlan) {
  const terms = plan.terms;
  return (text: string) => {
    const normalized = text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
    if (plan.exactPhrases.some(phrase => literalIncludes(normalized, phrase))) return 4;
    if (!terms.length) return 0;
    const tokens = new Set(tokenizeRecallText(normalized, "document"));
    if (terms.some(term => WORD_TOKEN.test(term) && !tokens.has(term))) return 0;
    const matched = terms.filter(term => tokens.has(term)).length;
    const coverage = matched / terms.length;
    return coverage >= MIN_TERM_COVERAGE ? coverage : 0;
  };
}

function messageAnchor(message: HistoryMessage, throughSeq?: number): HistoryAnchor {
  return { seq: message.seq, entryId: message.entryId, version: historyMessageVersion(message), throughSeq };
}

function rankHistory(history: AutomaticHistory, plan: RecallQueryPlan, match: ReturnType<typeof lexicalMatcher>): HistoryMatch | undefined {
  const messages = historyMessages(history);
  if (!messages.length) return;
  const latest = messages[messages.length - 1];
  const result = { conversationId: history.conversationId, title: history.title, updatedAt: history.updatedAt, score: 1,
    sources: [historySourcePointer(history.conversationId, history.turns[0])] };
  if (plan.kind === "recent") return { ...result, anchor: messageAnchor(latest, latest.seq) };
  const dates = plan.from !== undefined && plan.to !== undefined;
  const eligible = messages.map((message, position) => ({ message, position }))
    .filter(({ message }) => !dates || (message.at >= plan.from! && message.at < plan.to!));
  if (!eligible.length) return;
  const titleScore = history.title === "旧会话" ? 0 : match(history.title);
  let best: (typeof eligible)[number] | undefined;
  let bodyScore = 0;
  for (const item of eligible) {
    const score = dates && !plan.terms.length && !plan.exactPhrases.length ? 1 : match(item.message.text);
    if (score <= 0 || score < bodyScore) continue;
    bodyScore = score;
    best = item;
  }
  const score = titleScore * 1.3 + bodyScore;
  if (!score) return;
  if (dates && !best) best = eligible.at(-1);
  if (best) result.sources.push(best.message.pointer);
  return { ...result, score, anchor: messageAnchor(best?.message ?? history.turns[0].user, latest.seq),
    ...(best ? { before: Math.min(messages.length, best.position + 3), matchedAt: best.message.at } : {}) };
}

function recentIds(database: ConversationDatabase, horizon: number, blocked: string, offset: number, limit: number): string[] {
  return database.db.prepare(`SELECT c.id FROM conversations c WHERE ${SCOPED_CHATS} ${RECENT_ORDER} LIMIT ? OFFSET ?`)
    .all(horizon, blocked, limit, offset).map(row => row.id as string);
}

function requiredCandidateTerms(database: ConversationDatabase, plan: RecallQueryPlan): string {
  const frequency = database.db.prepare(`SELECT doc FROM ${FTS_VOCAB} WHERE term=?`);
  const frequencies = new Map<string, number>();
  const score = (term: string) => {
    if (!frequencies.has(term)) frequencies.set(term, Number(frequency.get(term)?.doc ?? 0));
    return frequencies.get(term)!;
  };
  const rareFirst = (terms: readonly string[]) => [...terms].sort((a, b) => score(a) - score(b));
  // Tokens only contain letters and numbers. Parameter binding still protects the SQL boundary.
  const quote = (term: string) => `"${term.replace(/"/gu, '""')}"`;
  const exactBranches = plan.exactPhrases.flatMap(phrase => {
    const terms = tokenizeRecallText(phrase, "query");
    return terms.length ? [`(${rareFirst(terms).slice(0, 2).map(quote).join(" AND ")})`] : [];
  });
  const required = plan.terms.filter(term => WORD_TOKEN.test(term));
  const omitted = plan.terms.length - Math.ceil(plan.terms.length * MIN_TERM_COVERAGE);
  // An accepted partial match omits at most `omitted` terms. It must hit
  // at least one of the `omitted + 1` rarest tokens, as well as whole-word anchors.
  const partial = [`(${rareFirst(plan.terms).slice(0, omitted + 1).map(quote).join(" OR ")})`, ...required.map(quote)];
  return [...new Set([...exactBranches, `(${partial.join(" AND ")})`])].join(" OR ");
}

function matchIds(database: ConversationDatabase, input: HistorySearchInput, horizon: number, blocked: string, offset: number): string[] {
  const { plan } = input;
  const expression = requiredCandidateTerms(database, plan);
  const dates = plan.from !== undefined && plan.to !== undefined;
  const dateFilter = dates ? "AND (d.at IS NULL OR (d.at>=? AND d.at<?))" : "";
  return database.db.prepare(`WITH ranked AS MATERIALIZED (
      SELECT d.conversation_id, bm25(${FTS_NAME}) AS rank, d.kind FROM ${FTS_NAME}
      JOIN history_index_docs d ON d.doc_id=${FTS_NAME}.rowid JOIN conversations c ON c.id=d.conversation_id
      JOIN history_index_state s ON s.conversation_id=c.id AND s.dirty=0
      WHERE ${FTS_NAME} MATCH ? AND ${SCOPED_CHATS} ${dateFilter})
    SELECT conversation_id FROM ranked GROUP BY conversation_id
    ORDER BY MIN(rank * CASE WHEN kind='title' THEN 1.3 ELSE 1.0 END), conversation_id LIMIT ? OFFSET ?`)
    .all(expression, horizon, blocked, ...(dates ? [plan.from!, plan.to!] : []), MAX_CANDIDATES + 1, offset)
    .map(row => row.conversation_id as string);
}

export async function searchConversationHistory(database: ConversationDatabase, input: HistorySearchInput,
  importTranscript: ImportTranscript): Promise<HistorySearchPage> {
  const horizon = input.horizon ?? nextHorizon(database);
  if (!eligibleDestination(database, input)) throw new Error("HISTORY_DESTINATION_CHANGED");
  if (input.plan.ambiguousTime || input.plan.wantsSessionContext) return {
    hits: [], horizon, nextOffset: null, legacyNextOffset: null, coverage: "complete", scannedIds: [],
  };
  const excluded = new Set([...input.blockedIds, ...(input.skipIds ?? []), ...(input.destinationId ? [input.destinationId] : [])]);
  const blocked = JSON.stringify([...excluded]);
  const recent = input.plan.kind === "recent";
  const size = recent ? Math.max(input.limit * 3, 24) : BATCH_SIZE;
  let coverage: HistorySearchPage["coverage"] = "complete";
  let nextOffset: number | null = null;
  let windowOffset = input.offset;
  let ids: string[];

  if (input.candidateIds) ids = input.candidateIds;
  else if (!recent && input.plan.terms.length) {
    try {
      const status = await refreshIndex(database, importTranscript, input, horizon);
      if (status.resumable || status.uncertain) coverage = "partial";
      windowOffset = input.offset - input.offset % MAX_CANDIDATES;
      ids = matchIds(database, input, horizon, blocked, windowOffset);
      if (ids.length > MAX_CANDIDATES) {
        ids.pop();
        nextOffset = windowOffset + MAX_CANDIDATES;
      } else if (status.resumable) nextOffset = 0;
    } catch {
      // FTS is optional and cannot turn a storage/index error into an assertion of absent evidence.
      coverage = "degraded";
      windowOffset = input.offset - input.offset % size;
      ids = recentIds(database, horizon, blocked, windowOffset, size + 1);
      if (ids.length > size) { ids.pop(); nextOffset = windowOffset + size; }
    }
  } else {
    if (!recent) windowOffset = input.offset - input.offset % size;
    ids = recentIds(database, horizon, blocked, windowOffset, size + 1);
    if (ids.length > size) { ids.pop(); nextOffset = windowOffset + size; coverage = "partial"; }
  }

  const { load, failed, visibility } = createLookup(database, input);
  const match = lexicalMatcher(input.plan);
  const hits: HistoryMatch[] = [];
  for (const id of ids) {
    if (!isLocalChat(database, id, excluded)) continue;
    try { await importTranscript(id); }
    catch { coverage = coverage === "degraded" ? "degraded" : "partial"; continue; }
    const source = load(id);
    const hit = source && rankHistory(visibility.visible(source), input.plan, match);
    if (hit) hits.push(hit);
  }
  if ((failed.size || visibility.incomplete) && coverage === "complete") coverage = "partial";
  let remaining = hits;
  let legacyNextOffset = nextOffset;
  if (!input.candidateIds && recent && hits.length > input.limit) {
    legacyNextOffset = windowOffset + ids.indexOf(hits[input.limit - 1].conversationId) + 1;
  } else if (!input.candidateIds && !recent) {
    hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId));
    // Numeric clients resume within the same ranked batch before moving to the
    // next raw storage window. Only opaque cursors freeze progress across edits.
    remaining = hits.slice(input.offset - windowOffset);
    if (remaining.length > input.limit) legacyNextOffset = input.offset + input.limit;
  }
  return { hits: remaining, horizon, nextOffset, legacyNextOffset, coverage, scannedIds: ids };
}

function messageForWire(message: HistoryMessage) {
  const text = message.text.length > 720 ? `${message.text.slice(0, 720).replace(/[\uD800-\uDBFF]$/u, "")}…` : message.text;
  const value = { role: message.role, text, at: message.at };
  return { value, size: Buffer.byteLength(JSON.stringify(value), "utf8") + 1 };
}

export async function readConversationHistory(database: ConversationDatabase, input: HistoryReadInput,
  importTranscript: ImportTranscript): Promise<HistoryReadPage | undefined> {
  const id = input.conversationId;
  if (id === input.destinationId || !eligibleDestination(database, input)) return;
  if (!isLocalChat(database, id, new Set(input.blockedIds))) return;
  await importTranscript(id);
  const { load, visibility } = createLookup(database, input);
  const source = load(id);
  if (!source) return;
  const history = visibility.visible(source);
  const throughSeq = input.anchor?.throughSeq;
  const messages = throughSeq === undefined ? historyMessages(history) : historyMessages(history).filter(message => message.seq <= throughSeq);
  if (!messages.length) return;
  const metadataBytes = Buffer.byteLength(JSON.stringify({ title: history.title, conversationId: id }), "utf8");
  const contentBudget = Math.min(PAGE_CONTENT_BYTES, 9_500 - metadataBytes);
  let first = Math.min(input.before ?? messages.length, messages.length);
  if (input.anchor) {
    const { seq, entryId, version } = input.anchor;
    const index = messages.findIndex(message => message.seq === seq && message.entryId === entryId);
    if (index < 0 || historyMessageVersion(messages[index]) !== version) return { error: "stale" };
    first = index;
    if (!input.older) {
      let keptBytes = messageForWire(messages[first++]).size;
      // Include messages just after the match only if the matched message still fits.
      while (first < messages.length && first - index < Math.min(3, input.limit)) {
        keptBytes += messageForWire(messages[first]).size;
        if (keptBytes > contentBudget) break;
        first++;
      }
    }
  }
  const page: Pick<HistoryMessage, "role" | "text" | "at">[] = [];
  const pointers: HistorySourcePointer[] = [];
  let bytes = 0;
  while (first > 0 && page.length < input.limit) {
    const message = messages[first - 1];
    const { value, size } = messageForWire(message);
    if (bytes + size > contentBudget) break;
    page.unshift(value);
    pointers.push(message.pointer);
    bytes += size;
    first--;
  }
  const anchor = first && messages[first];
  return { conversationId: id, title: history.title, updatedAt: history.updatedAt, messages: page, pointers,
    titlePointer: history.title !== "旧会话" ? historySourcePointer(id, history.turns[0]) : undefined,
    nextAnchor: anchor ? messageAnchor(anchor, throughSeq) : undefined,
    nextBefore: first || null };
}

export function currentHistorySourcePointers(database: ConversationDatabase, pointers: readonly HistorySourcePointer[], policy: HistoryLookupPolicy) {
  if (!eligibleDestination(database, policy)) return [];
  const { visibility } = createLookup(database, policy);
  return pointers.filter(pointer => pointer.conversationId !== policy.destinationId && visibility.allows(pointer));
}
