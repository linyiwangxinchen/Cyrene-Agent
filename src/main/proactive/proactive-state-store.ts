// ProactiveChat 状态持久化（从原 opener/desire-engine 搬出 + 剃除 opener 专属字段）
// 文件名改用 "proactive-state.json"，避免与历史 opener-state.json 残留冲突。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { normalizeDurableCandidate, type ProactiveCommitIntent, type ProactiveState, type ProactiveDeliveryContext } from "./proactive-types";
import type { GeneratedImageAttachment } from "../../shared/generated-image";

export function defaultProactiveState(): ProactiveState {
  return {
    proactiveEpoch: 0,
    unansweredCount: 0,
    lastProactiveAt: null,
    lastProactiveScene: null,
    lastNormalConversationEndedAt: null,
    globalDesire: 0,
    affinity: {},
    lastFiredAt: {},
    dailyMessageDate: undefined,
    dailyMessageCount: 0,
    dailyQuestionCount: 0,
  };
}

function getStatePath(): string {
  return path.join(app.getPath("userData"), "proactive-state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePendingCommitIntent(value: unknown): ProactiveCommitIntent | undefined {
  if (!isRecord(value) || typeof value.intentId !== "string" || !value.intentId
    || !Number.isInteger(value.sequence) || (value.sequence as number) < 1
    || !Number.isInteger(value.generationEpoch) || (value.generationEpoch as number) < 0
    || typeof value.intentAt !== "number" || !Number.isFinite(value.intentAt)
    || typeof value.text !== "string" || !value.text
    || (value.source !== "model" && value.source !== "fallback")
    || !isRecord(value.candidate)) return undefined;
  const candidate = normalizeDurableCandidate(value.candidate);
  if (!candidate) return undefined;
  const context = value.deliveryContext;
  const deliveryContext: ProactiveDeliveryContext | undefined = isRecord(context) && Number.isSafeInteger(context.relationshipRevision)
    && ((context.composedAt === undefined && context.timezone === undefined)
      || typeof context.composedAt === "number" && Number.isFinite(context.composedAt) && typeof context.timezone === "string" && context.timezone.length <= 100)
    && ["conversationId", "sessionId", "targetId", "threadId", "followupId"].every(key => context[key] === undefined || (typeof context[key] === "string" && context[key].length <= 300))
    && (context.recipientScope === undefined || (typeof context.recipientScope === "string" && /^peer:[a-f0-9]{64}$/.test(context.recipientScope)))
    && (context.bindingUpdatedAt === undefined || (typeof context.bindingUpdatedAt === "number" && Number.isFinite(context.bindingUpdatedAt)))
    && (context.expression === undefined || (isRecord(context.expression) && typeof context.expression.query === "string"
      && context.expression.query.length <= 300 && typeof context.expression.evidenceKey === "string" && /^[a-f0-9]{64}$/.test(context.expression.evidenceKey)))
    && (context.memoryMode === undefined || (typeof context.memoryMode === "string" && ["off", "vector", "summary", "wiki"].includes(context.memoryMode)))
    ? { relationshipRevision: context.relationshipRevision as number,
      ...(typeof context.memoryMode === "string" ? { memoryMode: context.memoryMode } : {}),
      ...(typeof context.recipientScope === "string" ? { recipientScope: context.recipientScope } : {}),
      ...(typeof context.bindingUpdatedAt === "number" ? { bindingUpdatedAt: context.bindingUpdatedAt } : {}),
      ...(isRecord(context.expression) ? { expression: { query: context.expression.query as string, evidenceKey: context.expression.evidenceKey as string } } : {}),
      ...(typeof context.composedAt === "number" && typeof context.timezone === "string" ? { composedAt: context.composedAt, timezone: context.timezone } : {}),
      ...Object.fromEntries(["conversationId", "sessionId", "targetId", "threadId", "followupId"].filter(key => typeof context[key] === "string").map(key => [key, context[key]])) } : undefined;
  if (value.deliveryContext !== undefined && !deliveryContext) return undefined;
  // 主动自拍的图片：只接受已落盘的模型图片引用，损坏则整条意图作废，避免发出缺图的配文。
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.filter((item): item is GeneratedImageAttachment => isRecord(item) && item.kind === "image" && item.source === "model"
      && item.status === "done" && typeof item.id === "string" && typeof item.filePath === "string" && typeof item.name === "string"
      && typeof item.byteLength === "number")
    : [];
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || attachments.length !== value.attachments.length)) return undefined;
  return {
    intentId: value.intentId,
    sequence: value.sequence as number,
    candidate,
    generationEpoch: value.generationEpoch as number,
    intentAt: value.intentAt,
    ...(typeof value.localDate === "string" && value.localDate.length <= 20 ? { localDate: value.localDate } : {}),
    text: value.text,
    source: value.source,
    ...(value.deliveryTarget === "local" || value.deliveryTarget === "wechat" || value.deliveryTarget === "feishu" ? { deliveryTarget: value.deliveryTarget } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "fallbackPayload") ? { fallbackPayload: value.fallbackPayload } : {}),
  };
}

export function loadProactiveState(): ProactiveState {
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return defaultProactiveState();
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ProactiveState>;
    const base = defaultProactiveState();
    const {
      pendingCommitIntent: _pendingCommitIntent,
      proactiveCommitSequence: _proactiveCommitSequence,
      recentProactiveAt: _recentProactiveAt,
      lastProactiveSourceEventId: _lastProactiveSourceEventId,
      dailyQuestionCount: _dailyQuestionCount,
      ...legacyFields
    } = raw;
    const proactiveCommitSequence = typeof raw.proactiveCommitSequence === "number"
      && Number.isInteger(raw.proactiveCommitSequence)
      && raw.proactiveCommitSequence >= 0
      ? raw.proactiveCommitSequence
      : undefined;
    const pendingCommitIntent = normalizePendingCommitIntent(raw.pendingCommitIntent);
    return {
      ...base,
      ...legacyFields,
      affinity: { ...base.affinity, ...(raw.affinity ?? {}) },
      lastFiredAt: { ...(raw.lastFiredAt ?? {}) },
      ...(Array.isArray(raw.recentProactiveAt) ? { recentProactiveAt: raw.recentProactiveAt.filter(at => typeof at === "number" && Number.isFinite(at)).slice(-4) } : {}),
      ...(typeof raw.lastProactiveSourceEventId === "string" ? { lastProactiveSourceEventId: raw.lastProactiveSourceEventId.slice(0, 300) } : {}),
      ...(typeof raw.dailyMessageDate === "string" && raw.dailyMessageDate.length <= 20 ? { dailyMessageDate: raw.dailyMessageDate } : {}),
      ...(Number.isSafeInteger(raw.dailyMessageCount) && (raw.dailyMessageCount as number) >= 0 ? { dailyMessageCount: raw.dailyMessageCount as number } : {}),
      ...(Number.isSafeInteger(raw.dailyQuestionCount) && (raw.dailyQuestionCount as number) >= 0 ? { dailyQuestionCount: raw.dailyQuestionCount as number } : {}),
      ...(proactiveCommitSequence !== undefined ? { proactiveCommitSequence } : {}),
      ...(pendingCommitIntent !== undefined ? { pendingCommitIntent } : {}),
    };
  } catch {
    return defaultProactiveState();
  }
}

export function saveProactiveState(state: ProactiveState): void {
  const filePath = getStatePath();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    throw error;
  }
}
