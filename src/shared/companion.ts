/** One identity across all task modes and transports. No Electron dependency. */
import type { BondProgressState } from "./companion-progress";

export type RelationshipStage = "new" | "familiar" | "close" | "long_term";
export type CompanionStyle = "natural" | "gentle" | "lively" | "concise";
export type CapabilityPreset = "inherit" | "companion" | "basic" | "shared_life" | "full";
export interface RelationshipState {
  id: string;
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
  kind: "turn" | "repair" | "diary" | "preferences" | "permissions" | "followup" | "bond";
  at: number;
  text: string;
  conversationId?: string;
  runId?: string;
  sourceEventId?: string;
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
export interface CompanionSnapshot {
  revision: number;
  relationship: RelationshipState;
  affect: AffectState;
  /** Game-like, monotonic progress; independent from closeness and permissions. */
  bondProgress?: BondProgressState;
  permissions: CompanionPermissions;
  records: CompanionRecord[];
  followups?: CompanionFollowup[];
}
export type RelationshipPreferences = Pick<RelationshipState,
  "userLabel" | "sharedGoals" | "milestones" | "boundaries" | "tasteNotes" | "closeness" | "paused" | "recordHistory" | "style" | "affection" | "innerLifeEnabled" | "proactiveLifeEnabled">;
export type CompanionCommand = { expectedRevision: number } & (
  | { type: "preferences"; patch: Partial<RelationshipPreferences> }
  | { type: "permissions"; patch: Partial<CompanionPermissions> }
  | { type: "repair"; note: string }
  | { type: "delete_record"; id: string }
  | { type: "clear_history" }
  | { type: "reset_relationship" }
  | { type: "reset_bond_progress" }
  | { type: "followup_save"; id?: string; topic: string; conversationId: string; nextEligibleAt: number }
  | { type: "followup_status"; id: string; conversationId: string; status: Exclude<CompanionFollowupStatus, "awaiting_reply">; nextEligibleAt?: number }
);
export interface CompanionApi {
  get(): Promise<CompanionSnapshot>;
  update(command: CompanionCommand): Promise<CompanionSnapshot>;
  export(): Promise<string>;
}
