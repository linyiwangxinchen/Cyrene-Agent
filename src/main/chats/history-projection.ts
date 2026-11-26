import type { ChatMessage, ChatSessionRecord } from "../../shared/chat-types";
import type { HistorySourcePointer } from "../../shared/companion-references";
import { createHash } from "node:crypto";
import { CHAT_HISTORY_TOOL_IDS } from "../memory/memory-scope";
import { memoryFactKey, memorySourceKey } from "../memory/memory-source-policy";
import type { MemoryStore } from "../memory/memory-types";
import { reduceTranscriptProjection } from "../orchestrator/conversation-transcript-projection";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";

export type { HistorySourcePointer } from "../../shared/companion-references";

export interface HistoryMessage {
  entryId: string;
  turnId?: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface HistoryTurn {
  userTurnId: string;
  user: HistoryMessage;
  reply?: HistoryMessage;
  revision: string;
  dependencies: HistorySourcePointer[];
}

export interface AutomaticHistory {
  conversationId: string;
  title: string;
  updatedAt: number;
  hideTitle: boolean;
  turns: HistoryTurn[];
  quoteOnlyUsers: HistoryMessage[];
  standaloneReplies: { message: HistoryMessage; dependencies: HistorySourcePointer[] }[];
}

export const HISTORY_ENTRY_KINDS: TranscriptEntry["kind"][] = ["user", "assistant", "turn_rewind", "turn_tombstone", "presentation_patch", "compaction_checkpoint", "delivery_receipt", "tool_started"];

export interface HistoryWithdrawal {
  sourceKeys: string[];
  factKeys: string[];
}

export function historyWithdrawal(memory: Pick<MemoryStore, "forgetting">): HistoryWithdrawal {
  return { sourceKeys: [...new Set([...(memory.forgetting?.sourceKeys ?? []), ...(memory.forgetting?.derivedSourceKeys ?? [])])],
    factKeys: memory.forgetting?.factKeys ?? [] };
}

export function historySourcePointer(conversationId: string, turn: HistoryTurn): HistorySourcePointer {
  return { conversationId, userTurnId: turn.userTurnId, userEntryId: turn.user.entryId,
    ...(turn.reply ? { assistantEntryId: turn.reply.entryId } : {}),
    revision: turn.revision };
}

export function historyPointerKey(pointer: HistorySourcePointer): string {
  return JSON.stringify([pointer.conversationId, pointer.userTurnId, pointer.userEntryId, pointer.assistantEntryId, pointer.revision]);
}

export function historyMessageVersion(message: HistoryMessage): string {
  return createHash("sha256").update(message.text).digest("hex");
}

export function historyMessages(history: AutomaticHistory) {
  const messages = history.turns.flatMap(turn => {
    const pointer = historySourcePointer(history.conversationId, turn);
    const messages = turn.user.text ? [{ ...turn.user, pointer }] : [];
    if (turn.reply) messages.push({ ...turn.reply, pointer });
    return messages;
  });
  return [...new Map(messages.map(message => [message.entryId, message])).values()].sort((a, b) => a.seq - b.seq);
}

function visibleText(entry: TranscriptEntry, message: ChatMessage): HistoryMessage {
  return { entryId: entry.id, turnId: entry.turnId, seq: entry.seq, role: message.role === "user" ? "user" : "assistant",
    text: message.content.trim(), at: message.at };
}

function makeTurn(title: string, userTurnId: string, user: HistoryMessage, reply?: HistoryMessage,
  dependencies: HistorySourcePointer[] = []): HistoryTurn {
  const revision = createHash("sha256").update(JSON.stringify([title, user.text, reply?.text ?? null])).digest("hex");
  return { userTurnId, user, reply, revision, dependencies };
}

function isActiveRun(status?: string): boolean {
  return status === "prepared" || status === "running";
}

export function projectAutomaticHistory(
  record: ChatSessionRecord,
  entries: TranscriptEntry[],
  runUsers: ReadonlyMap<string, string>,
  runStatuses: ReadonlyMap<string, string>,
): AutomaticHistory | undefined {
  if (record.mode !== "chat" || record.purpose || record.id.startsWith("channel:")) return;
  if (entries.some(entry => (entry.kind === "user" && (entry.id.startsWith("channel:") || entry.turnId?.startsWith("channel:")))
    || entry.kind === "delivery_receipt" || (entry.kind === "presentation_patch" && entry.payload.patch.channelSource))) return;

  const projection = reduceTranscriptProjection(entries);
  const nodes = projection.state?.nodes;
  if (!nodes) return;
  const visible = new Map(projection.messages.map(message => [message.id, message]));
  const canonical = new Map(entries.map(entry => [entry.id, entry]));
  const latest = new Map(nodes.map(node => [node.messageId, node]));
  const historyToolRuns = new Set(entries.flatMap(entry => entry.runId && (
    (entry.kind === "tool_started" && CHAT_HISTORY_TOOL_IDS.has(entry.payload.toolName))
    || (entry.kind === "assistant" && entry.payload.toolCalls?.some(call => CHAT_HISTORY_TOOL_IDS.has(call.name)))
  ) ? [entry.runId] : []));
  const users = new Map<string, HistoryMessage>();
  const turns: HistoryTurn[] = [];
  const standaloneReplies: AutomaticHistory["standaloneReplies"] = [];
  const blockedUsers = new Set([...runUsers].flatMap(([runId, userTurnId]) => isActiveRun(runStatuses.get(runId)) ? [userTurnId] : []));
  if (record.pendingDispatch?.messageId) blockedUsers.add(record.pendingDispatch.messageId);
  const usersWithUnverifiableReplies = new Set<string>();
  const pairedUsers = new Set<string>();
  let adjacentUser: string | undefined;

  for (const node of nodes) {
    if (node.kind === "compaction") continue;
    const entry = canonical.get(node.entryId);
    const message = visible.get(node.messageId);
    if (node.kind === "user") {
      adjacentUser = node.turnId;
      if (entry && message?.role === "user" && node.turnId && !entry.runId?.startsWith("plugin:")) {
        users.set(node.turnId, visibleText(entry, message));
        if (entry.runId && isActiveRun(runStatuses.get(entry.runId))) blockedUsers.add(node.turnId);
      }
      continue;
    }
    // An interjection can have a user row of its own. Use its run receipt to
    // identify which user actually prompted the reply, with adjacency for old records.
    const userTurnId = (entry?.runId && runUsers.get(entry.runId)) || adjacentUser;
    const status = entry?.runId ? runStatuses.get(entry.runId) : undefined;
    // After crash recovery a display snapshot may still say running even though
    // SQLite has settled the run. Only the author's input can be reused then.
    if (userTurnId && message?.runSnapshot?.status === "running" && (!status || isActiveRun(status))) blockedUsers.add(userTurnId);
    if (entry?.kind !== "assistant" || message?.role !== "model" || !message.content.trim()
      || latest.get(node.messageId) !== node || entry.payload.visibility === "internal" || entry.payload.toolCalls?.length
      || entry.runId?.startsWith("plugin:") || (message.runSnapshot && (message.runSnapshot.status !== "terminal"
      || (message.runSnapshot.terminalStatus && message.runSnapshot.terminalStatus !== "success")))) continue;
    if (status && status !== "completed") continue;
    const dependencies = entry.historySources;
    if (entry.historySourcesIncomplete || (entry.runId && historyToolRuns.has(entry.runId) && dependencies === undefined)) {
      if (userTurnId) usersWithUnverifiableReplies.add(userTurnId);
      continue;
    }
    const reply = visibleText(entry, message);
    if (!userTurnId) {
      standaloneReplies.push({ message: reply, dependencies: dependencies ?? [] });
      continue;
    }
    const user = users.get(userTurnId);
    if (!user) continue;
    turns.push(makeTurn(record.title, userTurnId, user, reply, dependencies));
    pairedUsers.add(userTurnId);
  }
  const quoteOnlyUsers: HistoryMessage[] = [];
  for (const [userTurnId, user] of users) {
    if (!user.text || pairedUsers.has(userTurnId) || blockedUsers.has(userTurnId)) continue;
    if (usersWithUnverifiableReplies.has(userTurnId)) quoteOnlyUsers.push(user);
    else turns.push(makeTurn(record.title, userTurnId, user));
  }
  turns.sort((a, b) => a.user.seq - b.user.seq);
  return { conversationId: record.id, title: record.title, updatedAt: record.updatedAt, turns, quoteOnlyUsers, standaloneReplies,
    hideTitle: !record.titleIsCustom && (entries.some(entry => entry.kind === "turn_tombstone"
      || (entry.kind === "turn_rewind" && entry.payload.disposition === "replace_user")) || Boolean(turns.length && adjacentUser
      && !turns.some(turn => turn.user.entryId === users.values().next().value?.entryId))) };
}

/** A retained quotation cannot revive a deleted, edited, or revoked source. */
export function createHistoryVisibility(
  load: (id: string) => AutomaticHistory | undefined,
  withdrawal: HistoryWithdrawal,
) {
  const waivedSources = new Set(withdrawal.sourceKeys);
  const waivedFacts = new Set(withdrawal.factKeys);
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  let checkedDependencies = 0;
  let incomplete = false;
  const revoked = (conversationId: string, message: HistoryMessage) => {
    return [message.entryId, message.turnId].some(messageId => {
      if (!messageId) return false;
      const source = { conversationId, messageId };
      return waivedSources.has(memorySourceKey(source)) || (waivedFacts.size > 0 && waivedFacts.has(memoryFactKey(source, message.text)));
    });
  };
  function allowed(conversationId: string, turn: HistoryTurn): boolean {
    const key = historyPointerKey(historySourcePointer(conversationId, turn));
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key) || visiting.size >= 8) { incomplete = true; return false; }
    if (!visiting.size) checkedDependencies = 0;
    visiting.add(key);
    const valid = !revoked(conversationId, turn.user) && (!turn.reply || !revoked(conversationId, turn.reply)) && turn.dependencies.every(pointer => {
      if (++checkedDependencies > 1_000) { incomplete = true; return false; }
      const current = matchingTurn(pointer);
      return !!current && allowed(pointer.conversationId, current);
    });
    visiting.delete(key);
    memo.set(key, valid);
    return valid;
  }
  function matchingTurn(pointer: HistorySourcePointer): HistoryTurn | undefined {
    if (!pointer.revision) return;
    return load(pointer.conversationId)?.turns.find(turn => turn.userTurnId === pointer.userTurnId
      && turn.user.entryId === pointer.userEntryId && turn.reply?.entryId === pointer.assistantEntryId && turn.revision === pointer.revision);
  }
  return {
    get incomplete() { return incomplete; },
    allows(pointer: HistorySourcePointer): boolean {
      const turn = matchingTurn(pointer);
      return !!turn && allowed(pointer.conversationId, turn);
    },
    visible(history: AutomaticHistory): AutomaticHistory {
      const turns = history.turns.filter(turn => allowed(history.conversationId, turn));
      const quoteOnlyUsers = history.quoteOnlyUsers.filter(message => !revoked(history.conversationId, message));
      const standaloneReplies = history.standaloneReplies.filter(({ message, dependencies }) =>
        !revoked(history.conversationId, message) && dependencies.every(pointer => {
          const current = matchingTurn(pointer);
          return !!current && allowed(pointer.conversationId, current);
        }));
      const hasHiddenContent = turns.length !== history.turns.length || quoteOnlyUsers.length !== history.quoteOnlyUsers.length
        || standaloneReplies.length !== history.standaloneReplies.length;
      const title = (history.hideTitle || hasHiddenContent ? "" : history.title.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 180)) || "旧会话";
      return { ...history, turns, quoteOnlyUsers, standaloneReplies, title };
    },
  };
}
