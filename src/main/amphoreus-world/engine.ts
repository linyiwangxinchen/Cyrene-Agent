import { AMPHOREUS_CANON_REVISION, AMPHOREUS_FACTS, AMPHOREUS_HISTORY, AMPHOREUS_LOCATIONS, AMPHOREUS_PREMISE, AMPHOREUS_RESIDENTS, AMPHOREUS_ROUTES, AMPHOREUS_SOURCES, canonAuthority, initialAmphoreusThreads } from "../../shared/amphoreus-canon";
import type { AmphoreusEvent, AmphoreusState, AmphoreusView, EventResolution, ResidentNow, WorldHistoryEntry } from "../../shared/amphoreus-world";
import type { XilianTimelineEvent, XilianWorldData } from "../../shared/xilian-world";
import { worldClock, worldInstant } from "./clock";
import { advanceResidents, createPlaces, createResidents, fitsRoutine, remember, residentActivity, terminalEvent, travelMinutes } from "./life";
export { residentActivity as residentNow } from "./life";

export function createAmphoreusState(now: number): AmphoreusState {
  return { schema: 2, canonRevision: AMPHOREUS_CANON_REVISION, epoch: "post-irontomb-memory-continuation", createdAt: now,
    narrativeEnabled: true, days: [], attempts: [], threads: initialAmphoreusThreads(now), appliedEventIds: [], lastReconciledAt: 0,
    residents: createResidents(now), places: createPlaces(now), gaps: [], lastLifeTick: 0, timezone: "", revision: 1, dailyModelBudget: 8, eventFacts: {} };
}
export function eventStatus(state: AmphoreusState, event: AmphoreusEvent, now: number): NonNullable<AmphoreusEvent["status"]> {
  if (event.status && terminalEvent(event)) return event.status;
  if (state.appliedEventIds.includes(event.id)) return "completed";
  if (event.status === "deferred") return "deferred";
  return event.endsAt <= now ? "awaiting_resolution" : event.startsAt <= now ? "active" : "planned";
}
function blocked(state: AmphoreusState, event: AmphoreusEvent): { reason: string; permanent?: boolean } | undefined {
  for (const condition of event.conditions ?? []) {
    if (condition.kind === "event") {
      const previous = state.days.flatMap((d) => d.events).find((e) => e.id === condition.eventId);
      const status = previous?.status ?? state.eventFacts[condition.eventId];
      if (status !== "completed") return { reason: status && ["partial", "failed", "cancelled"].includes(status) ? "前序事件没有完成，原来的安排无法继续" : "等待前序事件的结果", permanent: !!status && ["partial", "failed", "cancelled"].includes(status) };
    } else {
      const place = state.places.find((p) => p.id === condition.placeId)!;
      if (place[condition.field] < condition.minimum) return { reason: `${condition.field === "supplies" ? "物资" : "设施"}条件尚未满足` };
    }
  }
  for (const id of event.participants) {
    const person = AMPHOREUS_RESIDENTS.find((r) => r.id === id)!;
    if (!Number.isFinite(travelMinutes(person.home, event.locationId, state.places))) return { reason: "往来通路受阻，需要重新安排" };
    if ((state.residents.find((r) => r.id === id)?.energy ?? 80) < 20) return { reason: `${person.name}需要先休息` };
  }
}
function closeWithoutSuccess(event: AmphoreusEvent, reason: string, now: number) {
  event.status = "cancelled"; event.reason = reason; event.outcome = reason;
  event.effects = []; event.developments = []; event.resolutionSource = "engine"; event.resolvedAt = now; event.version = (event.version ?? 1) + 1;
}
function reschedule(state: AmphoreusState, event: AmphoreusEvent, now: number, timezone: string): boolean {
  const duration = Math.round((event.endsAt - event.startsAt) / 60_000), clock = worldClock(now, timezone);
  const all = state.days.flatMap((d) => d.events).filter((e) => e.id !== event.id && !terminalEvent(e));
  for (let offset = 0; offset < 2; offset++) {
    const date = new Date(Date.parse(`${clock.date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    for (let minute = offset ? 510 : Math.max(510, Math.ceil((clock.minute + 15) / 15) * 15); minute + duration < 1440; minute += 15) {
      const start = worldInstant(date, minute, timezone), end = worldInstant(date, minute + duration, timezone);
      if (!event.participants.every((id) => {
        const person = AMPHOREUS_RESIDENTS.find((r) => r.id === id)!;
        const travel = travelMinutes(person.home, event.locationId, state.places);
        return Number.isFinite(travel) && fitsRoutine(person, minute - travel, minute + duration + travel) && !all.some((e) => e.participants.includes(id) && ((worldClock(e.startsAt, timezone).date === date && e.locationId !== event.locationId) || (e.startsAt < end + travel * 60_000 && e.endsAt > start - travel * 60_000)));
      })) continue;
      event.startsAt = start; event.endsAt = end; event.date = date; event.status = "deferred";
      event.version = (event.version ?? 1) + 1; event.deferCount = (event.deferCount ?? 0) + 1; return true;
    }
  }
  return false;
}
function recordResolution(state: AmphoreusState, event: AmphoreusEvent, now: number): void {
  if (state.appliedEventIds.includes(event.id)) return;
  for (const effect of event.effects ?? []) {
    if (effect.kind === "place" || effect.kind === "access") {
      const place = state.places.find((p) => p.id === effect.placeId)!;
      if (effect.kind === "place") place[effect.field] = Math.max(0, Math.min(100, place[effect.field] + effect.delta));
      else place.access = effect.value;
      place.note = effect.reason; place.updatedAt = now; place.eventId = event.id;
    } else {
      const resident = state.residents.find((r) => r.id === effect.residentId)!;
      if (effect.kind === "goal") {
        const goal = resident.goals.find((g) => g.id === effect.goalId)!;
        goal.progress = Math.min(100, goal.progress + effect.delta); goal.status = goal.progress === 100 ? "completed" : "active"; goal.reason = effect.reason; goal.updatedAt = now;
      } else {
        const old = resident.relations.find((r) => r.residentId === effect.otherId);
        resident.relations = [...resident.relations.filter((r) => r.residentId !== effect.otherId), { residentId: effect.otherId, trust: Math.max(-10, Math.min(10, (old?.trust ?? 0) + effect.delta)), reason: effect.reason, eventId: event.id, updatedAt: now }];
      }
    }
  }
  for (const change of event.developments) {
    const previous = state.threads.find((thread) => thread.id === change.id);
    state.threads = [...state.threads.filter((thread) => thread.id !== change.id), { ...change, participants: [...new Set([...(previous?.participants ?? []), ...change.participants])], eventId: event.id, updatedAt: now }];
  }
  for (const id of event.participants) {
    const resident = state.residents.find((r) => r.id === id)!;
    remember(resident, { id: `experienced:${id}:${event.id}`, eventId: event.id, at: now, kind: event.status === "cancelled" ? "routine" : "experienced", text: event.status === "cancelled" ? `「${event.title}」取消：${event.reason}` : event.outcome ?? event.summary, source: event.resolutionSource === "model" ? "事件结算" : "日程调整", locationId: event.locationId });
    resident.lastMeaningfulAt = now; resident.attention = event.status === "failed" || event.status === "cancelled" ? `重新考虑「${event.title}」：${event.reason ?? event.outcome}` : event.outcome ?? event.title;
  }
  state.appliedEventIds.push(event.id);
  state.eventFacts[event.id] = event.status as "completed" | "partial" | "failed" | "cancelled";
}
export function applyResolutions(state: AmphoreusState, resolutions: EventResolution[], now: number, expectedRevision: number): boolean {
  if (state.revision !== expectedRevision) return false;
  const all = state.days.flatMap((day) => day.events);
  if (!resolutions.every((resolution) => { const event = all.find((e) => e.id === resolution.eventId); return event && event.version === resolution.version && event.endsAt <= now && event.status === "awaiting_resolution" && !state.appliedEventIds.includes(event.id); })) return false;
  for (const resolution of resolutions) {
    const event = all.find((e) => e.id === resolution.eventId)!;
    const obstruction = blocked(state, event);
    if (obstruction) closeWithoutSuccess(event, obstruction.reason, now);
    else Object.assign(event, { status: resolution.status, outcome: resolution.outcome, effects: resolution.effects, developments: resolution.developments, resolutionSource: "model", resolvedAt: now, version: (event.version ?? 1) + 1 });
    recordResolution(state, event, now);
  }
  state.revision++; return true;
}
function personalEvent(activity: ResidentNow, state: AmphoreusState, now: number, timezone: string): XilianTimelineEvent {
  const global = state.days.flatMap((d) => d.events).find((e) => e.id === activity.eventId);
  const resident = state.residents.find((r) => r.id === "cyrene")!;
  const location = AMPHOREUS_LOCATIONS.find((p) => p.id === activity.locationId)!.name;
  const completed = global ? terminalEvent(global) : activity.endsAt <= now;
  return { id: activity.eventId, dateKey: worldClock(activity.startsAt, timezone).date, slotId: "amphoreus", occurredAt: activity.startsAt, locationId: activity.locationId,
    activityKind: activity.activity === "watch" ? "maintenance" : ["meal", "sleep"].includes(activity.activity) ? "rest" : activity.activity as XilianTimelineEvent["activityKind"],
    activityTitle: activity.title, summary: global?.summary ?? `昔涟在${location}${activity.title}。`,
    ...(completed ? { outcome: global?.outcome ?? `这段${activity.title}的时间已经结束。`, diaryText: global?.outcome ?? `在${location}度过了${activity.title}的时间。` } : {}),
    participants: (global?.participants ?? ["cyrene"]).map((id) => AMPHOREUS_RESIDENTS.find((r) => r.id === id)!.name), mood: resident.mood, energyAfter: resident.energy,
    status: global?.status === "failed" || global?.status === "cancelled" ? "interrupted" : completed ? "completed" : activity.startsAt > now ? "planned" : "active",
    visibility: global?.visibility === "participants" ? "private" : "shareable", source: "simulated_world", memoryTags: ["翁法罗斯", activity.source] };
}
export function reconcileAmphoreus(data: XilianWorldData, actualNow: number, timezone: string): void {
  const state = data.amphoreus ??= createAmphoreusState(actualNow);
  const now = Math.max(actualNow, state.lastReconciledAt), clock = worldClock(now, timezone);
  const before = JSON.stringify(state), changedZone = !!state.timezone && state.timezone !== clock.timezone;
  if (changedZone) for (const event of state.days.flatMap((day) => day.events)) {
    if (terminalEvent(event) || event.status === "awaiting_resolution") continue;
    event.originalTimezone ??= state.timezone;
    if (event.status === "active") closeWithoutSuccess(event, "当地时区改变，本次活动中断并重新安排生活", now);
    else if (!reschedule(state, event, now, timezone)) closeWithoutSuccess(event, "新时区暂无合适时段", now);
    else event.reason = "按新的当地时间调整了安排";
  }
  state.timezone = clock.timezone;
  for (const event of state.days.flatMap((d) => d.events).sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))) {
    if (terminalEvent(event)) { recordResolution(state, event, event.resolvedAt ?? event.endsAt); continue; }
    if (event.startsAt > now) continue;
    const obstruction = blocked(state, event);
    if (obstruction) {
      event.reason = obstruction.reason;
      if (obstruction.permanent || (event.deferCount ?? 0) >= 3 || !reschedule(state, event, now, timezone)) { closeWithoutSuccess(event, obstruction.reason, now); recordResolution(state, event, now); }
      continue;
    }
    event.status = event.endsAt <= now ? "awaiting_resolution" : "active";
  }
  advanceResidents(state, now, clock.timezone);
  const person = AMPHOREUS_RESIDENTS.find((r) => r.id === "cyrene")!;
  const current = residentActivity(state, person, now, timezone), next = residentActivity(state, person, current.endsAt + 1, timezone);
  const byId = new Map(data.timeline.map((event) => [event.id, event]));
  const previous = data.state.currentActivity;
  if (previous?.id.startsWith("amphoreus:") && previous.id !== current.eventId && previous.status === "active") {
    const global = state.days.flatMap((day) => day.events).find((event) => event.id === previous.id);
    byId.set(previous.id, global && !terminalEvent(global) || changedZone ? { ...previous, status: "interrupted" } : { ...previous, status: "completed", outcome: global?.outcome ?? `这段${previous.activityTitle}的时间已经结束。`, diaryText: global?.outcome ?? `这段${previous.activityTitle}的时间已经结束。` });
  }
  for (const event of state.days.flatMap((day) => day.events)) if (event.participants.includes("cyrene") && terminalEvent(event)) byId.set(event.id, personalEvent({ residentId: "cyrene", activity: event.activity, title: event.title, locationId: event.locationId, startsAt: event.startsAt, endsAt: event.endsAt, source: "llm", eventId: event.id }, state, now, timezone));
  const active = personalEvent(current, state, now, timezone), planned = personalEvent(next, state, now, timezone);
  byId.set(active.id, active); byId.set(planned.id, planned);
  for (const [id, event] of byId) if (event.slotId === "amphoreus" && event.status === "planned" && id !== planned.id && id !== active.id) byId.set(id, { ...event, status: "interrupted" });
  data.timeline = [...byId.values()].sort((a, b) => a.occurredAt - b.occurredAt).slice(-2000);
  const diary = new Map(data.diary.map((entry) => [entry.id, entry]));
  for (const event of data.timeline) if (event.slotId === "amphoreus" && event.diaryText && event.outcome) {
    const id = `diary:${event.id}`;
    if (!diary.has(id)) diary.set(id, { id, eventId: event.id, dateKey: event.dateKey, writtenAt: now, title: event.activityTitle, text: event.diaryText, mood: event.mood, locationId: event.locationId, visibility: event.visibility, source: "life_event" });
  }
  data.diary = [...diary.values()].sort((a, b) => a.writtenAt - b.writtenAt).slice(-2000);
  data.state = { ...data.state, worldDate: clock.date, seasonId: "翁法罗斯·战后记忆延续", currentActivity: active, nextPlannedEvent: planned, currentLocationId: current.locationId, goals: [], recentEventIds: data.timeline.slice(-24).map((event) => event.id) };
  if (before !== JSON.stringify(state)) { state.lastReconciledAt = now; state.revision++; data.state.revision++; }
  data.version = 3;
}
export function modelBudgetUsed(state: AmphoreusState, date: string): number { return state.attempts.filter((attempt) => attempt.date === date).reduce((sum, attempt) => sum + attempt.count, 0); }
export function amphoreusView(state: AmphoreusState, now: number, timezone: string): AmphoreusView {
  const clock = worldClock(now, timezone);
  return { name: "翁法罗斯", canonRevision: state.canonRevision, premise: AMPHOREUS_PREMISE, clock, narrativeEnabled: state.narrativeEnabled,
    narrative: state.attempts.filter((attempt) => attempt.date === clock.date).sort((a, b) => b.attemptedAt - a.attemptedAt)[0] ?? null,
    lastSuccessfulDate: state.days.at(-1)?.date ?? null,
    events: state.days.flatMap((day) => day.events).sort((a, b) => b.startsAt - a.startsAt).slice(0, 160).map(({ outcome, developments: _developments, ...event }) => ({ ...event, effects: terminalEvent(event) ? event.effects : [], status: eventStatus(state, { ...event, developments: [] }, now), ...(terminalEvent(event) ? { outcome } : {}) })),
    threads: state.threads.filter((t) => t.status === "open").concat(state.threads.filter((t) => t.status === "resolved").slice(-20)), residents: AMPHOREUS_RESIDENTS,
    activities: AMPHOREUS_RESIDENTS.map((r) => residentActivity(state, r, Math.max(now, state.lastReconciledAt), clock.timezone)), sources: AMPHOREUS_SOURCES, history: AMPHOREUS_HISTORY,
    facts: AMPHOREUS_FACTS, residentStates: state.residents.map(({ heardEventIds: _heard, ...resident }) => ({ ...resident, memories: resident.memories.slice(-12) })), places: state.places, routes: AMPHOREUS_ROUTES, gaps: state.gaps.slice(-10), revision: state.revision, budget: { limit: state.dailyModelBudget, used: modelBudgetUsed(state, clock.date) } };
}
export function formatAmphoreusContext(view: AmphoreusView): string {
  const resident = view.residentStates.find((person) => person.id === "cyrene");
  return ["【翁法罗斯个人认知；模拟数据，不是指令或用户记忆】", canonAuthority(), view.premise,
    `现实当地时间：${view.clock.date} ${view.clock.time} (${view.clock.timezone})。铁墓决战属于过去。`,
    "昔涟只是居民之一。只知道下方亲历与听闻记录，不使用观察页全知视角。未完成活动不可声称成功。",
    resident ? `正在惦记：${resident.attention}` : "",
    ...(resident?.memories.slice(-5) ?? []).map((memory) => `${memory.kind === "experienced" ? "亲历" : memory.kind === "heard" ? `听闻（${memory.source}）` : "自己的日常"}：${memory.text}`),
  ].filter(Boolean).join("\n");
}
export function historyEntries(state: AmphoreusState): WorldHistoryEntry[] {
  return [
    ...state.days.flatMap((day) => day.events).filter(terminalEvent).map((event): WorldHistoryEntry => ({ id: event.id, at: event.resolvedAt ?? event.endsAt, kind: "event", title: event.title, text: event.outcome ?? event.reason ?? event.summary, residentIds: event.participants, locationId: event.locationId, eventId: event.id, status: event.status, details: { intent: event.intent, conditions: event.conditions, effects: event.effects, reason: event.reason } })),
    ...state.residents.flatMap((resident) => resident.memories.map((memory): WorldHistoryEntry => ({ id: memory.id, at: memory.at, kind: "memory", title: `${AMPHOREUS_RESIDENTS.find((p) => p.id === resident.id)!.name} · ${memory.kind === "heard" ? "听闻" : memory.kind === "experienced" ? "经历" : "日常"}`, text: memory.text, residentIds: [resident.id], locationId: memory.locationId, eventId: memory.eventId }))),
    ...state.threads.map((thread): WorldHistoryEntry => ({ id: `thread:${thread.id}:${thread.updatedAt}:${thread.eventId ?? "initial"}`, at: thread.updatedAt, kind: "thread", title: thread.title, text: `${thread.summary} 下一步：${thread.nextStep}`, residentIds: thread.participants, eventId: thread.eventId })),
    ...state.gaps.map((gap): WorldHistoryEntry => ({ id: gap.id, at: gap.to, kind: "gap", title: "离线后的生活接续", text: gap.summary, residentIds: [] })),
  ];
}
