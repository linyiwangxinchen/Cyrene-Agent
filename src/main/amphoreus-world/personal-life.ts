import { AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import { createHash } from "node:crypto";
import type { AmphoreusState, PersonalAction } from "../../shared/amphoreus-world";
import { worldClock, worldInstant } from "./clock";
import { fitsRoutine, remember, travelMinutes } from "./life";

const stageNames = ["收集线索", "尝试一小段", "回看与调整", "整理成自己的记录"];
const projectMilestones: Readonly<Record<string, readonly { artifact: string; outcome: string }[]>> = {
  "cyrene:personal:0": [
    { artifact: "页边的草稿", outcome: "把手记开头改成了一句话，先写了那天出门时听见的声音。" },
    { artifact: "两份开头的草稿", outcome: "把两种开头念了一遍，选了更像自己平时说话的那版。" },
    { artifact: "带删改的手记页", outcome: "划掉了结尾那句解释，读起来顺了些。" },
    { artifact: "写完的一页手记", outcome: "在手记页脚写上日期，把这一页夹回本子里。" },
  ],
  "cyrene:personal:1": [
    { artifact: "标着出门方向的草图", outcome: "在散步用的草图上标了今天出门的方向。" },
    { artifact: "标着折返点的散步路线", outcome: "试走了一段近路，在草图上补了折返的位置。" },
    { artifact: "加了一处停留点的路线图", outcome: "走到一半停下来歇了会儿，回去后顺手把停留的位置画进路线图。" },
    { artifact: "带有长短两条路线的草图", outcome: "把散步路线分成了长、短两条。下回时间少，也知道可以往哪儿走。" },
  ],
  "cyrene:personal:2": [
    { artifact: "按讲述人分好的故事页", outcome: "把几张故事页按讲述人分开，这回能一眼看出每张是谁讲的了。" },
    { artifact: "标着原文的故事稿", outcome: "给故事里两句想保留的原话画了线，省得誊写时顺手改掉。" },
    { artifact: "排好顺序的一叠故事页", outcome: "把同一件事的两份讲述挪到相邻的两页，来回看方便多了。" },
    { artifact: "有目录的一册故事", outcome: "给这叠故事页补上目录，现在找哪一篇都不用从头翻了。" },
  ],
};

/** Old generated filler remains in saved history but has no concrete result to resurface in chat. */
export function isLegacyPersonalOutcome(text: string): boolean {
  return /^为「.+」留了一段专心的时间，留下.+。(?:还有一点没想明白，想下次接着试。|这一阶段可以先收起来了。)$/su.test(text);
}

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
      const progress = Math.min(100, goal.progress + 8);
      const previousCheckpoint = Math.floor(goal.progress / 25);
      const checkpoint = Math.floor(progress / 25);
      if (action.origin === "user_suggestion") {
        action.outcome = `为「${action.title}」留了一段时间，把准备尝试的一小步写进了自己的笔记。`;
      } else if (action.origin === "model") {
        action.outcome = `花了一点时间试做「${action.title}」。`;
      } else {
        // Each prewritten project result belongs to its first pass. Later passes still record practice.
        const milestone = (goal.cycle ?? 1) === 1 && checkpoint > previousCheckpoint
          ? projectMilestones[goal.id]?.[checkpoint - 1]
          : undefined;
        action.outcome = milestone?.outcome ?? `抽了点时间继续「${goal.title}」。`;
        if (milestone) action.artifact = milestone.artifact;
      }
      goal.progress = progress; goal.status = progress === 100 ? "completed" : "active";
      goal.updatedAt = action.endsAt; goal.lastActionId = action.id;
      goal.reason = action.conversationId ? "给自己的小事留了一点时间，记下了下一步。" : action.outcome;
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
