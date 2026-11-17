import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type InitiativeMotive = "interesting" | "boredom" | "connection" | "followup" | "progress";
export type InitiativeReplyBurden = "none" | "light" | "question";
export type InitiativeDensity = "quiet" | "natural" | "active";
export type InitiativeStatus = "pending" | "selected" | "held" | "sent" | "dropped" | "expired" | "delivery_review" | "delivery_partial" | "delivery_unknown";
export interface InitiativeOpportunityInput {
  id: string;
  source: string;
  sourceEventId: string;
  evidenceVersion: string | number;
  conversationId?: string;
  motive: InitiativeMotive;
  summary: string;
  occurredAt: number;
  expiresAt: number;
  strengthPerHour: number;
  /** Exponential loss of freshness from occurredAt; zero retains a constant rate. */
  decayPerHour?: number;
  replyBurden: InitiativeReplyBurden;
  momentId?: string;
  sceneId?: string;
  score?: number;
  sceneCooldownMs?: number;
}
export interface InitiativeOpportunity extends InitiativeOpportunityInput {
  /** Stable source + evidence + scope identity; use this when resolving. */
  key: string;
  status: InitiativeStatus;
  threshold: number;
  accumulated: number;
  lastAdvancedAt: number;
  previousRate: number;
  wasEligible: boolean;
  lastSelectedAt?: number;
  holdUntil?: number;
  resumeOn?: "user_message" | "evidence_change";
  finishedAt?: number;
  lastAttemptSelectionAt?: number;
}
interface InitiativeData {
  version: 1;
  initializedAt: number;
  sequence: number;
  entries: InitiativeOpportunity[];
  attemptDate?: string;
  attemptCount?: number;
}
export interface InitiativeSelectInput {
  now: number;
  opportunities: readonly InitiativeOpportunityInput[];
  eligible: boolean | ((opportunity: InitiativeOpportunityInput) => boolean);
  density?: InitiativeDensity;
  /** Only simulations with a known uninterrupted clock should opt in. */
  continuous?: boolean;
  dayKey?: string;
  dailyAttemptLimit?: number;
}
const MAX_ENTRIES = 4096;
const MAX_CONTINUOUS_GAP = 5 * 60_000;
const MAX_AGE = 30 * 86_400_000;
const statuses: InitiativeStatus[] = ["pending", "selected", "held", "sent", "dropped", "expired", "delivery_review", "delivery_partial", "delivery_unknown"];
const motives: InitiativeMotive[] = ["interesting", "boredom", "connection", "followup", "progress"];
const densityRate = { quiet: 0.35, natural: 0.7, active: 1 };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function validInput(item: InitiativeOpportunityInput): boolean {
  return Boolean(item && typeof item === "object" && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 300
    && typeof item.source === "string" && item.source.length <= 80
    && typeof item.sourceEventId === "string" && item.sourceEventId.length > 0 && item.sourceEventId.length <= 300
    && (typeof item.evidenceVersion === "string" || finite(item.evidenceVersion)) && String(item.evidenceVersion).length <= 100
    && (item.conversationId === undefined || typeof item.conversationId === "string" && item.conversationId.length <= 300)
    && motives.includes(item.motive) && ["none", "light", "question"].includes(item.replyBurden)
    && typeof item.summary === "string" && item.summary.length > 0 && item.summary.length <= 1000
    && finite(item.occurredAt) && finite(item.expiresAt) && item.expiresAt > item.occurredAt
    && finite(item.strengthPerHour) && item.strengthPerHour >= 0 && item.strengthPerHour <= 120
    && (item.decayPerHour === undefined || finite(item.decayPerHour) && item.decayPerHour >= 0));
}
function identity(item: InitiativeOpportunityInput): string {
  return createHash("sha256").update(JSON.stringify([item.source, item.sourceEventId, String(item.evidenceVersion), item.conversationId ?? ""])).digest("hex");
}
function clone(entry: InitiativeOpportunity): InitiativeOpportunity { return { ...entry }; }

/** Persistent, evidence-bound spontaneous intentions. No model or delivery calls. */
export class InitiativeOpportunityStore {
  private resumed = false;
  constructor(private readonly filePath: string, private readonly random: () => number = Math.random) {}

  private read(): InitiativeData | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as InitiativeData;
    // Refuse to overwrite future or damaged files: they contain delivery tombstones.
    if (raw.version !== 1 || !finite(raw.initializedAt) || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0 || !Array.isArray(raw.entries)) {
      throw new Error("Invalid or unsupported initiative state");
    }
    if (raw.attemptDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(raw.attemptDate)
      || raw.attemptCount !== undefined && (!Number.isSafeInteger(raw.attemptCount) || raw.attemptCount < 0)) throw new Error("Invalid initiative attempt budget");
    if (!raw.entries.every(entry => validInput(entry) && entry.key === identity(entry) && statuses.includes(entry.status)
      && finite(entry.threshold) && entry.threshold > 0 && finite(entry.accumulated) && entry.accumulated >= 0
      && finite(entry.lastAdvancedAt) && finite(entry.previousRate) && entry.previousRate >= 0 && typeof entry.wasEligible === "boolean"
      && (entry.holdUntil === undefined || finite(entry.holdUntil))
      && (entry.resumeOn === undefined || entry.resumeOn === "user_message" || entry.resumeOn === "evidence_change"))) {
      throw new Error("Invalid initiative opportunity");
    }
    return raw;
  }

  private write(data: InitiativeData): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original */ }
      throw error;
    }
  }

  select(input: InitiativeSelectInput): InitiativeOpportunity | undefined {
    if (!finite(input.now)) throw new Error("Invalid initiative clock");
    const data: InitiativeData = this.read() ?? { version: 1, initializedAt: input.now, sequence: 0, entries: [] };
    const now = input.now;
    const firstInProcess = !this.resumed;
    const before = JSON.stringify(data);
    // A crash between selection and durable delivery intent must not install an
    // endless in-flight item. Durable intents are replayed by the service before
    // this selection path; abandoned generations wait for new evidence.
    for (const entry of data.entries) if (entry.status === "selected" && (firstInProcess || now - (entry.lastSelectedAt ?? entry.lastAdvancedAt) >= 10 * 60_000)) {
      entry.status = "held"; entry.resumeOn = "evidence_change"; entry.wasEligible = false;
      entry.lastAdvancedAt = Math.max(now, entry.lastAdvancedAt);
    }
    const presented = new Set<string>();
    const rateMultiplier = densityRate[input.density ?? "active"];
    for (const opportunity of input.opportunities) {
      if (!validInput(opportunity)) continue;
      const key = identity(opportunity);
      if (presented.has(key)) continue;
      presented.add(key);
      let entry = data.entries.find(item => item.key === key);
      if (!entry) {
        if (opportunity.occurredAt < data.initializedAt - 15 * 60_000 || opportunity.occurredAt > now || opportunity.expiresAt <= now) continue;
        // Upgrading evidence supersedes the old pending intention, not its tombstone.
        for (const previous of data.entries) if (previous.source === opportunity.source && previous.sourceEventId === opportunity.sourceEventId
          && previous.conversationId === opportunity.conversationId && ["pending", "held", "selected"].includes(previous.status)) {
          previous.status = "dropped"; previous.finishedAt = now; previous.wasEligible = false;
        }
        const draw = this.random();
        if (!finite(draw)) throw new Error("Invalid initiative random source");
        const threshold = -Math.log(Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, draw)));
        entry = { ...opportunity, key, status: "pending", threshold, accumulated: 0, lastAdvancedAt: now,
          previousRate: 0, wasEligible: false };
        data.entries.push(entry);
        data.sequence++;
      }
      if (entry.status !== "pending") continue;
      if (entry.expiresAt <= now) { entry.status = "expired"; entry.finishedAt = now; entry.wasEligible = false; continue; }
      const eligible = typeof input.eligible === "function" ? input.eligible(opportunity) : input.eligible;
      const elapsed = Math.max(0, now - entry.lastAdvancedAt);
      // The prior rate applies until a state change. New arrivals never get the prior tick.
      if (!firstInProcess && eligible && entry.wasEligible && (input.continuous || elapsed <= MAX_CONTINUOUS_GAP)) {
        const hours = elapsed / 3_600_000;
        const decay = entry.decayPerHour ?? 0;
        const age = Math.max(0, entry.lastAdvancedAt - entry.occurredAt) / 3_600_000;
        // Integrate the whole interval exactly, independent of polling frequency.
        // Absolute source age keeps advancing while delivery is suppressed.
        entry.accumulated += decay > 0
          ? entry.previousRate * Math.exp(-decay * age) * -Math.expm1(-decay * hours) / decay
          : entry.previousRate * hours;
      }
      entry.previousRate = Math.max(0, opportunity.strengthPerHour * rateMultiplier);
      entry.wasEligible = eligible;
      entry.lastAdvancedAt = Math.max(now, entry.lastAdvancedAt);
      // Evidence identity is unchanged; a presentation update cannot alter its expiry.
      entry.strengthPerHour = opportunity.strengthPerHour;
      entry.decayPerHour = opportunity.decayPerHour ?? 0;
      entry.summary = opportunity.summary;
      entry.replyBurden = opportunity.replyBurden;
    }
    for (const entry of data.entries) {
      if (["pending", "held"].includes(entry.status) && (entry.expiresAt <= now || entry.holdUntil !== undefined && entry.holdUntil <= now)) {
        entry.status = "expired"; entry.finishedAt = now;
      }
      if (!presented.has(entry.key) || entry.status !== "pending") { entry.wasEligible = false; entry.lastAdvancedAt = Math.max(now, entry.lastAdvancedAt); }
    }
    // All eligible moments compete; one blocked high-scoring item cannot hide another.
    const budgetAvailable = input.dailyAttemptLimit === undefined || data.attemptDate !== input.dayKey || (data.attemptCount ?? 0) < input.dailyAttemptLimit;
    const ready = data.entries.filter(entry => budgetAvailable && entry.status === "pending" && entry.wasEligible && entry.accumulated >= entry.threshold);
    ready.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.accumulated / b.threshold - a.accumulated / a.threshold || b.occurredAt - a.occurredAt);
    const selected = ready[0];
    if (selected) { selected.status = "selected"; selected.lastSelectedAt = now; selected.wasEligible = false; }
    // Keep deduplication tombstones throughout the source replay horizon.
    data.entries = data.entries.filter(entry => entry.expiresAt >= now - MAX_AGE || ["selected", "delivery_review", "delivery_partial", "delivery_unknown"].includes(entry.status));
    if (data.entries.length > MAX_ENTRIES) {
      // Refuse new work rather than forgetting prior accepted delivery identities.
      throw new Error("Initiative opportunity capacity exceeded");
    }
    this.resumed = true;
    if (before !== JSON.stringify(data) || !fs.existsSync(this.filePath)) this.write(data);
    return selected ? clone(selected) : undefined;
  }

  resolve(id: string, decision: "send" | "hold" | "drop" | "delivery_review" | "delivery_partial" | "delivery_unknown", input: {
    now: number; holdUntil?: number; resumeOn?: "user_message" | "evidence_change";
  }): boolean {
    const data = this.read();
    if (!data) return false;
    const entry = data.entries.find(item => item.key === id) ?? [...data.entries].reverse().find(item => item.id === id);
    if (!entry) return false;
    const next = decision === "send" ? "sent" : decision === "hold" ? "held" : decision === "drop" ? "dropped" : decision;
    if (entry.status === next) return true; // durable intent ACK cleanup may be replayed
    if (!["pending", "selected", "held"].includes(entry.status)) return false;
    entry.status = next;
    entry.lastAdvancedAt = input.now; entry.wasEligible = false;
    if (decision === "hold") {
      entry.resumeOn = input.resumeOn ?? "evidence_change";
      if (finite(input.holdUntil)) entry.holdUntil = Math.min(input.holdUntil, entry.expiresAt);
    } else { entry.finishedAt = input.now; }
    this.write(data);
    return true;
  }

  find(id: string, now?: number): InitiativeOpportunity | undefined {
    const entries = this.read()?.entries ?? [];
    const entry = entries.find(item => item.key === id) ?? [...entries].reverse().find(item => item.id === id);
    return entry && (now === undefined || entry.expiresAt > now) ? clone(entry) : undefined;
  }

  /** Count only real model attempts, not selection, suppression or UI reads. */
  markAttempt(id: string, now: number, dateKey: string, dailyLimit: number): boolean {
    if (!finite(now) || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Number.isSafeInteger(dailyLimit) || dailyLimit < 0) return false;
    const data = this.read();
    if (!data) return false;
    const entry = data.entries.find(item => item.key === id) ?? [...data.entries].reverse().find(item => item.id === id);
    if (!entry || entry.status !== "selected" || entry.expiresAt <= now || entry.lastAttemptSelectionAt !== undefined && entry.lastAttemptSelectionAt === entry.lastSelectedAt) return false;
    const count = data.attemptDate === dateKey ? data.attemptCount ?? 0 : 0;
    if (count >= dailyLimit) return false;
    data.attemptDate = dateKey; data.attemptCount = count + 1;
    entry.lastAttemptSelectionAt = entry.lastSelectedAt;
    this.write(data);
    return true;
  }

  resume(reason: "user_message", now: number): void {
    const data = this.read();
    if (!data) return;
    let changed = false;
    for (const entry of data.entries) if (entry.status === "held" && entry.resumeOn === reason && entry.expiresAt > now
      && (entry.holdUntil === undefined || entry.holdUntil > now)) {
      entry.status = "pending"; entry.accumulated = 0; entry.lastAdvancedAt = now; entry.wasEligible = false;
      delete entry.resumeOn; delete entry.holdUntil; changed = true;
    }
    if (changed) this.write(data);
  }

  /** Explicit shutdown, lock, busy, quiet hours and channel loss do not accrue pressure. */
  suspend(now: number): void {
    const data = this.read();
    if (!data) return;
    let changed = false;
    for (const entry of data.entries) if (entry.status === "pending") {
      if (entry.wasEligible || entry.lastAdvancedAt !== now) changed = true;
      entry.wasEligible = false; entry.lastAdvancedAt = Math.max(now, entry.lastAdvancedAt);
    }
    if (changed) this.write(data);
  }

  /** Pure reads must not tick the simulation, consume randomness or create opportunities. */
  readThoughts(input: { now: number; conversationId?: string; limit?: number } | number): InitiativeOpportunity[] {
    const options = typeof input === "number" ? { now: input } : input;
    const data = this.read();
    return (data?.entries ?? []).filter(entry => entry.status === "held" && entry.expiresAt > options.now
      && (!entry.holdUntil || entry.holdUntil > options.now)
      && (options.conversationId === undefined || entry.conversationId === options.conversationId))
      .sort((a, b) => b.occurredAt - a.occurredAt).slice(0, Math.max(0, Math.min(20, options.limit ?? 5))).map(clone);
  }

  summarize(input: { now: number; conversationId?: string; limit?: number } | number): string[] {
    return this.readThoughts(input).map(entry => entry.summary);
  }
}
