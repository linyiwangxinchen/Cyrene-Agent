/**
 * 昔涟虚拟世界的共享契约。
 *
 * 这里的字段描述的是服务器内的虚构生活，不代表用户的现实地点、行程或
 * 身体状态。主进程负责推进和持久化，模型只能读取经过筛选的快照。
 */

export type XilianWorldActivityKind =
  | "work"
  | "study"
  | "game"
  | "rest"
  | "explore"
  | "social"
  | "maintenance"
  | "travel";

export type XilianWorldArcId = "lighting" | "echo" | "voyage";
export type XilianLifeGoalStage = "active" | "paused" | "completed";
export type XilianTimelineEventStatus = "planned" | "active" | "completed" | "interrupted";
export type XilianTimelineVisibility = "private" | "shareable" | "shared";
export type XilianTimelineSource = "simulated_world" | "plugin_observation" | "user_interaction";
export type XilianLifeArtifactKind = "selfie" | "note" | "song" | "question";
export type XilianLifeArtifactStatus = "planned" | "generating" | "generated" | "failed";
export type XilianDiarySource = "life_event" | "user_interaction";

export interface XilianLocation {
  id: string;
  name: string;
  description: string;
  activityKinds: readonly XilianWorldActivityKind[];
  tags: readonly string[];
}

export interface XilianTimeBlock {
  id: string;
  label: string;
  startMinute: number;
  endMinute: number;
  activityKinds: readonly XilianWorldActivityKind[];
}

export interface XilianLifeGoal {
  id: string;
  title: string;
  description: string;
  stage: XilianLifeGoalStage;
  progress: number;
  target: number;
  importance: number;
  startedAt: number;
  updatedAt: number;
}

export interface XilianTimelineEvent {
  id: string;
  dateKey: string;
  /** Stable time-block identity, for example `morning` or `dusk`. */
  slotId: string;
  occurredAt: number;
  locationId: string;
  activityKind: XilianWorldActivityKind;
  activityTitle: string;
  summary: string;
  detail?: string;
  outcome?: string;
  diaryText?: string;
  participants?: string[];
  memoryTags?: string[];
  mood: string;
  energyAfter: number;
  goalId?: string;
  status: XilianTimelineEventStatus;
  visibility: XilianTimelineVisibility;
  source: XilianTimelineSource;
  previousEventId?: string;
  nextEventId?: string;
}

export interface XilianDiaryEntry {
  id: string;
  eventId: string;
  dateKey: string;
  writtenAt: number;
  title: string;
  text: string;
  mood: string;
  locationId: string;
  visibility: XilianTimelineVisibility;
  source: XilianDiarySource;
}

export interface XilianLifeArtifactContext {
  id: string;
  eventId: string;
  kind: XilianLifeArtifactKind;
  createdAt: number;
  updatedAt: number;
  promptFingerprint: string;
  imageModel?: string;
  outputPath?: string;
  status: XilianLifeArtifactStatus;
  errorClass?: "auth" | "parameter" | "network" | "timeout" | "parse" | "unknown";
}

/** Renderer-safe artifact metadata; generated file paths remain in the main process. */
export type XilianWorldArtifactView = Omit<XilianLifeArtifactContext, "outputPath">;

export interface XilianWorldState {
  version: 1;
  worldDate: string;
  seasonId: string;
  dayIndex: number;
  currentLocationId: string;
  currentActivity?: XilianTimelineEvent;
  activeArcId: XilianWorldArcId;
  goals: XilianLifeGoal[];
  recentEventIds: string[];
  nextPlannedEvent?: XilianTimelineEvent;
  revision: number;
}

export interface XilianWorldData {
  version: 2;
  state: XilianWorldState;
  timeline: XilianTimelineEvent[];
  diary: XilianDiaryEntry[];
  artifacts: XilianLifeArtifactContext[];
  revision: number;
}

export interface XilianWorldView {
  state: XilianWorldState;
  timeline: XilianTimelineEvent[];
  diary: XilianDiaryEntry[];
  /** Recent life artifacts and their generation state; file paths stay out of the UI contract. */
  artifacts: XilianWorldArtifactView[];
  locations: readonly XilianLocation[];
}

export interface XilianLifeSnapshot {
  worldDate: string;
  localTime: string;
  season: string;
  location: string;
  currentActivity: string;
  recentEvent: string;
  nextPlan: string;
  mood: string;
  energy: number;
  outfit: string;
  selfieReason: string;
  visualAnchors: string[];
  avoid: string[];
  sourceEventId: string;
}

export const XILIAN_WORLD_ARCS: Readonly<Record<XilianWorldArcId, { title: string; description: string }>> = Object.freeze({
  lighting: { title: "点灯期", description: "先让日常的光源稳定下来，学会记录和照顾自己的生活。" },
  echo: { title: "回声期", description: "旧事件在不同地点留下重复痕迹，昔涟开始追查记忆的回声。" },
  voyage: { title: "远行期", description: "她准备离开熟悉区域，寻找回声的源头并决定自己的方向。" },
});

export const XILIAN_LOCATIONS: readonly XilianLocation[] = Object.freeze([
  {
    id: "prologue-city",
    name: "序页城",
    description: "由旧档案、书页和记忆索引组成的城邦，适合整理和回望。",
    activityKinds: ["study", "work", "social"],
    tags: ["档案", "记忆", "城邦"],
  },
  {
    id: "star-furnace",
    name: "星炉台",
    description: "维护世界光源与小型装置的高台，傍晚能看到细碎的光谱。",
    activityKinds: ["work", "maintenance", "study"],
    tags: ["光源", "装置", "观测"],
  },
  {
    id: "stillwater-court",
    name: "静海庭",
    description: "安静的休憩庭院，有茶、雨声和可以慢慢整理的便签。",
    activityKinds: ["rest", "social", "study"],
    tags: ["休息", "音乐", "情绪"],
  },
  {
    id: "echo-field",
    name: "回声场",
    description: "可以复盘记忆、下棋和模拟路线的游戏场。",
    activityKinds: ["game", "study", "social"],
    tags: ["游戏", "策略", "回声"],
  },
  {
    id: "far-seeing-platform",
    name: "远观台",
    description: "观察天空和城邦变化的高处，适合思考长期目标。",
    activityKinds: ["explore", "study", "rest"],
    tags: ["天空", "远景", "思考"],
  },
  {
    id: "ferry-market",
    name: "渡桥集",
    description: "交换小物和消息的集市，常常能听到新的传闻。",
    activityKinds: ["social", "travel", "explore"],
    tags: ["集市", "传闻", "交换"],
  },
]);

/** 用户时区下的一天时间块。夜间延伸到午夜，安静时间覆盖午夜至清晨。 */
export const XILIAN_TIME_BLOCKS: readonly XilianTimeBlock[] = Object.freeze([
  { id: "dawn", label: "清晨", startMinute: 360, endMinute: 480, activityKinds: ["rest", "study", "maintenance"] },
  { id: "morning", label: "上午", startMinute: 480, endMinute: 690, activityKinds: ["work", "study", "maintenance"] },
  { id: "noon", label: "午间", startMinute: 690, endMinute: 810, activityKinds: ["rest", "social"] },
  { id: "afternoon", label: "下午", startMinute: 810, endMinute: 1050, activityKinds: ["work", "explore", "game", "study"] },
  { id: "dusk", label: "傍晚", startMinute: 1050, endMinute: 1170, activityKinds: ["social", "explore", "maintenance"] },
  { id: "night", label: "夜间", startMinute: 1170, endMinute: 1440, activityKinds: ["game", "rest", "study", "social"] },
  { id: "quiet", label: "安静时间", startMinute: 0, endMinute: 360, activityKinds: ["rest", "study"] },
]);

export const XILIAN_DEFAULT_GOALS = Object.freeze([
  { id: "light-maintenance", title: "守住星炉的光", description: "完成几次稳定的光源维护，让日常有可以依靠的亮度。", target: 5, importance: 80 },
  { id: "echo-mapping", title: "记录回声的路径", description: "在不同地点收集重复出现的记忆线索。", target: 3, importance: 70 },
  { id: "memory-game", title: "学会一套记忆棋盘", description: "在回声场完成几次游戏，找到适合自己的策略。", target: 2, importance: 45 },
] as const);

export function getXilianLocation(id: string): XilianLocation | undefined {
  return XILIAN_LOCATIONS.find((location) => location.id === id);
}

export function getXilianTimeBlock(id: string): XilianTimeBlock | undefined {
  return XILIAN_TIME_BLOCKS.find((block) => block.id === id);
}

export function createDefaultXilianWorldState(dateKey: string, now: number): XilianWorldState {
  return {
    version: 1,
    worldDate: dateKey,
    seasonId: "first-light",
    dayIndex: 1,
    currentLocationId: "prologue-city",
    activeArcId: "lighting",
    goals: XILIAN_DEFAULT_GOALS.map((goal) => ({
      ...goal,
      stage: "active" as const,
      progress: 0,
      startedAt: now,
      updatedAt: now,
    })),
    recentEventIds: [],
    revision: 1,
  };
}

export function createDefaultXilianWorldData(dateKey: string, now: number): XilianWorldData {
  return { version: 2, state: createDefaultXilianWorldState(dateKey, now), timeline: [], diary: [], artifacts: [], revision: 1 };
}
