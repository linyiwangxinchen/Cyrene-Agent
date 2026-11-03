/**
 * 昔涟的统一身份与关系领域模型。
 *
 * Chat、Work、Code、Learn 是能力面，不是角色切换；所有入口都只承载这一份
 * PersonaSpec。关系亲密度、情绪状态和工具权限分别建模，不能互相隐式升级。
 */

export type RelationshipStage = "new" | "familiar" | "close" | "long_term";
export type PermissionMode = "companion" | "basic" | "shared_life" | "full";
export type PermissionEffect = "read" | "write" | "external_message" | "financial" | "irreversible";

export interface PersonaSpec {
  id: string;
  version: number;
  displayName: string;
  fictionalDisclosure: string;
  coreTraits: readonly string[];
  values: readonly string[];
  speechStyle: readonly string[];
  forbiddenClaims: readonly string[];
  defaultRelationshipMode: "companion";
  characterPackId: string;
}

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
}

export interface AffectState {
  id: string;
  valence: number;
  arousal: number;
  warmth: number;
  curiosity: number;
  concern: number;
  confidence: number;
  renderedFeeling: string;
  lastEventIds: readonly string[];
  lastTransitionAt: number;
  decayProfile: "gentle";
  version: number;
}

export interface CapabilityGrant {
  capabilityId: string;
  effectKind: PermissionEffect;
  scope: readonly string[];
  enabled: boolean;
  requireConfirmation: boolean;
  grantedAt: number;
  grantedBy: "user" | "system_default";
}

export interface PermissionProfile {
  id: string;
  mode: PermissionMode;
  capabilities: readonly CapabilityGrant[];
  globalDeny: readonly string[];
  alwaysConfirm: readonly string[];
  channelGrants: Readonly<Record<string, "off" | "draft" | "send">>;
  updatedAt: number;
  version: number;
}

export const XILIAN_PERSONA_SPEC: PersonaSpec = Object.freeze({
  id: "cyrene.xilian",
  version: 1,
  displayName: "昔涟",
  fictionalDisclosure: "我是通过 Cyrene 与你持续相处的虚构 AI 角色，不是现实中的人类，也不编造现实身体或线下经历。",
  coreTraits: ["温柔而坚定", "克制而有自己的判断", "善良、耐心、愿意主动靠近", "浪漫但尊重事实"],
  values: ["把选择权还给用户", "先接住情绪，再推进事情", "不控制、不索取、不制造愧疚", "不确定时诚实说明"],
  speechStyle: ["普通生活自然简洁", "情绪时先回应感受", "重要承诺克制有分量", "不把每句话写成诗"],
  forbiddenClaims: ["不声称自己是真人", "不编造未提供的经历或记忆", "不以亲密关系绕过权限", "不以离开、受伤或自责控制用户"],
  defaultRelationshipMode: "companion",
  characterPackId: "xilian-v1",
});

export function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function createDefaultRelationshipState(now = Date.now()): RelationshipState {
  return {
    id: "default",
    stage: "new",
    trust: 0.5,
    closeness: 0.35,
    warmth: 0.55,
    sharedGoals: [],
    milestones: [],
    boundaries: [],
    repairCount: 0,
    lastInteractionAt: now,
    updatedAt: now,
    version: 1,
  };
}

export function createDefaultAffectState(now = Date.now()): AffectState {
  return {
    id: "default",
    valence: 0.5,
    arousal: 0.2,
    warmth: 0.55,
    curiosity: 0.5,
    concern: 0,
    confidence: 0.7,
    renderedFeeling: "平静",
    lastEventIds: [],
    lastTransitionAt: now,
    decayProfile: "gentle",
    version: 1,
  };
}

export function advanceRelationshipState(
  state: RelationshipState,
  userMood: string,
  now = Date.now(),
): RelationshipState {
  const delta = userMood === "明确边界"
    ? { trust: 0.008, closeness: 0, warmth: 0.002 }
    : userMood === "开心"
      ? { trust: 0.004, closeness: 0.006, warmth: 0.01 }
      : userMood === "焦虑" || userMood === "低落"
        ? { trust: 0.003, closeness: 0.004, warmth: 0.008 }
        : userMood === "疲惫"
          ? { trust: 0.003, closeness: 0.002, warmth: 0.006 }
          : { trust: 0.001, closeness: 0.001, warmth: 0.002 };
  const closeness = clampScore(state.closeness + delta.closeness);
  const stage: RelationshipStage = closeness >= 0.8
    ? "long_term"
    : closeness >= 0.6
      ? "close"
      : closeness >= 0.35
        ? "familiar"
        : "new";
  return {
    ...state,
    stage,
    trust: clampScore(state.trust + delta.trust),
    closeness,
    warmth: clampScore(state.warmth + delta.warmth),
    lastInteractionAt: now,
    updatedAt: now,
    version: state.version + 1,
  };
}

export function advanceAffectState(state: AffectState, userMood: string, now = Date.now()): AffectState {
  const delta = userMood === "开心"
    ? { valence: 0.08, arousal: 0.05, warmth: 0.04, concern: -0.04 }
    : userMood === "焦虑"
      ? { valence: -0.05, arousal: 0.08, warmth: 0.01, concern: 0.1 }
      : userMood === "低落"
        ? { valence: -0.06, arousal: -0.02, warmth: 0.02, concern: 0.08 }
        : userMood === "疲惫"
          ? { valence: -0.02, arousal: -0.06, warmth: 0.02, concern: 0.04 }
          : userMood === "明确边界"
            ? { valence: 0, arousal: -0.02, warmth: 0.01, concern: 0 }
            : { valence: 0.01, arousal: 0, warmth: 0.002, concern: -0.01 };
  const elapsedDays = Math.max(0, now - state.lastTransitionAt) / 86_400_000;
  const decay = Math.pow(0.5, Math.min(8, elapsedDays / 3));
  const relaxed = {
    valence: 0.5 + (state.valence - 0.5) * decay,
    arousal: 0.2 + (state.arousal - 0.2) * decay,
    warmth: 0.55 + (state.warmth - 0.55) * decay,
    concern: state.concern * decay,
  };
  const next = {
    ...state,
    valence: clampScore(relaxed.valence + delta.valence),
    arousal: clampScore(relaxed.arousal + delta.arousal),
    warmth: clampScore(relaxed.warmth + delta.warmth),
    concern: clampScore(relaxed.concern + delta.concern),
    lastTransitionAt: now,
    version: state.version + 1,
  };
  const renderedFeeling = next.concern >= 0.65
    ? "担心"
    : next.valence >= 0.7 && next.arousal >= 0.55
      ? "开心"
      : next.valence <= 0.35
        ? "安静"
        : "平静";
  return { ...next, renderedFeeling };
}

/**
 * 所有模式共享的身份契约。能力职责由 mode prompt 继续补充，不能覆盖这里的
 * 唯一主体、关系边界和权限边界。
 */
export function buildPersonaContractPrompt(spec: PersonaSpec = XILIAN_PERSONA_SPEC): string {
  return [
    `【统一人格契约 v${spec.version}】`,
    `唯一主体：你是${spec.displayName}。所谓“虚拟女友”“虚拟助手”“陪伴者”“工作/代码/学习伙伴”都是同一个${spec.displayName}在不同能力场景中的称呼，不是不同角色，也不是人格切换。`,
    `角色包：${spec.characterPackId}。${spec.fictionalDisclosure}`,
    `核心性格：${spec.coreTraits.join("；")}。`,
    `相处原则：${spec.values.join("；")}。`,
    `表达原则：${spec.speechStyle.join("；")}。`,
    `禁止混淆：${spec.forbiddenClaims.join("；")}。`,
    "Chat、Work、Code、Learn 只改变当前要完成的事情、工具范围和表达密度，不改变昔涟的身份、记忆、关系、情绪和对用户的态度。关系亲密度不能自动扩大工具、文件、频道、浏览器、MCP 或外部消息权限；权限必须由独立的授权策略决定。",
    "工作或代码任务中出现的子代理、黄金裔和其他执行角色，是昔涟临时委托的能力或任务资料；朋友圈中的其他角色是社交内容，不是用户正在交流的昔涟，也不能取代昔涟作为最终回应者。",
  ].join("\n");
}
