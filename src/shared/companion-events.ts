/** Sanitized internal events shared by bond progress and virtual life. */

export type CompanionEventKind =
  | "turn_completed"
  | "goal_progressed"
  | "followup_completed"
  | "repair_acknowledged"
  | "moment_shared"
  | "plugin_observation"
  | "music_context"
  | "idle_window";

export type CompanionEventSource =
  | "desktop"
  | "web"
  | "channel"
  | "scheduler"
  | "plugin"
  | "system";

const EVENT_KINDS: readonly CompanionEventKind[] = [
  "turn_completed", "goal_progressed", "followup_completed", "repair_acknowledged",
  "moment_shared", "plugin_observation", "music_context", "idle_window",
];
const EVENT_SOURCES: readonly CompanionEventSource[] = ["desktop", "web", "channel", "scheduler", "plugin", "system"];

export interface CompanionEvent {
  eventId: string;
  kind: CompanionEventKind;
  source: CompanionEventSource;
  conversationId?: string;
  occurredAt: number;
  summary: string;
  evidenceRefs?: string[];
  pluginId?: string;
  /** Optional, already-sanitized scalar facts. Never put credentials here. */
  payload?: Record<string, string | number | boolean>;
  /** Explicit override for trusted host producers; ordinary events use defaults. */
  bondDelta?: number;
}

export function isCompanionEvent(value: unknown): value is CompanionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<CompanionEvent>;
  const payload = event.payload;
  const payloadValid = payload === undefined || (
    payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && Object.keys(payload).length <= 20
    && Object.entries(payload).every(([key, item]) => /^[a-zA-Z0-9_.:-]{1,80}$/.test(key)
      && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
  );
  return typeof event.eventId === "string"
    && event.eventId.length > 0
    && event.eventId.length <= 200
    && EVENT_KINDS.includes(event.kind as CompanionEventKind)
    && EVENT_SOURCES.includes(event.source as CompanionEventSource)
    && Number.isFinite(event.occurredAt)
    && typeof event.summary === "string"
    && event.summary.length > 0
    && event.summary.length <= 1000
    && (event.conversationId === undefined || (typeof event.conversationId === "string" && event.conversationId.length <= 200))
    && (event.pluginId === undefined || (typeof event.pluginId === "string" && event.pluginId.length <= 100))
    && (event.evidenceRefs === undefined || (Array.isArray(event.evidenceRefs)
      && event.evidenceRefs.length <= 20
      && event.evidenceRefs.every(item => typeof item === "string" && item.length <= 200)))
    && (event.bondDelta === undefined || (typeof event.bondDelta === "number" && Number.isFinite(event.bondDelta)))
    && payloadValid;
}

export function sanitizeCompanionEvent(value: CompanionEvent): CompanionEvent {
  const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
    ? Object.fromEntries(Object.entries(value.payload)
      .filter(([key, item]) => /^[a-zA-Z0-9_.:-]{1,80}$/.test(key)
        && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
      .slice(0, 20)
      .map(([key, item]) => [key, typeof item === "string" ? item.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) : item]))
    : undefined;
  return {
    eventId: value.eventId.slice(0, 200),
    kind: value.kind,
    source: value.source,
    occurredAt: value.occurredAt,
    summary: value.summary.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000),
    ...(value.conversationId ? { conversationId: value.conversationId.slice(0, 200) } : {}),
    ...(value.pluginId ? { pluginId: value.pluginId.slice(0, 100) } : {}),
    ...(value.evidenceRefs ? { evidenceRefs: value.evidenceRefs.filter((item) => typeof item === "string").slice(0, 20) } : {}),
    ...(payload && Object.keys(payload).length ? { payload } : {}),
    ...(typeof value.bondDelta === "number" && Number.isFinite(value.bondDelta) ? { bondDelta: value.bondDelta } : {}),
  };
}
