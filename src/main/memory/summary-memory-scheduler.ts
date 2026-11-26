import path from "node:path";
import fs from "node:fs/promises";
import type { ChatSessionRecord, SummaryMemoryPendingTurn, SummaryMemoryProgress } from "../../shared/chat-types";
import { isSummaryMemoryEnabled } from "./memory-mode";
import { resolveSummaryMemoryPaths } from "./summary-memory-paths";
import { MAX_SUMMARY_SOURCES, readSummaryFile, writeSummaryFileAtomic, type SummaryReadResult } from "./summary-memory-store";
import { summarizeMemory } from "./summary-memory-llm";
import { areSummaryMemorySourcesCurrent, resolveSummaryMemorySources, type SummaryMemoryTurnSource } from "./summary-memory-sources";

export interface SummaryMemoryProgressStore {
  getSessionRecord(id: string): (ChatSessionRecord | null) | Promise<ChatSessionRecord | null>;
  getSummaryMemoryProgress(id: string): (SummaryMemoryProgress | undefined) | Promise<SummaryMemoryProgress | undefined>;
  appendSummaryMemoryTurn(id: string, turn: SummaryMemoryPendingTurn): (boolean) | Promise<boolean>;
  markSummaryMemoryProcessed(id: string, processedTurns: Array<{ assistantEntryId: string }>): (boolean) | Promise<boolean>;
  listSessions(): (Array<{ id: string }>) | Promise<Array<{ id: string }>>;
}

export interface SummaryMemorySchedulerOptions {
  userDataRoot: string;
  sessions: SummaryMemoryProgressStore;
  onError?: (conversationId: string, error: unknown) => void;
  isTurnCurrent?: (conversationId: string, turn: SummaryMemoryPendingTurn) => Promise<boolean>;
  trackSources?: boolean;
}

type QueueMap = Map<string, Promise<unknown>>;

export class SummaryMemoryScheduler {
  private enabled = false;
  private generation = 0;
  private readonly sessionQueues: QueueMap = new Map();
  private readonly workspaceQueues: QueueMap = new Map();
  private readonly abortControllers = new Set<AbortController>();
  private readonly cancelledSessions = new Set<string>();

  constructor(private readonly options: SummaryMemorySchedulerOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (!enabled) {
      for (const controller of this.abortControllers) controller.abort();
      this.abortControllers.clear();
    }
  }

  async scheduleSummaryTurn(input: {
    conversationId: string;
    assistantEntryId: string;
    userTurnId?: string;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled() || this.cancelledSessions.has(input.conversationId) || !input.assistantEntryId) return;
    try {
      if (this.options.isTurnCurrent && !await this.options.isTurnCurrent(input.conversationId, input)) return;
      if (this.options.trackSources && (!input.userTurnId || !(await resolveSummaryMemorySources(this.options.userDataRoot, [{
        conversationId: input.conversationId, userTurnId: input.userTurnId, assistantEntryId: input.assistantEntryId,
      }]))[0])) return;
      const recorded = (await this.options.sessions.appendSummaryMemoryTurn(input.conversationId, {
        assistantEntryId: input.assistantEntryId,
        ...(input.userTurnId ? { userTurnId: input.userTurnId } : {}),
        userText: input.userText,
        assistantText: input.assistantText,
      }));
      if (!recorded) return;
      const progress = (await this.options.sessions.getSummaryMemoryProgress(input.conversationId));
      if ((progress?.pendingTurns.length ?? 0) >= 10) {
        void this.flushSummary(input.conversationId).catch((error) => this.reportError(input.conversationId, error));
      }
    } catch (error) {
      this.reportError(input.conversationId, error);
    }
  }

  flushSummary(conversationId: string): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled() || this.cancelledSessions.has(conversationId)) return Promise.resolve();
    return this.enqueue(this.sessionQueues, conversationId, () => this.flushOne(conversationId));
  }

  async flushAll(): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled()) return;
    await Promise.all((await this.options.sessions.listSessions()).map(({ id }) => (
      this.flushSummary(id).catch((error) => this.reportError(id, error))
    )));
  }

  async cancelSession(conversationId: string): Promise<void> {
    this.cancelledSessions.add(conversationId);
    const active = [...this.abortControllers];
    // Session deletion invalidates the current generation only for this session.
    for (const controller of active) {
      if ((controller as AbortController & { __summarySessionId?: string }).__summarySessionId === conversationId) {
        controller.abort();
        this.abortControllers.delete(controller);
      }
    }
    await this.sessionQueues.get(conversationId)?.catch(() => undefined);
  }

  releaseSessionCancellation(conversationId: string): void {
    this.cancelledSessions.delete(conversationId);
  }

  dispose(): void {
    this.setEnabled(false);
  }

  private async flushOne(conversationId: string): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled() || this.cancelledSessions.has(conversationId)) return;
    const generation = this.generation;
    const session = (await this.options.sessions.getSessionRecord(conversationId));
    if (!session) return;
    const progress = (await this.options.sessions.getSummaryMemoryProgress(conversationId));
    const pending = progress?.pendingTurns ?? [];
    if (pending.length === 0) return;
    const { isTurnCurrent, trackSources, userDataRoot } = this.options;
    const sourceCandidates = trackSources ? await resolveSummaryMemorySources(userDataRoot, pending.map(turn => ({
      conversationId, userTurnId: turn.userTurnId ?? "", assistantEntryId: turn.assistantEntryId,
    }))) : undefined;
    const validity = isTurnCurrent ? await Promise.all(pending.map(turn => isTurnCurrent(conversationId, turn))) : undefined;
    const eligible = pending.flatMap((turn, index) => {
      if (validity?.[index] === false || (trackSources && !sourceCandidates?.[index])) return [];
      return [{ turn, source: sourceCandidates?.[index] }];
    });
    const batch = trackSources ? eligible.slice(-MAX_SUMMARY_SOURCES) : eligible;
    const turns = batch.map(({ turn }) => turn);
    const batchSources = batch.flatMap(({ source }) => source ? [source] : []);
    const processed = pending.map(({ assistantEntryId }) => ({ assistantEntryId }));
    if (turns.length === 0) {
      await this.options.sessions.markSummaryMemoryProcessed(conversationId, processed);
      return;
    }
    const paths = resolveSummaryMemoryPaths({ conversationId, userDataRoot: this.options.userDataRoot, session });
    const workspaceRoot = paths.workspacePath
      ? path.resolve(session.workspaceBinding!.workspaceRoot)
      : path.resolve(this.options.userDataRoot);
    const workspaceKey = paths.workspacePath
      ? await fs.realpath(session.workspaceBinding!.workspaceRoot)
        .then((root) => path.join(root, ".cyrene", "memory", "workspace.md"))
        .catch(() => path.resolve(paths.workspacePath!))
      : `session:${conversationId}`;
    await this.enqueue(this.workspaceQueues, workspaceKey, async () => {
      if (!(await this.isCurrent(conversationId, generation))) return;
      const previous = async (filePath: string, limit: number) => {
        const file = await readSummaryFile(filePath, limit, workspaceRoot);
        const empty: SummaryReadResult = { content: "", truncated: false };
        return file.sources === null || (file.sources && !await areSummaryMemorySourcesCurrent(userDataRoot, file.sources)) ? empty : file;
      };
      const sessionFile = await previous(paths.sessionPath, 800);
      const workspaceFile = paths.workspacePath ? await previous(paths.workspacePath, 1200) : undefined;
      // The model sees both old summaries and can move information between them. Each output inherits
      // all sources. Once the bounded history is full, start from the verified current batch instead.
      const allSources: SummaryMemoryTurnSource[] = [...new Map([
        ...(sessionFile.sources ?? []), ...(workspaceFile?.sources ?? []), ...batchSources,
      ].map(source => [JSON.stringify(source), source])).values()];
      const refresh = trackSources && allSources.length > MAX_SUMMARY_SOURCES;
      const activeSources = refresh ? batchSources : allSources;
      const sessionSummary = refresh ? "" : sessionFile.content;
      const workspaceSummary = refresh ? "" : workspaceFile?.content ?? "";
      const isCurrentTarget = async () => {
        if (isTurnCurrent && !(await Promise.all(turns.map(turn => isTurnCurrent(conversationId, turn)))).every(Boolean)) return false;
        if (!await areSummaryMemorySourcesCurrent(userDataRoot, activeSources)) return false;
        return this.isCurrentTarget(conversationId, generation, paths.sessionPath, paths.workspacePath);
      };
      if (!await isCurrentTarget()) return;
      const controller = new AbortController() as AbortController & { __summarySessionId?: string };
      controller.__summarySessionId = conversationId;
      this.abortControllers.add(controller);
      let result: Awaited<ReturnType<typeof summarizeMemory>>;
      try {
        result = await summarizeMemory({
          sessionSummary,
          workspaceSummary,
          turns: turns.map(({ userText, assistantText }) => ({ userText, assistantText })),
          hasWorkspace: Boolean(paths.workspacePath),
          signal: controller.signal,
        });
      } finally {
        this.abortControllers.delete(controller);
      }
      if (!(await isCurrentTarget())) return;

      // Write the project-level file first. Repeated retries replace complete summaries,
      // so a crash between file writes cannot duplicate source turns in either file.
      if (paths.workspacePath && result.workspaceSummary && result.workspaceSummary !== workspaceSummary) {
        await writeSummaryFileAtomic(paths.workspacePath, result.workspaceSummary, 1200, workspaceRoot, isCurrentTarget,
          trackSources ? activeSources : undefined);
      }
      if (!(await isCurrentTarget())) return;
      if (result.sessionSummary !== sessionSummary) {
        await writeSummaryFileAtomic(paths.sessionPath, result.sessionSummary, 800, workspaceRoot, isCurrentTarget,
          trackSources ? activeSources : undefined);
      }
      if (!(await isCurrentTarget())) return;
      await this.options.sessions.markSummaryMemoryProcessed(conversationId, processed);
    });
  }

  private async isCurrent(conversationId: string, generation: number): Promise<boolean> {
    return this.enabled && isSummaryMemoryEnabled() && generation === this.generation
      && !this.cancelledSessions.has(conversationId)
      && (await this.options.sessions.getSessionRecord(conversationId)) !== null;
  }

  private async isCurrentTarget(
    conversationId: string,
    generation: number,
    expectedSessionPath: string,
    expectedWorkspacePath?: string,
  ): Promise<boolean> {
    if (!(await this.isCurrent(conversationId, generation))) return false;
    const session = (await this.options.sessions.getSessionRecord(conversationId));
    if (!session) return false;
    try {
      const currentPaths = resolveSummaryMemoryPaths({
        conversationId,
        userDataRoot: this.options.userDataRoot,
        session,
      });
      return currentPaths.sessionPath === expectedSessionPath
        && currentPaths.workspacePath === expectedWorkspacePath;
    } catch {
      return false;
    }
  }

  private enqueue<T>(queues: QueueMap, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const cleanup = () => {
      if (queues.get(key) === settled) queues.delete(key);
    };
    // Observe both outcomes on the internal tail while preserving rejection
    // on next for the caller. A finally-only tail would reject unobserved.
    const settled = next.then(cleanup, cleanup);
    queues.set(key, settled);
    return next;
  }

  private reportError(conversationId: string, error: unknown): void {
    this.options.onError?.(conversationId, error);
    if (!this.options.onError) console.warn("[SummaryMemory] background update failed:", conversationId, error);
  }
}

let scheduler: SummaryMemoryScheduler | null = null;

export function initializeSummaryMemoryScheduler(options: SummaryMemorySchedulerOptions): SummaryMemoryScheduler {
  scheduler?.dispose();
  scheduler = new SummaryMemoryScheduler({ trackSources: true, ...options });
  return scheduler;
}

export function enableSummaryMemoryScheduler(enabled: boolean): void {
  scheduler?.setEnabled(enabled);
}

export function scheduleSummaryTurn(input: Parameters<SummaryMemoryScheduler["scheduleSummaryTurn"]>[0]): void {
  scheduler?.scheduleSummaryTurn(input);
}

export function flushSummaryMemory(conversationId: string): Promise<void> {
  return scheduler?.flushSummary(conversationId) ?? Promise.resolve();
}

export function flushAllSummaryMemory(): Promise<void> {
  return scheduler?.flushAll() ?? Promise.resolve();
}

export function cancelSummaryMemorySession(conversationId: string): Promise<void> {
  return scheduler?.cancelSession(conversationId) ?? Promise.resolve();
}

export function releaseSummaryMemorySessionCancellation(conversationId: string): void {
  scheduler?.releaseSessionCancellation(conversationId);
}

export async function disposeSummaryMemoryScheduler(): Promise<void> {
  scheduler?.dispose();
  scheduler = null;
}
