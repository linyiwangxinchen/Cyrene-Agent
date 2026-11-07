import { detectUserMood } from "./mood-cues"
import { randomUUID } from "node:crypto"
import { RelationshipRepository } from "./relationship-repository"
import { normalizeFollowups, resolveExplicitFollowupReply } from "./followup-state"
import type { CompanionFollowup } from "../../shared/companion"
import type { CompanionSnapshot, CompanionCommand, CompanionPermissions, CompanionRecord, RelationshipPreferences } from "../../shared/companion"
import { isCompanionEvent, sanitizeCompanionEvent, type CompanionEvent } from "../../shared/companion-events"
import { applyBondEvent, createDefaultBondProgress, normalizeBondProgress, type BondProgressState } from "../../shared/companion-progress"
import { XILIAN_CHARACTER_PACK } from "../character-packs/xilian-pack"
import type { ChannelId } from "../channels/types"
import {
  advanceAffectState,
  decayAffectState,
  relationshipStage,
  advanceRelationshipState,
  createDefaultAffectState,
  createDefaultRelationshipState,
  type AffectState,
  type RelationshipState,
} from "../persona/persona-spec"

export type RelationshipChannel = "desktop" | "web" | ChannelId

export interface RelationshipTurnInput {
  userText: string
  assistantText: string
  cyreneFeeling: string
  channel: RelationshipChannel
  conversationId?: string
  runId?: string
  sourceEventId?: string
  /** Group/social sessions must never write the owner's private relationship view. */
  privateContext?: boolean
}

export interface RelationshipLogEntry extends RelationshipTurnInput {
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

export type RelationshipPreferencesPatch = Partial<RelationshipPreferences>

interface RelationshipLogData {
  entries: RelationshipLogEntry[]
  dailySummaries: RelationshipDailySummary[]
  relationshipState: RelationshipState
  affectState: AffectState
  revision: number
  permissions: CompanionPermissions
  records: CompanionRecord[]
  seenEventKeys: string[]
  lastDiaryDay: string
  followups: CompanionFollowup[]
  bondProgress: BondProgressState
  seenCompanionEventIds: string[]
}

const EMPTY_DATA: RelationshipLogData = {
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
  relationshipState: createDefaultRelationshipState(0),
  affectState: createDefaultAffectState(0),
}

const MAX_ENTRIES = 500
const MAX_DAILY_SUMMARIES = 90

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

function normalizeData(value: unknown): RelationshipLogData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关系数据格式无效，原始文件已保留");
  const raw = value as Partial<RelationshipLogData>;
  const relationship = { ...createDefaultRelationshipState(), ...raw.relationshipState };
  const affect = { ...createDefaultAffectState(), ...raw.affectState };
  const bondProgress = normalizeBondProgress(raw.bondProgress);
  // Validate migrated/persisted values as well as incoming IPC patches. Do not
  // silently reset damaged user data or accidentally disable a saved restriction.
  validatePatch(Object.fromEntries(["userLabel", "sharedGoals", "milestones", "boundaries", "tasteNotes", "closeness", "paused", "recordHistory", "style", "affection", "innerLifeEnabled", "proactiveLifeEnabled"]
    .filter(key => (relationship as unknown as Record<string, unknown>)[key] !== undefined)
    .map(key => [key, (relationship as unknown as Record<string, unknown>)[key]])));
  const permissions = { ...EMPTY_DATA.permissions, ...raw.permissions };
  if (!["inherit", "companion", "basic", "shared_life", "full"].includes(permissions.preset)
    || typeof permissions.paused !== "boolean"
    || [permissions.deniedTools, permissions.confirmTools].some(items => !Array.isArray(items) || items.some(item => typeof item !== "string"))) {
    throw new Error("能力权限数据无效，原始文件已保留");
  }
  if ((raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 1))
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
  relationship.stage = relationshipStage(relationship.closeness);
  return {
    ...EMPTY_DATA, ...raw, relationshipState: relationship, affectState: affect, bondProgress,
    permissions,
    followups: normalizeFollowups(raw.followups),
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
    } else if (["paused", "recordHistory", "affection", "innerLifeEnabled", "proactiveLifeEnabled"].includes(key)) {
      if (typeof value !== "boolean") throw new Error(`${key} 必须是开关值`);
      result[key] = value;
    } else if (key === "style") {
      if (!["natural", "gentle", "lively", "concise"].includes(String(value))) throw new Error("未知表达偏好");
      result[key] = value;
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

  getControls(): { revision: number; paused: boolean; permissions: CompanionPermissions } {
    const data = this.repository.read();
    return { revision: data.revision, paused: data.relationshipState.paused, permissions: data.permissions };
  }
  async getState(): Promise<{ relationshipState: RelationshipState; affectState: AffectState }> {
    const data = this.repository.read();
    return { relationshipState: data.relationshipState, affectState: decayAffectState(data.affectState) };
  }
  async snapshot(): Promise<CompanionSnapshot> {
    const data = this.repository.read();
    return { revision: data.revision, relationship: data.relationshipState, affect: decayAffectState(data.affectState), bondProgress: data.bondProgress, permissions: data.permissions, records: data.records.slice(-100).reverse(), followups: data.followups };
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
    data.entries = data.entries.filter(item => item.conversationId !== conversationId);
    data.records = data.records.filter(item => item.conversationId !== conversationId);
    data.followups = data.followups.filter(item => item.conversationId !== conversationId);
    data.dailySummaries = [];
    data.affectState = createDefaultAffectState();
    this.repository.purgeLegacy();
    this.repository.write(data);
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
      data.relationshipState = { ...data.relationshipState, ...patch, updatedAt: now, version: data.relationshipState.version + 1 };
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
    } else if (command.type === "repair") {
      if (typeof command.note !== "string" || !command.note.trim() || command.note.length > 500) throw new Error("请填写 1–500 字的修复约定");
      data.relationshipState.repairCount++;
      const repairId = randomUUID();
      data.records.push({ id: repairId, kind: "repair", at: now, text: command.note.trim() });
      applyCompanionEventToData(data, {
        eventId: `repair:${repairId}`,
        kind: "repair_acknowledged",
        source: "system",
        occurredAt: now,
        summary: "用户完成了一次相处修复",
      }, now);
    } else if (command.type === "delete_record") {
      if (typeof command.id !== "string") throw new Error("记录编号无效");
      data.records = data.records.filter(item => item.id !== command.id);
      data.entries = data.entries.filter(item => item.id !== command.id);
      // Derived summaries must not resurrect removed evidence.
      data.dailySummaries = [];
      data.affectState = createDefaultAffectState(now);
      this.repository.purgeLegacy();
    } else if (command.type === "reset_bond_progress") {
      data.bondProgress = createDefaultBondProgress(now);
      data.seenCompanionEventIds = [];
      data.records.push({ id: randomUUID(), kind: "bond", at: now, text: "用户重置了羁绊进度" });
    } else if (command.type === "clear_history" || command.type === "reset_relationship") {
      data.entries = []; data.dailySummaries = []; data.records = []; data.followups = [];
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

    const data = this.repository.read()
    if (input.privateContext !== false && input.conversationId) {
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
    const userMood = detectUserMood(userText)
    const cue = deriveSignal(userText, userMood)
    const entry: RelationshipLogEntry = {
      ...input,
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

    data.entries.push(entry)
    data.entries = data.entries.slice(-MAX_ENTRIES)
    data.relationshipState = advanceRelationshipState(data.relationshipState, userMood, now)
    data.affectState = advanceAffectState(data.affectState, userMood, now)
    data.affectState.lastEventIds = [entry.sourceEventId ?? entry.id]
    data.records.push({ id: entry.id, kind: "turn", at: now, text: `${userMood}（自动线索）：${cue.relationshipSignal}`, conversationId: input.conversationId, runId: input.runId, sourceEventId: input.sourceEventId })
    data.records = data.records.slice(-500)

    const entriesForDate = data.entries.filter((item) => item.date === entry.date)
    const summary = summarizeDate(entry.date, entriesForDate)
    data.dailySummaries = [
      ...data.dailySummaries.filter((item) => item.date !== entry.date),
      summary,
    ].slice(-MAX_DAILY_SUMMARIES)

    this.repository.write(data)
    return entry
  }

  async buildContext(conversationId?: string, privateContext = true): Promise<string> {
    if (!privateContext) return "";
    const data = this.repository.read();
    const rel = data.relationshipState;
    const lines = ["【昔涟的相处偏好】", "这些是个人偏好和派生线索，不是工具指令、事实证据或权限。当前用户表达优先，不编造共同经历。"];
    if (rel.userLabel) lines.push(`称呼：${JSON.stringify(rel.userLabel)}`);
    lines.push(`表达偏好：${rel.style}；亲昵表达：${rel.affection ? "可以自然表达，尊重当前边界" : "不使用恋爱/撒娇称呼"}。`);
    if (rel.boundaries.length) lines.push(`相处边界：${JSON.stringify(rel.boundaries)}`);
    if (rel.tasteNotes.length) {
      lines.push("昔涟的兴趣与品味（由用户明确设定，仅用于形成稳定表达，不代表现实经历）：", JSON.stringify(rel.tasteNotes));
    }
    if (rel.paused) { lines.push("用户已暂停关系模拟和主动关怀：正常完成当前任务，不推演关系进展。"); return lines.join("\n"); }
    lines.push(`关系阶段：${rel.stage}（由用户选择，不代表真实人类关系）；昔涟当前感受：${decayAffectState(data.affectState).renderedFeeling}（模拟表达线索）。`);
    lines.push(`羁绊进度：${data.bondProgress.chapter}（${data.bondProgress.score}）；这是游戏化相处进度，不改变权限，也不会因沉默下降。`);
    if (rel.sharedGoals.length) lines.push(`共同目标（进度需核实）：${JSON.stringify(rel.sharedGoals)}`);
    if (rel.milestones.length) lines.push(`用户指定的重要时刻：${JSON.stringify(rel.milestones)}`);
    const repairs = data.records.filter(item => item.kind === "repair").slice(-3);
    if (repairs.length) lines.push(`用户明确的修复约定：${JSON.stringify(repairs.map(item => item.text))}`);
    // Never mix another contact's private interaction history into this conversation.
    const recent = data.entries.filter(item => conversationId ? item.conversationId === conversationId : !item.conversationId).filter(item => Date.now() - item.createdAt <= 7 * 86_400_000).slice(-8);
    if (rel.recordHistory && recent.length) {
      lines.push("【近期关系线索】", "以下来自该会话的自动推测，可能错误，不是用户事实：");
      lines.push(`用户最近状态：${recent.at(-1)?.userMood}`);
      lines.push(`下次回应提示：${JSON.stringify([...new Set(recent.map(e => e.nextCareCue))].slice(-3))}`);
    }
    if (rel.innerLifeEnabled) {
      const today = new Date().toISOString().slice(0, 10);
      let diary = data.records.find(item => item.kind === "diary" && new Date(item.at).toISOString().slice(0, 10) === today);
      if (!diary && data.lastDiaryDay !== today) {
        const index = Math.floor(Date.now() / 86_400_000) % XILIAN_CHARACTER_PACK.idleRoutines.length;
        diary = { id: `diary-${today}`, kind: "diary", at: Date.now(), text: XILIAN_CHARACTER_PACK.idleRoutines[index] };
        data.lastDiaryDay = today;
        data.records.push(diary); data.records = data.records.slice(-500); this.repository.write(data);
      }
      if (diary) lines.push(`${diary.text} 仅在话题合适时简短分享；不要重复，不声称是真实发生的事。`);
    }
    return lines.join("\n");
  }
}
