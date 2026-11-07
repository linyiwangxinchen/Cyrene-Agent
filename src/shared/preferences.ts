export type DefaultChatMode = "work" | "chat" | "code";
export type SegmentedOutputMode = "all" | "chat" | "off";
export type MobileMessageSegmentationMode = "on" | "natural" | "off";
export type ProactiveChatMode = "on" | "off";
export type ProactiveDeliveryTarget = "local" | "wechat" | "feishu";
export const DEFAULT_PROACTIVE_TARGET_SCORE = 60;
export const DEFAULT_PROACTIVE_QUIET_START_MINUTE = 22 * 60;
export const DEFAULT_PROACTIVE_QUIET_END_MINUTE = 8 * 60;
export const DEFAULT_PROACTIVE_DAILY_LIMIT = 3;

export type { CustomStyleConfig, StyleId } from "./style-sampling";

export function normalizeChatSocialContextEnabled(value: unknown): boolean {
  return value === true;
}

export function normalizeDefaultChatMode(value: unknown): DefaultChatMode {
  // 兼容旧版磁盘值：talk -> chat，collab -> work。
  if (value === "chat" || value === "talk") return "chat";
  if (value === "work" || value === "collab") return "work";
  if (value === "code") return "code";
  return "chat";
}

export function normalizeSegmentedOutputMode(value: unknown): SegmentedOutputMode {
  return value === "all" || value === "chat" ? value : "off";
}

export function normalizeMobileMessageSegmentationMode(value: unknown): MobileMessageSegmentationMode {
  return value === "on" || value === "natural" ? value : "off";
}

export function normalizeProactiveChatMode(value: unknown): ProactiveChatMode {
  return value === "on" ? "on" : "off";
}

export function normalizeProactiveDeliveryTarget(value: unknown): ProactiveDeliveryTarget {
  return value === "wechat" || value === "feishu" ? value : "local";
}

export function normalizeProactiveTargetScore(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PROACTIVE_TARGET_SCORE;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeMinute(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1439, Math.round(numeric)));
}

export function normalizeProactiveQuietStartMinute(value: unknown): number {
  return normalizeMinute(value, DEFAULT_PROACTIVE_QUIET_START_MINUTE);
}

export function normalizeProactiveQuietEndMinute(value: unknown): number {
  return normalizeMinute(value, DEFAULT_PROACTIVE_QUIET_END_MINUTE);
}

export function normalizeProactiveDailyLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PROACTIVE_DAILY_LIMIT;
  return Math.max(0, Math.min(24, Math.round(numeric)));
}
