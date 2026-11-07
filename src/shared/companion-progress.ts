/**
 * Game-like companion progress is deliberately separate from relationship
 * preferences, affect and permissions.  It is a monotonic product signal:
 * silence, a pause, or an ordinary failed turn never removes progress.
 */

import type { CompanionEvent, CompanionEventKind } from "./companion-events";

export const BOND_PROGRESS_VERSION = 1 as const;

export type BondChapter =
  | "prologue"
  | "first_steps"
  | "shared_routines"
  | "shared_projects"
  | "long_term";

export interface BondProgressAward {
  eventId: string;
  kind: CompanionEventKind;
  delta: number;
  summary: string;
  occurredAt: number;
}

export interface BondProgressState {
  version: typeof BOND_PROGRESS_VERSION;
  score: number;
  chapter: BondChapter;
  unlockedMilestones: string[];
  awardedEventIds: string[];
  recentAwards: BondProgressAward[];
  updatedAt: number;
  revision: number;
}

export interface BondProgressUpdate {
  state: BondProgressState;
  awarded: BondProgressAward | null;
  chapterChanged: boolean;
}

const CHAPTER_THRESHOLDS: readonly { chapter: BondChapter; threshold: number; milestone: string }[] = [
  { chapter: "prologue", threshold: 0, milestone: "bond.prologue" },
  { chapter: "first_steps", threshold: 50, milestone: "bond.first_steps" },
  { chapter: "shared_routines", threshold: 150, milestone: "bond.shared_routines" },
  { chapter: "shared_projects", threshold: 300, milestone: "bond.shared_projects" },
  { chapter: "long_term", threshold: 600, milestone: "bond.long_term" },
];

const DEFAULT_AWARD_DELTAS: Readonly<Partial<Record<CompanionEventKind, number>>> = {
  goal_progressed: 8,
  followup_completed: 6,
  repair_acknowledged: 10,
  moment_shared: 3,
  plugin_observation: 2,
  music_context: 1,
};

function finiteScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function chapterForScore(score: number): BondChapter {
  let chapter: BondChapter = "prologue";
  for (const item of CHAPTER_THRESHOLDS) {
    if (score >= item.threshold) chapter = item.chapter;
  }
  return chapter;
}

function milestonesForScore(score: number): string[] {
  return CHAPTER_THRESHOLDS.filter((item) => score >= item.threshold).map((item) => item.milestone);
}

export function createDefaultBondProgress(now = Date.now()): BondProgressState {
  return {
    version: BOND_PROGRESS_VERSION,
    score: 0,
    chapter: "prologue",
    unlockedMilestones: ["bond.prologue"],
    awardedEventIds: [],
    recentAwards: [],
    updatedAt: now,
    revision: 1,
  };
}

export function normalizeBondProgress(value: unknown, now = Date.now()): BondProgressState {
  const defaults = createDefaultBondProgress(now);
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const raw = value as Partial<BondProgressState>;
  const score = finiteScore(raw.score);
  const unlocked = Array.isArray(raw.unlockedMilestones)
    ? raw.unlockedMilestones.filter((item): item is string => typeof item === "string").slice(-50)
    : [];
  const awarded = Array.isArray(raw.awardedEventIds)
    ? raw.awardedEventIds.filter((item): item is string => typeof item === "string").slice(-10_000)
    : [];
  const recentAwards = Array.isArray(raw.recentAwards)
    ? raw.recentAwards.filter((item): item is BondProgressAward => Boolean(
      item && typeof item === "object"
      && typeof (item as BondProgressAward).eventId === "string"
      && typeof (item as BondProgressAward).kind === "string"
      && Number.isFinite((item as BondProgressAward).delta)
      && typeof (item as BondProgressAward).summary === "string"
      && Number.isFinite((item as BondProgressAward).occurredAt),
    )).slice(-100)
    : [];
  const milestones = [...new Set([...unlocked, ...milestonesForScore(score)])];
  return {
    version: BOND_PROGRESS_VERSION,
    score,
    chapter: chapterForScore(score),
    unlockedMilestones: milestones,
    awardedEventIds: [...new Set(awarded)],
    recentAwards,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
    revision: Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : defaults.revision,
  };
}

/**
 * Apply one sanitized companion event.  Events without a meaningful reward
 * remain valid inputs but intentionally produce no score change.
 */
export function applyBondEvent(
  current: BondProgressState,
  event: CompanionEvent,
  now = Date.now(),
): BondProgressUpdate {
  const state = normalizeBondProgress(current, now);
  if (state.awardedEventIds.includes(event.eventId)) {
    return { state, awarded: null, chapterChanged: false };
  }

  const delta = Math.max(0, Math.floor(event.bondDelta ?? DEFAULT_AWARD_DELTAS[event.kind] ?? 0));
  const previousChapter = state.chapter;
  const score = state.score + delta;
  const chapter = chapterForScore(score);
  const unlockedMilestones = [...new Set([
    ...state.unlockedMilestones,
    ...milestonesForScore(score),
  ])];
  const awarded = delta > 0 ? {
    eventId: event.eventId,
    kind: event.kind,
    delta,
    summary: event.summary,
    occurredAt: event.occurredAt,
  } satisfies BondProgressAward : null;

  const next: BondProgressState = {
    ...state,
    score,
    chapter,
    unlockedMilestones,
    // Keep no-award event ids out of the award list; the caller's event ledger
    // is responsible for all-event dedupe.  This list is specifically the
    // durable reward ledger and remains bounded.
    awardedEventIds: awarded
      ? [...state.awardedEventIds, event.eventId].slice(-10_000)
      : state.awardedEventIds,
    recentAwards: awarded ? [...state.recentAwards, awarded].slice(-100) : state.recentAwards,
    updatedAt: now,
    revision: state.revision + (awarded ? 1 : 0),
  };
  return { state: next, awarded, chapterChanged: chapter !== previousChapter };
}

export function bondChapterThresholds(): readonly { chapter: BondChapter; threshold: number; milestone: string }[] {
  return CHAPTER_THRESHOLDS;
}
