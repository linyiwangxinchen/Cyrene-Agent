import fs from "node:fs";
import path from "node:path";
import {
  createDefaultXilianWorldData,
  getXilianLocation,
  getXilianTimeBlock,
  XILIAN_DEFAULT_GOALS,
  XILIAN_LOCATIONS,
  type XilianLifeArtifactContext,
  type XilianLifeArtifactKind,
  type XilianLifeArtifactStatus,
  type XilianDiaryEntry,
  type XilianTimelineEvent,
  type XilianWorldData,
  type XilianWorldState,
} from "../../shared/xilian-world";
import { getXilianDateKey, reconcileXilianWorld, type XilianCompanionSignals } from "./schedule";

const MAX_TIMELINE_EVENTS = 2_000;
const MAX_ARTIFACTS = 500;

export interface XilianWorldAdvanceInput {
  now?: number;
  timezone?: string;
  companion?: XilianCompanionSignals;
}

export interface XilianTimelineQuery {
  dateKey?: string;
  from?: number;
  to?: number;
  limit?: number;
  order?: "asc" | "desc";
}

export interface XilianArtifactClaimInput {
  eventId: string;
  kind: XilianLifeArtifactKind;
  promptFingerprint: string;
  now?: number;
}

export interface XilianArtifactResult {
  imageModel?: string;
  outputPath?: string;
  now?: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isArtifactKind(value: unknown): value is XilianLifeArtifactKind {
  return value === "selfie" || value === "note" || value === "song" || value === "question";
}

function isArtifactStatus(value: unknown): value is XilianLifeArtifactStatus {
  return value === "planned" || value === "generating" || value === "generated" || value === "failed";
}

function normalizeArtifact(value: unknown): XilianLifeArtifactContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<XilianLifeArtifactContext>;
  if (typeof raw.id !== "string" || typeof raw.eventId !== "string" || !isArtifactKind(raw.kind)) return null;
  if (!isArtifactStatus(raw.status)) return null;
  return {
    id: raw.id.slice(0, 200),
    eventId: raw.eventId.slice(0, 200),
    kind: raw.kind,
    createdAt: validNumber(raw.createdAt, 0),
    updatedAt: validNumber(raw.updatedAt, validNumber(raw.createdAt, 0)),
    promptFingerprint: typeof raw.promptFingerprint === "string" ? raw.promptFingerprint.slice(0, 200) : "",
    ...(typeof raw.imageModel === "string" ? { imageModel: raw.imageModel.slice(0, 200) } : {}),
    ...(typeof raw.outputPath === "string" ? { outputPath: raw.outputPath.slice(0, 2_000) } : {}),
    status: raw.status,
    ...(raw.errorClass === "auth" || raw.errorClass === "parameter" || raw.errorClass === "network" || raw.errorClass === "timeout" || raw.errorClass === "parse" || raw.errorClass === "unknown"
      ? { errorClass: raw.errorClass }
      : {}),
  };
}

function normalizeEvent(value: unknown): XilianTimelineEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<XilianTimelineEvent>;
  if (typeof raw.id !== "string" || typeof raw.dateKey !== "string" || !validDateKey(raw.dateKey)) return null;
  if (typeof raw.slotId !== "string" || !getXilianTimeBlock(raw.slotId)) return null;
  if (typeof raw.locationId !== "string" || !getXilianLocation(raw.locationId)) return null;
  const activityKinds = ["work", "study", "game", "rest", "explore", "social", "maintenance", "travel"] as const;
  const statuses = ["planned", "active", "completed", "interrupted"] as const;
  const visibilities = ["private", "shareable", "shared"] as const;
  const sources = ["simulated_world", "plugin_observation", "user_interaction"] as const;
  if (!activityKinds.includes(raw.activityKind as typeof activityKinds[number])) return null;
  if (!statuses.includes(raw.status as typeof statuses[number])) return null;
  if (!visibilities.includes(raw.visibility as typeof visibilities[number])) return null;
  if (!sources.includes(raw.source as typeof sources[number])) return null;
  return {
    id: raw.id.slice(0, 200),
    dateKey: raw.dateKey,
    slotId: raw.slotId.slice(0, 80),
    occurredAt: validNumber(raw.occurredAt, 0),
    locationId: raw.locationId,
    activityKind: raw.activityKind as XilianTimelineEvent["activityKind"],
    activityTitle: typeof raw.activityTitle === "string" ? raw.activityTitle.slice(0, 300) : "昔涟完成了一件小事",
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 1_000) : "",
    ...(typeof raw.detail === "string" ? { detail: raw.detail.slice(0, 1_000) } : {}),
    ...(typeof raw.outcome === "string" ? { outcome: raw.outcome.slice(0, 500) } : {}),
    ...(typeof raw.diaryText === "string" ? { diaryText: raw.diaryText.slice(0, 1_200) } : {}),
    ...(Array.isArray(raw.participants) ? { participants: raw.participants.filter((item): item is string => typeof item === "string").slice(0, 8).map(item => item.slice(0, 100)) } : {}),
    ...(Array.isArray(raw.memoryTags) ? { memoryTags: raw.memoryTags.filter((item): item is string => typeof item === "string").slice(0, 12).map(item => item.slice(0, 80)) } : {}),
    mood: typeof raw.mood === "string" ? raw.mood.slice(0, 200) : "平稳",
    energyAfter: clamp(validNumber(raw.energyAfter, 50)),
    ...(typeof raw.goalId === "string" ? { goalId: raw.goalId.slice(0, 100) } : {}),
    status: raw.status as XilianTimelineEvent["status"],
    visibility: raw.visibility as XilianTimelineEvent["visibility"],
    source: raw.source as XilianTimelineEvent["source"],
    ...(typeof raw.previousEventId === "string" ? { previousEventId: raw.previousEventId.slice(0, 200) } : {}),
    ...(typeof raw.nextEventId === "string" ? { nextEventId: raw.nextEventId.slice(0, 200) } : {}),
  };
}

function normalizeDiary(value: unknown): XilianDiaryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<XilianDiaryEntry>;
  if (typeof raw.id !== "string" || typeof raw.eventId !== "string" || typeof raw.dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dateKey)) return null;
  if (typeof raw.locationId !== "string" || !getXilianLocation(raw.locationId)) return null;
  const visibility = raw.visibility === "private" || raw.visibility === "shared" ? raw.visibility : "shareable";
  const source = raw.source === "user_interaction" ? "user_interaction" : "life_event";
  return {
    id: raw.id.slice(0, 200),
    eventId: raw.eventId.slice(0, 200),
    dateKey: raw.dateKey,
    writtenAt: validNumber(raw.writtenAt, 0),
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "涟宝的小日记",
    text: typeof raw.text === "string" ? raw.text.slice(0, 1_500) : "",
    mood: typeof raw.mood === "string" ? raw.mood.slice(0, 200) : "平稳",
    locationId: raw.locationId,
    visibility,
    source,
  };
}

function normalizeGoal(value: unknown, fallback: typeof XILIAN_DEFAULT_GOALS[number], now: number) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<XilianWorldState["goals"][number]> : {};
  const progress = clamp(validNumber(raw.progress, 0), 0, fallback.target);
  const stage = raw.stage === "paused" ? "paused" : progress >= fallback.target || raw.stage === "completed" ? "completed" : "active";
  return {
    id: fallback.id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.slice(0, 200) : fallback.title,
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description.slice(0, 500) : fallback.description,
    stage,
    progress,
    target: fallback.target,
    importance: clamp(validNumber(raw.importance, fallback.importance)),
    startedAt: validNumber(raw.startedAt, now),
    updatedAt: validNumber(raw.updatedAt, now),
  } as XilianWorldState["goals"][number];
}

function diaryEntryForEvent(event: XilianTimelineEvent): XilianDiaryEntry | null {
  if (event.status !== "completed" || !event.diaryText) return null;
  return {
    id: `diary:${event.id}`,
    eventId: event.id,
    dateKey: event.dateKey,
    writtenAt: event.occurredAt,
    title: event.activityTitle,
    text: event.diaryText,
    mood: event.mood,
    locationId: event.locationId,
    visibility: event.visibility,
    source: event.source === "user_interaction" ? "user_interaction" : "life_event",
  };
}

function normalizeState(value: unknown, dateKey: string, now: number): XilianWorldState {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<XilianWorldState> : {};
  const fallback = createDefaultXilianWorldData(dateKey, now).state;
  const goals = XILIAN_DEFAULT_GOALS.map((goal, index) => normalizeGoal(Array.isArray(raw.goals) ? raw.goals[index] : undefined, goal, now));
  const currentActivity = normalizeEvent(raw.currentActivity);
  const nextPlannedEvent = normalizeEvent(raw.nextPlannedEvent);
  return {
    version: 1,
    worldDate: validDateKey(raw.worldDate) ? raw.worldDate : fallback.worldDate,
    seasonId: typeof raw.seasonId === "string" ? raw.seasonId.slice(0, 80) : fallback.seasonId,
    dayIndex: Math.max(1, Math.floor(validNumber(raw.dayIndex, fallback.dayIndex))),
    currentLocationId: typeof raw.currentLocationId === "string" && getXilianLocation(raw.currentLocationId) ? raw.currentLocationId : fallback.currentLocationId,
    ...(currentActivity ? { currentActivity } : {}),
    activeArcId: raw.activeArcId === "echo" || raw.activeArcId === "voyage" ? raw.activeArcId : "lighting",
    goals,
    recentEventIds: Array.isArray(raw.recentEventIds) ? raw.recentEventIds.filter((item): item is string => typeof item === "string").slice(-24) : [],
    ...(nextPlannedEvent ? { nextPlannedEvent } : {}),
    revision: Math.max(1, Math.floor(validNumber(raw.revision, fallback.revision))),
  };
}

function normalizeData(value: unknown, dateKey: string, now: number): XilianWorldData {
  const fallback = createDefaultXilianWorldData(dateKey, now);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const raw = value as Partial<XilianWorldData>;
  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline.map(normalizeEvent).filter((event): event is XilianTimelineEvent => Boolean(event)).slice(-MAX_TIMELINE_EVENTS)
    : [];
  const diary = Array.isArray(raw.diary)
    ? raw.diary.map(normalizeDiary).filter((entry): entry is XilianDiaryEntry => Boolean(entry)).slice(-MAX_TIMELINE_EVENTS)
    : [];
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.map(normalizeArtifact).filter((artifact): artifact is XilianLifeArtifactContext => Boolean(artifact)).slice(-MAX_ARTIFACTS)
    : [];
  return {
    version: 2,
    state: normalizeState(raw.state, dateKey, now),
    timeline,
    diary,
    artifacts,
    revision: Math.max(1, Math.floor(validNumber(raw.revision, fallback.revision))),
  };
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export class XilianWorldStore {
  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  private backupCorruptFile(): void {
    try {
      const backup = `${this.filePath}.corrupt-${Date.now()}.json`;
      fs.copyFileSync(this.filePath, backup);
    } catch {
      // A corrupt backup is best effort; the safe default still keeps runtime alive.
    }
  }

  private readData(): XilianWorldData {
    const at = this.now();
    const dateKey = getXilianDateKey(new Date(at), systemTimezone());
    if (!fs.existsSync(this.filePath)) return createDefaultXilianWorldData(dateKey, at);
    try {
      return normalizeData(JSON.parse(fs.readFileSync(this.filePath, "utf8")), dateKey, at);
    } catch {
      this.backupCorruptFile();
      const fallback = createDefaultXilianWorldData(dateKey, at);
      try { this.writeData(fallback); } catch { /* keep the in-memory safe default */ }
      return fallback;
    }
  }

  private writeData(data: XilianWorldData): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  private save(data: XilianWorldData): void {
    data.revision += 1;
    this.writeData(data);
  }

  readDataSnapshot(): XilianWorldData {
    return clone(this.readData());
  }

  readSnapshot(): XilianWorldState {
    return clone(this.readData().state);
  }

  advance(input: XilianWorldAdvanceInput = {}): XilianWorldState {
    const at = input.now ?? this.now();
    const timezone = input.timezone || systemTimezone();
    const data = this.readData();
    const result = reconcileXilianWorld({ state: data.state, timeline: data.timeline, now: at, timezone, companion: input.companion });
    if (!result.changed) return clone(data.state);
    const byId = new Map(data.timeline.map((event) => [event.id, event]));
    for (const event of result.events) byId.set(event.id, event);
    data.timeline = [...byId.values()].sort((a, b) => a.occurredAt - b.occurredAt).slice(-MAX_TIMELINE_EVENTS);
    const diaryById = new Map(data.diary.map((entry) => [entry.id, entry]));
    for (const event of result.events) {
      const entry = diaryEntryForEvent(event);
      if (entry) diaryById.set(entry.id, entry);
    }
    data.diary = [...diaryById.values()].sort((a, b) => a.writtenAt - b.writtenAt).slice(-MAX_TIMELINE_EVENTS);
    data.state = result.state;
    this.save(data);
    return clone(data.state);
  }

  appendEvent(event: XilianTimelineEvent): XilianTimelineEvent {
    const data = this.readData();
    const existing = data.timeline.find((candidate) => candidate.id === event.id);
    if (existing) return clone(existing);
    data.timeline = [...data.timeline, clone(event)].sort((a, b) => a.occurredAt - b.occurredAt).slice(-MAX_TIMELINE_EVENTS);
    const entry = diaryEntryForEvent(event);
    if (entry) data.diary = [...data.diary.filter((candidate) => candidate.id !== entry.id), entry].sort((a, b) => a.writtenAt - b.writtenAt).slice(-MAX_TIMELINE_EVENTS);
    data.state = { ...data.state, recentEventIds: [...new Set([...data.state.recentEventIds, event.id])].slice(-24), revision: data.state.revision + 1 };
    this.save(data);
    return clone(event);
  }

  getEvent(eventId: string): XilianTimelineEvent | undefined {
    const event = this.readData().timeline.find((candidate) => candidate.id === eventId);
    return event ? clone(event) : undefined;
  }

  queryTimeline(query: XilianTimelineQuery = {}): XilianTimelineEvent[] {
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
    const filtered = this.readData().timeline.filter((event) => {
      if (query.dateKey && event.dateKey !== query.dateKey) return false;
      if (typeof query.from === "number" && event.occurredAt < query.from) return false;
      if (typeof query.to === "number" && event.occurredAt > query.to) return false;
      return true;
    }).sort((a, b) => query.order === "asc" ? a.occurredAt - b.occurredAt : b.occurredAt - a.occurredAt);
    return clone(filtered.slice(0, limit));
  }

  queryDiary(query: { dateKey?: string; limit?: number; order?: "asc" | "desc" } = {}): XilianDiaryEntry[] {
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
    const filtered = this.readData().diary.filter((entry) => !query.dateKey || entry.dateKey === query.dateKey)
      .sort((a, b) => query.order === "asc" ? a.writtenAt - b.writtenAt : b.writtenAt - a.writtenAt);
    return clone(filtered.slice(0, limit));
  }

  worldView(input: { dateKey?: string; limit?: number } = {}): import("../../shared/xilian-world").XilianWorldView {
    const data = this.readData();
    const dateKey = input.dateKey ?? data.state.worldDate;
    return {
      state: clone(data.state),
      timeline: this.queryTimeline({ dateKey, order: "asc", limit: input.limit ?? 50 }),
      diary: this.queryDiary({ dateKey, order: "asc", limit: input.limit ?? 50 }),
      locations: XILIAN_LOCATIONS,
    };
  }

  listArtifacts(input: { eventId?: string; kind?: XilianLifeArtifactKind; limit?: number } = {}): XilianLifeArtifactContext[] {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const artifacts = this.readData().artifacts.filter((artifact) => (!input.eventId || artifact.eventId === input.eventId) && (!input.kind || artifact.kind === input.kind));
    return clone(artifacts.slice(-limit).reverse());
  }

  claimArtifact(input: XilianArtifactClaimInput): XilianLifeArtifactContext | null {
    const now = input.now ?? this.now();
    const data = this.readData();
    if (!data.timeline.some((event) => event.id === input.eventId)) return null;
    const id = `xilian-artifact:${input.eventId}:${input.kind}`;
    const existing = data.artifacts.find((artifact) => artifact.id === id);
    if (existing && existing.status !== "failed") return clone(existing);
    const next: XilianLifeArtifactContext = existing
      ? { ...existing, promptFingerprint: input.promptFingerprint.slice(0, 200), updatedAt: now, status: "planned", errorClass: undefined }
      : { id, eventId: input.eventId, kind: input.kind, createdAt: now, updatedAt: now, promptFingerprint: input.promptFingerprint.slice(0, 200), status: "planned" };
    data.artifacts = [...data.artifacts.filter((artifact) => artifact.id !== id), next].slice(-MAX_ARTIFACTS);
    this.save(data);
    return clone(next);
  }

  markArtifactGenerating(id: string, now = this.now()): XilianLifeArtifactContext | undefined {
    return this.updateArtifact(id, (artifact) => ({ ...artifact, status: "generating", updatedAt: now, errorClass: undefined }));
  }

  completeArtifact(id: string, input: XilianArtifactResult = {}): XilianLifeArtifactContext | undefined {
    const now = input.now ?? this.now();
    return this.updateArtifact(id, (artifact) => ({
      ...artifact,
      status: "generated",
      updatedAt: now,
      ...(input.imageModel ? { imageModel: input.imageModel.slice(0, 200) } : {}),
      ...(input.outputPath ? { outputPath: input.outputPath.slice(0, 2_000) } : {}),
      errorClass: undefined,
    }));
  }

  failArtifact(id: string, errorClass: NonNullable<XilianLifeArtifactContext["errorClass"]>, now = this.now()): XilianLifeArtifactContext | undefined {
    return this.updateArtifact(id, (artifact) => ({ ...artifact, status: "failed", errorClass, updatedAt: now }));
  }

  private updateArtifact(id: string, update: (artifact: XilianLifeArtifactContext) => XilianLifeArtifactContext): XilianLifeArtifactContext | undefined {
    const data = this.readData();
    const existing = data.artifacts.find((artifact) => artifact.id === id);
    if (!existing) return undefined;
    const next = update(existing);
    data.artifacts = data.artifacts.map((artifact) => artifact.id === id ? next : artifact);
    this.save(data);
    return clone(next);
  }
}

export function createXilianWorldStore(filePath: string): XilianWorldStore {
  return new XilianWorldStore(filePath);
}

const sharedStores = new Map<string, XilianWorldStore>();

/** Desktop main-process callers share one store instance to serialize writes. */
export function getSharedXilianWorldStore(filePath: string): XilianWorldStore {
  const existing = sharedStores.get(filePath);
  if (existing) return existing;
  const created = createXilianWorldStore(filePath);
  sharedStores.set(filePath, created);
  return created;
}
