import { AMPHOREUS_LOCATIONS, AMPHOREUS_RESIDENTS, AMPHOREUS_ROUTES } from "../../shared/amphoreus-canon";
import type { AmphoreusEvent, AmphoreusResident, AmphoreusState, PlaceState, ResidentActivity, ResidentMemory, ResidentNow, ResidentState } from "../../shared/amphoreus-world";
import { worldClock, worldInstant } from "./clock";

const HALF_HOUR = 30 * 60_000;
export const terminalEvent = (event: Pick<AmphoreusEvent, "status">) => ["completed", "partial", "failed", "cancelled"].includes(event.status ?? "");
export function createResidents(now: number): ResidentState[] {
  return AMPHOREUS_RESIDENTS.map((person) => ({ id: person.id, energy: 80, mood: "平静", attention: person.aspiration, locationId: person.home,
    goals: (person.dailyInterests ?? [person.occupation]).map((title, index) => ({ id: `${person.id}:personal:${index}`, title, progress: 0, status: "active", updatedAt: now, reason: "项目延续中的个人愿望" })),
    memories: [], relations: [], heardEventIds: [], lastMeaningfulAt: 0, lastRoutineDate: "", updatedAt: now }));
}
export function createPlaces(now: number): PlaceState[] {
  return AMPHOREUS_LOCATIONS.map((place) => ({ id: place.id, access: "open", condition: 75, supplies: 70, note: "项目延续起点：维持基本生活与往来。", updatedAt: now }));
}
export function routineProfile(id: string) {
  const index = Math.max(0, AMPHOREUS_RESIDENTS.findIndex((r) => r.id === id));
  return { wake: 390 + index % 4 * 15, lunch: 720 + index % 3 * 15, dinner: 1080 + index % 3 * 15, bed: 1350 + index % 4 * 15 };
}
interface Slot { start: number; end: number; activity: ResidentActivity; title: string }
export function routineSlots(person: AmphoreusResident, state?: ResidentState, date = ""): Slot[] {
  const profile = routineProfile(person.id);
  const day = Math.floor(Date.parse(date || "2026-01-01") / 86_400_000);
  const goals = state?.goals.filter((g) => g.status === "active") ?? [];
  const goal = goals.length ? goals[Math.abs(day + Math.floor((100 - (state?.energy ?? 80)) / 20)) % goals.length] : undefined;
  const title = goal?.title ?? person.occupation;
  const tired = (state?.energy ?? 80) < 28;
  return [
    { start: 0, end: profile.wake, activity: "sleep", title: "夜间睡眠" },
    { start: profile.wake, end: profile.wake + 45, activity: "meal", title: "吃早餐" },
    { start: profile.wake + 45, end: 510, activity: "rest", title: "整理心绪，安排今天" },
    { start: 510, end: profile.lunch, activity: tired ? "rest" : person.activity, title: tired ? "休息一下，稍后再继续" : title },
    { start: profile.lunch, end: profile.lunch + 45, activity: "meal", title: "吃午餐" },
    { start: profile.lunch + 45, end: profile.lunch + 75, activity: "rest", title: "午间休息" },
    { start: profile.lunch + 75, end: profile.dinner, activity: tired ? "rest" : person.activity, title: tired ? "恢复体力，调整安排" : title },
    { start: profile.dinner, end: profile.dinner + 45, activity: "meal", title: "吃晚餐" },
    { start: profile.dinner + 45, end: profile.bed - 45, activity: "social", title: state?.relations.length ? "与熟悉的人相处，也留些自己的时间" : "散步、交谈与自由活动" },
    { start: profile.bed - 45, end: profile.bed, activity: "rest", title: "安静下来，准备休息" },
    { start: profile.bed, end: 1440, activity: "sleep", title: "夜间睡眠" },
  ];
}
export function fitsRoutine(person: AmphoreusResident, start: number, end: number): boolean {
  return routineSlots(person).some((slot) => !["sleep", "meal", "rest"].includes(slot.activity) && start >= slot.start && end <= slot.end);
}
export function travelMinutes(from: string, to: string, places?: PlaceState[]): number {
  if (from === to) return 0;
  if (places?.some((p) => p.id === from && p.access === "closed")) return Infinity;
  const distance = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    queue.sort((a, b) => distance.get(a)! - distance.get(b)!);
    const current = queue.shift()!;
    if (current === to) return distance.get(current)!;
    for (const edge of AMPHOREUS_ROUTES) {
      const next = edge.from === current ? edge.to : edge.to === current ? edge.from : undefined;
      if (!next || places?.some((p) => p.id === next && p.access === "closed")) continue;
      const duration = edge.minutes * (places?.some((p) => (p.id === next || p.id === current) && p.access === "limited") ? 2 : 1);
      const candidate = distance.get(current)! + duration;
      if (candidate < (distance.get(next) ?? Infinity)) { distance.set(next, candidate); queue.push(next); }
    }
  }
  return Infinity;
}

export function residentActivity(state: AmphoreusState, person: AmphoreusResident, now: number, timezone: string): ResidentNow {
  const clock = worldClock(now, timezone);
  const resident = state.residents.find((r) => r.id === person.id);
  const slot = routineSlots(person, resident, clock.date).find((s) => s.start <= clock.minute && s.end > clock.minute)!;
  const events = state.days.flatMap((day) => day.events).filter((event) => event.participants.includes(person.id) && event.status !== "cancelled").sort((a, b) => a.startsAt - b.startsAt);
  const today = events.filter((event) => worldClock(event.startsAt, timezone).date === clock.date);
  let startsAt = worldInstant(clock.date, slot.start, timezone);
  let endsAt = worldInstant(clock.date, slot.end, timezone);
  let locationId = person.home;
  if (!["sleep", "meal", "rest"].includes(slot.activity)) {
    const current = today.find((event) => event.startsAt <= now && event.endsAt > now && !terminalEvent(event));
    if (current) return { residentId: person.id, activity: current.activity, title: current.title, locationId: current.locationId, startsAt: current.startsAt, endsAt: current.endsAt, source: "llm", eventId: current.id };
    const first = today[0], last = today.at(-1);
    if (first && last) {
      const duration = travelMinutes(person.home, first.locationId, state.places) * 60_000;
      if (Number.isFinite(duration) && duration > 0) {
        const departure = first.startsAt - duration;
        const returnAt = last.endsAt + duration;
        if (now >= departure && now < first.startsAt) return { residentId: person.id, activity: "travel", title: `前往${AMPHOREUS_LOCATIONS.find((p) => p.id === first.locationId)!.name}`, locationId: person.home, startsAt: departure, endsAt: first.startsAt, source: "routine", eventId: `amphoreus:travel:${person.id}:${first.id}:out` };
        if (now >= last.endsAt && now < returnAt) return { residentId: person.id, activity: "travel", title: "结束今天的往来，返回住处", locationId: last.locationId, startsAt: last.endsAt, endsAt: returnAt, source: "routine", eventId: `amphoreus:travel:${person.id}:${last.id}:return` };
        if (now < departure && departure < endsAt) endsAt = departure;
        if (now >= returnAt && returnAt > startsAt) startsAt = returnAt;
      }
      if (now >= first.startsAt && now < last.endsAt) locationId = first.locationId;
    }
  }
  // Meal/rest location follows the visit, provided the route is available.
  if (slot.activity !== "sleep" && today[0] && now >= today[0].startsAt && now < today.at(-1)!.endsAt) locationId = today[0].locationId;
  for (const event of today) {
    if (event.endsAt <= now && event.endsAt > startsAt) startsAt = event.endsAt;
    if (event.startsAt > now && event.startsAt < endsAt) endsAt = event.startsAt;
  }
  return { residentId: person.id, activity: slot.activity, title: slot.title, locationId, startsAt, endsAt, source: "routine", eventId: `amphoreus:routine:${person.id}:${startsAt}` };
}

export function remember(resident: ResidentState, memory: ResidentMemory): void {
  if (resident.memories.some((entry) => entry.id === memory.id)) return;
  resident.memories.push(memory);
  resident.updatedAt = Math.max(resident.updatedAt, memory.at);
}

/** Half-hour checkpoints keep physiology persistent without writing on each minute. */
export function advanceResidents(state: AmphoreusState, now: number, timezone: string): void {
  const bucket = Math.floor(now / HALF_HOUR) * HALF_HOUR;
  if (bucket <= state.lastLifeTick) return;
  const previous = state.lastLifeTick || now;
  const clock = worldClock(now, timezone);
  const samples: Array<{ at: number; date: string; minute: number }> = [];
  for (let sample = Math.max(previous, bucket - 24 * 3_600_000) + HALF_HOUR; sample <= bucket; sample += HALF_HOUR) samples.push({ at: sample - 1, ...worldClock(sample - 1, timezone) });
  const publicEvents = state.days.flatMap((day) => day.events);
  if (now - previous > 6 * 3_600_000 && worldClock(previous, timezone).date !== clock.date) {
    const id = `gap:${previous}:${bucket}`;
    if (!state.gaps.some((gap) => gap.id === id)) state.gaps.push({ id, from: previous, to: now, source: "offline", summary: "离线期间按既有作息恢复生活；公共事项仍以已经验证的结果为准。恢复后继续未结事务。" });
  }
  for (const person of AMPHOREUS_RESIDENTS) {
    const resident = state.residents.find((r) => r.id === person.id)!;
    const visits = publicEvents.filter((event) => event.participants.includes(person.id) && event.status !== "cancelled" && event.endsAt >= bucket - 24 * 3_600_000);
    for (const sample of samples) {
      const slot = routineSlots(person, resident, sample.date).find((s) => s.start <= sample.minute && s.end > sample.minute)!;
      const event = visits.find((e) => e.startsAt <= sample.at && e.endsAt > sample.at);
      const activity = !["meal", "sleep", "rest"].includes(slot.activity) && event ? event.activity : slot.activity;
      const delta = activity === "sleep" ? 5 : activity === "meal" ? 6 : activity === "rest" ? 3 : activity === "social" ? -1 : -2;
      resident.energy = Math.max(10, Math.min(100, resident.energy + delta));
    }
    const activity = residentActivity(state, person, now, timezone);
    resident.locationId = activity.locationId;
    resident.mood = resident.energy < 30 ? "有些疲倦，想放慢一点" : resident.energy > 75 ? "精神舒展" : "平静而专注";
    const personal = resident.goals.find((goal) => goal.status === "active");
    const affair = state.threads.find((thread) => thread.status === "open" && thread.participants.includes(person.id));
    resident.attention = affair ? `${affair.title}：${affair.nextStep}` : personal?.title ?? person.aspiration;
    if (clock.minute >= routineProfile(person.id).dinner && resident.lastRoutineDate !== clock.date) {
      const goal = resident.goals.filter((g) => g.status === "active").sort((a, b) => a.progress - b.progress)[0];
      const progress = resident.energy < 30 ? 0 : 3;
      if (goal) { goal.progress = Math.min(100, goal.progress + progress); goal.status = goal.progress === 100 ? "completed" : "active"; goal.updatedAt = now; goal.reason = progress ? "今天按自己的节奏留出了一段时间" : "今天先照顾休息需求"; }
      const id = `routine:${person.id}:${clock.date}`;
      remember(resident, { id, eventId: id, at: now, kind: "routine", locationId: person.home, source: "本地作息",
        text: progress ? `今天为「${goal?.title ?? person.occupation}」留出了一段时间。${goal?.status === "completed" ? "这一阶段的小目标已经完成。" : "还想按自己的节奏继续。"}` : "今天有些疲倦，暂缓了手边的事，把时间留给休息。" });
      resident.lastRoutineDate = clock.date;
      resident.lastMeaningfulAt = now;
    }
    if (["social", "meal"].includes(activity.activity)) {
      for (const event of publicEvents) {
        if (!terminalEvent(event) || !event.outcome || event.visibility === "participants" || !event.resolvedAt || event.resolvedAt + 2 * 3_600_000 > now || event.participants.includes(person.id) || resident.heardEventIds.includes(event.id)) continue;
        remember(resident, { id: `heard:${person.id}:${event.id}`, eventId: event.id, at: now, kind: "heard", text: event.outcome, source: "城邦公开消息", locationId: event.locationId });
        resident.heardEventIds.push(event.id);
      }
    }
    resident.updatedAt = now;
  }
  state.lastLifeTick = bucket;
}
