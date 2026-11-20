import type { SocialAtom } from "../social-context/types";
import type { InitiativeOpportunityInput } from "./initiative-opportunities";

export const MEMORY_FOLLOWUP_SOURCE = "memory_followup";
/** Asking about tomorrow's interview right after hearing about it is not caring. */
export const MEMORY_FOLLOWUP_DELAY_MS = 12 * 3_600_000;
const MEMORY_FOLLOWUP_MAX_AGE_MS = 14 * 86_400_000;
const MEMORY_FOLLOWUP_WINDOW_MS = 3 * 86_400_000;

export function isMemoryFollowupAtomOpen(atom: SocialAtom | undefined, now: number): atom is SocialAtom {
  return Boolean(atom && atom.type === "open_loop" && atom.status === "active"
    && (typeof atom.expiresAt !== "number" || atom.expiresAt > now));
}

/**
 * Things the user said would happen ("下周三答辩", "明天面试") become a chance
 * to ask how it went. The extractor closes the loop when the user tells her,
 * so a resolved atom never produces another question.
 */
export function memoryFollowupOpportunities(atoms: readonly SocialAtom[], now: number, conversationId: string): InitiativeOpportunityInput[] {
  return atoms
    .filter((atom) => atom.conversationId === conversationId && isMemoryFollowupAtomOpen(atom, now)
      && now - atom.createdAt >= MEMORY_FOLLOWUP_DELAY_MS && now - atom.createdAt <= MEMORY_FOLLOWUP_MAX_AGE_MS)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 2)
    .map((atom) => {
      const occurredAt = atom.createdAt + MEMORY_FOLLOWUP_DELAY_MS;
      return {
        id: `memory:${atom.id}`, source: MEMORY_FOLLOWUP_SOURCE, sourceEventId: atom.id, evidenceVersion: 1, conversationId,
        motive: "followup" as const, summary: atom.content,
        occurredAt, expiresAt: Math.min(atom.expiresAt ?? Number.POSITIVE_INFINITY, occurredAt + MEMORY_FOLLOWUP_WINDOW_MS),
        strengthPerHour: 1.5, decayPerHour: 0.2, replyBurden: "question" as const,
        sceneId: `memory:${atom.id}`, score: 74, sceneCooldownMs: 0,
      };
    });
}
