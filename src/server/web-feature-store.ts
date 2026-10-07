import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WebKnowledgePath { path: string; label?: string; addedAt: number; }
export interface WebKnowledgeCollection {
  id: string;
  name: string;
  scope?: string;
  enabled: boolean;
  paths: WebKnowledgePath[];
  createdAt: number;
  updatedAt: number;
  scanning: boolean;
  fileCount: number;
  errorCount: number;
}

export interface WebSchedule {
  id: string;
  name: string;
  title?: string;
  prompt: string;
  schedule: unknown;
  enabled: boolean;
  workspaceRoot?: string;
  workspaceBinding?: Record<string, unknown>;
  mode?: string;
  toolMode?: string;
  allowedToolIds?: string[];
  nextFireAt?: string | null;
  lastFiredAt?: number | string;
  runCount?: number;
  maxRuns?: number;
  endAt?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

export interface WebFeatureData {
  channels: Record<string, unknown>;
  knowledge: { enabled: boolean; collections: WebKnowledgeCollection[] };
  memory: {
    l0: Record<string, string>;
    l1: Record<string, string>;
    l2: Array<Record<string, unknown>>;
    reflections: Array<Record<string, unknown>>;
    vaultPath: string;
    autoSync: boolean;
    lastSyncAt: number;
  };
  schedules: WebSchedule[];
  scheduleHistory: Array<Record<string, unknown>>;
  profile: Record<string, unknown>;
  tokenUsage: { days: Array<Record<string, unknown>>; models: Array<Record<string, unknown>> };
  enabledPlugins: Record<string, boolean>;
  moments: { posts: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>>; reactions: Array<Record<string, unknown>> };
}

const FILE_NAME = "web-features.json";
const DEFAULT_CHANNELS = {
  wechat: { enabled: false },
  feishu: { enabled: false },
  qq: { enabled: false, listenMode: "auto", port: 6200, allowedPrivateUserIds: [], allowedGroupIds: [] },
  qqbot: { enabled: false, allowAnyPrivate: false, allowedUserOpenids: [], allowedGroupOpenids: [] },
  rateLimitPerUser: 10, rateLimitPerChannel: 100, ttsEnabled: true,
  stickerEnabled: true, mirrorToDesktop: false, toolSandbox: "all",
};

function defaults(): WebFeatureData {
  return {
    channels: structuredClone(DEFAULT_CHANNELS),
    knowledge: { enabled: false, collections: [] },
    memory: {
      l0: { preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "" },
      l1: { recentGoals: "", recentPreferences: "", currentProject: "" },
      l2: [], reflections: [], vaultPath: "", autoSync: false, lastSyncAt: 0,
    },
    schedules: [], scheduleHistory: [],
    profile: { nickname: "admin", callPreference: "", birthday: "", timezone: "Asia/Shanghai", avatarPath: "", defaultCity: "", gender: "", replyLanguage: "zh-CN" },
    tokenUsage: { days: [], models: [] },
    enabledPlugins: {},
    moments: { posts: [], comments: [], reactions: [] },
  };
}

function mergeData(input: Partial<WebFeatureData>): WebFeatureData {
  const base = defaults();
  const memory = (input.memory ?? {}) as Partial<WebFeatureData["memory"]>;
  return {
    ...base, ...input,
    channels: { ...base.channels, ...(input.channels ?? {}) },
    knowledge: { ...base.knowledge, ...(input.knowledge ?? {}), collections: Array.isArray(input.knowledge?.collections) ? input.knowledge.collections : [] },
    memory: {
      ...base.memory, ...memory,
      l0: { ...base.memory.l0, ...(memory.l0 ?? {}) },
      l1: { ...base.memory.l1, ...(memory.l1 ?? {}) },
      l2: Array.isArray(memory.l2) ? memory.l2 : [], reflections: Array.isArray(memory.reflections) ? memory.reflections : [],
    },
    schedules: Array.isArray(input.schedules) ? input.schedules.map((item) => {
      const value = item as WebSchedule;
      return {
        ...value,
        title: typeof value.title === "string" ? value.title : value.name,
        schedule: value.schedule && typeof value.schedule === "object" ? value.schedule : { kind: "daily", timeOfDay: "08:00" },
        toolMode: value.toolMode ?? "all-enabled",
        allowedToolIds: Array.isArray(value.allowedToolIds) ? value.allowedToolIds : [],
        nextFireAt: value.nextFireAt ?? null,
      };
    }) : [],
    scheduleHistory: Array.isArray(input.scheduleHistory) ? input.scheduleHistory : [],
    profile: { ...base.profile, ...(input.profile ?? {}) },
    tokenUsage: { ...base.tokenUsage, ...(input.tokenUsage ?? {}), days: Array.isArray(input.tokenUsage?.days) ? input.tokenUsage.days : [], models: Array.isArray(input.tokenUsage?.models) ? input.tokenUsage.models : [] },
    enabledPlugins: { ...base.enabledPlugins, ...(input.enabledPlugins ?? {}) },
    moments: { ...base.moments, ...(input.moments ?? {}), posts: Array.isArray(input.moments?.posts) ? input.moments.posts : [], comments: Array.isArray(input.moments?.comments) ? input.moments.comments : [], reactions: Array.isArray(input.moments?.reactions) ? input.moments.reactions : [] },
  };
}

export class WebFeatureStore {
  private data = defaults();
  private loadPromise?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}
  private get filePath(): string { return path.join(this.dataDir, FILE_NAME); }

  async load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.loadData().catch(error => { this.loadPromise = undefined; throw error; });
    await this.loadPromise;
  }

  private async loadData(): Promise<void> {
    try { this.data = mergeData(JSON.parse(await readFile(this.filePath, "utf8")) as Partial<WebFeatureData>); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    return this.writeChain;
  }

  async getChannels(): Promise<Record<string, unknown>> { await this.load(); return structuredClone(this.data.channels); }
  /** Runtime-only read. Callers must never send this value to a browser because it can contain connector secrets. */
  async getChannelsRaw(): Promise<Record<string, unknown>> { await this.load(); return structuredClone(this.data.channels); }
  async getChannelsPublic(): Promise<Record<string, unknown>> {
    await this.load();
    const channels = structuredClone(this.data.channels);
    for (const [id, value] of Object.entries(channels)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const channel = value as Record<string, unknown>;
      if (id === "feishu" || id === "qqbot") {
        const field = id === "feishu" ? "appSecret" : "appSecret";
        channel[`has${field === "appSecret" ? "AppSecret" : "Secret"}`] = Boolean(channel[field]);
        delete channel[field];
      }
      if (id === "qq") {
        channel.hasAccessToken = Boolean(channel.accessToken);
        delete channel.accessToken;
      }
    }
    return channels;
  }
  async patchChannels(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.load();
    const next = { ...this.data.channels };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === "object" && !Array.isArray(value) && next[key] && typeof next[key] === "object" && !Array.isArray(next[key])) {
        next[key] = { ...(next[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else next[key] = value;
    }
    this.data.channels = next;
    await this.save();
    return structuredClone(this.data.channels);
  }

  async getKnowledge(): Promise<WebFeatureData["knowledge"]> { await this.load(); return structuredClone(this.data.knowledge); }
  async setKnowledge(patch: Partial<WebFeatureData["knowledge"]>): Promise<WebFeatureData["knowledge"]> { await this.load(); this.data.knowledge = { ...this.data.knowledge, ...patch }; await this.save(); return structuredClone(this.data.knowledge); }
  async createCollection(input: { name: string; scope?: string }): Promise<WebKnowledgeCollection> { await this.load(); const now = Date.now(); const collection: WebKnowledgeCollection = { id: `web-kb-${randomUUID()}`, name: input.name.trim().slice(0, 120) || "资料集", scope: input.scope, enabled: true, paths: [], createdAt: now, updatedAt: now, scanning: false, fileCount: 0, errorCount: 0 }; this.data.knowledge.collections.push(collection); await this.save(); return structuredClone(collection); }
  async updateCollection(id: string, patch: Partial<WebKnowledgeCollection>): Promise<WebKnowledgeCollection | null> { await this.load(); const item = this.data.knowledge.collections.find((entry) => entry.id === id); if (!item) return null; Object.assign(item, patch, { updatedAt: Date.now() }); await this.save(); return structuredClone(item); }
  async deleteCollection(id: string): Promise<boolean> { await this.load(); const before = this.data.knowledge.collections.length; this.data.knowledge.collections = this.data.knowledge.collections.filter((entry) => entry.id !== id); if (before === this.data.knowledge.collections.length) return false; await this.save(); return true; }

  async getMemory(): Promise<WebFeatureData["memory"]> { await this.load(); return structuredClone(this.data.memory); }
  async patchMemory(patch: Partial<WebFeatureData["memory"]>): Promise<WebFeatureData["memory"]> { await this.load(); this.data.memory = { ...this.data.memory, ...patch, l0: { ...this.data.memory.l0, ...(patch.l0 ?? {}) }, l1: { ...this.data.memory.l1, ...(patch.l1 ?? {}) } }; await this.save(); return structuredClone(this.data.memory); }

  async listSchedules(): Promise<WebSchedule[]> { await this.load(); return structuredClone(this.data.schedules); }
  async createSchedule(input: Partial<WebSchedule>): Promise<WebSchedule> { await this.load(); const now = Date.now(); const raw = input as Record<string, unknown>; const title = String(raw.title ?? raw.name ?? "定时任务").slice(0, 120); const workspaceBinding = raw.workspaceBinding && typeof raw.workspaceBinding === "object" ? raw.workspaceBinding as Record<string, unknown> : undefined; const item: WebSchedule = { id: `web-schedule-${randomUUID()}`, name: title, title, prompt: String(raw.prompt ?? ""), schedule: raw.schedule ?? { kind: "daily", timeOfDay: "08:00" }, enabled: raw.enabled !== false, workspaceRoot: typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : typeof workspaceBinding?.workspaceRoot === "string" ? workspaceBinding.workspaceRoot : undefined, workspaceBinding, mode: typeof raw.mode === "string" ? raw.mode : "work", toolMode: typeof raw.toolMode === "string" ? raw.toolMode : "all-enabled", allowedToolIds: Array.isArray(raw.allowedToolIds) ? raw.allowedToolIds.map(String) : [], nextFireAt: null, runCount: 0, createdAt: now, updatedAt: now }; this.data.schedules.push(item); await this.save(); return structuredClone(item); }
  async updateSchedule(id: string, patch: Partial<WebSchedule>): Promise<WebSchedule | null> { await this.load(); const item = this.data.schedules.find((entry) => entry.id === id); if (!item) return null; Object.assign(item, patch, { id, updatedAt: Date.now() }); if (typeof (patch as any).title === "string") item.name = String((patch as any).title); if (typeof item.title !== "string") item.title = item.name; await this.save(); return structuredClone(item); }
  async deleteSchedule(id: string): Promise<boolean> { await this.load(); const before = this.data.schedules.length; this.data.schedules = this.data.schedules.filter((entry) => entry.id !== id); if (before === this.data.schedules.length) return false; await this.save(); return true; }
  async scheduleHistory(): Promise<Array<Record<string, unknown>>> { await this.load(); return structuredClone(this.data.scheduleHistory); }
  async addScheduleHistory(item: Record<string, unknown>): Promise<void> { await this.load(); this.data.scheduleHistory = [item, ...this.data.scheduleHistory].slice(0, 200); await this.save(); }

  async getProfile(): Promise<Record<string, unknown>> { await this.load(); return structuredClone(this.data.profile); }
  async patchProfile(patch: Record<string, unknown>): Promise<Record<string, unknown>> { await this.load(); this.data.profile = { ...this.data.profile, ...patch }; await this.save(); return structuredClone(this.data.profile); }
  async getUsage(): Promise<WebFeatureData["tokenUsage"]> { await this.load(); return structuredClone(this.data.tokenUsage); }
  async clearUsage(): Promise<void> { await this.load(); this.data.tokenUsage = { days: [], models: [] }; await this.save(); }
  async getPluginEnabled(): Promise<Record<string, boolean>> { await this.load(); return structuredClone(this.data.enabledPlugins); }
  async setPluginEnabled(id: string, enabled: boolean): Promise<Record<string, boolean>> { await this.load(); this.data.enabledPlugins[id] = enabled; await this.save(); return structuredClone(this.data.enabledPlugins); }
  async listMoments(limit = 50): Promise<Array<Record<string, unknown>>> { await this.load(); return this.data.moments.posts.slice().sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)).slice(0, limit).map((post) => ({ post: structuredClone(post), comments: this.data.moments.comments.filter((item) => item.postId === post.id).map((item) => structuredClone(item)), likes: this.data.moments.reactions.filter((item) => item.postId === post.id).map((item) => structuredClone(item)) })); }
  async createMoment(input: Record<string, unknown>): Promise<Record<string, unknown>> { await this.load(); const post = { id: `web-moment-${randomUUID()}`, author: "user", title: typeof input.title === "string" ? input.title.slice(0, 60) : undefined, text: String(input.text ?? "").slice(0, 2000), media: Array.isArray(input.media) ? input.media.slice(0, 9) : [], mentions: Array.isArray(input.mentions) ? input.mentions.map(String) : [], createdAt: Date.now(), source: { type: "manual" } }; this.data.moments.posts.push(post); await this.save(); return { applied: true, value: structuredClone(post) }; }
  async deleteMoment(id: string): Promise<Record<string, unknown>> { await this.load(); const before = this.data.moments.posts.length; this.data.moments.posts = this.data.moments.posts.filter((post) => post.id !== id); if (before === this.data.moments.posts.length) return { applied: false, reason: "post_not_found" }; this.data.moments.comments = this.data.moments.comments.filter((item) => item.postId !== id); this.data.moments.reactions = this.data.moments.reactions.filter((item) => item.postId !== id); await this.save(); return { applied: true, value: null }; }
  async commentMoment(input: Record<string, unknown>): Promise<Record<string, unknown>> { await this.load(); const post = this.data.moments.posts.find((item) => item.id === input.postId); if (!post) return { applied: false, reason: "post_not_found" }; const comment = { id: `web-comment-${randomUUID()}`, postId: post.id, author: "user", content: String(input.content ?? "").slice(0, 500), ...(typeof input.replyTo === "string" ? { replyTo: input.replyTo } : {}), createdAt: Date.now() }; this.data.moments.comments.push(comment); await this.save(); return { applied: true, value: structuredClone(comment) }; }
  async toggleMomentLike(id: string): Promise<Record<string, unknown>> { await this.load(); const index = this.data.moments.reactions.findIndex((item) => item.postId === id && item.actor === "user" && item.type === "like"); if (index >= 0) { this.data.moments.reactions.splice(index, 1); await this.save(); return { applied: true, value: { liked: false } }; } if (!this.data.moments.posts.some((post) => post.id === id)) return { applied: false, reason: "post_not_found" }; this.data.moments.reactions.push({ postId: id, actor: "user", type: "like", createdAt: Date.now() }); await this.save(); return { applied: true, value: { liked: true } }; }
}
