import { AMPHOREUS_LOCATIONS, AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import type { AmphoreusEvent, AmphoreusState } from "../../shared/amphoreus-world";
import { createAmphoreusState } from "./engine";
import { worldTimezone } from "./clock";
import { boundedText as text, check, finite as number, list, record, FutureWorldVersion } from "./canon-guard";
import { eventFields, parseConditions, parseEffect, parseThread, place } from "./narrative";

/** Retain completed history; predictions from schema 1 do not become completed facts. */
export function readAmphoreusState(value: unknown, now: number): AmphoreusState {
  if (value === undefined) return createAmphoreusState(now);
  const raw = record(value);
  if (typeof raw.schema === "number" && raw.schema > 2) throw new FutureWorldVersion();
  check([1, 2].includes(raw.schema as number) && raw.epoch === "post-irontomb-memory-continuation" && typeof raw.narrativeEnabled === "boolean");
  const legacy = raw.schema === 1, state = createAmphoreusState(number(raw.createdAt));
  const date = (v: unknown) => { const d = text(v, 10); check(/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d))); return d; };
  const applied = list(raw.appliedEventIds, 0, 5000).map((id) => text(id, 160));
  state.days = list(raw.days, 0, 10000).map((value) => {
    const day = record(value), dayDate = date(day.date);
    const events = list(day.events, 0, 8).map((v): AmphoreusEvent => {
      const entry = record(v), id = text(entry.id, 160), startsAt = number(entry.startsAt), endsAt = number(entry.endsAt);
      check(endsAt > startsAt && endsAt - startsAt <= 90 * 60_000); const eventDate = date(entry.date);
      const status = legacy ? applied.includes(id) ? "completed" : "planned" : entry.status;
      check(["planned", "deferred", "active", "awaiting_resolution", "completed", "partial", "failed", "cancelled"].includes(status as string));
      return { ...eventFields(entry, true), id, date: eventDate, startsAt, endsAt, status: status as AmphoreusEvent["status"], version: legacy ? 1 : number(entry.version),
        intent: typeof entry.intent === "string" ? text(entry.intent, 300) : text(entry.summary, 500), conditions: parseConditions(entry.conditions),
        visibility: entry.visibility === "participants" ? "participants" : "public", developments: (!legacy || applied.includes(id)) ? list(entry.developments ?? [], 0, 3).map((v) => parseThread(v, true)) : [],
        ...(typeof entry.outcome === "string" && (!legacy || applied.includes(id)) ? { outcome: text(entry.outcome, 600) } : {}),
        effects: legacy ? [] : list(entry.effects ?? [], 0, 8) as AmphoreusEvent["effects"], resolutionSource: legacy ? "legacy" : entry.resolutionSource as AmphoreusEvent["resolutionSource"],
        ...(legacy && applied.includes(id) ? { resolvedAt: endsAt } : typeof entry.resolvedAt === "number" ? { resolvedAt: number(entry.resolvedAt) } : {}),
        ...(typeof entry.reason === "string" ? { reason: text(entry.reason, 400) } : {}),
        ...(typeof entry.deferCount === "number" ? { deferCount: number(entry.deferCount) } : {}),
        ...(typeof entry.originalTimezone === "string" ? { originalTimezone: text(entry.originalTimezone, 100) } : {}),
      };
    });
    return { date: dayDate, timezone: worldTimezone(text(day.timezone, 100)), generatedAt: number(day.generatedAt), events };
  });
  check(new Set(state.days.map((day) => day.date)).size === state.days.length);
  const ids = state.days.flatMap((day) => day.events.map((event) => event.id)); check(new Set(ids).size === ids.length);
  state.appliedEventIds = applied.filter((id) => ids.includes(id));
  for (const event of state.days.flatMap((day) => day.events)) if (applied.includes(event.id)) state.eventFacts[event.id] = event.status as "completed" | "partial" | "failed" | "cancelled";
  state.threads = list(raw.threads, 0, 100_000).map((value) => ({ ...parseThread(value, true), updatedAt: number(record(value).updatedAt) }));
  state.attempts = list(raw.attempts, 0, 1500).map((value) => {
    const entry = record(value), count = number(entry.count); check(Number.isInteger(count) && count >= 0 && count <= 3);
    check(["pending", "generating", "success", "failed", "unconfigured", "cancelled"].includes(entry.status as string));
    check(entry.error === undefined || ["invalid_output", "request_failed", "interrupted"].includes(entry.error as string));
    return { date: date(entry.date), timezone: worldTimezone(text(entry.timezone, 100)), count, status: entry.status as AmphoreusState["attempts"][number]["status"], attemptedAt: number(entry.attemptedAt), retryAt: number(entry.retryAt),
      key: typeof entry.key === "string" ? text(entry.key, 300) : `plan:${entry.date}`, purpose: entry.purpose === "resolve" ? "resolve" as const : "plan" as const,
      ...(entry.error ? { error: entry.error as "invalid_output" | "request_failed" | "interrupted" } : {}),
      ...(Array.isArray(entry.eventIds) ? { eventIds: entry.eventIds.map((id) => text(id, 160)) } : {}),
    };
  });
  state.narrativeEnabled = raw.narrativeEnabled; state.lastReconciledAt = number(raw.lastReconciledAt);
  if (!legacy) {
    const residents = list(raw.residents, AMPHOREUS_RESIDENTS.length, AMPHOREUS_RESIDENTS.length);
    check(new Set(residents.map((r) => record(r).id)).size === AMPHOREUS_RESIDENTS.length);
    for (const value of residents) {
      const resident = record(value), target = state.residents.find((r) => r.id === resident.id); check(target);
      Object.assign(target, resident); check(number(target.energy) >= 0 && target.energy <= 100);
      target.heardEventIds = list(resident.heardEventIds ?? target.memories.filter((m) => m.kind === "heard").map((m) => m.eventId), 0, 10000).map((id) => text(id, 160));
      target.locationId = place(target.locationId); target.mood = text(target.mood, 100); target.attention = text(target.attention, 600);
      for (const goal of list(target.goals, 0, 100)) { const g = record(goal); text(g.id, 160); text(g.title, 200); check(number(g.progress) >= 0 && number(g.progress) <= 100 && ["active", "completed"].includes(g.status as string)); number(g.updatedAt); text(g.reason, 300); }
      for (const memory of list(target.memories, 0, 10000)) { const m = record(memory); text(m.id, 250); text(m.eventId, 160); number(m.at); check(["experienced", "heard", "routine"].includes(m.kind as string)); text(m.text, 800); text(m.source, 150); place(m.locationId); }
      for (const relation of list(target.relations, 0, 100)) { const r = record(relation); check(AMPHOREUS_RESIDENTS.some((p) => p.id === r.residentId) && Math.abs(number(r.trust)) <= 10); text(r.reason, 200); number(r.updatedAt); }
      number(target.updatedAt); number(target.lastMeaningfulAt); check(typeof target.lastRoutineDate === "string");
    }
    state.places = list(raw.places, AMPHOREUS_LOCATIONS.length, AMPHOREUS_LOCATIONS.length).map((value) => {
      const p = record(value); check(["open", "limited", "closed"].includes(p.access as string));
      check(number(p.condition) >= 0 && number(p.condition) <= 100 && number(p.supplies) >= 0 && number(p.supplies) <= 100);
      return { id: place(p.id), access: p.access as "open" | "limited" | "closed", condition: p.condition as number, supplies: p.supplies as number, note: text(p.note, 500), updatedAt: number(p.updatedAt), ...(typeof p.eventId === "string" ? { eventId: p.eventId } : {}) };
    });
    check(new Set(state.places.map((p) => p.id)).size === AMPHOREUS_LOCATIONS.length);
    state.gaps = list(raw.gaps, 0, 5000).map((value) => { const gap = record(value); return { id: text(gap.id, 160), from: number(gap.from), to: number(gap.to), summary: text(gap.summary, 600), source: "offline" }; });
    state.lastLifeTick = number(raw.lastLifeTick); state.timezone = typeof raw.timezone === "string" && raw.timezone ? worldTimezone(raw.timezone) : "";
    state.revision = number(raw.revision); state.dailyModelBudget = number(raw.dailyModelBudget); check(state.dailyModelBudget >= 3 && state.dailyModelBudget <= 24);
    for (const [id, status] of Object.entries(record(raw.eventFacts ?? {}))) { check(["completed", "partial", "failed", "cancelled"].includes(String(status))); state.eventFacts[text(id, 160)] = status as "completed" | "partial" | "failed" | "cancelled"; }
    for (const event of state.days.flatMap((day) => day.events)) event.effects = event.effects?.map((change) => parseEffect(change, event, state));
  }
  if (legacy) for (const event of state.days.flatMap((day) => day.events)) if (event.outcome && applied.includes(event.id)) for (const id of event.participants) {
    const resident = state.residents.find((r) => r.id === id)!;
    resident.memories.push({ id: `experienced:${id}:${event.id}`, eventId: event.id, at: event.endsAt, kind: "experienced", text: event.outcome, source: "历史迁移", locationId: event.locationId });
    resident.lastMeaningfulAt = Math.max(resident.lastMeaningfulAt, event.endsAt);
  }
  return state;
}
