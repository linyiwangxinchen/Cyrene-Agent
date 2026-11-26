import { detectUserMood } from "./mood-cues"
import { createHash, randomUUID } from "node:crypto"
import { RelationshipRepository } from "./relationship-repository"
import { normalizeFollowups, resolveExplicitFollowupReply } from "./followup-state"
import { classifyCompanionFeedback, isDirectCompanionWording, isTemporaryCompanionWording, stripCompanionQuotedBlocks, type CompanionFeedbackObservation, type CompanionLearningPreference } from "./companion-learning"
import { COMPANION_LEARNING_TOPICS, type CompanionLearnedPreference, type CompanionLearningTopic, type CompanionFollowup, type CompanionCommitment, type CompanionCommitmentStatus } from "../../shared/companion"
import { COMPANION_TASK_KINDS, COMPANION_TASK_METHODS, type CompanionTaskKind, type CompanionTaskLesson, type CompanionTaskMethod } from "../../shared/companion"
import type { CompanionSnapshot, CompanionCommand, CompanionPermissions, CompanionRecord, RelationshipPreferences, RepairCase, RepairCaseStatus, RelationshipMode, SelfieFrequency } from "../../shared/companion"
import { isCompanionEvent, sanitizeCompanionEvent, type CompanionEvent } from "../../shared/companion-events"
import { applyBondEvent, createDefaultBondProgress, normalizeBondProgress, type BondProgressState } from "../../shared/companion-progress"
import { XILIAN_CHARACTER_PACK } from "../character-packs/xilian-pack"
import type { ChannelId } from "../channels/types"
import {
  advanceAffectState,
  advanceAffectForEvent,
  decayAffectState,
  relationshipStage,
  advanceRelationshipState,
  advanceRelationshipForEvent,
  createDefaultAffectState,
  createDefaultRelationshipState,
  type AffectState,
  type RelationshipState,
} from "../persona/persona-spec"

export type RelationshipChannel = "desktop" | "web" | ChannelId

export interface CompanionFeedbackInput {
  text: string
  userTurnId: string
  revision: number
  source?: { userEntryId: string; userRevision: number };
}

export interface AcceptedCompanionFeedback {
  conversationId: string;
  userTurnId: string;
  userEntryId: string;
  userRevision: number;
  speechScope: string;
  text: string;
  channel: RelationshipChannel;
}

import { collectPrivateExpressions, expressionCorrection, privateExpressionHint, speechObservations, rememberSpeech, isSpeechObservation, type SpeechObservation } from "./private-expressions";
import { addDesireSample, desireAvailable, desireContext } from "./partner-desire";
import type { DesireSample } from "../../shared/companion";
import type { CompanionReference } from "../../shared/companion-references";

export interface RelationshipTurnInput {
  companionTurnId?: string;
  speechScope?: string;
  userText: string
  assistantText: string
  cyreneFeeling: string
  channel: RelationshipChannel
  conversationId?: string
  runId?: string
  sourceEventId?: string
  /** Group/social sessions must never write the owner's private relationship view. */
  privateContext?: boolean
  companionFeedback?: CompanionFeedbackInput
}

export interface RelationshipLogEntry extends Omit<RelationshipTurnInput, "companionFeedback"> {
  learnedExpressions?: boolean;
  id: string
  date: string
  createdAt: number
  userMood: string
  relationshipSignal: string
  importantMoment?: string
  nextCareCue: string
}

export interface RelationshipDailySummary {
  date: string
  updatedAt: number
  summary: string
  nextCareCue: string
}

export interface SavedDailyRecap {
  date: string;
  digest: string;
  attemptedAt: number;
  writtenAt?: number;
  text?: string;
  turns: { id: string; conversationId: string; turnId: string }[];
  expressionIds: string[];
  privateWords: string[];
  factHashes: string[];
}

export type RelationshipPreferencesPatch = Partial<RelationshipPreferences>

interface CompanionFeedbackRecord {
  speechScope?: string;
  userEntryId?: string;
  userRevision?: number;
  contextHash?: string;
  entryId: string
  conversationId: string
  userTurnId: string
  at: number
  topic: CompanionLearningTopic
  preference: CompanionLearningPreference
  explicit: boolean
}

type SourcedRepairCase = RepairCase & { userTurnId?: string; userEntryId?: string; userRevision?: number; speechScope?: string };

interface TaskMethodObservation {
  workspaceKey: string
  conversationId: string
  userTurnId: string
  task: CompanionTaskKind
  method: CompanionTaskMethod
  outcome: "worked" | "missed"
  at: number
}

type TaskMethodObservationInput = Omit<TaskMethodObservation, "at"> & { revision: number };

interface RelationshipLogData {
  speech: SpeechObservation[];
  desireHistory?: DesireSample[];
  entries: RelationshipLogEntry[]
  dailyRecaps?: SavedDailyRecap[]
  dailySummaries: RelationshipDailySummary[]
  relationshipState: RelationshipState
  affectState: AffectState
  revision: number
  permissions: CompanionPermissions
  records: CompanionRecord[]
  seenEventKeys: string[]
  lastDiaryDay: string
  followups: CompanionFollowup[]
  repairCases: SourcedRepairCase[]
  commitments: CompanionCommitment[]
  bondProgress: BondProgressState
  seenCompanionEventIds: string[]
  companionFeedback: CompanionFeedbackRecord[]
  acceptedFeedbackKeys: string[]
  learningRevision: number
  taskObservations: TaskMethodObservation[]
  taskLearningRevision: number
}

const EMPTY_DATA: RelationshipLogData = {
  speech: [],
  entries: [],
  dailySummaries: [],
  revision: 1,
  permissions: { preset: "inherit", paused: false, deniedTools: [], confirmTools: [] },
  records: [],
  seenEventKeys: [],
  lastDiaryDay: "",
  followups: [],
  bondProgress: createDefaultBondProgress(0),
  seenCompanionEventIds: [],
  repairCases: [],
  commitments: [],
  companionFeedback: [],
  acceptedFeedbackKeys: [],
  learningRevision: 1,
  taskObservations: [],
  taskLearningRevision: 1,
  relationshipState: createDefaultRelationshipState(0),
  affectState: createDefaultAffectState(0),
}

const MAX_ENTRIES = 500
const MAX_DAILY_SUMMARIES = 90
const MAX_COMPANION_FEEDBACK = 1000
const MAX_TASK_OBSERVATIONS = 1000

const LEARNED_STYLE: Record<CompanionLearningTopic, string> = {
  length: "日常接话短一点，说到点上就停。",
  questions: "说完可以停，少用问句收尾。",
  nicknames: "留意场合，少用昵称，平常直接接话。",
  flourishes: "用日常口语，少用固定开头、抒情收尾和语气装饰。",
  support: "对方倾诉时先听完，再按对方的需要给建议。",
};

function learnedPreferences(records: readonly CompanionFeedbackRecord[], share = false): CompanionLearnedPreference[] {
  const states = new Map<string, { pending: CompanionLearningPreference; contextHash?: string; active?: CompanionLearnedPreference }>();
  for (const { conversationId, topic, at, explicit, preference, speechScope, contextHash, userTurnId } of records) {
    const key = JSON.stringify([share && speechScope ? speechScope : conversationId, topic]);
    const previous = states.get(key);
    const confirmed = explicit || (previous?.pending === preference && (!contextHash || !previous.contextHash || contextHash !== previous.contextHash));
    states.set(key, {
      pending: preference,
      contextHash,
      active: confirmed ? (preference === "prefer" ? { conversationId, topic, updatedAt: at, userTurnId } : undefined) : previous?.active,
    });
  }
  return [...states.values()].flatMap(state => state.active ? [state.active] : []).sort((a, b) => b.updatedAt - a.updatedAt);
}

function appendFeedback(
  data: RelationshipLogData,
  source: Omit<CompanionFeedbackRecord, keyof CompanionFeedbackObservation>,
  observations: readonly CompanionFeedbackObservation[],
): boolean {
  const fresh = observations.filter(observation => !data.companionFeedback.some(item =>
    item.conversationId === source.conversationId && item.userTurnId === source.userTurnId
    && item.userEntryId === source.userEntryId && item.userRevision === source.userRevision && item.speechScope === source.speechScope
    && item.topic === observation.topic));
  if (!fresh.length) return false;
  data.companionFeedback = [...data.companionFeedback, ...fresh.map(observation => ({ ...observation, ...source }))].slice(-MAX_COMPANION_FEEDBACK);
  return true;
}

function feedbackContextHash(text: string): string {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return createHash("sha256").update(normalized).digest("hex");
}

function validCompanionFeedback(item: CompanionFeedbackRecord): boolean {
  return Boolean(item && typeof item.entryId === "string" && typeof item.conversationId === "string"
    && typeof item.userTurnId === "string" && Number.isFinite(item.at)
    && COMPANION_LEARNING_TOPICS.includes(item.topic) && (item.preference === "prefer" || item.preference === "default")
    && typeof item.explicit === "boolean");
}

function validTaskMethod(lesson: Pick<CompanionTaskLesson, "workspaceKey" | "task" | "method">): boolean {
  return typeof lesson.workspaceKey === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(lesson.workspaceKey)
    && COMPANION_TASK_KINDS.includes(lesson.task) && COMPANION_TASK_METHODS.includes(lesson.method);
}

function validTaskObservation(item: Omit<TaskMethodObservation, "at">): boolean {
  return Boolean(item && typeof item.conversationId === "string" && item.conversationId.trim() && item.conversationId.length <= 256
    && typeof item.userTurnId === "string" && item.userTurnId.trim() && item.userTurnId.length <= 256
    && (item.outcome === "worked" || item.outcome === "missed") && validTaskMethod(item));
}

function summarizeTaskLessons(observations: readonly TaskMethodObservation[]): CompanionTaskLesson[] {
  const methods = new Map<string, { lesson: CompanionTaskLesson; lastObservation: number }>();
  observations.forEach(({ workspaceKey, task, method, outcome, at }, index) => {
    const key = JSON.stringify([workspaceKey, task, method]);
    const confirmations = (methods.get(key)?.lesson.confirmations ?? 0) + (outcome === "worked" ? 1 : -1);
    methods.set(key, { lesson: { workspaceKey, task, method, confirmations, updatedAt: at }, lastObservation: index });
  });
  return [...methods.values()]
    .filter(({ lesson }) => lesson.confirmations >= 2)
    .sort((a, b) => b.lesson.confirmations - a.lesson.confirmations || b.lastObservation - a.lastObservation)
    .map(({ lesson }) => lesson);
}

function taskLearningEnabled(state: RelationshipState): boolean {
  return !state.paused && state.recordHistory && state.learnTaskMethods !== false;
}

const MOOD_REPLY_HINTS: Partial<Record<string, string>> = {
  疲惫: "如果对方在说自己现在累，放轻语气，少让对方费力解释。",
  焦虑: "如果对方在说眼下担心的事，先接住那件具体的事，给对方留点说话的余地。",
  低落: "如果对方在说自己现在难受，先听下去，回应对方具体说的事。",
  开心: "如果对方在分享开心的事，可以跟着高兴一下，说说刚听到的那件事。",
  明确边界: "如果对方说想先停一停，顺着这个意思接话。",
};

function localDate(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function compact(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim()
  return s.length > max ? s.slice(0, max) + "..." : s
}

function deriveSignal(userText: string, userMood: string): {
  relationshipSignal: string
  importantMoment?: string
  nextCareCue: string
} {
  if (userMood === "明确边界") {
    return {
      relationshipSignal: "用户表达了低打扰偏好或体验边界，需要优先尊重，不要把关心做成打断。",
      importantMoment: "用户明确表示不喜欢影响观感的确认卡片或过度询问。",
      nextCareCue: "减少不必要的追问；必须的工具授权与风险确认仍需执行，不能以低打扰为由绕过。",
    }
  }

  if (userMood === "疲惫") {
    return {
      relationshipSignal: "用户显露疲惫状态，更需要低压力陪伴和短回应。",
      nextCareCue: "下次回应提示：少安排、少追问，语气放慢，先接住状态。",
    }
  }

  if (userMood === "焦虑") {
    return {
      relationshipSignal: "用户可能处在压力或焦虑里，需要稳定感和清晰的小步建议。",
      nextCareCue: "下次回应提示：先安抚，再给一两个可执行小步，不要铺太大。",
    }
  }

  if (userMood === "低落") {
    return {
      relationshipSignal: "用户情绪偏低，需要被理解和陪着，而不是立刻被纠正。",
      nextCareCue: "下次回应提示：先承认感受，再轻轻陪伴，不要急着总结道理。",
    }
  }

  if (userMood === "开心") {
    return {
      relationshipSignal: "用户反馈偏积极，可以保持轻快互动并记住触发愉快的点。",
      nextCareCue: "下次回应提示：可以更轻松一点，延续用户的好状态。",
    }
  }

  return {
    relationshipSignal: "本轮互动没有明显情绪峰值，保持自然陪伴即可。",
    nextCareCue: `下次回应提示：延续最近话题「${compact(userText, 40)}」，不要过度解读。`,
  }
}

function matchingCommitments(
  relationship: RelationshipState,
  userText: string,
  assistantText: string,
): Array<{ kind: "goal_progressed" | "moment_shared"; text: string }> {
  const haystack = `${userText} ${assistantText}`.replace(/\s+/g, "").toLowerCase();
  const matches: Array<{ kind: "goal_progressed" | "moment_shared"; text: string }> = [];
  for (const goal of relationship.sharedGoals) {
    const needle = goal.replace(/\s+/g, "").toLowerCase();
    if (needle.length >= 2 && (haystack.includes(needle) || needle.split(/[，。！？、:：\/\\]/).some(part => part.length >= 4 && haystack.includes(part)))) {
      matches.push({ kind: "goal_progressed", text: goal });
    }
  }
  for (const milestone of relationship.milestones) {
    const needle = milestone.replace(/\s+/g, "").toLowerCase();
    if (needle.length >= 2 && (haystack.includes(needle) || needle.split(/[，。！？、:：\/\\]/).some(part => part.length >= 4 && haystack.includes(part)))) {
      matches.push({ kind: "moment_shared", text: milestone });
    }
  }
  return matches.slice(0, 5);
}

const PROMISE_ACTION = /(?:我(?:会|来|将|去)|稍后我|待会(?:儿)?我|接下来我).{0,8}?(?:帮你|给你|替你|去|把|整理|查|发|改|做|提醒|找|写|弄|准备|看看|核对)/u;

/** Task promises only. Quoted story lines and vows about how she will talk are not ledger items. */
function extractAssistantPromises(text: string): string[] {
  const withoutQuotes = text.replace(/「[^」]*」|“[^”]*”|"[^"]*"/gu, " ");
  return withoutQuotes.split(/[。！？!?\n]+/)
    .map((part) => compact(part, 180))
    .filter((part) => part.length >= 4 && part.length <= 80 && PROMISE_ACTION.test(part) && !part.includes("不会") && !part.includes("不再"))
    .slice(0, 3);
}

const CORRECTION_CUE = /^(?:纠正|更正|订正)\s*[:：]|不像人(?:说|话)|没有.{0,10}这种(?:词|说法)|(?:别|不要)再(?:说|用|提)|没头没脑|说的话.{0,4}(?:奇怪|别扭)|好(?:奇怪|别扭)的(?:话|说法)/u;

/** The user explicitly corrected how she talks. Kept as a standing note for the conversation. */
export function isCompanionCorrection(text: string): boolean {
  const direct = stripCompanionQuotedBlocks(text).trim();
  return isDirectCompanionWording(direct) && CORRECTION_CUE.test(direct);
}

function explicitRepairNote(text: string): string | undefined {
  const direct = stripCompanionQuotedBlocks(text).trim();
  if (!isDirectCompanionWording(direct) || isTemporaryCompanionWording(direct)) return;
  if (!/^(?:纠正|更正|订正)\s*[:：]|^(?:从今以后|从现在起|今后|以后|往后)\s*(?:别|不要)(?:再)?(?:这样|这么)/u.test(direct)) return;
  return compact(direct, 200) || undefined;
}

function refreshCommitmentStatuses(data: RelationshipLogData, now: number): boolean {
  let changed = false;
  for (const item of data.commitments) {
    if (item.status === "open" && item.dueAt !== undefined && item.dueAt <= now) {
      item.status = "overdue";
      item.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

function normalizeData(value: unknown): RelationshipLogData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关系数据格式无效，原始文件已保留");
  const raw = value as Partial<RelationshipLogData>;
  const relationship = { ...createDefaultRelationshipState(), ...raw.relationshipState };
  const affect = { ...createDefaultAffectState(), ...raw.affectState };
  const bondProgress = normalizeBondProgress(raw.bondProgress);
  // Validate migrated/persisted values as well as incoming IPC patches. Do not
  // silently reset damaged user data or accidentally disable a saved restriction.
  validatePatch(Object.fromEntries(["userLabel", "sharedGoals", "milestones", "boundaries", "tasteNotes", "closeness", "paused", "recordHistory", "learnConversationStyle", "learnPrivateExpressions", "learnTaskMethods", "style", "affection", "desireEnabled", "desireInitiative", "innerLifeEnabled", "proactiveLifeEnabled", "relationshipMode", "selfieFrequency"]
    .filter(key => (relationship as unknown as Record<string, unknown>)[key] !== undefined)
    .map(key => [key, (relationship as unknown as Record<string, unknown>)[key]])));
  const permissions = { ...EMPTY_DATA.permissions, ...raw.permissions };
  if (!["inherit", "companion", "basic", "shared_life", "full"].includes(permissions.preset)
    || typeof permissions.paused !== "boolean"
    || [permissions.deniedTools, permissions.confirmTools].some(items => !Array.isArray(items) || items.some(item => typeof item !== "string"))) {
    throw new Error("能力权限数据无效，原始文件已保留");
  }
  if ((raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 1))
    || (raw.learningRevision !== undefined && (!Number.isSafeInteger(raw.learningRevision) || raw.learningRevision < 1))
    || (raw.speech !== undefined && (!Array.isArray(raw.speech) || !raw.speech.every(isSpeechObservation)))
    || (raw.companionFeedback !== undefined && (!Array.isArray(raw.companionFeedback) || !raw.companionFeedback.every(validCompanionFeedback)))
    || (raw.taskLearningRevision !== undefined && (!Number.isSafeInteger(raw.taskLearningRevision) || raw.taskLearningRevision < 1))
    || (raw.taskObservations !== undefined && (!Array.isArray(raw.taskObservations)
      || !raw.taskObservations.every(item => Number.isFinite(item?.at) && validTaskObservation(item))))
    || (raw.desireHistory !== undefined && (!Array.isArray(raw.desireHistory) || raw.desireHistory.some(s => !s || typeof s.conversationId !== "string" || typeof s.turnId !== "string" || !Number.isFinite(s.at) || !Number.isInteger(s.value) || s.value < 0 || s.value > 100 || !["warm","interest","stop","rest"].includes(s.reason))))
    || !Number.isFinite(affect.lastTransitionAt)
    || (raw.lastDiaryDay !== undefined && typeof raw.lastDiaryDay !== "string")
    || [raw.entries, raw.dailySummaries, raw.records].some(items => items !== undefined && !Array.isArray(items))) {
    throw new Error("关系记录格式无效，原始文件已保留");
  }
  if (raw.entries?.some(item => !item || typeof item.id !== "string" || !Number.isFinite(item.createdAt)
    || [item.userText, item.assistantText, item.userMood, item.nextCareCue].some(text => typeof text !== "string"))
    || raw.records?.some(item => !item || typeof item.id !== "string" || typeof item.text !== "string" || !Number.isFinite(item.at))) {
    throw new Error("关系记录内容无效，原始文件已保留");
  }
  for (const field of ["closeness", "trust", "warmth"] as const) {
    if (!Number.isFinite(relationship[field]) || relationship[field] < 0 || relationship[field] > 1) throw new Error("关系数据数值无效，原始文件已保留");
  }
  for (const field of ["valence", "arousal", "warmth", "curiosity", "concern", "confidence"] as const) {
    if (!Number.isFinite(affect[field]) || affect[field] < 0 || affect[field] > 1) throw new Error("情绪数据数值无效，原始文件已保留");
  }
  const repairCases = Array.isArray(raw.repairCases) ? raw.repairCases.filter((item): item is SourcedRepairCase => Boolean(
    item && typeof item === "object" && typeof item.id === "string" && item.id.length <= 160
      && typeof item.note === "string" && item.note.length <= 500
      && ["acknowledged", "follow_up", "resolved", "dismissed"].includes(item.status)
      && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt)
      && (item.conversationId === undefined || typeof item.conversationId === "string")
      && (item.followUpAt === undefined || Number.isFinite(item.followUpAt))
      && (item.resolutionNote === undefined || typeof item.resolutionNote === "string"),
  )).slice(-100) : [];
  const commitments = Array.isArray(raw.commitments) ? raw.commitments.filter((item): item is CompanionCommitment => Boolean(
    item && typeof item === "object" && typeof item.id === "string" && item.id.length <= 160
      && typeof item.promise === "string" && item.promise.trim().length > 0 && item.promise.length <= 500
      && ["open", "fulfilled", "cancelled", "overdue"].includes(item.status)
      && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt)
      && (item.conversationId === undefined || typeof item.conversationId === "string")
      && (item.dueAt === undefined || Number.isFinite(item.dueAt))
      && (item.evidence === undefined || (typeof item.evidence === "string" && item.evidence.length <= 500)),
  )).slice(-200) : [];
  relationship.stage = relationshipStage(relationship.closeness);
  return {
    ...EMPTY_DATA, ...raw, relationshipState: relationship, affectState: affect, bondProgress,
    permissions,
    companionFeedback: raw.companionFeedback?.slice(-MAX_COMPANION_FEEDBACK) ?? [],
    acceptedFeedbackKeys: Array.isArray(raw.acceptedFeedbackKeys)
      ? raw.acceptedFeedbackKeys.filter(key => typeof key === "string" && /^[a-f0-9]{64}$/u.test(key)).slice(-10000)
      : [],
    taskObservations: raw.taskObservations?.slice(-MAX_TASK_OBSERVATIONS) ?? [],
    followups: normalizeFollowups(raw.followups),
    repairCases,
    commitments,
    speech: raw.speech ?? (raw.entries ?? []).flatMap(entry => speechObservations(entry)),
    entries: Array.isArray(raw.entries) ? raw.entries.slice(-MAX_ENTRIES) : [],
    dailySummaries: Array.isArray(raw.dailySummaries) ? raw.dailySummaries.slice(-MAX_DAILY_SUMMARIES) : [],
    records: Array.isArray(raw.records) ? raw.records.slice(-500) : [],
    seenEventKeys: Array.isArray(raw.seenEventKeys) ? raw.seenEventKeys.filter(key => typeof key === "string").slice(-10000) : [],
    seenCompanionEventIds: Array.isArray(raw.seenCompanionEventIds)
      ? raw.seenCompanionEventIds.filter((key): key is string => typeof key === "string").slice(-10000)
      : [],
  };
}

function validatePatch(patch: unknown): RelationshipPreferencesPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("偏好必须是对象");
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (["sharedGoals", "milestones", "boundaries"].includes(key)) {
      if (!Array.isArray(value) || value.length > 30 || value.some(item => typeof item !== "string" || item.length > 200)) throw new Error(`${key} 最多 30 行，每行最多 200 字`);
      result[key] = [...new Set(value.map(item => item.trim()).filter(Boolean))];
    } else if (key === "tasteNotes") {
      if (!Array.isArray(value) || value.length > 30 || value.some(item => typeof item !== "string" || item.length > 120)) throw new Error("tasteNotes 最多 30 行，每行最多 120 字");
      result[key] = [...new Set(value.map(item => item.trim()).filter(Boolean))];
    } else if (key === "userLabel") {
      if (typeof value !== "string" || value.length > 80) throw new Error("称呼最多 80 字");
      result[key] = value.trim();
    } else if (key === "closeness") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("相处程度必须在 0 到 1 之间");
      result[key] = value;
    } else if (["paused", "recordHistory", "learnConversationStyle", "learnPrivateExpressions", "learnTaskMethods", "affection", "desireEnabled", "desireInitiative", "innerLifeEnabled", "proactiveLifeEnabled"].includes(key)) {
      if (typeof value !== "boolean") throw new Error(`${key} 必须是开关值`);
      result[key] = value;
    } else if (key === "style") {
      if (!["natural", "gentle", "lively", "concise"].includes(String(value))) throw new Error("未知表达偏好");
      result[key] = value;
    } else if (key === "relationshipMode") {
      if (!["assistant", "friend", "companion", "partner"].includes(String(value))) throw new Error("未知关系模式");
      result[key] = value as RelationshipMode;
    } else if (key === "selfieFrequency") {
      if (!["off", "low", "normal", "high"].includes(String(value))) throw new Error("未知自拍频率");
      result[key] = value as SelfieFrequency;
    } else throw new Error(`不允许修改字段：${key}`);
  }
  return result;
}

function summarizeDate(date: string, entries: RelationshipLogEntry[]): RelationshipDailySummary {
  const moods = entries.map((e) => e.userMood).filter((m) => m !== "未知")
  const dominantMood = moods.at(-1) ?? "平稳"
  const important = [...entries].reverse().find((e) => e.importantMoment)?.importantMoment
  const cue = entries.at(-1)?.nextCareCue ?? "保持自然陪伴。"
  const signal = entries.at(-1)?.relationshipSignal ?? "今天互动平稳。"
  const parts = [
    `${date}：用户最近状态偏「${dominantMood}」。`,
    important ? `重要偏好：${important}` : signal,
    cue,
  ]
  return {
    date,
    updatedAt: Date.now(),
    summary: parts.join(" "),
    nextCareCue: cue,
  }
}

function applyCompanionEventToData(
  data: RelationshipLogData,
  event: CompanionEvent,
  now = Date.now(),
): ReturnType<typeof applyBondEvent> {
  if (data.seenCompanionEventIds.includes(event.eventId)) {
    return { state: data.bondProgress, awarded: null, chapterChanged: false };
  }
  const result = applyBondEvent(data.bondProgress, event, now);
  data.seenCompanionEventIds = [...data.seenCompanionEventIds, event.eventId].slice(-10000);
  // Event signals are intentionally small and explainable. Configuration
  // entries (for example, merely adding a goal in settings) are not shared
  // experiences and must not inflate the relationship or affect state.
  if (!event.eventId.startsWith("preference:")) {
    data.affectState = advanceAffectForEvent(data.affectState, event, now);
    data.relationshipState = advanceRelationshipForEvent(data.relationshipState, event, now);
  }
  if (result.awarded) {
    data.bondProgress = result.state;
    data.records.push({
      id: `bond-${event.eventId}`,
      kind: "bond",
      at: event.occurredAt,
      conversationId: event.conversationId,
      sourceEventId: event.eventId,
      text: `羁绊进度 +${result.awarded.delta}：${result.awarded.summary}`,
    });
    data.records = data.records.slice(-500);
  }
  return result;
}

export class RelationshipLogStore {
  private readonly repository: RelationshipRepository<RelationshipLogData>;
  constructor(filePath: string) { this.repository = new RelationshipRepository(filePath, normalizeData); }

  getControls(): { revision: number; learningRevision: number; paused: boolean; permissions: CompanionPermissions } {
    const data = this.repository.read();
    return { revision: data.revision, learningRevision: data.learningRevision, paused: data.relationshipState.paused, permissions: data.permissions };
  }
  getTaskLearningRevision(): number | undefined {
    const data = this.repository.read();
    return taskLearningEnabled(data.relationshipState) ? data.taskLearningRevision : undefined;
  }
  getTaskLessons(workspaceKey: string, task: CompanionTaskKind): CompanionTaskLesson[] {
    const data = this.repository.read();
    if (!taskLearningEnabled(data.relationshipState)) return [];
    return summarizeTaskLessons(data.taskObservations.filter(item => item.workspaceKey === workspaceKey && item.task === task));
  }
  recordTaskObservation(input: TaskMethodObservationInput): void {
    if (!validTaskObservation(input)) return;
    const data = this.repository.read();
    if (!taskLearningEnabled(data.relationshipState) || input.revision !== data.taskLearningRevision) return;
    const { workspaceKey, conversationId, userTurnId, task, method, outcome } = input;
    const duplicate = data.taskObservations.some(item => item.conversationId === conversationId && item.userTurnId === userTurnId
      && item.workspaceKey === workspaceKey && item.task === task && item.method === method);
    if (duplicate) return;
    data.taskObservations.push({ workspaceKey, conversationId, userTurnId, task, method, outcome, at: Date.now() });
    data.taskObservations = data.taskObservations.slice(-MAX_TASK_OBSERVATIONS);
    data.revision++;
    this.repository.write(data);
  }

  /** Record what the user explicitly committed, independently of whether a reply can be generated. */
  recordAcceptedCompanionFeedback(input: AcceptedCompanionFeedback): void {
    const { conversationId, userTurnId, userEntryId, userRevision, speechScope, channel, text } = input;
    if (!conversationId || !userTurnId || !userEntryId || !speechScope
      || !Number.isSafeInteger(userRevision) || userRevision < 1 || !text.trim()) return;
    const data = this.repository.read();
    const relationship = data.relationshipState;
    if (!relationship.recordHistory || relationship.paused) return;
    const at = Date.now();
    const sourceKey = createHash("sha256").update(JSON.stringify([conversationId, userEntryId, userRevision, speechScope])).digest("hex");
    if (data.acceptedFeedbackKeys.includes(sourceKey)) return;
    const entryId = `explicit-feedback:${sourceKey}`;
    let changed = relationship.learnConversationStyle !== false && appendFeedback(data,
      { conversationId, userTurnId, userEntryId, userRevision, speechScope, entryId, at },
      classifyCompanionFeedback(text).filter(observation => observation.explicit));
    const known = data.entries.slice().reverse().find(item => item.conversationId === conversationId
      && item.speechScope === speechScope && item.companionTurnId !== userTurnId);
    const words = collectPrivateExpressions(data.speech.filter(row => row.scope === speechScope)).samples.map(item => item.quote);
    const speech = speechObservations({
      id: entryId, conversationId, companionTurnId: userTurnId, speechScope, channel, createdAt: at, userText: text,
      learnedExpressions: relationship.learnPrivateExpressions === true,
    }, text, { reply: known?.assistantText ?? "", words }, "explicit")
      .filter(observation => !data.speech.some(row => row.id === entryId && row.kind === observation.kind && row.quote === observation.quote));
    if (speech.length) {
      rememberSpeech(data.speech, speech.map(row => ({ ...row, userEntryId, userRevision })));
      changed = true;
    }
    const note = relationship.learnConversationStyle !== false ? explicitRepairNote(text) : undefined;
    if (note && !data.repairCases.some(item => item.id === entryId)) {
      data.repairCases = [...data.repairCases, {
        id: entryId, note, status: "acknowledged", createdAt: at, updatedAt: at,
        conversationId, userTurnId, userEntryId, userRevision, speechScope,
      } satisfies SourcedRepairCase].slice(-100);
      data.records = [...data.records, { id: entryId, kind: "repair", at, conversationId, text: `对方纠正：${note}` } satisfies CompanionRecord].slice(-500);
      changed = true;
    }
    if (changed) {
      data.acceptedFeedbackKeys = [...data.acceptedFeedbackKeys, sourceKey].slice(-10000);
      data.revision++;
      this.repository.write(data);
    }
  }
  async getState(): Promise<{ relationshipState: RelationshipState; affectState: AffectState }> {
    const data = this.repository.read();
    return { relationshipState: data.relationshipState, affectState: decayAffectState(data.affectState) };
  }
  async snapshot(): Promise<CompanionSnapshot> {
    const data = this.repository.read();
    if (refreshCommitmentStatuses(data, Date.now())) { data.revision++; this.repository.write(data); }
    return { ...(desireAvailable(data.relationshipState) && { desireHistory: data.desireHistory ?? [] }), revision: data.revision, relationship: data.relationshipState, affect: decayAffectState(data.affectState), bondProgress: data.bondProgress, permissions: data.permissions, records: data.records.slice(-100).reverse(), followups: data.followups, repairCases: data.repairCases.slice(-50).reverse(), commitments: data.commitments.slice(-100).reverse(), learnedPreferences: learnedPreferences(data.companionFeedback, data.relationshipState.learnPrivateExpressions), taskLessons: summarizeTaskLessons(data.taskObservations) };
  }

  /**
   * Apply one sanitized companion event.  Event ids are consumed even when an
   * event has no reward so a retry cannot later become a duplicate reward.
   */
  async recordCompanionEvent(event: CompanionEvent): Promise<CompanionSnapshot> {
    if (!isCompanionEvent(event)) throw new Error("陪伴事件格式无效");
    event = sanitizeCompanionEvent(event);
    if (!isCompanionEvent(event)) throw new Error("陪伴事件摘要无效");
    const data = this.repository.read();
    if (data.seenCompanionEventIds.includes(event.eventId)) return this.snapshot();
    applyCompanionEventToData(data, event);
    data.revision++;
    this.repository.write(data);
    return this.snapshot();
  }
  async forgetConversation(conversationId: string): Promise<void> {
    const data = this.repository.read();
    data.dailyRecaps = data.dailyRecaps?.filter(r => !r.turns.some(t => t.conversationId === conversationId));
    data.speech = data.speech.filter(item => item.conversationId !== conversationId);
    data.entries = data.entries.filter(item => item.conversationId !== conversationId);
    data.desireHistory = data.desireHistory?.filter(item => item.conversationId !== conversationId);
    data.records = data.records.filter(item => item.conversationId !== conversationId);
    data.followups = data.followups.filter(item => item.conversationId !== conversationId);
    data.commitments = data.commitments.filter(item => item.conversationId !== conversationId);
    data.repairCases = data.repairCases.filter(item => item.conversationId !== conversationId);
    data.companionFeedback = data.companionFeedback.filter(item => item.conversationId !== conversationId);
    data.taskObservations = data.taskObservations.filter(item => item.conversationId !== conversationId);
    data.learningRevision++;
    data.taskLearningRevision++;
    data.revision++;
    data.dailySummaries = [];
    data.affectState = createDefaultAffectState();
    this.repository.purgeLegacy();
    this.repository.write(data);
  }
  retainCompanionFeedbackTurns(conversationId: string, retainedUserTurnIds: ReadonlySet<string>): void {
    const data = this.repository.read();
    data.dailyRecaps = data.dailyRecaps?.filter(r => !r.turns.some(t => t.conversationId === conversationId && !retainedUserTurnIds.has(t.turnId)));
    data.speech = data.speech.filter(item => item.conversationId !== conversationId || retainedUserTurnIds.has(item.turnId));
    data.entries = data.entries.filter(item => item.conversationId !== conversationId || !item.companionTurnId || retainedUserTurnIds.has(item.companionTurnId));
    data.desireHistory = data.desireHistory?.filter(item => item.conversationId !== conversationId || retainedUserTurnIds.has(item.turnId));
    data.companionFeedback = data.companionFeedback.filter(item => item.conversationId !== conversationId || retainedUserTurnIds.has(item.userTurnId));
    const removedRepairs = new Set(data.repairCases.filter(item => item.conversationId === conversationId
      && item.userTurnId && !retainedUserTurnIds.has(item.userTurnId)).map(item => item.id));
    data.repairCases = data.repairCases.filter(item => !removedRepairs.has(item.id));
    data.records = data.records.filter(item => !removedRepairs.has(item.id));
    data.taskObservations = data.taskObservations.filter(item => item.conversationId !== conversationId || retainedUserTurnIds.has(item.userTurnId));
    // A completion for a truncated turn could still be running its side effects.
    data.learningRevision++;
    data.taskLearningRevision++;
    data.revision++;
    this.repository.write(data);
  }
  dailyRecapMaterial() {
    const data = this.repository.read();
    const enabled = data.relationshipState.recordHistory && !data.relationshipState.paused;
    return {
      enabled,
      turns: enabled ? data.entries.filter(e => e.privateContext !== false && e.speechScope === "owner" && e.companionTurnId) : [],
      expressions: enabled && data.relationshipState.learnPrivateExpressions
        ? collectPrivateExpressions(data.speech.filter(row => row.scope === "owner")).samples : [],
      saved: data.dailyRecaps ?? [],
    };
  }
  saveDailyRecap(entry: SavedDailyRecap) {
    const data = this.repository.read();
    data.dailyRecaps = [...(data.dailyRecaps ?? []).filter(row => row.date !== entry.date), entry]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-90);
    this.repository.write(data);
  }
  expressionEvidence() {
    const data = this.repository.read();
    if (!data.relationshipState.recordHistory || data.relationshipState.paused) return [];
    return data.entries.filter(e => e.companionTurnId && e.conversationId);
  }
  blockedExpressions(conversationId: string, current: string, scope = "owner") {
    const data = this.repository.read();
    const relevant = data.relationshipState.recordHistory && !data.relationshipState.paused ? data.speech.filter(row => row.scope === scope
      && (data.relationshipState.learnPrivateExpressions || row.conversationId === conversationId)) : [];
    const previous = data.entries.slice().reverse().find(item => item.conversationId === conversationId && item.speechScope === scope);
    const { blocked, samples } = collectPrivateExpressions(relevant);
    return [...new Set([...blocked, ...expressionCorrection(current, { reply: previous?.assistantText ?? "", words: samples.map(item => item.quote) })])];
  }
  privateExpressions() {
    const data = this.repository.read();
    return data.relationshipState.learnPrivateExpressions && data.relationshipState.recordHistory && !data.relationshipState.paused ? collectPrivateExpressions(data.speech).samples : [];
  }
  async exportData(): Promise<string> {
    return JSON.stringify({ format: "cyrene.relationship.v1", exportedAt: Date.now(), ...this.repository.read() }, null, 2);
  }
  /** 投递事实到达后更新事项；重复 intent 不重复催问，不越过用户暂停/改绑。 */
  async settleFollowup(id: string, conversationId: string, intentId: string, at: number, outcome: "asked" | "unknown" | "incomplete"): Promise<void> {
    const data = this.repository.read();
    const item = data.followups.find(item => item.id === id && item.conversationId === conversationId);
    if (!item || item.lastIntentId === intentId || item.status !== "active") return;
    item.status = outcome === "asked" ? "awaiting_reply" : "paused";
    item.lastIntentId = intentId; item.updatedAt = at;
    if (outcome === "asked") item.lastAskedAt = at;
    item.resolutionReason = outcome === "asked" ? "已发出一次关怀，等待回复；不会自动反复催促"
      : outcome === "unknown" ? "渠道投递结果未知，已暂停，核对后可重新约时间"
        : "渠道仅投递部分内容，已暂停，请先到渠道投递记录核对或恢复";
    data.records.push({ id: randomUUID(), kind: "followup", at, conversationId, sourceEventId: intentId, text: `「${item.topic}」：${item.resolutionReason}` });
    data.records = data.records.slice(-500); data.revision++;
    this.repository.write(data);
  }
  async updatePreferences(patch: RelationshipPreferencesPatch): Promise<RelationshipState> {
    // Legacy in-process callers. Public IPC uses a mandatory expectedRevision.
    const result = await this.command({ type: "preferences", patch, expectedRevision: this.repository.read().revision });
    return result.relationship;
  }
  async command(command: CompanionCommand): Promise<CompanionSnapshot> {
    if (!command || typeof command !== "object") throw new Error("无效关系命令");
    const data = this.repository.read();
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== data.revision) throw new Error("设置已在其他窗口更新，请重新加载后再保存");
    const now = Date.now();
    if (command.type === "preferences") {
      const beforePreferences = data.relationshipState;
      const patch = validatePatch(command.patch);
      if (patch.desireEnabled === false || patch.recordHistory === false) data.desireHistory = [];
      data.relationshipState = { ...data.relationshipState, ...patch, updatedAt: now, version: data.relationshipState.version + 1 };
      const learningAvailabilityChanged = beforePreferences.paused !== data.relationshipState.paused
        || beforePreferences.recordHistory !== data.relationshipState.recordHistory;
      if (learningAvailabilityChanged || beforePreferences.learnPrivateExpressions !== data.relationshipState.learnPrivateExpressions || beforePreferences.learnConversationStyle !== data.relationshipState.learnConversationStyle) {
        data.learningRevision++;
      }
      if (learningAvailabilityChanged || beforePreferences.learnTaskMethods !== data.relationshipState.learnTaskMethods) {
        data.taskLearningRevision++;
      }
      data.relationshipState.stage = relationshipStage(data.relationshipState.closeness);
      data.records.push({ id: randomUUID(), kind: "preferences", at: now, text: "用户更新相处偏好（不会改变工具授权）" });
      if (!data.relationshipState.paused) {
        const previous = new Set(beforePreferences.sharedGoals);
        for (const goal of data.relationshipState.sharedGoals.filter(item => !previous.has(item))) {
          applyCompanionEventToData(data, {
            eventId: `preference:shared-goal:${goal}`,
            kind: "goal_progressed",
            source: "system",
            occurredAt: now,
            summary: `建立共同目标：${goal}`,
          }, now);
        }
        const previousMilestones = new Set(beforePreferences.milestones);
        for (const milestone of data.relationshipState.milestones.filter(item => !previousMilestones.has(item))) {
          applyCompanionEventToData(data, {
            eventId: `preference:milestone:${milestone}`,
            kind: "goal_progressed",
            source: "system",
            occurredAt: now,
            summary: `记下共同时刻：${milestone}`,
          }, now);
        }
        const previousTaste = new Set(beforePreferences.tasteNotes);
        for (const taste of data.relationshipState.tasteNotes.filter(item => !previousTaste.has(item))) {
          applyCompanionEventToData(data, {
            eventId: `preference:taste:${taste}`,
            kind: "music_context",
            source: "system",
            occurredAt: now,
            summary: `记住一条明确偏好：${taste}`,
          }, now);
        }
      }
    } else if (command.type === "permissions") {
      if (!command.patch || typeof command.patch !== "object" || Array.isArray(command.patch)) throw new Error("无效能力设置");
      for (const [key, value] of Object.entries(command.patch)) {
        if (key === "preset" && ["inherit", "companion", "basic", "shared_life", "full"].includes(String(value))) data.permissions.preset = value as CompanionPermissions["preset"];
        else if (key === "paused" && typeof value === "boolean") data.permissions.paused = value;
        else if ((key === "deniedTools" || key === "confirmTools") && Array.isArray(value) && value.length <= 300 && value.every(id => typeof id === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(id))) data.permissions[key] = [...new Set(value)];
        else throw new Error(`无效能力设置：${key}`);
      }
      data.records.push({ id: randomUUID(), kind: "permissions", at: now, text: `能力限制已更新：${data.permissions.preset}${data.permissions.paused ? "，已暂停" : ""}` });
    } else if (command.type === "followup_save") {
      const old = command.id ? data.followups.find(item => item.id === command.id) : undefined;
      if (command.id && !old) throw new Error("跟进事项不存在");
      if (!Number.isFinite(command.nextEligibleAt) || command.nextEligibleAt < now) throw new Error("请为跟进事项选择未来时间");
      const item: CompanionFollowup = { id: old?.id ?? randomUUID(), topic: command.topic, conversationId: command.conversationId,
        nextEligibleAt: command.nextEligibleAt, status: "active", createdAt: old?.createdAt ?? now, updatedAt: now,
        ...(old?.lastAskedAt ? { lastAskedAt: old.lastAskedAt } : {}) };
      data.followups = normalizeFollowups([...data.followups.filter(item => item.id !== old?.id), item]);
      data.records.push({ id: randomUUID(), kind: "followup", at: now, conversationId: item.conversationId, text: `用户设置具体跟进：${item.topic}` });
    } else if (command.type === "followup_status") {
      const item = data.followups.find(item => item.id === command.id && item.conversationId === command.conversationId);
      if (!item) throw new Error("跟进事项不存在");
      if (!["active", "completed", "paused", "cancelled"].includes(command.status)) throw new Error("跟进状态无效");
      if (command.status === "active") {
        if (!Number.isFinite(command.nextEligibleAt) || command.nextEligibleAt! < now) throw new Error("重新跟进需要明确选择未来时间");
        item.nextEligibleAt = command.nextEligibleAt!;
      }
      item.status = command.status; item.updatedAt = now; item.resolutionReason = "用户在设置中更新";
      data.records.push({ id: randomUUID(), kind: "followup", at: now, conversationId: item.conversationId, text: `用户将「${item.topic}」设为 ${item.status}` });
    } else if (command.type === "commitment_save") {
      if (typeof command.promise !== "string" || !command.promise.trim() || command.promise.length > 500) throw new Error("承诺内容必须是 1–500 字");
      if (command.dueAt !== undefined && (!Number.isFinite(command.dueAt) || command.dueAt < now)) throw new Error("承诺截止时间必须在未来");
      const old = command.id ? data.commitments.find(item => item.id === command.id) : undefined;
      if (command.id && !old) throw new Error("承诺不存在");
      const item: CompanionCommitment = {
        id: old?.id ?? randomUUID(), promise: command.promise.trim(), status: old?.status === "fulfilled" || old?.status === "cancelled" ? "open" : (old?.status ?? "open"),
        createdAt: old?.createdAt ?? now, updatedAt: now,
        ...(command.conversationId ?? old?.conversationId ? { conversationId: command.conversationId ?? old?.conversationId } : {}),
        ...(command.dueAt ?? old?.dueAt ? { dueAt: command.dueAt ?? old?.dueAt } : {}),
        ...(old?.evidence ? { evidence: old.evidence } : {}),
      };
      data.commitments = [...data.commitments.filter(candidate => candidate.id !== item.id), item].slice(-200);
      data.records.push({ id: randomUUID(), kind: "commitment", at: now, conversationId: item.conversationId, text: `记录助手承诺：${item.promise}` });
    } else if (command.type === "commitment_status") {
      const item = data.commitments.find(candidate => candidate.id === command.id);
      if (!item) throw new Error("承诺不存在");
      const statuses: CompanionCommitmentStatus[] = ["open", "fulfilled", "cancelled", "overdue"];
      if (!statuses.includes(command.status)) throw new Error("承诺状态无效");
      if (command.evidence !== undefined && (typeof command.evidence !== "string" || command.evidence.length > 500)) throw new Error("承诺凭据最多 500 字");
      item.status = command.status; item.updatedAt = now;
      if (command.evidence?.trim()) item.evidence = command.evidence.trim();
      data.records.push({ id: randomUUID(), kind: "commitment", at: now, conversationId: item.conversationId, text: `助手承诺「${item.promise}」更新为 ${item.status}` });
    } else if (command.type === "commitment_delete") {
      if (!data.commitments.some(item => item.id === command.id)) throw new Error("承诺不存在");
      data.commitments = data.commitments.filter(item => item.id !== command.id);
      data.records.push({ id: randomUUID(), kind: "commitment", at: now, text: "删除一条助手承诺" });
    } else if (command.type === "repair") {
      if (typeof command.note !== "string" || !command.note.trim() || command.note.length > 500) throw new Error("请填写 1–500 字的修复约定");
      if (command.conversationId !== undefined && (typeof command.conversationId !== "string" || !command.conversationId.trim())) throw new Error("修复约定的会话无效");
      if (command.followUpAt !== undefined && (!Number.isFinite(command.followUpAt) || command.followUpAt < now)) throw new Error("修复回访时间必须在未来");
      data.relationshipState.repairCount++;
      const repairId = randomUUID();
      const repairCase: RepairCase = {
        id: repairId,
        note: command.note.trim(),
        status: command.followUpAt ? "follow_up" : "acknowledged",
        createdAt: now,
        updatedAt: now,
        ...(command.conversationId ? { conversationId: command.conversationId } : {}),
        ...(command.followUpAt ? { followUpAt: command.followUpAt } : {}),
      };
      data.repairCases = [...data.repairCases, repairCase].slice(-100);
      data.records.push({ id: repairId, kind: "repair", at: now, conversationId: command.conversationId, text: command.note.trim() });
      applyCompanionEventToData(data, {
        eventId: `repair:${repairId}`,
        kind: "repair_acknowledged",
        source: "system",
        occurredAt: now,
        summary: "用户完成了一次相处修复",
      }, now);
    } else if (command.type === "repair_status") {
      const item = data.repairCases.find((candidate) => candidate.id === command.id);
      if (!item) throw new Error("修复事项不存在");
      const statuses: RepairCaseStatus[] = ["acknowledged", "follow_up", "resolved", "dismissed"];
      if (!statuses.includes(command.status)) throw new Error("修复状态无效");
      if (command.followUpAt !== undefined && (!Number.isFinite(command.followUpAt) || command.followUpAt < now)) throw new Error("修复回访时间必须在未来");
      if (command.resolutionNote !== undefined && (typeof command.resolutionNote !== "string" || command.resolutionNote.length > 500)) throw new Error("修复说明最多 500 字");
      item.status = command.status;
      item.updatedAt = now;
      if (command.followUpAt !== undefined) item.followUpAt = command.followUpAt;
      if (command.resolutionNote?.trim()) item.resolutionNote = command.resolutionNote.trim();
      data.records.push({ id: randomUUID(), kind: "repair", at: now, conversationId: item.conversationId, text: `修复事项「${item.note}」更新为 ${item.status}${item.resolutionNote ? `：${item.resolutionNote}` : ""}` });
    } else if (command.type === "forget_learned_preference") {
      if (typeof command.conversationId !== "string" || !command.conversationId.trim()
        || !COMPANION_LEARNING_TOPICS.includes(command.topic)) throw new Error("聊天偏好无效");
      const scope = data.relationshipState.learnPrivateExpressions && data.companionFeedback.slice().reverse().find(item => item.conversationId === command.conversationId && item.topic === command.topic)?.speechScope;
      data.companionFeedback = data.companionFeedback.filter(item => item.topic !== command.topic || (scope ? item.speechScope !== scope : item.conversationId !== command.conversationId));
      data.learningRevision++;
    } else if (command.type === "forget_task_method") {
      if (!validTaskMethod(command)) throw new Error("任务经验无效");
      data.taskObservations = data.taskObservations.filter(item => item.workspaceKey !== command.workspaceKey || item.task !== command.task || item.method !== command.method);
      data.taskLearningRevision++;
    } else if (command.type === "delete_record") {
      if (typeof command.id !== "string") throw new Error("记录编号无效");
      data.speech = data.speech.filter(item => item.id !== command.id);
      const removed = data.entries.find(item => item.id === command.id);
      if (removed?.companionTurnId) data.desireHistory = data.desireHistory?.filter(s => s.conversationId !== removed.conversationId || s.turnId !== removed.companionTurnId);
      data.records = data.records.filter(item => item.id !== command.id);
      data.entries = data.entries.filter(item => item.id !== command.id);
      data.companionFeedback = data.companionFeedback.filter(item => item.entryId !== command.id);
      data.repairCases = data.repairCases.filter(item => item.id !== command.id || !item.userTurnId);
      data.learningRevision++;
      // Derived summaries must not resurrect removed evidence.
      data.dailySummaries = [];
      data.dailyRecaps = data.dailyRecaps?.filter(r => !r.turns.some(t => t.id === command.id));
      data.affectState = createDefaultAffectState(now);
      this.repository.purgeLegacy();
    } else if (command.type === "reset_bond_progress") {
      data.bondProgress = createDefaultBondProgress(now);
      data.seenCompanionEventIds = [];
      data.records.push({ id: randomUUID(), kind: "bond", at: now, text: "用户重置了羁绊进度" });
    } else if (command.type === "clear_history" || command.type === "reset_relationship") {
      data.dailyRecaps = [];
      data.speech = [];
      data.desireHistory = [];
      data.entries = []; data.dailySummaries = []; data.records = []; data.followups = []; data.repairCases = []; data.commitments = [];
      data.companionFeedback = [];
      data.taskObservations = [];
      data.learningRevision++;
      data.taskLearningRevision++;
      data.affectState = createDefaultAffectState(now);
      data.lastDiaryDay = new Date(now).toISOString().slice(0, 10);
      if (command.type === "reset_relationship") { data.relationshipState = createDefaultRelationshipState(now); data.followups = []; }
      this.repository.purgeLegacy();
    } else throw new Error("未知关系命令");
    data.records = data.records.slice(-500);
    data.revision++;
    this.repository.write(data);
    return this.snapshot();
  }

  async recordTurn(input: RelationshipTurnInput): Promise<RelationshipLogEntry | null> {
    const userText = input.userText.trim()
    const assistantText = input.assistantText.trim()
    if (!userText && !assistantText) return null

    const ownerContext = !input.speechScope || input.speechScope === "owner";
    const data = this.repository.read()
    if (ownerContext && input.privateContext !== false && input.conversationId) {
      let changed = false;
      for (const item of data.followups.filter(item => item.conversationId === input.conversationId && ["active", "awaiting_reply", "paused"].includes(item.status))) {
        const status = resolveExplicitFollowupReply(item.topic, userText);
        if (!status) continue;
        item.status = status; item.updatedAt = Date.now(); item.resolutionReason = "用户在绑定会话中明确表示已完成或不要再问";
        changed = true;
        if (data.relationshipState.recordHistory) data.records.push({ id: randomUUID(), kind: "followup", at: item.updatedAt, conversationId: item.conversationId, text: `「${item.topic}」已${status === "completed" ? "完成" : "取消"}：用户明确表达` });
        if (status === "completed") {
          applyCompanionEventToData(data, {
            eventId: `followup:${item.id}:${item.updatedAt}`,
            kind: "followup_completed",
            source: input.channel === "desktop" || input.channel === "web" ? input.channel : "channel",
            conversationId: item.conversationId,
            occurredAt: item.updatedAt,
            summary: `完成跟进事项：${item.topic}`,
          }, item.updatedAt);
        }
      }
      if (changed) { data.revision++; this.repository.write(data); }
    }
    if (input.privateContext === false || data.relationshipState.paused || !data.relationshipState.recordHistory) return null
    if (input.sourceEventId && data.entries.some(e => e.sourceEventId === input.sourceEventId && e.conversationId === input.conversationId)) return null
    if (input.runId && data.entries.some(e => e.runId === input.runId && e.conversationId === input.conversationId)) return null
    const eventKey = input.sourceEventId || input.runId ? JSON.stringify([input.conversationId ?? "", input.sourceEventId ?? input.runId]) : undefined
    if (eventKey && data.seenEventKeys.includes(eventKey)) return null
    if (eventKey) data.seenEventKeys = [...data.seenEventKeys, eventKey].slice(-10000)
    const now = Date.now()
    if (ownerContext && input.companionTurnId && input.conversationId && desireAvailable(data.relationshipState)) {
      addDesireSample(data.desireHistory ??= [], input.conversationId, input.companionTurnId, userText, now);
    }
    const userMood = detectUserMood(userText)
    const cue = deriveSignal(userText, userMood)
    const { companionFeedback, ...turn } = input;
    const entry: RelationshipLogEntry = {
      ...turn,
      ...(input.companionTurnId && data.relationshipState.learnPrivateExpressions && { learnedExpressions: true }),
      userText: compact(userText, 500),
      assistantText: compact(assistantText, 500),
      id: `rel-${now}-${Math.random().toString(36).slice(2, 8)}`,
      date: localDate(now),
      createdAt: now,
      userMood,
      relationshipSignal: cue.relationshipSignal,
      importantMoment: cue.importantMoment,
      nextCareCue: cue.nextCareCue,
    }

    const revisionMatches = !companionFeedback || companionFeedback.revision === data.learningRevision;
    if (entry.companionTurnId && revisionMatches) {
      const text = companionFeedback?.text ?? userText;
      const previous = /(?:这么|这样)(?:说|叫|开头|收尾)/u.test(text)
        ? data.entries.slice().reverse().find(e => e.conversationId === entry.conversationId && e.speechScope === entry.speechScope && e.companionTurnId)
        : undefined;
      const known = previous && { reply: previous.assistantText, words: collectPrivateExpressions(data.speech.filter(row => row.scope === (entry.speechScope ?? "owner"))).samples.map(s => s.quote) };
      const speech = speechObservations(entry, text, known, companionFeedback?.source ? "passive" : "all");
      rememberSpeech(data.speech, companionFeedback?.source ? speech.map(row => ({ ...row, ...companionFeedback.source })) : speech);
    }
    data.entries.push(entry)
    data.entries = data.entries.slice(-MAX_ENTRIES)
    if (input.conversationId && companionFeedback?.userTurnId && assistantText && data.relationshipState.learnConversationStyle !== false
      && companionFeedback.revision === data.learningRevision) {
      const observations = classifyCompanionFeedback(companionFeedback.text).filter(observation => !companionFeedback.source || !observation.explicit);
      const changed = appendFeedback(data, {
        speechScope: entry.speechScope ?? (entry.learnedExpressions ? (entry.channel === "desktop" || entry.channel === "web" ? "owner" : "session:"+entry.conversationId) : undefined),
        ...companionFeedback.source, entryId: entry.id, conversationId: input.conversationId, userTurnId: companionFeedback.userTurnId, at: now,
        contextHash: feedbackContextHash(companionFeedback.text),
      }, observations);
      if (changed) data.revision++;
    }
    if (input.conversationId && companionFeedback?.userTurnId && data.relationshipState.learnConversationStyle !== false
      && companionFeedback.revision === data.learningRevision && !companionFeedback.source && isCompanionCorrection(companionFeedback.text)) {
      const note = compact(companionFeedback.text, 200);
      if (!data.repairCases.some(item => item.conversationId === input.conversationId && item.speechScope === entry.speechScope && item.note === note)) {
        data.repairCases = [...data.repairCases, {
          id: randomUUID(), note, status: "acknowledged", createdAt: now, updatedAt: now, conversationId: input.conversationId,
          speechScope: entry.speechScope,
        } satisfies SourcedRepairCase].slice(-100);
        data.records.push({ id: randomUUID(), kind: "repair", at: now, conversationId: input.conversationId, text: `对方纠正：${note}` });
        data.revision++;
      }
    }
    if (!ownerContext) {
      this.repository.write(data);
      return entry;
    }
    data.relationshipState = advanceRelationshipState(data.relationshipState, userMood, now)
    data.affectState = advanceAffectState(data.affectState, userMood, now)
    data.affectState.lastEventIds = [entry.sourceEventId ?? entry.id]
    data.records.push({ id: entry.id, kind: "turn", at: now, text: `${userMood}（自动线索）：${cue.relationshipSignal}`, conversationId: input.conversationId, runId: input.runId, sourceEventId: input.sourceEventId })
    data.records = data.records.slice(-500)

    // Explicitly named goals and milestones become shared events only when
    // the current turn mentions them. This keeps the relationship reciprocal
    // without pretending that an item was completed merely because it was
    // listed in settings.
    const commitments = matchingCommitments(data.relationshipState, userText, assistantText)
    for (const commitment of commitments) {
      const eventId = `${entry.id}:commitment:${commitment.kind}:${commitment.text}`;
      applyCompanionEventToData(data, {
        eventId,
        kind: commitment.kind,
        source: input.channel === "desktop" || input.channel === "web" ? input.channel : "channel",
        conversationId: input.conversationId,
        occurredAt: now,
        summary: `${commitment.kind === "goal_progressed" ? "共同目标有进展" : "共同记忆被提起"}：${commitment.text}`,
        payload: { item: commitment.text.slice(0, 120) },
      }, now);
      data.affectState.lastEventIds = [...data.affectState.lastEventIds, eventId].slice(-12);
    }

    for (const promise of extractAssistantPromises(assistantText)) {
      const normalized = promise.replace(/\s+/g, "").toLowerCase();
      const duplicate = data.commitments.some((item) => item.status === "open" && item.conversationId === input.conversationId && item.promise.replace(/\s+/g, "").toLowerCase() === normalized);
      if (duplicate) continue;
      const commitment: CompanionCommitment = { id: randomUUID(), promise, status: "open", createdAt: now, updatedAt: now, ...(input.conversationId ? { conversationId: input.conversationId } : {}) };
      data.commitments = [...data.commitments, commitment].slice(-200);
      data.records.push({ id: commitment.id, kind: "commitment", at: now, conversationId: input.conversationId, runId: input.runId, text: `记录助手承诺：${promise}` });
    }

    const entriesForDate = data.entries.filter(item => item.date === entry.date && (!item.speechScope || item.speechScope === "owner"));
    const summary = summarizeDate(entry.date, entriesForDate)
    data.dailySummaries = [
      ...data.dailySummaries.filter((item) => item.date !== entry.date),
      summary,
    ].slice(-MAX_DAILY_SUMMARIES)

    this.repository.write(data)
    return entry
  }

  async buildContext(conversationId?: string, privateContext = true, currentUserText?: string, useLearnedStyle = false, includeTaskLedger = true, speechScope = "owner",
    onReference?: (reference: CompanionReference) => void): Promise<string> {
    if (!privateContext) return "";
    const ownerContext = speechScope === "owner";
    const data = this.repository.read();
    if (ownerContext && refreshCommitmentStatuses(data, Date.now())) { data.revision++; this.repository.write(data); }
    const rel = data.relationshipState;
    const lines = ["【昔涟的相处偏好】", "这些偏好用于决定怎样开口。按对方此刻的意思应答，顺着对方提过的事聊。保留事实和权限边界，别向对方复述这些设置。"];
    if (ownerContext && rel.userLabel) lines.push(`称呼对方时可以用 ${JSON.stringify(rel.userLabel)}。来回聊天时直接接话就好。`);
    if (ownerContext && rel.boundaries.length) lines.push(`相处边界：${JSON.stringify(rel.boundaries)}`);
    if (rel.tasteNotes.length) {
      lines.push("昔涟的兴趣与品味（由用户明确设定，仅用于形成稳定表达，不代表现实经历）：", JSON.stringify(rel.tasteNotes));
    }
    const styleDescription = {
      natural: "像日常说话，句子长短随眼下要说的事。",
      gentle: "语气放柔一点，话还是说清楚。",
      lively: "话题轻松时可以俏皮，认真聊时就认真说。",
      concise: "说到点上就停，一句够了就用一句。",
    }[rel.style];
    if (rel.paused) {
      lines.push(styleDescription, ownerContext
        ? "对方已暂停关系模拟和主动关怀。礼貌回应眼下的话，亲昵互动等对方恢复后再聊。"
        : "礼貌回应眼下的话。");
      return lines.join("\n");
    }
    const relationshipMode = rel.relationshipMode ?? "companion";
    const relationshipDescription = {
      assistant: "先把对方问的事说清楚。日常也可以有一点温度，语气照常。",
      friend: "像朋友一样商量、接话或开个玩笑。关心落在对方刚说的事上。",
      companion: "平时可以关心、说笑，也可以一起安静待会儿。亲近程度跟着对方当下的语气走。",
      partner: "按对方选的伴侣式相处。开心时可以互相逗两句，难过时可以把话听完，日常也能直接答一句。闹别扭时就说这件具体的事，听清对方的意思，再继续聊。",
    }[relationshipMode];
    lines.push(ownerContext ? relationshipDescription : "根据这段对话里的称呼和熟悉程度接话。", styleDescription);
    if (conversationId && currentUserText && !includeTaskLedger) {
      if (rel.learnPrivateExpressions && rel.recordHistory && useLearnedStyle) {
        const learned = collectPrivateExpressions(data.speech.filter(row => row.scope === speechScope));
        const expression = privateExpressionHint(learned.samples, currentUserText, sample => onReference?.({
          kind: "expression", quote: sample.quote, conversationId: sample.turn.conversationId, userTurnId: sample.turn.turnId,
        }));
        if (expression) lines.push(expression);
      }
      if (ownerContext) {
        const hint = desireContext(rel, data.desireHistory ?? [], conversationId, currentUserText, Date.now());
        if (hint) lines.push(hint);
      }
    }
    if (ownerContext) {
      lines.push(rel.affection
        ? "话题和语气合适时，可以自然表达亲近。对方忙着、想安静或改了话题，就尊重这个选择。"
        : "对方喜欢体贴、平实的语气。用日常的关心，省去恋爱称呼和撒娇。");
      if (relationshipMode === "partner" && rel.affection) lines.push("对方接得住时可以说亲近的话，也可以逗逗对方。昵称和撒娇由当时的话题决定，不需要用来证明亲近。");
      lines.push(`内部亲近度 ${Math.round(rel.closeness * 100)}/100，仅参考熟悉程度。以对方选的相处方式、边界和当下的话为准。日常聊天省去报分。`);
      if (rel.stage === "new") lines.push("习惯和共同经历慢慢了解，先听对方怎么说。");
      if (rel.stage === "close" || rel.stage === "long_term") lines.push("可以接着聊彼此熟悉的话题，提到共同经历时以对话里确定的细节为准。");
    }
    // Only reactive callers have a current user message. A stored guess cannot describe this turn.
    const replyHint = currentUserText ? MOOD_REPLY_HINTS[detectUserMood(currentUserText)] : undefined;
    if (replyHint) lines.push("【本轮语气参考】", "这是从这一条消息自动识别的线索，可能误判。以对方原话、原话说的时间和明确要求为准。只调整接话方式，省去给对方贴标签。", replyHint);
    if (useLearnedStyle && conversationId && rel.recordHistory && rel.learnConversationStyle !== false) {
      const currentTopics = new Set(classifyCompanionFeedback(currentUserText ?? "").map(item => item.topic));
      const share = !!rel.learnPrivateExpressions && !includeTaskLedger;
      const scopedFeedback = data.companionFeedback.filter(item => item.speechScope
        ? item.speechScope === speechScope && (share || item.conversationId === conversationId)
        : ownerContext && item.conversationId === conversationId);
      const preferences = learnedPreferences(scopedFeedback, share).filter(item => !currentTopics.has(item.topic));
      for (const { topic, conversationId, userTurnId } of preferences) {
        onReference?.({ kind: "preference", topic, conversationId, userTurnId });
      }
      const style = preferences.map(item => LEARNED_STYLE[item.topic]);
      if (style.length) lines.push(share ? "【你们平常聊天的表达习惯】" : "【这段私聊的表达习惯】", "仅在合适时沿用。按对方这一轮明确的要求和相处边界接话。", ...style);
    }
    if (ownerContext && rel.sharedGoals.length) lines.push(`聊到相关事情时可以参考这些共同目标，进度按已知事实说：${JSON.stringify(rel.sharedGoals)}`);
    if (ownerContext && rel.milestones.length) lines.push(`只在时机或话题合适时提起这些由对方指定的日子：${JSON.stringify(rel.milestones)}`);
    const repairs = data.repairCases.filter(item =>
      (item.conversationId === undefined || item.conversationId === conversationId)
      && (item.speechScope ? item.speechScope === speechScope : ownerContext)
      && (item.status === "acknowledged" || item.status === "follow_up"),
    ).slice(-6);
    if (repairs.length) lines.push("【对方纠正过的地方】", "对方专门指出过这些说法或做法不对。以后照着改，别再犯，也不用再提起或道歉：", ...repairs.map(item => `- ${item.note}`));
    const commitments = ownerContext && includeTaskLedger ? data.commitments.filter(item => item.status === "open" || item.status === "overdue").filter(item => conversationId ? !item.conversationId || item.conversationId === conversationId : !item.conversationId).slice(-8) : [];
    if (commitments.length) lines.push("【助手承诺账本】", "以下承诺必须保持可追踪，完成后更新状态，不要声称已完成而没有证据：", JSON.stringify(commitments.map(item => ({ id: item.id, promise: item.promise, status: item.status, dueAt: item.dueAt, evidence: item.evidence }))));
    if (ownerContext && rel.innerLifeEnabled) {
      // Existing fictional diaries stay in the settings history. World sharing
      // uses grounded events from the conversation's own world context.
      const today = new Date().toISOString().slice(0, 10);
      let diary = data.records.find(item => item.kind === "diary" && new Date(item.at).toISOString().slice(0, 10) === today);
      if (!diary && data.lastDiaryDay !== today) {
        const index = Math.floor(Date.now() / 86_400_000) % XILIAN_CHARACTER_PACK.idleRoutines.length;
        diary = { id: `diary-${today}`, kind: "diary", at: Date.now(), text: XILIAN_CHARACTER_PACK.idleRoutines[index] };
        data.lastDiaryDay = today;
        data.records.push(diary); data.records = data.records.slice(-500); this.repository.write(data);
      }
    }
    return lines.join("\n");
  }
}
