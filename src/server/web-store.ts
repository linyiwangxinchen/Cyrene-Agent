import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { alignPresetApiBase } from "../shared/api-endpoint";
import { applyPresentationCheckpointToMessage } from "../main/orchestrator/conversation-transcript-projection";
import { assertValidPresentationPatch } from "../main/orchestrator/conversation-transcript-types";
import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ConversationMode,
  PendingChatMessage,
} from "../shared/chat-types";
import type {
  SidebarOrganizationDraft,
  SidebarOrganizationResult,
  SidebarOrganizationSnapshot,
} from "../shared/sidebar-organization";

const STORE_FILE = "web-data.json";
const STORE_VERSION = 1;

export interface WebSettings {
  general: Record<string, unknown>;
  config: Record<string, unknown>;
  timeout: Record<string, unknown>;
  permissionLevel: string;
  modelProfiles: Array<Record<string, unknown>>;
  defaultModelProfileId?: string;
}

interface PersistedWebData {
  version: number;
  settings: WebSettings;
  sessions: ChatSession[];
  sidebar: SidebarOrganizationSnapshot;
  recentProjects: string[];
  checkpointKeys: string[];
}

const DEFAULT_GENERAL: Record<string, unknown> = {
  language: "zh-CN",
  uiTheme: "pearl-white",
  currentStyleId: "default",
  petVisible: true,
  petAlwaysOnTop: false,
  petZoom: 1,
  ttsEarlyReadSplitEnabled: false,
  ttsEarlyReadSplitMode: "sentence",
  momentsEnabled: true,
  cyreneMomentsPostingEnabled: true,
  cyreneMomentsReactionsEnabled: true,
  momentsCharacterReactionsEnabled: true,
  momentsLiveliness: "quiet",
  filesystemMcpEnabled: false,
  taskCharacterPersonaEnabled: true,
  maxParallelToolCalls: 4,
};

const DEFAULT_CONFIG: Record<string, unknown> = {
  stickerEnabled: true,
  stickerSize: "standard",
  stickerSimilarityThreshold: 0.55,
  memoryMode: "summary",
  thinkingOverride: -1,
  disableMaxToken: false,
  modelRequestMaxRetries: 2,
  vision: { baseUrl: "", apiKey: "", model: "" },
};

function emptySidebar(): SidebarOrganizationSnapshot {
  return {
    version: 1,
    revision: 0,
    projects: [],
    projectOrder: [],
    projectCategories: [],
    projectCategoryMembers: {},
    groups: [],
    topLevelOrder: [],
    groupMembers: {},
  };
}

function defaultSettings(): WebSettings {
  return {
    general: { ...DEFAULT_GENERAL },
    config: { ...DEFAULT_CONFIG },
    timeout: { testTimeout: 30_000, requestTimeout: 120_000 },
    permissionLevel: "ask",
    modelProfiles: [],
  };
}

function defaultData(): PersistedWebData {
  return { version: STORE_VERSION, settings: defaultSettings(), sessions: [], sidebar: emptySidebar(), recentProjects: [], checkpointKeys: [] };
}

function isMode(value: unknown): value is ConversationMode {
  return value === "chat" || value === "work" || value === "code" || value === "learn";
}

function normalizeSession(value: Partial<ChatSession>): ChatSession | null {
  if (typeof value.id !== "string" || typeof value.title !== "string" || !Array.isArray(value.messages)) return null;
  const mode = isMode(value.mode) ? value.mode : "work";
  return {
    id: value.id,
    title: value.title,
    identityId: value.identityId ?? null,
    messages: (value.messages as ChatMessage[]).map(message => {
      const legacy = message as ChatMessage & { delta?: unknown };
      if (!legacy.delta) return message;
      const { delta, ...normalized } = legacy;
      try {
        const patch = { delta };
        assertValidPresentationPatch(patch);
        applyPresentationCheckpointToMessage(normalized, patch);
        return normalized;
      } catch { return message; }
    }),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    schemaVersion: 1,
    ...(value.purpose ? { purpose: value.purpose } : {}),
    ...(value.titleIsCustom ? { titleIsCustom: true } : {}),
    ...(value.workspaceBinding ? { workspaceBinding: value.workspaceBinding } : {}),
    mode,
    ...(value.pinned ? { pinned: true } : {}),
    ...(value.modelProfileId ? { modelProfileId: value.modelProfileId } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.currentContextUsage ? { currentContextUsage: value.currentContextUsage } : {}),
    ...(value.pendingMessages ? { pendingMessages: value.pendingMessages } : {}),
    ...(value.pendingDispatch ? { pendingDispatch: value.pendingDispatch } : {}),
  };
}

export class WebStore {
  private data: PersistedWebData = defaultData();
  private loadPromise?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();
  private listeners = new Set<(section: "sessions" | "sidebar" | "settings") => void>();

  constructor(private readonly dataDir: string) {}

  /** Internal runtime path; never included in public settings. */
  getDataDir(): string { return this.dataDir; }

  private get filePath(): string { return path.join(this.dataDir, STORE_FILE); }

  async load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.loadData().catch(error => { this.loadPromise = undefined; throw error; });
    await this.loadPromise;
  }

  private async loadData(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedWebData>;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((session) => normalizeSession(session as Partial<ChatSession>)).filter((x): x is ChatSession => x !== null)
        : [];
      this.data = {
        ...defaultData(),
        ...parsed,
        version: STORE_VERSION,
        settings: {
          ...defaultSettings(),
          ...(parsed.settings ?? {}),
          general: { ...DEFAULT_GENERAL, ...(parsed.settings?.general ?? {}) },
          config: { ...DEFAULT_CONFIG, ...(parsed.settings?.config ?? {}) },
          timeout: { testTimeout: 30_000, requestTimeout: 120_000, ...(parsed.settings?.timeout ?? {}) },
          modelProfiles: (parsed.settings?.modelProfiles ?? []).map(normalizeWebProfile),
        },
        sessions,
        sidebar: parsed.sidebar ?? emptySidebar(),
        recentProjects: parsed.recentProjects ?? [],
        checkpointKeys: Array.isArray(parsed.checkpointKeys) ? parsed.checkpointKeys.filter(key => typeof key === "string").slice(-4096) : [],
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }

  private async save(section: "sessions" | "sidebar" | "settings" = "sessions"): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporary, this.filePath);
      for (const listener of this.listeners) listener(section);
    });
    return this.writeChain;
  }

  onChanged(listener: (section: "sessions" | "sidebar" | "settings") => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async list(mode?: ConversationMode): Promise<ChatSessionMeta[]> {
    await this.load();
    return this.data.sessions
      .filter((session) => !mode || session.mode === mode)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .map((session) => ({
        id: session.id,
        title: session.title,
        identityId: session.identityId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        ...(session.purpose ? { purpose: session.purpose } : {}),
        mode: session.mode ?? "work",
        ...(session.workspaceBinding ? { workspaceRoot: session.workspaceBinding.workspaceRoot, workspaceDisplayName: session.workspaceBinding.displayName } : {}),
        ...(session.pinned ? { pinned: true } : {}),
      }));
  }

  async get(id: string): Promise<ChatSession | null> { await this.load(); return this.data.sessions.find((session) => session.id === id) ?? null; }

  async create(input: { identityId: null; mode: ConversationMode; title?: string }): Promise<ChatSession> {
    await this.load();
    const now = Date.now();
    const title = input.title?.trim() || (input.mode === "chat" ? "新对话" : "新任务");
    const session: ChatSession = { id: randomUUID(), title, identityId: input.identityId, messages: [], createdAt: now, updatedAt: now, schemaVersion: 1, mode: input.mode };
    this.data.sessions.push(session);
    await this.save();
    return session;
  }

  async rename(id: string, title: string): Promise<ChatSession | null> {
    const session = await this.get(id); if (!session) return null;
    session.title = title.trim().slice(0, 200) || session.title; session.titleIsCustom = true; session.updatedAt = Date.now(); await this.save(); return session;
  }

  async delete(id: string): Promise<boolean> { await this.load(); const before = this.data.sessions.length; this.data.sessions = this.data.sessions.filter((session) => session.id !== id); if (before === this.data.sessions.length) return false; await this.save(); return true; }

  async setPinned(id: string, pinned: boolean): Promise<ChatSession | null> { const session = await this.get(id); if (!session) return null; session.pinned = pinned; session.updatedAt = Date.now(); await this.save(); return session; }

  async updateSession(id: string, patch: Record<string, unknown>): Promise<ChatSession | null> {
    const session = await this.get(id); if (!session) return null;
    if (typeof patch.modelProfileId === "string") session.modelProfileId = patch.modelProfileId;
    if (typeof patch.model === "string") session.model = patch.model;
    if (typeof patch.workspaceRoot === "string") {
      const root = path.resolve(patch.workspaceRoot);
      const info = await stat(root).catch(() => null);
      if (!info?.isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
      session.workspaceBinding = { workspaceRoot: root, displayName: path.basename(root) || root, boundAt: Date.now() };
      if (!this.data.recentProjects.includes(root)) this.data.recentProjects = [root, ...this.data.recentProjects].slice(0, 20);
    }
    session.updatedAt = Date.now(); await this.save(); return session;
  }

  async enqueue(id: string, entry: Omit<PendingChatMessage, "enqueuedAt">): Promise<{ ok: true; queue: PendingChatMessage[] } | { ok: false; error: string }> {
    const session = await this.get(id); if (!session) return { ok: false, error: "SESSION_NOT_FOUND" };
    const queue = session.pendingMessages ?? [];
    if (queue.some((item) => item.id === entry.id)) return { ok: true, queue };
    const item: PendingChatMessage = { ...entry, enqueuedAt: Date.now() };
    session.pendingMessages = [...queue, item]; session.updatedAt = Date.now(); await this.save(); return { ok: true, queue: session.pendingMessages };
  }

  async pendingList(id: string): Promise<PendingChatMessage[] | null> { const session = await this.get(id); return session ? [...(session.pendingMessages ?? [])] : null; }

  async pendingRemove(id: string, messageId: string): Promise<{ ok: boolean; error?: string; queue?: PendingChatMessage[] }> { const session = await this.get(id); if (!session) return { ok: false, error: "SESSION_NOT_FOUND" }; const queue = session.pendingMessages ?? []; if (!queue.some((item) => item.id === messageId)) return { ok: false, error: "PENDING_MESSAGE_NOT_FOUND", queue }; session.pendingMessages = queue.filter((item) => item.id !== messageId); session.updatedAt = Date.now(); await this.save(); return { ok: true, queue: session.pendingMessages }; }

  async pendingEdit(id: string, messageId: string, update: { rawContent: string; visibleContent: string; userSticker?: string }): Promise<{ ok: boolean; error?: string; queue?: PendingChatMessage[] }> { const session = await this.get(id); if (!session) return { ok: false, error: "SESSION_NOT_FOUND" }; const queue = session.pendingMessages ?? []; const item = queue.find((entry) => entry.id === messageId); if (!item) return { ok: false, error: "PENDING_MESSAGE_NOT_FOUND", queue }; item.rawContent = update.rawContent; item.visibleContent = update.visibleContent; if (update.userSticker) item.userSticker = update.userSticker; else delete item.userSticker; session.updatedAt = Date.now(); await this.save(); return { ok: true, queue }; }

  async pendingAdjust(id: string, messageId: string): Promise<{ ok: boolean; error?: string; queue?: PendingChatMessage[] }> { const session = await this.get(id); if (!session) return { ok: false, error: "SESSION_NOT_FOUND" }; const queue = session.pendingMessages ?? []; if (!queue.some((entry) => entry.id === messageId)) return { ok: false, error: "PENDING_MESSAGE_NOT_FOUND", queue }; return { ok: false, error: "no-active-run", queue }; }

  async claim(id: string): Promise<{ ok: true; claimed: true; userMessage: ChatMessage; visibleContent: string; remainingQueue: PendingChatMessage[]; session: ChatSession } | { ok: true; claimed: false } | { ok: false; error: string }> {
    const session = await this.get(id); if (!session) return { ok: false, error: "SESSION_NOT_FOUND" };
    if (session.pendingDispatch || !(session.pendingMessages?.length)) return { ok: true, claimed: false };
    const [entry, ...remaining] = session.pendingMessages;
    const userMessage: ChatMessage = { id: entry.id, role: "user", content: entry.visibleContent, modelContext: entry.rawContent, at: Date.now(), ...(entry.attachments ? { attachments: entry.attachments as ChatMessage["attachments"] } : {}), ...(entry.userSticker ? { sticker: entry.userSticker } : {}) };
    session.messages.push(userMessage);
    session.pendingMessages = remaining;
    session.pendingDispatch = {
      messageId: userMessage.id,
      claimedAt: Date.now(),
      userMessage: {
        id: userMessage.id,
        at: userMessage.at,
        text: entry.rawContent,
        visibleContent: entry.visibleContent,
        ...(entry.attachments ? { attachments: entry.attachments } : {}),
        ...(entry.userSticker ? { sticker: entry.userSticker } : {}),
      },
    };
    session.updatedAt = Date.now(); await this.save();
    return { ok: true, claimed: true, userMessage, visibleContent: entry.visibleContent, remainingQueue: remaining, session };
  }

  async completeDispatch(id: string, messageId: string): Promise<{ ok: boolean; error?: string }> { const session = await this.get(id); if (!session) return { ok: false, error: "SESSION_NOT_FOUND" }; if (session.pendingDispatch?.messageId === messageId) { delete session.pendingDispatch; await this.save(); } return { ok: true }; }

  async addAssistantMessage(id: string, message: ChatMessage): Promise<void> { const session = await this.get(id); if (!session) throw new Error("SESSION_NOT_FOUND"); session.messages.push(message); session.updatedAt = Date.now(); await this.save(); }

  async patchMessage(id: string, messageId: string, patch: Partial<ChatMessage>): Promise<void> { const session = await this.get(id); if (!session) throw new Error("SESSION_NOT_FOUND"); const message = session.messages.find((item) => item.id === messageId); if (!message) { session.messages.push({ id: messageId, role: "model", content: "", at: Date.now(), ...patch }); } else Object.assign(message, patch); session.updatedAt = Date.now(); await this.save(); }

  async checkpointPresentation(id: string, messageId: string, mutationKey: string, patch: unknown): Promise<{ ok: boolean; error?: string }> {
    if (!mutationKey) throw new Error("CHECKPOINT_MUTATION_KEY_REQUIRED");
    assertValidPresentationPatch(patch);
    const session = await this.get(id);
    if (!session || !messageId) return { ok: false, error: "MESSAGE_NOT_FOUND" };
    // The original run controller checkpoints its placeholder before AGUI_RUN.
    let message = session.messages.find(item => item.id === messageId);
    if (!message) {
      message = { id: messageId, role: "model", content: "", at: Date.now() };
      session.messages.push(message);
    }
    const key = JSON.stringify([id, messageId, mutationKey]);
    if (this.data.checkpointKeys.includes(key)) return { ok: true };
    applyPresentationCheckpointToMessage(message, patch);
    this.data.checkpointKeys = [...this.data.checkpointKeys, key].slice(-4096);
    session.updatedAt = Date.now();
    await this.save();
    return { ok: true };
  }

  async sidebar(): Promise<SidebarOrganizationSnapshot> { await this.load(); return this.data.sidebar; }
  async applySidebar(expectedRevision: number, draft: SidebarOrganizationDraft): Promise<SidebarOrganizationResult> { await this.load(); if (expectedRevision !== this.data.sidebar.revision) return { ok: false, reason: "conflict", snapshot: this.data.sidebar }; this.data.sidebar = { version: 1, revision: expectedRevision + 1, ...draft }; await this.save("sidebar"); return { ok: true, snapshot: this.data.sidebar }; }
  async recentProjects(): Promise<string[]> { await this.load(); return [...this.data.recentProjects]; }

  async getSettings(): Promise<WebSettings> { await this.load(); return this.data.settings; }
  async patchSettings(section: "general" | "config" | "timeout", patch: Record<string, unknown>): Promise<WebSettings> { await this.load(); this.data.settings[section] = { ...this.data.settings[section], ...patch }; await this.save("settings"); return this.data.settings; }
  async setPermissionLevel(level: string): Promise<string> { await this.load(); this.data.settings.permissionLevel = level; await this.save("settings"); return level; }
  async setModelProfiles(profiles: Array<Record<string, unknown>>, defaultModelProfileId?: string): Promise<WebSettings> { await this.load(); this.data.settings.modelProfiles = profiles.map(normalizeWebProfile); if (defaultModelProfileId !== undefined) this.data.settings.defaultModelProfileId = defaultModelProfileId; if (!profiles.some(item => item.id === this.data.settings.defaultModelProfileId)) this.data.settings.defaultModelProfileId = profiles[0]?.id as string | undefined; await this.save("settings"); return this.data.settings; }
}

function normalizeWebProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const transport = profile.explicitTransport;
  if (typeof profile.baseUrl !== "string" || (transport !== "openai" && transport !== "anthropic" && transport !== "responses")) return profile;
  return { ...profile, baseUrl: alignPresetApiBase(profile.baseUrl, transport) };
}
