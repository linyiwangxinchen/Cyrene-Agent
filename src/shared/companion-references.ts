import { COMPANION_LEARNING_TOPICS, type CompanionLearningTopic } from "./companion";

type ReferenceSource = { conversationId: string; userTurnId?: string };

export interface HistorySourcePointer {
  conversationId: string;
  userTurnId: string;
  userEntryId: string;
  assistantEntryId: string;
  /** Fingerprint of the authorized visible turn as it was provided to the model. */
  revision?: string;
}

export type HistorySourceObserver = (
  sources: readonly HistorySourcePointer[],
  usage: "search" | "read",
  incomplete?: boolean,
) => void;

export const MAX_HISTORY_SOURCE_POINTERS = 64;

export type CompanionReference =
  | (ReferenceSource & { kind: "preference"; topic: CompanionLearningTopic })
  | (ReferenceSource & { kind: "expression"; quote: string; appeared?: boolean })
  | (ReferenceSource & { kind: "conversation"; title: string })
  | (HistorySourcePointer & { kind: "chat-history" });

function isReferenceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

const historyPointerFields = ["conversationId", "userTurnId", "userEntryId", "assistantEntryId"] as const;

function hasHistoryPointerIds(row: Record<string, unknown>): boolean {
  return historyPointerFields.every(key => isReferenceId(row[key]))
    && (row.revision === undefined || typeof row.revision === "string" && /^[a-f0-9]{64}$/u.test(row.revision));
}

export function isHistorySourcePointer(value: unknown): value is HistorySourcePointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return hasHistoryPointerIds(row) && Object.keys(row).every(key => key === "revision" || historyPointerFields.some(field => field === key));
}

function isReference(value: unknown): value is CompanionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const sourceOk = typeof row.conversationId === "string" && row.conversationId.length > 0 && row.conversationId.length <= 256
    && (row.userTurnId === undefined || (typeof row.userTurnId === "string" && row.userTurnId.length > 0 && row.userTurnId.length <= 256));
  if (!sourceOk) return false;
  const fields = Object.keys(row);
  if (row.kind === "preference") {
    return COMPANION_LEARNING_TOPICS.includes(row.topic as CompanionLearningTopic)
      && fields.every(key => ["kind", "topic", "conversationId", "userTurnId"].includes(key));
  }
  if (row.kind === "conversation") {
    return typeof row.title === "string" && row.title.length > 0 && row.title.length <= 180
      && fields.every(key => ["kind", "title", "conversationId"].includes(key));
  }
  if (row.kind === "chat-history") {
    return hasHistoryPointerIds(row) && fields.every(key => key === "kind" || key === "revision" || historyPointerFields.some(field => field === key));
  }
  return row.kind === "expression" && typeof row.quote === "string" && row.quote.length > 0 && row.quote.length <= 64
    && (row.appeared === undefined || typeof row.appeared === "boolean")
    && fields.every(key => ["kind", "quote", "appeared", "conversationId", "userTurnId"].includes(key));
}

export function isCompanionReferenceList(value: unknown): value is CompanionReference[] {
  return Array.isArray(value) && value.length <= 6 && value.every(isReference);
}
