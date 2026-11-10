/** One identity across all task modes and transports. No Electron dependency. */
import type { BondProgressState } from "./companion-progress";
import type { XilianWorldView } from "./xilian-world";
import type { WorldHistoryPage, WorldHistoryQuery } from "./amphoreus-world";

export type RelationshipStage = "new" | "familiar" | "close" | "long_term";
/**
 * 用户选择的关系场景契约。它只约束表达方式和主动性，不会扩大工具、
 * 文件或外部渠道权限，也不会把模拟关系当成现实关系。
 */
export type RelationshipMode = "assistant" | "friend" | "companion" | "partner";
export type CompanionStyle = "natural" | "gentle" | "lively" | "concise";
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
  style: CompanionStyle;
  affection: boolean;
  innerLifeEnabled: boolean;
  proactiveLifeEnabled: boolean;
}
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
export interface CompanionSnapshot {
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
}
export type RelationshipPreferences = Pick<RelationshipState,
  "userLabel" | "sharedGoals" | "milestones" | "boundaries" | "tasteNotes" | "closeness" | "paused" | "recordHistory" | "style" | "affection" | "innerLifeEnabled" | "proactiveLifeEnabled" | "relationshipMode">;
export type CompanionCommand = { expectedRevision: number } & (
  | { type: "preferences"; patch: Partial<RelationshipPreferences> }
  | { type: "permissions"; patch: Partial<CompanionPermissions> }
  | { type: "repair"; note: string; conversationId?: string; followUpAt?: number }
  | { type: "repair_status"; id: string; status: RepairCaseStatus; resolutionNote?: string; followUpAt?: number }
  | { type: "delete_record"; id: string }
  | { type: "clear_history" }
  | { type: "reset_relationship" }
  | { type: "reset_bond_progress" }
  | { type: "followup_save"; id?: string; topic: string; conversationId: string; nextEligibleAt: number }
  | { type: "followup_status"; id: string; conversationId: string; status: Exclude<CompanionFollowupStatus, "awaiting_reply">; nextEligibleAt?: number }
  | { type: "commitment_save"; id?: string; promise: string; conversationId?: string; dueAt?: number }
  | { type: "commitment_status"; id: string; status: CompanionCommitmentStatus; evidence?: string }
  | { type: "commitment_delete"; id: string }
);
export interface CompanionApi {
  get(): Promise<CompanionSnapshot>;
  getWorld(): Promise<XilianWorldView>;
  configureWorld(options: { narrativeEnabled: boolean }): Promise<void>;
  getWorldHistory(query?: WorldHistoryQuery): Promise<WorldHistoryPage>;
  getWorldUpdate(cursor?: string): Promise<{ cursor: string; clock?: import("./amphoreus-world").AmphoreusClock; view?: XilianWorldView }>;
  getWorldArtifact(id: string): Promise<{ dataUrl: string } | null>;
  update(command: CompanionCommand): Promise<CompanionSnapshot>;
  export(): Promise<string>;
}
