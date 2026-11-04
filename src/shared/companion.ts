/** One identity across all task modes and transports. No Electron dependency. */
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
  kind: "turn" | "repair" | "diary" | "preferences" | "permissions";
  at: number;
  text: string;
  conversationId?: string;
  runId?: string;
  sourceEventId?: string;
}
export interface CompanionSnapshot {
  revision: number;
  relationship: RelationshipState;
  affect: AffectState;
  permissions: CompanionPermissions;
  records: CompanionRecord[];
}
export type RelationshipPreferences = Pick<RelationshipState,
  "userLabel" | "sharedGoals" | "milestones" | "boundaries" | "closeness" | "paused" | "recordHistory" | "style" | "affection" | "innerLifeEnabled" | "proactiveLifeEnabled">;
export type CompanionCommand = { expectedRevision: number } & (
  | { type: "preferences"; patch: Partial<RelationshipPreferences> }
  | { type: "permissions"; patch: Partial<CompanionPermissions> }
  | { type: "repair"; note: string }
  | { type: "delete_record"; id: string }
  | { type: "clear_history" }
  | { type: "reset_relationship" }
);
export interface CompanionApi {
  get(): Promise<CompanionSnapshot>;
  update(command: CompanionCommand): Promise<CompanionSnapshot>;
  export(): Promise<string>;
}
