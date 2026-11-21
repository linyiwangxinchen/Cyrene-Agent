import { DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS, type TaskAccessMode, type TaskSession, type TaskSessionStatus, type TaskSubagentType, type TaskTraceRecord } from "../../shared/task-session";
import { TaskSessionStore } from "../tasks/task-session-store";
import { projectTaskTraceEvent } from "./task-events";
import { getTaskAgentProfile, resolveTaskTools, TASK_BUILTIN_TOOL_IDS } from "./task-profiles";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { HarnessInput, HarnessResult } from "./harness/types";
import { getHarnessRunStore } from "./harness/run-store";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { createTranscriptSink } from "./transcript-sink";
import { projectTaskTodoItems, projectTaskTranscriptMessages, projectTaskContinuity } from "./task-transcript-projection";
import { resolveEffectKind, type ToolDefinition } from "./tools/registry/tool-registry";
import type { VendorConfig, ChatMessage } from "./vendors/types";
import type { ToolContext } from "./tools/registry/tool-context";
import { taskCharacterLeasePool, type TaskCharacterLeasePool } from "../tasks/task-character-pool";
import { loadPromptFile } from "../prompts/prompt-loader";
import { loadGeneralSettings } from "../settings/settings-facade";
import { listSavedModelProfiles, loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import type { TaskDelegationPresentation } from "../../shared/task-session";
import type { RunCapabilities } from "./run-capabilities";
import type { PromptLayers } from "./prompt-layers";
import type { ToolOutputStore } from "./harness/tool-output/tool-output-store";
import type { SkillEntry } from "../skills/types";
import { buildSkillCatalog } from "../skills/skill-catalog";
import { ACCESS_LEVEL_LABEL } from "../permission";
import { getFileAccessLevel } from "./tools/file-access";
import {
  describeTaskWorktreeOutcome,
  getTaskWorktreeManager,
  isolateTaskTools,
  TaskIsolationError,
  type TaskIsolation,
  type TaskWorktreeHandle,
  type TaskWorktreeManager,
  type TaskWorktreeOutcome,
  type TaskWorktreeSummary,
} from "./task-worktree";

const TASK_TRACE_CHECKPOINT_INTERVAL_MS = 500;
const TASK_TRACE_LIMIT = 2_000;

function appendTaskTraceRecord(trace: TaskTraceRecord[], next: TaskTraceRecord): void {
  const previous = trace.at(-1);
  const canMergeDelta = (next.kind === "candidate" || next.kind === "reasoning")
    && next.phase === "delta"
    && previous?.kind === next.kind
    && previous.phase === "delta"
    && previous.label === next.label
    && previous.roundId === next.roundId;
  if (canMergeDelta && previous) {
    previous.content = `${previous.content ?? ""}${next.content ?? ""}`;
    previous.at = next.at;
  } else {
    trace.push(next);
  }
  if (trace.length > TASK_TRACE_LIMIT) trace.splice(0, trace.length - TASK_TRACE_LIMIT);
}

export interface TaskExecuteRequest {
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  companionId: string;
  accessMode?: TaskAccessMode;
  maxParallelToolCalls?: number;
  taskId?: string;
  /** worktree：在独立 git worktree 中执行，可与其他子任务并行。 */
  isolation?: TaskIsolation;
}

export interface TaskExecuteResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
  /** isolation=worktree 时的收尾结果；保留时含分支、路径与 diff 摘要。 */
  worktree?: TaskWorktreeOutcome;
  /** 同仓库中其他被保留的子任务 worktree（含上次运行遗留）。 */
  retainedWorktrees?: TaskWorktreeSummary[];
}

export interface TaskCloseRequest {
  companionId: string;
}

export interface TaskCloseResult {
  taskId: string;
  companionId: string;
  status: "closed";
}

export interface TaskRuntimeParentContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  capabilities?: RunCapabilities;
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
  includeInteractiveTools?: boolean;
  permissionMode?: import("./cyrene-agent").CyreneRunOptions["permissionMode"];
  toolOutputStore?: ToolOutputStore;
  /** 子任务 session 增量落库（SQLite transcript）的 userData 根。缺省时子任务不写轨迹（仅测试路径）。 */
  transcriptRoot?: string;
}

function taskStatus(result: HarnessResult): { status: Exclude<TaskSessionStatus, "running" | "interrupted">; error?: { code: string; message: string } } {
  const terminal = result.terminal?.status;
  if (terminal === "cancelled" || result.terminateReason === "cancelled") return { status: "cancelled" };
  if (terminal === "timeout" || result.terminateReason === "timeout") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间上限" } };
  }
  if (terminal === "runtime_error" || result.terminateReason === "error") {
    return { status: "failed", error: { code: "TASK_RUNTIME_ERROR", message: result.finalAnswer || "子任务运行失败" } };
  }
  return { status: "completed" };
}

export function buildChildPromptLayers(
  parent: TaskRuntimeParentContext,
  profilePrompt: string,
  accessMode: TaskAccessMode = "write",
  skills: readonly SkillEntry[] = [],
  worktree?: Pick<TaskWorktreeHandle, "workspaceRoot" | "worktreePath" | "mainWorkspaceRoot" | "branch">,
): PromptLayers {
  const workspaceRoot = worktree?.workspaceRoot ?? parent.resolvedWorkspaceRoot;
  const workspace = workspaceRoot
    ? `可信工作目录：${workspaceRoot}`
    : "当前没有绑定工作目录。";
  const isolationNote = worktree
    ? `本任务在独立 git worktree 中执行：${worktree.worktreePath}（分支 ${worktree.branch}，基于主工作区当前 HEAD）。`
      + `所有读写和命令都在该 worktree 内进行，不能写入主工作区 ${worktree.mainWorkspaceRoot}；不要 git push，不要切换或删除分支。`
      + "可以在 worktree 内提交改动；未提交的改动同样会保留。结束时在结果中说明改了什么，合并由主代理决定。"
    : "";
  return {
    stablePrefix: [
      profilePrompt,
      accessMode === "read_only"
        ? "本任务处于只读模式：只检查和读取信息，不修改文件、仓库或外部状态。你可用的工具也已按只读能力限制。"
        : worktree
          ? "本任务可在主代理当前权限允许的范围内按指令写入，写入范围限定在隔离 worktree 内。"
          : "本任务可在主代理当前权限允许的范围内按指令写入；并行委派时，只读子任务可并行，写入子任务排队串行执行。",
      isolationNote,
      "专用能力由主代理协调；若缺少完成任务所需的工具，请在结果中说明。技能只提供执行指令，实际操作以可用工具和权限为准。",
      buildSkillCatalog(skills.map((skill) => ({ ...skill, manifest: undefined,
        description: skill.description.split(/\r?\n/)[0].slice(0, 240) }))),
    ].filter(Boolean).join("\n\n"),
    sessionPrefix: `${workspace}\n会话模式：${parent.mode}\n当前文件权限：${ACCESS_LEVEL_LABEL[getFileAccessLevel(parent)]}。`
      + "工作目录用于解析相对路径；绝对路径能否访问由主代理当前权限决定。仅项目只读限制在工作区内，普通只读可读取外部路径，审批档位按操作审批，完全访问允许外部读写。执行时跟随最新权限。",
    mode: parent.mode,
  };
}

function stripCharacterPromptFrontmatter(prompt: string): string {
  return prompt.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
}

function buildCharacterTaskPrompt(companionId: string): string {
  const personaEnabled = loadGeneralSettings().taskCharacterPersonaEnabled;
  const taskSystem = personaEnabled
    ? loadPromptFile("task/task_system.md")
    : loadPromptFile("task/task_system_nonesoul.md");
  const character = personaEnabled
    ? stripCharacterPromptFrontmatter(loadPromptFile(`task/${companionId}.md`))
    : "";
  const taskSystemPath = personaEnabled ? "task/task_system.md" : "task/task_system_nonesoul.md";
  if (!taskSystem) console.warn(`[TaskRuntime] Missing task system prompt: prompts/${taskSystemPath}`);
  if (personaEnabled && !character) console.warn(`[TaskRuntime] Missing character task prompt: prompts/task/${companionId}.md`);
  return [taskSystem, character].filter(Boolean).join("\n\n");
}

function resolveTaskModel(parentVendorConfig: VendorConfig): {
  vendorConfig: VendorConfig;
  contextWindowTokens?: number;
} {
  const settings = loadGeneralSettings();
  const profileId = settings.taskModelProfileId;
  const model = settings.taskModel;
  if (!profileId || !model) return { vendorConfig: parentVendorConfig };

  const modelSettings = loadModelSettings();
  const profile = listSavedModelProfiles(modelSettings).find((candidate) => candidate.id === profileId);
  if (!profile) return { vendorConfig: parentVendorConfig };
  const availableModels = profile.models?.length ? profile.models : [profile.model];
  if (!availableModels.includes(model)) return { vendorConfig: parentVendorConfig };

  const expanded = resolveModelSettingsProfile(modelSettings, profileId);
  const modelOption = profile.modelOptions?.[model];
  return {
    vendorConfig: {
      ...parentVendorConfig,
      provider: expanded.provider,
      baseUrl: expanded.baseUrl,
      model,
      apiKey: expanded.apiKey,
      explicitTransport: expanded.explicitTransport,
      responsesNative: expanded.responsesNative,
      reasoning: expanded.reasoning,
      manualReasoning: modelOption?.manualReasoning,
    },
    contextWindowTokens: modelOption?.contextWindowTokens
      ?? profile.contextWindowTokens
      ?? modelSettings.contextWindowTokens,
  };
}

export function createTaskExecutor(input: {
  parent: TaskRuntimeParentContext;
  store: TaskSessionStore;
  runHarness?: typeof runCyreneHarness;
  characterPool?: Pick<TaskCharacterLeasePool, "acquire">;
  onLifecycle?: (event: TaskDelegationPresentation) => void;
  worktrees?: Pick<TaskWorktreeManager, "resolveRepository" | "acquire" | "finalize">;
}): (request: TaskExecuteRequest) => Promise<TaskExecuteResult> {
  const runHarness = input.runHarness ?? runCyreneHarness;
  const characterPool = input.characterPool ?? taskCharacterLeasePool;
  const worktrees = input.worktrees ?? getTaskWorktreeManager();
  // session 增量落库的 facade：transcript 管对话事实，runs 管 run 生命周期。
  // conversationId 用稳定的 session.id，runId 用每次 resume 换新的 childRunId——
  // 与主 agent 的 conversationId/runId 模型同构，复用同一套表与幂等约束。
  const transcript = input.parent.transcriptRoot
    ? {
        store: getConversationTranscriptStore(input.parent.transcriptRoot),
        runs: getHarnessRunStore(input.parent.transcriptRoot),
      }
    : undefined;
  return async (request) => {
    // 每次调用独立：隔离子任务会并行，且创建 worktree 前有 await，闭包共享会串台。
    let transcriptHistory: ReturnType<typeof projectTaskTranscriptMessages> | undefined;
    let transcriptTodoItems: ReturnType<typeof projectTaskTodoItems> | undefined;
    let transcriptContinuity: ReturnType<typeof projectTaskContinuity>;
    const profile = getTaskAgentProfile(request.subagentType);
    // 隔离前置校验在建 session 之前：非 git 工作区直接报错，不留下空任务记录。
    if (request.isolation === "worktree") await worktrees.resolveRepository(input.parent.resolvedWorkspaceRoot);
    const lease = characterPool.acquire(input.parent.parentConversationId, request.companionId);
    let session: TaskSession;
    try {
      const previous = request.taskId
        ? null
        : await input.store.findOpenByCompanion(input.parent.parentConversationId, request.companionId);
      const taskId = request.taskId ?? previous?.id;
      session = taskId
        ? await input.store.resume(taskId, {
            parentConversationId: input.parent.parentConversationId,
            parentRunId: input.parent.parentRunId,
            subagentType: request.subagentType,
            prompt: request.prompt,
            companionId: request.companionId,
          })
        : await input.store.create({
            parentConversationId: input.parent.parentConversationId,
            parentRunId: input.parent.parentRunId,
            description: request.description,
            prompt: request.prompt,
            subagentType: request.subagentType,
            companionId: request.companionId,
            mode: input.parent.mode,
            resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
          });
      if (transcript) {
        // run 记录先行：崩溃在对账时标记 interrupted（fail-closed），
        // user 条目随后；两步间的崩溃窗口只会留下孤儿 prompt 条目，可接受。
        await transcript.runs.create({ conversationId: session.id, runId: session.childRunId });
        await transcript.store.append(session.id, {
          id: `${session.childRunId}:prompt`,
          kind: "user",
          at: Date.now(),
          runId: session.childRunId,
          turnId: `${session.childRunId}:prompt`,
          revision: 1,
          payload: { text: request.prompt },
        });
        // 对话历史以 transcript 为唯一来源：checkpoint 全量快照退役后，
        // resume 的 harness 输入靠重投影（含当前 prompt，它刚追加为最后一个 user 条目）。
        const snapshot = await transcript.store.read(session.id);
        transcriptHistory = projectTaskTranscriptMessages(snapshot.entries);
        transcriptTodoItems = projectTaskTodoItems(snapshot.entries);
        transcriptContinuity = projectTaskContinuity(snapshot.entries);
      }
    } catch (error) {
      lease.release();
      throw error;
    }

    let worktree: TaskWorktreeHandle | undefined;
    if (request.isolation === "worktree") {
      try {
        worktree = await worktrees.acquire({ workspaceRoot: input.parent.resolvedWorkspaceRoot, taskId: session.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await transcript?.runs.markTerminal(session.childRunId, "failed");
          await input.store.checkpoint(session.id, { status: "failed", error: { code: "TASK_WORKTREE_FAILED", message }, completedAt: Date.now() });
        } catch (checkpointError) {
          console.error("[TaskRuntime] worktree 创建失败后的终态记录失败:", checkpointError);
        } finally {
          lease.release();
        }
        throw error instanceof TaskIsolationError ? error : new TaskIsolationError("TASK_WORKTREE_FAILED", message);
      }
    }
    // 收尾只做一次；失败时绝不删除，一律按保留处理。
    let worktreeOutcome: TaskWorktreeOutcome | undefined;
    const finalizeWorktree = async (): Promise<TaskWorktreeOutcome | undefined> => {
      if (!worktree || worktreeOutcome) return worktreeOutcome;
      try {
        worktreeOutcome = await worktrees.finalize(worktree);
      } catch (finalizeError) {
        console.error("[TaskRuntime] worktree 收尾失败，已保留:", finalizeError);
        worktreeOutcome = { kind: "retained", branch: worktree.branch, worktreePath: worktree.worktreePath, baseCommit: worktree.baseCommit,
          commitsAhead: 0, uncommitted: false, diffStat: "", changedFiles: [], untrackedFiles: [],
          note: `收尾检查失败，worktree 已保留：${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}` };
      }
      return worktreeOutcome;
    };

    const accessMode = request.accessMode ?? "write";
    const resolvedTaskTools = resolveTaskTools(profile, input.parent.tools, accessMode);
    const taskTools = worktree ? isolateTaskTools(resolvedTaskTools, worktree) : resolvedTaskTools;
    const taskToolIds = new Set(taskTools.map((tool) => tool.id));
    const taskSkills = taskToolIds.has("invoke_skill")
      ? (input.parent.capabilities?.skills ?? []).filter((skill) => skill.enabled
        && (!input.parent.capabilities || input.parent.capabilities.skillIds.has(skill.id))
        && (skill.tools ?? []).every((toolId) => taskToolIds.has(toolId)))
      : [];
    const toolContext: ToolContext = {
      userQuery: request.prompt,
      conversationId: session.id,
      runId: session.childRunId,
      signal: input.parent.signal,
      resolvedWorkspaceRoot: worktree?.workspaceRoot ?? input.parent.resolvedWorkspaceRoot,
      ...(worktree ? { writeRoot: worktree.worktreePath } : {}),
      mode: input.parent.mode,
      allowedSkillIds: new Set(taskSkills.map((skill) => skill.id)),
      permissionMode: input.parent.permissionMode,
      allowUserInteraction: false,
      readOnly: accessMode === "read_only",
    };

    const presentation = {
      invocationId: session.childRunId,
      taskId: session.id,
      description: request.description,
      nickname: lease.nickname,
      assetFileName: lease.assetFileName,
    };
    let taskTrace = session.trace;
    let pendingTaskTrace: TaskTraceRecord[] = [];
    let taskTraceDirty = false;
    let taskTraceFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushTaskTrace = async (): Promise<void> => {
      if (taskTraceFlushTimer !== undefined) {
        clearTimeout(taskTraceFlushTimer);
        taskTraceFlushTimer = undefined;
      }
      for (const record of pendingTaskTrace) appendTaskTraceRecord(taskTrace, record);
      if (pendingTaskTrace.length > 0) {
        pendingTaskTrace = [];
        taskTraceDirty = true;
      }
      if (!taskTraceDirty) return;
      await input.store.checkpoint(session.id, { trace: taskTrace });
      taskTraceDirty = false;
    };
    const scheduleTaskTraceFlush = () => {
      if (taskTraceFlushTimer !== undefined) return;
      taskTraceFlushTimer = setTimeout(() => {
        taskTraceFlushTimer = undefined;
        // Retain the dirty in-memory trace; the next batch or terminal flush retries it.
        void flushTaskTrace().catch((error) => console.error("[TaskRuntime] trace checkpoint failed", error));
      }, TASK_TRACE_CHECKPOINT_INTERVAL_MS);
    };
    input.onLifecycle?.({ ...presentation, status: "running" });

    try {
      const combinedTaskPrompt = buildCharacterTaskPrompt(request.companionId);
      const promptLayers = buildChildPromptLayers(input.parent, combinedTaskPrompt, accessMode, taskSkills, worktree);
      const taskModel = resolveTaskModel(input.parent.vendorConfig);
      let activeRoundId: string | undefined;
      // entryId 由 (runId, 协议点) 确定性生成：resume 产生新 childRunId，重试不会写重复条目。
      const transcriptSink = transcript
        ? createTranscriptSink({
            store: transcript.store,
            conversationId: session.id,
            runId: session.childRunId,
            assistantTurnId: `${session.childRunId}:assistant`,
          })
        : undefined;
      const result = await runHarness({
        runId: session.childRunId,
        assistantTurnId: `${session.childRunId}:assistant`,
        systemPrompt: promptLayers.stablePrefix,
        promptLayers,
        messages: (transcriptHistory ?? session.messages) as ChatMessage[],
        tools: taskTools,
        vendorConfig: taskModel.vendorConfig,
        config: {
          totalTimeoutMs: profile.timeoutMs,
          maxParallelToolCalls: request.maxParallelToolCalls ?? DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS,
          ...(taskModel.contextWindowTokens ? { contextWindowTokens: taskModel.contextWindowTokens } : {}),
        },
        initialState: {
          todoItems: transcriptTodoItems ?? session.todoItems,
          ...(transcriptContinuity ? { continuity: transcriptContinuity } : {}),
          uncertainEffects: [],
        },
        ...(transcriptSink ? { transcriptSink } : {}),
        signal: input.parent.signal,
        toolContext,
        toolOutputStore: input.parent.toolOutputStore,
        checkPermission: async (toolId, args) => {
          const tool = taskTools.find((candidate) => candidate.id === toolId);
          if (!tool || (accessMode === "read_only" && resolveEffectKind(tool, args) !== "read")) return false;
          return input.parent.checkPermission ? input.parent.checkPermission(toolId, args) : true;
        },
        includeInteractiveTools: false,
        allowedBuiltinToolIds: TASK_BUILTIN_TOOL_IDS,
        onEvent: (event) => {
          if (event.type === "round_start") activeRoundId = event.roundId;
          const trace = projectTaskTraceEvent(event);
          if (trace) {
            trace.runId = session.childRunId;
            if (event.type !== "round_start" && event.type !== "round_end" && activeRoundId) {
              trace.roundId = activeRoundId;
            }
            pendingTaskTrace.push(trace);
            scheduleTaskTraceFlush();
          }
          if (event.type === "round_end") activeRoundId = undefined;
        },
      });
      await flushTaskTrace();
      const mapped = taskStatus(result);
      // run 生命周期是元数据不是权威事实（权威在 transcript）；落库失败只记录，不改变任务结果。
      try {
        await transcript?.runs.markTerminal(session.childRunId, mapped.status === "completed" ? "completed" : "failed");
      } catch (terminalError) {
        console.error("[TaskRuntime] run terminal 记录失败:", terminalError);
      }
      const outcome = await finalizeWorktree();
      const resultText = outcome ? `${result.finalAnswer}

${describeTaskWorktreeOutcome(outcome)}` : result.finalAnswer;
      await input.store.checkpoint(session.id, {
        status: mapped.status,
        resultText,
        todoItems: result.finalState.todoItems,
        ...(mapped.error ? { error: mapped.error } : {}),
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: mapped.status });
      return {
        taskId: session.id,
        status: mapped.status,
        text: result.finalAnswer,
        ...(outcome ? { worktree: outcome } : {}),
        ...(worktree?.retainedWorktrees.length ? { retainedWorktrees: worktree.retainedWorktrees } : {}),
      };
    } catch (error) {
      try {
        await flushTaskTrace();
      } catch (traceError) {
        console.error("[TaskRuntime] final trace checkpoint failed", traceError);
      }
      const outcome = await finalizeWorktree();
      const baseMessage = error instanceof Error ? error.message : String(error);
      const message = outcome?.kind === "retained" ? `${baseMessage}
${describeTaskWorktreeOutcome(outcome)}` : baseMessage;
      try {
        // 终态必须落库：run 行滞留 running 会触发 one_active 唯一索引，阻塞该任务的下次 resume。
        await transcript?.runs.markTerminal(session.childRunId, input.parent.signal?.aborted ? "cancelled" : "failed");
      } catch (terminalError) {
        console.error("[TaskRuntime] run terminal 记录失败（任务已失败）:", terminalError);
      }
      await input.store.checkpoint(session.id, {
        status: input.parent.signal?.aborted ? "cancelled" : "failed",
        error: { code: input.parent.signal?.aborted ? "TASK_CANCELLED" : "TASK_RUNTIME_ERROR", message },
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: input.parent.signal?.aborted ? "cancelled" : "failed" });
      // 改动保留时让主代理在错误里看到分支与路径，避免“失败即丢弃”的误解。
      if (outcome?.kind === "retained" && error instanceof Error) {
        try {
          error.message = message;
        } catch {
          // DOMException 等只读 message：worktree 清单仍会在下次隔离任务中列出。
        }
      }
      throw error;
    } finally {
      if (taskTraceFlushTimer !== undefined) clearTimeout(taskTraceFlushTimer);
      lease.release();
    }
  };
}

export function createTaskCloser(input: {
  store: TaskSessionStore;
  parentConversationId: string;
}): (request: TaskCloseRequest) => Promise<TaskCloseResult> {
  return async ({ companionId }) => {
    const session = await input.store.closeByCompanion(input.parentConversationId, companionId);
    return { taskId: session.id, companionId, status: "closed" };
  };
}
