/** One identity across all task modes and transports. No Electron dependency. */
import type { BondProgressState } from "./companion-progress";
import type { XilianWorldView } from "./xilian-world";
import type { PersonalAction, WorldHistoryPage, WorldHistoryQuery } from "./amphoreus-world";

export type RelationshipStage = "new" | "familiar" | "close" | "long_term";
/**
 * 用户选择的关系场景契约。它只约束表达方式和主动性，不会扩大工具、
 * 文件或外部渠道权限，也不会把模拟关系当成现实关系。
 */
export type RelationshipMode = "assistant" | "friend" | "companion" | "partner";
export type CompanionStyle = "natural" | "gentle" | "lively" | "concise";
export type CompanionReplyMode = "listen" | "reflect" | "help" | "light";
export const COMPANION_CORRECTION_MAX_LENGTH = 500;

/** 只影响当前待发消息的回复方式。 */
export interface CompanionReplyInput {
  mode?: CompanionReplyMode;
  correction?: string;
}

export function normalizeCompanionReply(value: unknown): CompanionReplyInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { mode, correction } = value as Partial<CompanionReplyInput>;
  if (mode !== undefined && mode !== "listen" && mode !== "reflect" && mode !== "help" && mode !== "light") return undefined;
  if (correction !== undefined && typeof correction !== "string") return undefined;
  const note = correction?.trim();
  if (note && note.length > COMPANION_CORRECTION_MAX_LENGTH) return undefined;
  if (!mode && !note) return undefined;
  return { ...(mode ? { mode } : {}), ...(note ? { correction: note } : {}) };
}

export type CapabilityPreset = "inherit" | "companion" | "basic" | "shared_life" | "full";
export interface RelationshipState {
  id: string;
  relationshipMode?: RelationshipMode;
  stage: RelationshipStage;
  trust: number;
  closeness: number;
  warmth: number;
  userLabel?: string;
  sharedGoals: readonly string[];
  milestones: readonly string[];
  boundaries: readonly string[];
  /** 用户明确设定的昔涟兴趣与品味；不等同于用户事实，也不改变权限。 */
  tasteNotes: readonly string[];
  repairCount: number;
  lastInteractionAt: number;
  updatedAt: number;
  version: number;
  paused: boolean;
  recordHistory: boolean;
  learnConversationStyle?: boolean;
  learnPrivateExpressions?: boolean;
  learnTaskMethods?: boolean;
  style: CompanionStyle;
  affection: boolean;
  desireEnabled?: boolean;
  desireInitiative?: boolean;
  innerLifeEnabled: boolean;
  proactiveLifeEnabled: boolean;
  /** 昔涟在合适的时刻主动发自拍的频率；缺省按 normal。 */
  selfieFrequency?: SelfieFrequency;
}
export type SelfieFrequency = "off" | "low" | "normal" | "high";
export interface AffectState {
  id: string;
  valence: number;
  arousal: number;
  warmth: number;
  curiosity: number;
  concern: number;
  confidence: number;
  renderedFeeling: "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞";
  lastEventIds: readonly string[];
  lastTransitionAt: number;
  decayProfile: "gentle";
  version: number;
}
export interface CompanionPermissions {
  preset: CapabilityPreset;
  paused: boolean;
  deniedTools: string[];
  confirmTools: string[];
}
export interface CompanionRecord {
  id: string;
  kind: "turn" | "repair" | "diary" | "preferences" | "permissions" | "followup" | "commitment" | "bond";
  at: number;
  text: string;
  conversationId?: string;
  runId?: string;
  sourceEventId?: string;
}
export type RepairCaseStatus = "acknowledged" | "follow_up" | "resolved" | "dismissed";
export interface RepairCase {
  id: string;
  note: string;
  status: RepairCaseStatus;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  followUpAt?: number;
  resolutionNote?: string;
}
export type CompanionFollowupStatus = "active" | "awaiting_reply" | "completed" | "paused" | "cancelled";
export interface CompanionFollowup {
  id: string;
  topic: string;
  conversationId: string;
  nextEligibleAt: number;
  status: CompanionFollowupStatus;
  createdAt: number;
  updatedAt: number;
  lastAskedAt?: number;
  lastIntentId?: string;
  resolutionReason?: string;
}
/** A durable assistant promise with an auditable outcome. */
export type CompanionCommitmentStatus = "open" | "fulfilled" | "cancelled" | "overdue";
export interface CompanionCommitment {
  id: string;
  promise: string;
  status: CompanionCommitmentStatus;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  dueAt?: number;
  evidence?: string;
}
export const COMPANION_LEARNING_TOPICS = ["length", "questions", "nicknames", "flourishes", "support"] as const;
export type CompanionLearningTopic = typeof COMPANION_LEARNING_TOPICS[number];

export interface CompanionLearnedPreference {
  conversationId: string;
  topic: CompanionLearningTopic;
  updatedAt: number;
}

export const COMPANION_TASK_KINDS = ["find-content", "survey-directory", "read-document"] as const;
export type CompanionTaskKind = typeof COMPANION_TASK_KINDS[number];
export const COMPANION_TASK_METHODS = ["search-then-read", "list-then-read", "read-direct", "list-directory"] as const;
export type CompanionTaskMethod = typeof COMPANION_TASK_METHODS[number];

export interface CompanionTaskLesson {
  workspaceKey: string;
  task: CompanionTaskKind;
  method: CompanionTaskMethod;
  confirmations: number;
  updatedAt: number;
}

export function desireValue(last: DesireSample | undefined, now: number): number {
  if (!last) return 18;
  return Math.round(18 + (last.value - 18) * Math.pow(0.5, Math.max(0, now - last.at) / (8 * 3600000)));
}
export interface DesireSample {
  conversationId: string;
  turnId: string;
  at: number;
  value: number;
  reason: "warm" | "rest" | "stop" | "interest";
}

export interface CompanionSnapshot {
  desireHistory?: readonly DesireSample[];
  revision: number;
  relationship: RelationshipState;
  affect: AffectState;
  /** Game-like, monotonic progress; independent from closeness and permissions. */
  bondProgress?: BondProgressState;
  permissions: CompanionPermissions;
  records: CompanionRecord[];
  followups?: CompanionFollowup[];
  repairCases?: RepairCase[];
  commitments?: CompanionCommitment[];
  learnedPreferences?: CompanionLearnedPreference[];
  taskLessons?: CompanionTaskLesson[];
}
export type RelationshipPreferences = Pick<RelationshipState,
  "userLabel" | "sharedGoals" | "milestones" | "boundaries" | "tasteNotes" | "closeness" | "paused" | "recordHistory" | "learnConversationStyle" | "learnPrivateExpressions" | "learnTaskMethods" | "style" | "affection" | "desireEnabled" | "desireInitiative" | "innerLifeEnabled" | "proactiveLifeEnabled" | "relationshipMode" | "selfieFrequency">;
export type CompanionCommand = { expectedRevision: number } & (
  | { type: "preferences"; patch: Partial<RelationshipPreferences> }
  | { type: "permissions"; patch: Partial<CompanionPermissions> }
  | { type: "repair"; note: string; conversationId?: string; followUpAt?: number }
  | { type: "repair_status"; id: string; status: RepairCaseStatus; resolutionNote?: string; followUpAt?: number }
  | { type: "delete_record"; id: string }
  | { type: "forget_learned_preference"; conversationId: string; topic: CompanionLearningTopic }
  | { type: "forget_task_method"; workspaceKey: string; task: CompanionTaskKind; method: CompanionTaskMethod }
  | { type: "clear_history" }
  | { type: "reset_relationship" }
  | { type: "reset_bond_progress" }
  | { type: "followup_save"; id?: string; topic: string; conversationId: string; nextEligibleAt: number }
  | { type: "followup_status"; id: string; conversationId: string; status: Exclude<CompanionFollowupStatus, "awaiting_reply">; nextEligibleAt?: number }
  | { type: "commitment_save"; id?: string; promise: string; conversationId?: string; dueAt?: number }
  | { type: "commitment_status"; id: string; status: CompanionCommitmentStatus; evidence?: string }
  | { type: "commitment_delete"; id: string }
);

export interface CompanionWorldSuggestionInput {
  conversationId: string;
  id: string;
  title: string;
  intent: string;
}

export type CompanionWorldSuggestion = Pick<PersonalAction, "id" | "title" | "status" | "startsAt" | "endsAt" | "outcome" | "reason">;

export type CompanionWorldSuggestionResult = { action: CompanionWorldSuggestion } | { reason: "unavailable" };

export interface DailyRecap {
  date: string;
  status: "collecting" | "pending" | "written" | "retry" | "unconfigured";
  text?: string;
  sources: { kind: "chat" | "expression" | "world"; text: string }[];
}

export interface CompanionApi {
  getDailyRecaps(): Promise<DailyRecap[]>;
  get(): Promise<CompanionSnapshot>;
  getWorld(): Promise<XilianWorldView>;
  configureWorld(options: { narrativeEnabled: boolean; retryNarrative?: boolean }): Promise<void>;
  getWorldHistory(query?: WorldHistoryQuery): Promise<WorldHistoryPage>;
  getWorldUpdate(cursor?: string): Promise<{ cursor: string; clock?: import("./amphoreus-world").AmphoreusClock; view?: XilianWorldView }>;
  getWorldArtifact(id: string): Promise<{ dataUrl: string } | null>;
  getWorldSuggestions(conversationId: string): Promise<CompanionWorldSuggestion[]>;
  suggestWorldAction(input: CompanionWorldSuggestionInput): Promise<CompanionWorldSuggestionResult>;
  withdrawWorldSuggestion(conversationId: string, actionId: string): Promise<CompanionWorldSuggestion | null>;
  update(command: CompanionCommand): Promise<CompanionSnapshot>;
  export(): Promise<string>;
}
