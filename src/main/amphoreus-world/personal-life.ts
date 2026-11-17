import { AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import { createHash } from "node:crypto";
import type { AmphoreusState, PersonalAction } from "../../shared/amphoreus-world";
import { worldClock, worldInstant } from "./clock";
import { fitsRoutine, remember, travelMinutes } from "./life";

const stageNames = ["收集线索", "尝试一小段", "回看与调整", "整理成自己的记录"];
const details = ["一张折过角的记录页", "一份还留着空白的清单", "一条准备下次核对的问题", "写在页边的一小段感想", "两种做法的对照笔记", "一张留给下一次的书签"];
function hash(text: string): number { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; }

function obstruction(state: AmphoreusState, action: PersonalAction): string | undefined {
  const resident = state.residents.find((r) => r.id === action.residentId)!;
  if (state.places.find((p) => p.id === action.locationId)?.access === "closed") return "原来的地方暂时不便使用，先把念头记下";
  if (resident.energy < 25) return "有些疲倦，先休息，之后再接着做";
  const person = AMPHOREUS_RESIDENTS.find((r) => r.id === action.residentId)!;
  if (state.days.flatMap((d) => d.events).some((event) => {
    if (event.status === "cancelled" || !event.participants.includes(action.residentId)) return false;
    const travel = travelMinutes(person.home, event.locationId, state.places) * 60_000;
    return event.startsAt - travel < action.endsAt && event.endsAt + travel > action.startsAt;
  })) return "有了公共约定，自己的小事留到下次";
}

/** Small, rule-verifiable private actions. Public story outcomes remain model-resolved. */
export function advancePersonalActions(state: AmphoreusState, now: number): void {
  const person = AMPHOREUS_RESIDENTS.find((r) => r.id === "cyrene")!;
  const resident = state.residents.find((r) => r.id === person.id)!;
  for (const action of state.personalActions) {
    if (action.status === "completed" || action.status === "interrupted") continue;
    if (now < action.startsAt) continue;
    const reason = obstruction(state, action);
    if (reason) {
      action.status = "interrupted"; action.reason = reason; action.outcome = reason; action.version++;
    } else if (action.endsAt <= now) {
      const goal = resident.goals.find((g) => g.id === action.goalId);
      if (!goal || goal.status === "completed") { action.status = "interrupted"; action.reason = "这个阶段已有结果，先放下原来的安排"; action.resolvedAt = Math.min(now, action.endsAt); action.version++; continue; }
      action.status = "completed"; action.version++;
      action.artifact = details[hash(action.id) % details.length];
      action.outcome = `为「${goal.title}」留了一段专心的时间，留下${action.artifact}。${goal.progress >= 90 ? "这一阶段可以先收起来了。" : "还有一点没想明白，想下次接着试。"}`;
      goal.progress = Math.min(100, goal.progress + 8); goal.status = goal.progress === 100 ? "completed" : "active";
      goal.updatedAt = action.endsAt; goal.lastActionId = action.id; goal.reason = action.outcome;
      goal.stage = `${goal.cycle && goal.cycle > 1 ? `第${goal.cycle}阶段·` : ""}${stageNames[Math.min(3, Math.floor(goal.progress / 25))]}`;
      goal.nextStep = goal.status === "completed" ? "回顾这一阶段，再决定是否继续" : `${goal.stage}，从上次留下的记录接着做`;
    } else { if (action.status === "planned") action.status = "active"; continue; }
    action.resolvedAt = Math.min(now, action.endsAt);
    remember(resident, { id: `personal:${action.id}`, eventId: action.id, at: Math.min(now, action.endsAt), occurredAt: Math.min(now, action.endsAt), sourceVersion: action.version,
      kind: "routine", text: action.outcome ?? action.reason!, source: "昔涟自己的生活", locationId: action.locationId, ...(action.conversationId ? { conversationId: action.conversationId } : {}) }, state);
    resident.lastMeaningfulAt = Math.min(now, action.endsAt);
  }
}

export function planPersonalLife(state: AmphoreusState, now: number, timezone: string, changedZone = false): void {
  const clock = worldClock(now, timezone);
  const person = AMPHOREUS_RESIDENTS.find((r) => r.id === "cyrene")!;
  const resident = state.residents.find((r) => r.id === person.id)!;
  if (changedZone) for (const action of state.personalActions) if (action.status === "active" || action.status === "planned") {
    action.status = "interrupted"; action.reason = "当地时间改变，先重新安排自己的生活"; action.resolvedAt = now; action.version++;
    remember(resident, { id: `personal:${action.id}`, eventId: action.id, at: now, occurredAt: now, sourceVersion: action.version, kind: "routine", text: action.reason, source: "昔涟自己的生活", locationId: action.locationId, ...(action.conversationId ? { conversationId: action.conversationId } : {}) }, state);
  }
  if (state.personalLifeDate === clock.date && !changedZone) return;
  state.personalLifeDate = clock.date;
  if (resident.goals.length && resident.goals.every((goal) => goal.status === "completed") && resident.energy >= 40 && hash(clock.date) % 3 !== 0) {
    const goal = resident.goals[hash(`${clock.date}:next-project`) % resident.goals.length];
    goal.cycle = (goal.cycle ?? 1) + 1; goal.status = "active"; goal.progress = 0; goal.updatedAt = now;
    goal.stage = `第${goal.cycle}阶段：换个角度再试试`; goal.nextStep = "从上一阶段的记录里挑一个还想尝试的小问题";
    goal.reason = "上一阶段已经收好，自己决定沿着感兴趣的方向再试一小段";
    goal.practiceMinutes = 0; goal.dailyProgress = 0;
  }
  const goals = resident.goals.filter((g) => g.status === "active");
  if (!goals.length) return;
  // Only propose upcoming actions. A late start never manufactures a completed morning.
  for (const [index, base] of [540, 870, 1200].entries()) {
    const seed = hash(`${clock.date}:${index}:${person.id}`), goal = goals[(seed + index) % goals.length];
    const minute = base + seed % 35, duration = 35 + (seed >>> 8) % 25;
    const startsAt = worldInstant(clock.date, minute, timezone), endsAt = startsAt + duration * 60_000;
    if (startsAt < now || startsAt < state.createdAt || !fitsRoutine(person, minute, minute + duration)) continue;
    if (state.personalActions.some((action) => action.residentId === person.id && action.status !== "interrupted" && action.startsAt < endsAt && action.endsAt > startsAt)) continue;
    const id = `amphoreus:personal:${clock.date}:${index}${changedZone ? `:zone-${hash(timezone)}` : ""}`;
    if (state.personalActions.some((a) => a.id === id)) continue;
    const stage = `${goal.cycle && goal.cycle > 1 ? `第${goal.cycle}阶段·` : ""}${stageNames[Math.min(3, Math.floor(goal.progress / 25))]}`;
    const action: PersonalAction = { id, residentId: person.id, goalId: goal.id, title: `${stage}：${goal.title}`, intent: `给「${goal.title}」留一点自己的时间；只做眼下能完成的一小步`,
      activity: index === 1 ? "work" : "study", startsAt, endsAt, locationId: person.home, status: "planned", version: 1, stage, origin: "local" };
    if (!obstruction(state, action)) state.personalActions.push(action);
  }
}

export interface PersonalIntentionInput { id: string; title: string; intent: string; goalId?: string; conversationId?: string }
export function personalIntentionId(input: Pick<PersonalIntentionInput, "id" | "conversationId">): string {
  return `amphoreus:personal:user:${createHash("sha256").update(JSON.stringify([input.conversationId ?? "", input.id])).digest("hex").slice(0, 32)}`;
}
/** Explicit structured suggestions become proposed actions, never already-completed facts. */
export function planPersonalIntention(state: AmphoreusState, input: PersonalIntentionInput, now: number, timezone: string): PersonalAction | undefined {
  if (!input || !/^[a-zA-Z0-9:_-]{1,120}$/.test(input.id) || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > 300 || input.conversationId !== undefined && (typeof input.conversationId !== "string" || input.conversationId.length > 200)) throw new Error("Invalid personal intention");
  const id = personalIntentionId(input);
  const existing = state.personalActions.find((action) => action.id === id);
  if (existing) return existing;
  const person = AMPHOREUS_RESIDENTS.find((resident) => resident.id === "cyrene")!;
  const resident = state.residents.find((r) => r.id === person.id)!;
  const goal = resident.goals.find((goal) => goal.status === "active" && (!input.goalId || goal.id === input.goalId));
  if (!goal) return undefined;
  const first = Math.ceil((now + 15 * 60_000) / (15 * 60_000)) * 15 * 60_000;
  for (let startsAt = first; startsAt < now + 2 * 86_400_000; startsAt += 15 * 60_000) {
    const local = worldClock(startsAt, timezone), endsAt = startsAt + 45 * 60_000;
    if (!fitsRoutine(person, local.minute, local.minute + 45) || state.personalActions.some((action) => action.status !== "interrupted" && action.startsAt < endsAt && action.endsAt > startsAt)) continue;
    const action: PersonalAction = { id, residentId: person.id, goalId: goal.id, title: input.title.trim(), intent: `用户明确提出的建议，尚未完成：${input.intent.trim()}`, activity: "study", startsAt, endsAt, locationId: person.home, status: "planned", version: 1, stage: "考虑用户的建议", origin: "user_suggestion", ...(input.conversationId ? { conversationId: input.conversationId } : {}) };
    if (obstruction(state, action)) continue;
    state.personalActions.push(action); return action;
  }
  return undefined;
}
