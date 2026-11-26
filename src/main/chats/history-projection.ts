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
  seq: number;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface HistoryTurn {
  userTurnId: string;
  user: HistoryMessage;
  reply: HistoryMessage;
  revision: string;
  dependencies: HistorySourcePointer[];
}

export interface AutomaticHistory {
  conversationId: string;
  title: string;
  updatedAt: number;
  hideTitle: boolean;
  turns: HistoryTurn[];
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
  return { conversationId, userTurnId: turn.userTurnId, userEntryId: turn.user.entryId, assistantEntryId: turn.reply.entryId,
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
    return [{ ...turn.user, pointer }, { ...turn.reply, pointer }];
  });
  return [...new Map(messages.map(message => [message.entryId, message])).values()].sort((a, b) => a.seq - b.seq);
}

function visibleText(entry: TranscriptEntry, message: ChatMessage): HistoryMessage {
  return { entryId: entry.id, seq: entry.seq, role: message.role === "user" ? "user" : "assistant",
    text: message.content.trim(), at: message.at };
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
  let adjacentUser: string | undefined;

  for (const node of nodes) {
    if (node.kind === "compaction") continue;
    const entry = canonical.get(node.entryId);
    const message = visible.get(node.messageId);
    if (node.kind === "user") {
      adjacentUser = node.turnId;
      if (entry && message?.role === "user" && message.content.trim() && node.turnId && !entry.runId?.startsWith("plugin:")) {
        users.set(node.turnId, visibleText(entry, message));
      }
      continue;
    }
    if (entry?.kind !== "assistant" || message?.role !== "model" || !message.content.trim()
      || latest.get(node.messageId) !== node || entry.payload.visibility === "internal" || entry.payload.toolCalls?.length
      || entry.runId?.startsWith("plugin:") || (message.runSnapshot && (message.runSnapshot.status !== "terminal"
      || (message.runSnapshot.terminalStatus && message.runSnapshot.terminalStatus !== "success")))) continue;
    const status = entry.runId ? runStatuses.get(entry.runId) : undefined;
    if (status && status !== "completed") continue;
    // Interjections have a user row, but the author of a reply is the user
    // in its run's admission receipt. Only runs predating receipts use adjacency.
    const userTurnId = (entry.runId && runUsers.get(entry.runId)) || adjacentUser;
    const user = userTurnId && users.get(userTurnId);
    if (!user || !userTurnId) continue;
    const dependencies = entry.historySources;
    if (entry.historySourcesIncomplete || (entry.runId && historyToolRuns.has(entry.runId) && dependencies === undefined)) continue;
    const reply = visibleText(entry, message);
    const revision = createHash("sha256").update(JSON.stringify([record.title, user.text, reply.text])).digest("hex");
    turns.push({ userTurnId, user, reply, revision, dependencies: dependencies ?? [] });
  }
  return { conversationId: record.id, title: record.title, updatedAt: record.updatedAt, turns,
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
    const source = { conversationId, messageId: message.entryId };
    return waivedSources.has(memorySourceKey(source)) || (waivedFacts.size > 0 && waivedFacts.has(memoryFactKey(source, message.text)));
  };
  function allowed(conversationId: string, turn: HistoryTurn): boolean {
    const key = historyPointerKey(historySourcePointer(conversationId, turn));
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key) || visiting.size >= 8) { incomplete = true; return false; }
    if (!visiting.size) checkedDependencies = 0;
    visiting.add(key);
    const valid = !revoked(conversationId, turn.user) && !revoked(conversationId, turn.reply) && turn.dependencies.every(pointer => {
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
      && turn.user.entryId === pointer.userEntryId && turn.reply.entryId === pointer.assistantEntryId && turn.revision === pointer.revision);
  }
  return {
    get incomplete() { return incomplete; },
    allows(pointer: HistorySourcePointer): boolean {
      const turn = matchingTurn(pointer);
      return !!turn && allowed(pointer.conversationId, turn);
    },
    visible(history: AutomaticHistory): AutomaticHistory {
      const turns = history.turns.filter(turn => allowed(history.conversationId, turn));
      const title = (history.hideTitle || turns.length !== history.turns.length ? "" : history.title.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 180)) || "旧会话";
      return { ...history, turns, title };
    },
  };
}
