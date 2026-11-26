import { COMPANION_LEARNING_TOPICS, type CompanionLearningTopic } from "./companion";

type ReferenceSource = { conversationId: string; userTurnId?: string };

export type CompanionReference =
  | (ReferenceSource & { kind: "preference"; topic: CompanionLearningTopic })
  | (ReferenceSource & { kind: "expression"; quote: string; appeared?: boolean });

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
  return row.kind === "expression" && typeof row.quote === "string" && row.quote.length > 0 && row.quote.length <= 64
    && (row.appeared === undefined || typeof row.appeared === "boolean")
    && fields.every(key => ["kind", "quote", "appeared", "conversationId", "userTurnId"].includes(key));
}

export function isCompanionReferenceList(value: unknown): value is CompanionReference[] {
  return Array.isArray(value) && value.length <= 6 && value.every(isReference);
}
