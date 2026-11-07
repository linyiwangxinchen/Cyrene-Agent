import {
  getXilianLocation,
  XILIAN_LOCATIONS,
  XILIAN_TIME_BLOCKS,
  type XilianLifeGoal,
  type XilianTimelineEvent,
  type XilianTimeBlock,
  type XilianWorldActivityKind,
  type XilianWorldArcId,
  type XilianWorldState,
} from "../../shared/xilian-world";

export interface XilianCompanionSignals {
  energy: number;
  curiosity: number;
  boredom: number;
}

export interface XilianScheduleInput {
  state: XilianWorldState;
  timeline: readonly XilianTimelineEvent[];
  now: number;
  timezone: string;
  companion?: XilianCompanionSignals;
}

export interface XilianScheduleResult {
  state: XilianWorldState;
  events: XilianTimelineEvent[];
  changed: boolean;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DEFAULT_SIGNALS: XilianCompanionSignals = { energy: 70, curiosity: 50, boredom: 20 };

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
  } catch {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
  }
}

export function getXilianDateKey(date: Date, timezone: string): string {
  const parts = getZonedDateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localMinute(parts: ZonedDateParts): number {
  return parts.hour * 60 + parts.minute;
}

/** Stable non-cryptographic hash for a day's deterministic schedule. */
export function xilianStableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

export function getXilianSeasonId(dayIndex: number): string {
  if (dayIndex <= 14) return "first-light";
  if (dayIndex <= 30) return "echo-tide";
  return "far-voyage";
}

function blockContains(block: XilianTimeBlock, minute: number): boolean {
  if (block.id === "quiet") return minute >= block.startMinute && minute < block.endMinute;
  return minute >= block.startMinute && minute < block.endMinute;
}

function shouldMaterialize(block: XilianTimeBlock, minute: number): boolean {
  // Quiet time is the first block of the local day. At 23:00 the night block
  // carries the state until midnight; the next quiet event belongs to tomorrow.
  if (block.id === "quiet") return minute < block.endMinute;
  return minute >= block.startMinute;
}

export function getCurrentXilianTimeBlock(minute: number): XilianTimeBlock | undefined {
  return XILIAN_TIME_BLOCKS.find((block) => blockContains(block, minute));
}

function chooseActivityKind(block: XilianTimeBlock, signals: XilianCompanionSignals, seed: string): XilianWorldActivityKind {
  const allowed = [...block.activityKinds];
  if (signals.energy < 30 && block.id !== "quiet" && block.id !== "noon") {
    const rest = allowed.includes("rest") ? "rest" : undefined;
    if (rest) return rest;
  }
  if (signals.boredom >= 65) {
    if (allowed.includes("game")) return "game";
    if (allowed.includes("explore")) return "explore";
    if (allowed.includes("social")) return "social";
  }
  const index = xilianStableHash(seed) % Math.max(1, allowed.length);
  return allowed[index] ?? "rest";
}

function chooseLocation(kind: XilianWorldActivityKind, seed: string): string {
  const candidates = XILIAN_LOCATIONS.filter((location) => location.activityKinds.includes(kind));
  if (!candidates.length) return "prologue-city";
  return candidates[xilianStableHash(seed) % candidates.length]!.id;
}

function goalForActivity(kind: XilianWorldActivityKind): string | undefined {
  if (kind === "work" || kind === "maintenance") return "light-maintenance";
  if (kind === "game") return "memory-game";
  if (kind === "study" || kind === "explore" || kind === "travel") return "echo-mapping";
  return undefined;
}

function activityTitle(kind: XilianWorldActivityKind, locationName: string): string {
  switch (kind) {
    case "work": return `在${locationName}整理今天的工作记录`;
    case "study": return `在${locationName}读一段旧档案`;
    case "game": return `在${locationName}玩一局记忆棋盘`;
    case "rest": return `在${locationName}安静休息一会儿`;
    case "explore": return `从${locationName}观察一处新的变化`;
    case "social": return `在${locationName}和熟悉的人交换消息`;
    case "maintenance": return `在${locationName}维护一盏小灯`;
    case "travel": return `从${locationName}带回一件小物`;
  }
}

function activitySummary(kind: XilianWorldActivityKind, locationName: string, dayIndex: number): string {
  switch (kind) {
    case "work": return `昔涟在${locationName}把第 ${dayIndex} 天的记录整理成了可以继续使用的页签。`;
    case "study": return `昔涟在${locationName}翻到一段旧档案，记下了一个暂时还没有答案的线索。`;
    case "game": return `昔涟在${locationName}复盘了一局记忆棋盘，发现自己更喜欢先观察再落子。`;
    case "rest": return `昔涟在${locationName}放慢了节奏，给自己留了一段不需要完成什么的时间。`;
    case "explore": return `昔涟在${locationName}看见一处细小变化，把它记进了今天的观察页。`;
    case "social": return `昔涟在${locationName}听到一条有趣的传闻，准备之后再确认它是否真实。`;
    case "maintenance": return `昔涟在${locationName}完成了一次小维护，光线比之前稳定了一点。`;
    case "travel": return `昔涟从${locationName}带回一件小物，想找时间告诉用户它为什么有意思。`;
  }
}

function activityMood(kind: XilianWorldActivityKind, signals: XilianCompanionSignals): string {
  if (kind === "rest" || signals.energy < 30) return "有一点疲惫，但在慢慢恢复";
  if (kind === "game" || signals.boredom >= 65) return "被小小的好奇心提起了精神";
  if (kind === "explore" || kind === "study") return "安静而专注";
  return signals.curiosity >= 65 ? "专注里带着一点期待" : "平稳地做着手边的事";
}

function eventTimestamp(now: number, parts: ZonedDateParts, block: XilianTimeBlock): number {
  const current = localMinute(parts);
  const elapsed = Math.max(0, current - block.startMinute);
  return now - elapsed * 60_000;
}

function eventVisibility(kind: XilianWorldActivityKind, status: XilianTimelineEvent["status"]): XilianTimelineEvent["visibility"] {
  if (status === "active") return "private";
  if (kind === "rest") return "private";
  return "shareable";
}

function makeEvent(
  input: XilianScheduleInput,
  block: XilianTimeBlock,
  parts: ZonedDateParts,
  signals: XilianCompanionSignals,
  existing?: XilianTimelineEvent,
): XilianTimelineEvent {
  const dateKey = getXilianDateKey(new Date(input.now), input.timezone);
  const minute = localMinute(parts);
  const active = blockContains(block, minute);
  const status: XilianTimelineEvent["status"] = active ? "active" : "completed";
  const kind = chooseActivityKind(block, signals, `${dateKey}:${input.state.dayIndex}:${block.id}:${input.state.activeArcId}`);
  const locationId = chooseLocation(kind, `${dateKey}:${input.state.dayIndex}:${block.id}:${kind}`);
  const location = getXilianLocation(locationId) ?? XILIAN_LOCATIONS[0]!;
  const goalId = goalForActivity(kind);
  const energyCost = kind === "rest" ? -4 : kind === "game" || kind === "social" ? 2 : 7;
  const candidate: XilianTimelineEvent = {
    id: `xilian:${dateKey}:${block.id}`,
    dateKey,
    slotId: block.id,
    occurredAt: eventTimestamp(input.now, parts, block),
    locationId: location.id,
    activityKind: kind,
    activityTitle: activityTitle(kind, location.name),
    summary: activitySummary(kind, location.name, input.state.dayIndex),
    mood: activityMood(kind, signals),
    energyAfter: clamp(signals.energy - energyCost),
    ...(goalId ? { goalId } : {}),
    status,
    visibility: eventVisibility(kind, status),
    source: "simulated_world",
  };
  if (!existing) return candidate;
  // Terminal state wins if the clock is moved backwards after a restart.
  const terminalStatus = existing.status === "completed" || existing.status === "interrupted" ? existing.status : candidate.status;
  return {
    ...candidate,
    ...existing,
    status: terminalStatus,
    visibility: existing.visibility === "shared" ? "shared" : eventVisibility(candidate.activityKind, terminalStatus),
    occurredAt: existing.occurredAt,
    previousEventId: existing.previousEventId,
    nextEventId: existing.nextEventId,
  };
}

function updateGoals(
  goals: readonly XilianLifeGoal[],
  events: readonly XilianTimelineEvent[],
  newlyCompleted: readonly XilianTimelineEvent[],
  now: number,
): XilianLifeGoal[] {
  const increment = new Map<string, number>();
  for (const event of newlyCompleted) if (event.goalId) increment.set(event.goalId, (increment.get(event.goalId) ?? 0) + 1);
  return goals.map((goal) => {
    const progress = Math.min(goal.target, goal.progress + (increment.get(goal.id) ?? 0));
    const stage = progress >= goal.target ? "completed" : goal.stage === "completed" ? "completed" : goal.stage;
    return { ...goal, progress, stage, updatedAt: increment.has(goal.id) ? now : goal.updatedAt };
  });
}

function activeArcForGoals(goals: readonly XilianLifeGoal[]): XilianWorldArcId {
  const lighting = goals.find((goal) => goal.id === "light-maintenance");
  const echo = goals.find((goal) => goal.id === "echo-mapping");
  if (lighting?.stage === "completed" && echo?.stage === "completed") return "voyage";
  if (lighting?.stage === "completed") return "echo";
  return "lighting";
}

function nextPlannedEvent(input: XilianScheduleInput, block: XilianTimeBlock, parts: ZonedDateParts, signals: XilianCompanionSignals, previousEventId?: string): XilianTimelineEvent {
  const dateKey = getXilianDateKey(new Date(input.now), input.timezone);
  const kind = chooseActivityKind(block, signals, `${dateKey}:${input.state.dayIndex}:${block.id}:${input.state.activeArcId}`);
  const locationId = chooseLocation(kind, `${dateKey}:${input.state.dayIndex}:${block.id}:${kind}`);
  const location = getXilianLocation(locationId) ?? XILIAN_LOCATIONS[0]!;
  return {
    id: `xilian:${dateKey}:${block.id}`,
    dateKey,
    slotId: block.id,
    occurredAt: input.now + Math.max(0, block.startMinute - localMinute(parts)) * 60_000,
    locationId: location.id,
    activityKind: kind,
    activityTitle: activityTitle(kind, location.name),
    summary: activitySummary(kind, location.name, input.state.dayIndex),
    mood: activityMood(kind, signals),
    energyAfter: clamp(signals.energy - (kind === "rest" ? -4 : 7)),
    ...(goalForActivity(kind) ? { goalId: goalForActivity(kind) } : {}),
    status: "planned",
    visibility: "private",
    source: "simulated_world",
    ...(previousEventId ? { previousEventId } : {}),
  };
}

function eventEqual(a: XilianTimelineEvent | undefined, b: XilianTimelineEvent): boolean {
  return Boolean(a && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * Pure日程归一化：只根据固定时钟、世界状态和短期信号生成事件。
 * 不调用模型，也不写文件；持久化和去重由 XilianWorldStore 负责。
 */
export function reconcileXilianWorld(input: XilianScheduleInput): XilianScheduleResult {
  const signals = input.companion ?? DEFAULT_SIGNALS;
  const parts = getZonedDateParts(new Date(input.now), input.timezone);
  const dateKey = getXilianDateKey(new Date(input.now), input.timezone);
  const minute = localMinute(parts);
  const dayAdvance = input.state.worldDate === dateKey ? 0 : daysBetween(input.state.worldDate, dateKey);
  const nextDayIndex = input.state.worldDate === dateKey ? input.state.dayIndex : input.state.dayIndex + Math.max(1, dayAdvance);
  const stateBase: XilianWorldState = {
    ...input.state,
    worldDate: dateKey,
    dayIndex: nextDayIndex,
    seasonId: getXilianSeasonId(nextDayIndex),
    currentActivity: undefined,
    nextPlannedEvent: undefined,
  };
  const existingById = new Map(input.timeline.map((event) => [event.id, event]));
  const changedEvents: XilianTimelineEvent[] = [];
  const newlyCompleted: XilianTimelineEvent[] = [];
  const materialized: XilianTimelineEvent[] = [];

  for (const block of XILIAN_TIME_BLOCKS) {
    if (!shouldMaterialize(block, minute)) continue;
    const existing = existingById.get(`xilian:${dateKey}:${block.id}`);
    const event = makeEvent({ ...input, state: stateBase }, block, parts, signals, existing);
    materialized.push(event);
    if (!eventEqual(existing, event)) changedEvents.push(event);
    if (event.status === "completed" && existing?.status !== "completed" && existing?.status !== "interrupted") newlyCompleted.push(event);
  }

  const currentBlock = getCurrentXilianTimeBlock(minute);
  const current = currentBlock ? materialized.find((event) => event.slotId === currentBlock.id) : undefined;
  const previous = materialized.at(-1);
  const nextBlock = currentBlock
    ? XILIAN_TIME_BLOCKS.find((block) => block.startMinute > currentBlock.startMinute && block.startMinute > minute)
    : XILIAN_TIME_BLOCKS.find((block) => block.startMinute > minute);
  const goals = updateGoals(input.state.goals, [...input.timeline, ...changedEvents], newlyCompleted, input.now);
  const state: XilianWorldState = {
    ...stateBase,
    currentLocationId: current?.locationId ?? previous?.locationId ?? input.state.currentLocationId,
    ...(current ? { currentActivity: current } : previous ? { currentActivity: previous } : {}),
    ...(nextBlock ? { nextPlannedEvent: nextPlannedEvent({ ...input, state: { ...stateBase, goals } }, nextBlock, parts, signals, current?.id ?? previous?.id) } : {}),
    goals,
    activeArcId: activeArcForGoals(goals),
    recentEventIds: [...new Set([...input.state.recentEventIds, ...materialized.map((event) => event.id)])].slice(-24),
    revision: input.state.revision + (dateKey !== input.state.worldDate || changedEvents.length > 0 || newlyCompleted.length > 0 ? 1 : 0),
  };
  const changed = dateKey !== input.state.worldDate
    || state.seasonId !== input.state.seasonId
    || state.dayIndex !== input.state.dayIndex
    || state.currentLocationId !== input.state.currentLocationId
    || state.activeArcId !== input.state.activeArcId
    || JSON.stringify(state.goals) !== JSON.stringify(input.state.goals)
    || JSON.stringify(state.currentActivity) !== JSON.stringify(input.state.currentActivity)
    || JSON.stringify(state.nextPlannedEvent) !== JSON.stringify(input.state.nextPlannedEvent)
    || changedEvents.length > 0;
  return { state, events: changedEvents, changed };
}
