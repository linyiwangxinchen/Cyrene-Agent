// ProactiveChat 状态持久化（从原 opener/desire-engine 搬出 + 剃除 opener 专属字段）
// 文件名改用 "proactive-state.json"，避免与历史 opener-state.json 残留冲突。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { ProactiveCandidate, ProactiveCommitIntent, ProactiveState, ProactiveDeliveryContext } from "./proactive-types";

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
    || !isRecord(value.candidate)
    || typeof value.candidate.sceneId !== "string"
    || typeof value.candidate.score !== "number" || !Number.isFinite(value.candidate.score)
    || typeof value.candidate.sceneCooldownMs !== "number" || !Number.isFinite(value.candidate.sceneCooldownMs)) return undefined;
  const candidate: ProactiveCandidate = {
    sceneId: value.candidate.sceneId,
    score: value.candidate.score,
    sceneCooldownMs: value.candidate.sceneCooldownMs,
    ...(typeof value.candidate.momentId === "string" ? { momentId: value.candidate.momentId.slice(0, 200) } : {}),
    ...(typeof value.candidate.momentSummary === "string" ? { momentSummary: value.candidate.momentSummary.slice(0, 1000) } : {}),
  };
  const context = value.deliveryContext;
  const deliveryContext: ProactiveDeliveryContext | undefined = isRecord(context) && Number.isSafeInteger(context.relationshipRevision)
    && ["conversationId", "sessionId", "targetId", "threadId", "followupId"].every(key => context[key] === undefined || (typeof context[key] === "string" && context[key].length <= 300))
    ? { relationshipRevision: context.relationshipRevision as number,
      ...Object.fromEntries(["conversationId", "sessionId", "targetId", "threadId", "followupId"].filter(key => typeof context[key] === "string").map(key => [key, context[key]])) } : undefined;
  if (value.deliveryContext !== undefined && !deliveryContext) return undefined;
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
      ...(typeof raw.dailyMessageDate === "string" && raw.dailyMessageDate.length <= 20 ? { dailyMessageDate: raw.dailyMessageDate } : {}),
      ...(Number.isSafeInteger(raw.dailyMessageCount) && (raw.dailyMessageCount as number) >= 0 ? { dailyMessageCount: raw.dailyMessageCount as number } : {}),
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
