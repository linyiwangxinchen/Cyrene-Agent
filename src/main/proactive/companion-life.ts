import fs from "node:fs";
import path from "node:path";
import type { CompanionEvent } from "../../shared/companion-events";

export type CompanionMomentKind = "share" | "ask" | "checkin" | "joke" | "followup";
export type CompanionMomentStatus = "pending" | "consumed" | "dismissed";

export const DEFAULT_COMPANION_LIFE_LIMITS = {
  // Active enough to feel present across a normal day. The proactive policy
  // still applies its two-hour global cooldown and unanswered-message guard.
  dailyMessages: 8,
  dailyQuestions: 3,
  dailyPluginShares: 6,
} as const;

export interface CompanionLifeLimits {
  dailyMessages: number;
  dailyQuestions: number;
  dailyPluginShares: number;
}

export interface CompanionLifeState {
  version: 2;
  dateKey: string;
  energy: number;
  curiosity: number;
  boredom: number;
  dailyMessageCount: number;
  dailyQuestionCount: number;
  dailyPluginShareCount: number;
  lastInteractionAt: number | null;
  lastMomentAt: number | null;
  lastAdvancedAt: number;
  revision: number;
}

export type CompanionLifeObservationKind = "user_message" | "plugin_observation" | "moment_shared";

export interface CompanionMoment {
  id: string;
  kind: CompanionMomentKind;
  source: CompanionEvent["source"];
  summary: string;
  occurredAt: number;
  conversationId?: string;
  pluginId?: string;
  status: CompanionMomentStatus;
  notBefore?: number;
  expiresAt?: number;
}

interface CompanionLifeData {
  version: 2;
  moments: CompanionMoment[];
  dailyMomentDate?: string;
  state: CompanionLifeState;
  revision: number;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function validDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function createDefaultLifeState(dateKey = "", now = 0): CompanionLifeState {
  return {
    version: 2,
    dateKey,
    energy: 70,
    curiosity: 50,
    boredom: 20,
    dailyMessageCount: 0,
    dailyQuestionCount: 0,
    dailyPluginShareCount: 0,
    lastInteractionAt: null,
    lastMomentAt: null,
    lastAdvancedAt: now,
    revision: 1,
  };
}

function normalizeLifeState(value: unknown): CompanionLifeState {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<CompanionLifeState> : {};
  return {
    version: 2,
    dateKey: validDateKey(raw.dateKey) ? raw.dateKey : "",
    energy: clamp(typeof raw.energy === "number" && Number.isFinite(raw.energy) ? raw.energy : 70),
    curiosity: clamp(typeof raw.curiosity === "number" && Number.isFinite(raw.curiosity) ? raw.curiosity : 50),
    boredom: clamp(typeof raw.boredom === "number" && Number.isFinite(raw.boredom) ? raw.boredom : 20),
    dailyMessageCount: clamp(typeof raw.dailyMessageCount === "number" && Number.isFinite(raw.dailyMessageCount) ? raw.dailyMessageCount : 0, 0, 1000),
    dailyQuestionCount: clamp(typeof raw.dailyQuestionCount === "number" && Number.isFinite(raw.dailyQuestionCount) ? raw.dailyQuestionCount : 0, 0, 1000),
    dailyPluginShareCount: clamp(typeof raw.dailyPluginShareCount === "number" && Number.isFinite(raw.dailyPluginShareCount) ? raw.dailyPluginShareCount : 0, 0, 1000),
    lastInteractionAt: typeof raw.lastInteractionAt === "number" && Number.isFinite(raw.lastInteractionAt) ? raw.lastInteractionAt : null,
    lastMomentAt: typeof raw.lastMomentAt === "number" && Number.isFinite(raw.lastMomentAt) ? raw.lastMomentAt : null,
    lastAdvancedAt: typeof raw.lastAdvancedAt === "number" && Number.isFinite(raw.lastAdvancedAt) ? raw.lastAdvancedAt : 0,
    revision: Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : 1,
  };
}

function emptyData(): CompanionLifeData {
  return { version: 2, moments: [], state: createDefaultLifeState(), revision: 1 };
}

function normalize(value: unknown): CompanionLifeData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyData();
  const raw = value as Partial<CompanionLifeData>;
  const moments = Array.isArray(raw.moments) ? raw.moments.filter((item): item is CompanionMoment => Boolean(
    item && typeof item === "object"
    && typeof (item as CompanionMoment).id === "string"
    && ["share", "ask", "checkin", "joke", "followup"].includes((item as CompanionMoment).kind)
    && ["desktop", "web", "channel", "scheduler", "plugin", "system"].includes((item as CompanionMoment).source)
    && typeof (item as CompanionMoment).summary === "string"
    && (item as CompanionMoment).summary.length <= 1000
    && Number.isFinite((item as CompanionMoment).occurredAt)
    && ["pending", "consumed", "dismissed"].includes((item as CompanionMoment).status),
  )).map((item) => ({
    ...item,
    ...(typeof item.expiresAt === "number" && Number.isFinite(item.expiresAt)
      ? { expiresAt: item.expiresAt }
      : item.id.startsWith("daily:") || item.id.startsWith("idle:")
        ? { expiresAt: item.occurredAt + 24 * 60 * 60_000 }
        : item.source === "plugin" ? { expiresAt: item.occurredAt + 7 * 24 * 60 * 60_000 } : {}),
  })).slice(-200) : [];
  return {
    version: 2,
    moments,
    ...(typeof raw.dailyMomentDate === "string" ? { dailyMomentDate: raw.dailyMomentDate } : {}),
    state: normalizeLifeState(raw.state),
    revision: Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : 1,
  };
}

function localDate(now: number): string {
  const value = new Date(now);
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Small durable queue used by proactive life; it never calls a model itself. */
export class CompanionLifeStore {
  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  private read(): CompanionLifeData {
    try {
      if (!fs.existsSync(this.filePath)) return emptyData();
      return normalize(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      return emptyData();
    }
  }

  private write(data: CompanionLifeData): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  private advanceState(data: CompanionLifeData, now: number, dateKey?: string): CompanionLifeState {
    const key = validDateKey(dateKey) ? dateKey : localDate(now);
    let state = data.state;
    let changed = false;
    if (state.dateKey !== key) {
      const firstDate = !state.dateKey;
      state = {
        ...state,
        dateKey: key,
        energy: clamp(state.energy + (firstDate ? 0 : 15)),
        curiosity: clamp(state.curiosity + (firstDate ? 0 : 10)),
        boredom: firstDate ? state.boredom : 20,
        dailyMessageCount: 0,
        dailyQuestionCount: 0,
        dailyPluginShareCount: 0,
        lastAdvancedAt: now,
        revision: state.revision + 1,
      };
      changed = true;
    }
    const elapsed = Math.max(0, now - state.lastAdvancedAt);
    if (elapsed >= 60_000) {
      const halfHours = Math.floor(elapsed / (30 * 60_000));
      state = {
        ...state,
        energy: clamp(state.energy - Math.min(20, Math.floor(halfHours / 2) * 3)),
        curiosity: clamp(state.curiosity + Math.min(15, halfHours * 2)),
        boredom: clamp(state.boredom + Math.min(35, halfHours * 5)),
        lastAdvancedAt: now,
        revision: state.revision + 1,
      };
      changed = true;
    }
    if (changed) data.state = state;
    return state;
  }

  /** Advance short-term virtual feelings and persist daily rollover. */
  refreshState(input: { now?: number; dateKey?: string } = {}): CompanionLifeState {
    const now = input.now ?? this.now();
    const data = this.read();
    const before = JSON.stringify(data.state);
    const state = this.advanceState(data, now, input.dateKey);
    if (JSON.stringify(state) !== before) {
      data.revision++;
      this.write(data);
    }
    return { ...state };
  }

  getState(input: { now?: number; dateKey?: string } = {}): CompanionLifeState {
    return this.refreshState(input);
  }

  observeInteraction(input: {
    kind: CompanionLifeObservationKind;
    now?: number;
    dateKey?: string;
  }): CompanionLifeState {
    const now = input.now ?? this.now();
    const data = this.read();
    this.advanceState(data, now, input.dateKey);
    const state = data.state;
    const next = input.kind === "user_message"
      ? { ...state, energy: clamp(state.energy + 12), curiosity: clamp(state.curiosity + 8), boredom: clamp(state.boredom - 25), lastInteractionAt: now }
      : input.kind === "plugin_observation"
        ? { ...state, curiosity: clamp(state.curiosity + 5), boredom: clamp(state.boredom - 3) }
        : { ...state, energy: clamp(state.energy - 3), boredom: clamp(state.boredom - 12), lastMomentAt: now };
    data.state = { ...next, lastAdvancedAt: now, revision: state.revision + 1 };
    data.revision++;
    this.write(data);
    return { ...data.state };
  }

  listPending(now = this.now()): CompanionMoment[] {
    const data = this.read();
    return data.moments
      .filter((item) => item.status === "pending" && (!item.notBefore || item.notBefore <= now) && (!item.expiresAt || item.expiresAt > now))
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, 200)
      .map((item) => ({ ...item }));
  }

  getNextShareable(input: { now?: number; dateKey?: string; limits?: CompanionLifeLimits; allow?: (moment: CompanionMoment) => boolean } = {}): CompanionMoment | undefined {
    const now = input.now ?? this.now();
    const state = this.getState({ now, dateKey: input.dateKey });
    const limits = input.limits ?? DEFAULT_COMPANION_LIFE_LIMITS;
    const pending = this.listPending(now).filter((item) => {
      if (input.allow && !input.allow(item)) return false;
      if (state.dailyMessageCount >= limits.dailyMessages) return false;
      if ((item.kind === "ask" || item.kind === "checkin") && state.dailyQuestionCount >= limits.dailyQuestions) return false;
      if (item.source === "plugin" && state.dailyPluginShareCount >= limits.dailyPluginShares) return false;
      return true;
    });
    const priority = (item: CompanionMoment): number => item.source === "plugin" ? 3 : item.kind === "ask" || item.kind === "checkin" ? 2 : 1;
    return pending.sort((a, b) => priority(b) - priority(a) || b.occurredAt - a.occurredAt)[0];
  }

  enqueue(moment: Omit<CompanionMoment, "status">): CompanionMoment {
    const data = this.read();
    const existing = data.moments.find((item) => item.id === moment.id);
    if (existing) return { ...existing };
    const next: CompanionMoment = { ...moment, status: "pending", summary: moment.summary.trim().slice(0, 1000) };
    data.moments = [...data.moments, next].slice(-200);
    data.revision++;
    this.write(data);
    return { ...next };
  }

  consume(id: string, status: Exclude<CompanionMomentStatus, "pending"> = "consumed", input: { now?: number; dateKey?: string } = {}): boolean {
    const data = this.read();
    const item = data.moments.find((candidate) => candidate.id === id);
    if (!item || item.status !== "pending") return false;
    const now = input.now ?? this.now();
    this.advanceState(data, now, input.dateKey);
    item.status = status;
    if (status === "consumed") {
      data.state = {
        ...data.state,
        energy: clamp(data.state.energy - 3),
        boredom: clamp(data.state.boredom - 12),
        dailyMessageCount: data.state.dailyMessageCount + 1,
        dailyQuestionCount: data.state.dailyQuestionCount + (item.kind === "ask" || item.kind === "checkin" ? 1 : 0),
        dailyPluginShareCount: data.state.dailyPluginShareCount + (item.source === "plugin" ? 1 : 0),
        lastMomentAt: now,
        lastAdvancedAt: now,
        revision: data.state.revision + 1,
      };
    }
    data.revision++;
    this.write(data);
    return true;
  }

  /** Create one daily low-pressure question when boredom is high and the user has been away. */
  ensureIdleMoment(input: {
    enabled: boolean;
    dateKey: string;
    now?: number;
    idleSec: number;
    conversationId?: string;
  }): CompanionMoment | null {
    if (!input.enabled) return null;
    const now = input.now ?? this.now();
    const data = this.read();
    const beforeState = JSON.stringify(data.state);
    const state = this.advanceState(data, now, input.dateKey);
    const stateChanged = JSON.stringify(state) !== beforeState;
    const persistState = (): void => {
      if (stateChanged) {
        data.revision++;
        this.write(data);
      }
    };
    if (state.lastInteractionAt === null || input.idleSec < 45 * 60 || state.boredom < 30 || state.dailyQuestionCount >= DEFAULT_COMPANION_LIFE_LIMITS.dailyQuestions) {
      persistState();
      return null;
    }
    const id = `idle:${input.dateKey}`;
    const existing = data.moments.find((item) => item.id === id);
    if (existing) {
      persistState();
      return { ...existing };
    }
    const next: CompanionMoment = {
      id,
      kind: "ask",
      source: "system",
      summary: "虚构角色今天有一点无聊，想用一个轻量问题重新和用户连接；不要连续追问，也不要制造压力。",
      occurredAt: now,
      status: "pending",
      expiresAt: now + 24 * 60 * 60_000,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    };
    data.moments = [...data.moments, next].slice(-200);
    data.revision++;
    this.write(data);
    return { ...next };
  }

  /** Create at most one clearly fictional daily note when inner life is enabled. */
  ensureDailyFictionalMoment(input: {
    enabled: boolean;
    conversationId?: string;
    summary: string;
    now?: number;
    /** The user's resolved local date; avoids using the host timezone for the daily boundary. */
    dateKey?: string;
  }): CompanionMoment | null {
    if (!input.enabled) return null;
    const at = input.now ?? this.now();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.dateKey ?? "") ? input.dateKey! : localDate(at);
    const data = this.read();
    if (data.dailyMomentDate === date) return data.moments.find((item) => item.id === `daily:${date}`) ?? null;
    data.dailyMomentDate = date;
    const next: CompanionMoment = {
      id: `daily:${date}`,
      kind: "share",
      source: "system",
      summary: input.summary.trim().slice(0, 1000),
      occurredAt: at,
      status: "pending",
      expiresAt: at + 24 * 60 * 60_000,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    };
    data.moments = [...data.moments.filter((item) => item.id !== next.id), next].slice(-200);
    data.revision++;
    this.write(data);
    return { ...next };
  }
}

export function createCompanionLifeStore(filePath: string): CompanionLifeStore {
  return new CompanionLifeStore(filePath);
}
