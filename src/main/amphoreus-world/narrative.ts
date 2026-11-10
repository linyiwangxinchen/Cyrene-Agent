import { AMPHOREUS_LOCATIONS, AMPHOREUS_RESIDENTS, expandResidentIds } from "../../shared/amphoreus-canon";
import type { AmphoreusDay, AmphoreusEvent, AmphoreusState, AmphoreusThread, EventCondition, EventResolution, ResidentActivity, WorldEffect } from "../../shared/amphoreus-world";
import { worldClock, worldInstant, worldTimezone } from "./clock";
import { fitsRoutine, travelMinutes } from "./life";
import { boundedText as text, check, finite as number, list, record, storyText, jsonObject, onlyKeys } from "./canon-guard";
export { InvalidNarrative, FutureWorldVersion } from "./canon-guard";
export { readAmphoreusState } from "./state";
export { narrativeMessages, resolutionMessages, reviewMessages } from "./prompts";

export function members(value: unknown, legacy = false, maximum = 12): string[] {
  let ids = list(value, 1, maximum).map((v) => text(v, 80));
  if (legacy) ids = expandResidentIds(ids);
  check(new Set(ids).size === ids.length && ids.every((id) => AMPHOREUS_RESIDENTS.some((r) => r.id === id))); return ids;
}
export function place(value: unknown): string { const id = text(value, 80); check(AMPHOREUS_LOCATIONS.some((p) => p.id === id)); return id; }
export function parseThread(value: unknown, legacy = false): Omit<AmphoreusThread, "updatedAt"> {
  const raw = record(value), id = text(raw.id, 80);
  check(/^[a-z][a-z0-9-]*$/.test(id) && (raw.status === "open" || raw.status === "resolved"));
  const read = legacy ? text : storyText;
  return { id, title: read(raw.title, 100), summary: read(raw.summary, 500), nextStep: read(raw.nextStep, 300), participants: members(raw.participants, legacy, AMPHOREUS_RESIDENTS.length), status: raw.status,
    ...(typeof raw.eventId === "string" ? { eventId: raw.eventId } : {}) };
}
export function parseConditions(value: unknown): EventCondition[] {
  return list(value ?? [], 0, 5).map((entry) => {
    const raw = record(entry);
    if (raw.kind === "event") { onlyKeys(raw, ["kind", "eventId"]); return { kind: "event", eventId: text(raw.eventId, 160) }; }
    onlyKeys(raw, ["kind", "placeId", "field", "minimum"]);
    check(raw.kind === "place" && (raw.field === "condition" || raw.field === "supplies"));
    const minimum = number(raw.minimum); check(minimum >= 0 && minimum <= 100);
    return { kind: "place", placeId: place(raw.placeId), field: raw.field, minimum };
  });
}
export function eventFields(raw: Record<string, unknown>, legacy = false) {
  check(["work", "study", "social", "watch", "travel", "rest"].includes(raw.activity as string));
  check(["routine", "notable", "major"].includes(raw.severity as string));
  const read = legacy ? text : storyText;
  return { locationId: place(raw.locationId), participants: members(raw.participants, legacy), activity: raw.activity as ResidentActivity,
    severity: raw.severity as AmphoreusEvent["severity"], title: read(raw.title, 100), summary: read(raw.summary, 500) };
}
export function neglectedResidents(state: AmphoreusState, now: number): string[] {
  const last = (id: string) => Math.max(state.createdAt, ...state.days.flatMap((day) => day.events).filter((event) => event.participants.includes(id) && event.status !== "cancelled").map((event) => event.startsAt));
  return AMPHOREUS_RESIDENTS.filter((person) => now - last(person.id) >= 7 * 86_400_000).sort((a, b) => last(a.id) - last(b.id) || a.id.localeCompare(b.id)).map((r) => r.id);
}
export function parseDailyPlan(output: string, date: string, timezone: string, now: number, state?: AmphoreusState): AmphoreusDay {
  const raw = jsonObject(output); onlyKeys(raw, ["date", "events"]); check(raw.date === date);
  const events: AmphoreusEvent[] = list(raw.events, 3, 8).map((value, index) => {
    const entry = record(value);
    onlyKeys(entry, ["startMinute", "durationMinutes", "locationId", "participants", "activity", "severity", "title", "summary", "intent", "conditions", "visibility"]);
    const start = number(entry.startMinute), duration = number(entry.durationMinutes);
    check(Number.isInteger(start) && Number.isInteger(duration) && duration >= 15 && duration <= 90);
    const fields = eventFields(entry);
    for (const id of fields.participants) {
      const person = AMPHOREUS_RESIDENTS.find((r) => r.id === id)!;
      const travel = travelMinutes(person.home, fields.locationId, state?.places);
      check(Number.isFinite(travel) && fitsRoutine(person, start - travel, start + duration + travel));
    }
    const startsAt = worldInstant(date, start, timezone), endsAt = worldInstant(date, start + duration, timezone);
    check(worldClock(startsAt, timezone).minute === start && endsAt > startsAt);
    check(entry.visibility === undefined || entry.visibility === "public" || entry.visibility === "participants");
    return { ...fields, id: `amphoreus:${date}:${index}`, date, startsAt, endsAt, status: "planned", version: 1,
      intent: storyText(entry.intent ?? entry.summary, 300), conditions: parseConditions(entry.conditions), developments: [], effects: [], visibility: entry.visibility === "participants" ? "participants" : "public" };
  });
  const existing = state?.days.flatMap((day) => day.events).filter((event) => event.date === date && event.status !== "cancelled") ?? [];
  validateEnsemble(events);
  if (existing.length) validateEnsemble([...existing, ...events]);
  for (const event of events) for (const condition of event.conditions ?? []) if (condition.kind === "event") {
    condition.eventId = condition.eventId.replace(/^today:(\d+)$/, `amphoreus:${date}:$1`);
    const previous = [...events, ...(state?.days.flatMap((d) => d.events) ?? [])].find((e) => e.id === condition.eventId);
    check(previous ? previous.endsAt <= event.startsAt && previous.id !== event.id : !!state?.eventFacts[condition.eventId]);
  }
  if (state) {
    const overdue = neglectedResidents(state, now).slice(0, 3);
    if (overdue.length) check(events.some((event) => event.participants.some((id) => overdue.includes(id))));
  }
  return { date, timezone: worldTimezone(timezone), generatedAt: now, events: events.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id)) };
}
function validateEnsemble(events: AmphoreusEvent[]): void {
  const ids = new Set(events.flatMap((e) => e.participants));
  check(ids.size >= 6 && new Set(events.map((e) => e.locationId)).size >= 2);
  check(AMPHOREUS_RESIDENTS.some((r) => r.kind === "npc" && ids.has(r.id)));
  check(events.filter((e) => e.participants.includes("cyrene")).length <= 1);
  for (const id of ids) {
    const assigned = events.filter((e) => e.participants.includes(id)).sort((a, b) => a.startsAt - b.startsAt);
    check(new Set(assigned.map((e) => e.locationId)).size <= 1 && assigned.every((e, i) => !i || assigned[i - 1].endsAt <= e.startsAt));
  }
}
export function parseEffect(value: unknown, event: AmphoreusEvent, state: AmphoreusState): WorldEffect {
  const raw = record(value), reason = storyText(raw.reason, 200);
  if (raw.kind === "place") {
    onlyKeys(raw, ["kind", "placeId", "field", "delta", "reason"]);
    check(raw.field === "condition" || raw.field === "supplies"); const delta = number(raw.delta); check(Number.isInteger(delta) && Math.abs(delta) <= 20);
    const placeId = place(raw.placeId); check(placeId === event.locationId);
    return { kind: "place", placeId, field: raw.field, delta, reason };
  }
  if (raw.kind === "access") {
    onlyKeys(raw, ["kind", "placeId", "value", "reason"]); const placeId = place(raw.placeId); check(placeId === event.locationId && ["open", "limited", "closed"].includes(raw.value as string));
    return { kind: "access", placeId, value: raw.value as "open" | "limited" | "closed", reason };
  }
  const residentId = text(raw.residentId, 80); check(event.participants.includes(residentId));
  const delta = number(raw.delta); check(Number.isInteger(delta));
  if (raw.kind === "goal") {
    onlyKeys(raw, ["kind", "residentId", "goalId", "delta", "reason"]);
    const goalId = text(raw.goalId, 160); check(delta >= 0 && delta <= 20 && state.residents.find((r) => r.id === residentId)?.goals.some((g) => g.id === goalId));
    return { kind: "goal", residentId, goalId, delta, reason };
  }
  onlyKeys(raw, ["kind", "residentId", "otherId", "delta", "reason"]);
  const otherId = text(raw.otherId, 80); check(raw.kind === "relationship" && Math.abs(delta) <= 2 && residentId !== otherId && event.participants.includes(otherId));
  return { kind: "relationship", residentId, otherId, delta, reason };
}
export function parseResolutions(output: string, pending: AmphoreusEvent[], state: AmphoreusState): EventResolution[] {
  const raw = jsonObject(output); onlyKeys(raw, ["resolutions"]);
  const resolutions = list(raw.resolutions, pending.length, pending.length).map((value): EventResolution => {
    const entry = record(value); onlyKeys(entry, ["eventId", "version", "status", "outcome", "effects", "developments"]);
    const eventId = text(entry.eventId, 160), event = pending.find((candidate) => candidate.id === eventId);
    check(event && number(entry.version) === event.version && ["completed", "partial", "failed"].includes(entry.status as string));
    const effects = list(entry.effects ?? [], 0, 8).map((change) => parseEffect(change, event, state));
    const targets = effects.map((change) => change.kind === "place" ? `place:${change.placeId}:${change.field}` : change.kind === "access" ? `access:${change.placeId}` : change.kind === "goal" ? `goal:${change.residentId}:${change.goalId}` : `relationship:${change.residentId}:${change.otherId}`);
    check(new Set(targets).size === targets.length);
    if (entry.status === "failed") check(effects.every((change) => change.kind === "relationship" || (change.kind === "goal" && change.delta <= 3) || (change.kind === "place" && change.delta <= 0)));
    const developments = list(entry.developments ?? [], 0, 3).map((change) => parseThread(change));
    check(new Set(developments.map((change) => change.id)).size === developments.length);
    for (const change of developments) {
      const previous = state.threads.find((thread) => thread.id === change.id);
      check(change.participants.every((id) => event.participants.includes(id)) && (entry.status !== "failed" || change.status !== "resolved"));
      check(!previous || previous.participants.some((id) => event.participants.includes(id)));
    }
    return { eventId, version: event.version!, status: entry.status as EventResolution["status"], outcome: storyText(entry.outcome, 600), effects, developments };
  });
  check(new Set(resolutions.map((resolution) => resolution.eventId)).size === pending.length);
  return resolutions;
}
