import type {
  PluginAgentEvent,
  PluginAgentRunOptions,
  PluginAgentRunResult,
  PluginTool,
} from "../plugins/api";
import type { AgentRuntime } from "./orchestrator/agent-runtime";
import { runCyreneHarness } from "./orchestrator/harness/cyrene-harness";
import { mapTerminateReasonToTerminal } from "./orchestrator/harness/adapter/terminal-mapper";
import { buildHarnessPromptLayers } from "./orchestrator/harness/adapter/prompt-builder";
import { FileToolOutputStore } from "./orchestrator/harness/tool-output/file-tool-output-store";
import type { HarnessEvent } from "./orchestrator/harness/types";
import { ExecutionLedgerStore } from "./orchestrator/execution-ledger";
import { buildToolSystemPrompt } from "./orchestrator/system-prompt-builder";
import type { ToolDefinition } from "./orchestrator/tools/registry/tool-registry";
import type { ConversationJournalService } from "./orchestrator/conversation-journal-service";

const DEFAULT_MAX_ROUNDS = 50;
const DEFAULT_MAX_WALL_MS = 15 * 60_000;
const MAX_RUN_ID_LENGTH = 128;
const MAX_PURPOSE_LENGTH = 80;
const executionLedgers = new ExecutionLedgerStore();

export interface PluginAgentRunnerDeps {
  pluginId: string;
  pluginSignal: AbortSignal;
  userDataPath: string;
  agentRuntime: Pick<AgentRuntime, "buildOptions">;
  runHarness?: typeof runCyreneHarness;
  executionLedgers?: Pick<ExecutionLedgerStore, "forScope">;
  /** 测试替身入口；生产缺省使用 AbortSignal.timeout。 */
  createDeadline?: (maxWallMs: number) => AbortSignal;
  journal?: Pick<ConversationJournalService, "appendUser" | "buildModelContext" | "createRunSink">;
}

type AbortSource = "external" | "plugin" | "deadline";

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  if (normalized.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符`);
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, field: string, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${field} 必须是 1-${max} 的整数`);
  }
  return resolved;
}

function diagnosticLabel(pluginId: string, purpose: string | undefined): string {
  const value = purpose === undefined
    ? "goal"
    : requireText(purpose, "purpose", MAX_PURPOSE_LENGTH);
  const normalized = value.replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return `plugin:${pluginId}:${normalized || "goal"}`;
}

function validateAndMapTools(pluginId: string, input: ReadonlyArray<PluginTool>): ToolDefinition[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("tools 必须是非空数组");
  }
  const expectedPrefix = `${pluginId}_`;
  const ids = new Set<string>();
  const frozenTools = Object.freeze([...input]);
  return frozenTools.map((tool) => {
    if (!tool || typeof tool !== "object") throw new Error("tools 含有无效工具");
    if (!tool.id.startsWith(expectedPrefix)) {
      throw new Error(`目标工具 id 必须以 ${expectedPrefix} 开头: ${tool.id}`);
    }
    if (ids.has(tool.id)) throw new Error(`目标工具 id 重复: ${tool.id}`);
    ids.add(tool.id);
    if (tool.enabled !== true) throw new Error(`目标工具必须启用: ${tool.id}`);
    if (tool.inputSchema?.type !== "object" || !tool.inputSchema.properties || typeof tool.inputSchema.properties !== "object") {
      throw new Error(`目标工具 inputSchema 必须是带 properties 的 object: ${tool.id}`);
    }
    if (!tool.effectKind || tool.effectKind === "unknown") {
      throw new Error(`目标工具必须显式声明非 unknown 的 effectKind: ${tool.id}`);
    }
    if (typeof tool.execute !== "function") throw new Error(`目标工具 execute 必须是函数: ${tool.id}`);

    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      ...(tool.catalogHint ? { catalogHint: tool.catalogHint } : {}),
      ...(tool.category ? { category: tool.category } : {}),
      ...(tool.capability ? { capability: tool.capability } : {}),
      enabled: true,
      ...(tool.risk ? { risk: tool.risk } : {}),
      ...(tool.modes ? { modes: [...tool.modes] } : {}),
      inputSchema: {
        type: "object",
        properties: tool.inputSchema.properties,
        ...(tool.inputSchema.required ? { required: [...tool.inputSchema.required] } : {}),
      },
      ...(tool.needsContext ? { needsContext: true } : {}),
      ...(tool.ledgerPolicy ? { ledgerPolicy: tool.ledgerPolicy } : {}),
      ...(tool.deprecated ? { deprecated: true } : {}),
      effectKind: tool.effectKind,
      ...(tool.verificationPolicy ? { verificationPolicy: tool.verificationPolicy } : {}),
      execute: tool.execute,
    };
  });
}

function emitEvent(listener: PluginAgentRunOptions["onEvent"], event: PluginAgentEvent): void {
  try {
    listener?.(event);
  } catch (error) {
    console.warn("[plugin-agent] 插件进度回调失败，已忽略", error);
  }
}

function projectEvent(
  listener: PluginAgentRunOptions["onEvent"],
  event: HarnessEvent,
  toolNames: Map<string, string>,
): void {
  if (event.type === "round_start") {
    const round = Number(event.roundId.replace(/^round-/, ""));
    emitEvent(listener, { kind: "round_started", round: Number.isFinite(round) ? round + 1 : 0 });
  } else if (event.type === "tool_start") {
    toolNames.set(event.toolCallId, event.toolName);
    emitEvent(listener, { kind: "tool_started", toolName: event.toolName });
  } else if (event.type === "tool_end") {
    const toolName = toolNames.get(event.toolCallId) ?? "unknown";
    toolNames.delete(event.toolCallId);
    emitEvent(listener, { kind: "tool_finished", toolName, ok: event.outcome === "success" });
  }
}

function combineSignals(input: {
  external?: AbortSignal;
  plugin: AbortSignal;
  deadline: AbortSignal;
}): { signal: AbortSignal; firstAbortSource: () => AbortSource | undefined } {
  let first: AbortSource | undefined;
  const sources: Array<readonly [AbortSource, AbortSignal]> = [];
  if (input.external) sources.push(["external", input.external]);
  sources.push(["plugin", input.plugin], ["deadline", input.deadline]);
  for (const [source, signal] of sources) {
    const mark = () => { first ??= source; };
    if (signal.aborted) mark();
    else signal.addEventListener("abort", mark, { once: true });
  }
  return {
    signal: AbortSignal.any(sources.map(([, signal]) => signal)),
    firstAbortSource: () => first,
  };
}

/**
 * 为单个插件创建无头目标运行入口。服务实例由 host-services 按插件绑定，
 * 因而插件不可伪造 pluginId，也不需要新增 manifest capability。
 */
export function createPluginAgentRunner(deps: PluginAgentRunnerDeps): NonNullable<import("../plugins/api").PluginLlmService["runGoal"]> {
  const runHarness = deps.runHarness ?? runCyreneHarness;
  const ledgers = deps.executionLedgers ?? executionLedgers;

  return async (options) => {
    const runId = requireText(options.runId, "runId", MAX_RUN_ID_LENGTH);
    const goal = requireText(options.goal, "goal", 8_000);
    const mode = options.personaMode ?? "work";
    if (mode !== "chat" && mode !== "work") throw new Error("personaMode 必须为 chat 或 work");
    if (options.context !== undefined && (typeof options.context !== "string" || options.context.length > 64_000)) {
      throw new Error("context 必须是最多 64000 字符的文本");
    }
    if (options.modelProfileId !== undefined) requireText(options.modelProfileId, "modelProfileId", 128);
    const maxRounds = positiveInteger(options.maxRounds, DEFAULT_MAX_ROUNDS, "maxRounds", 1_000);
    const maxWallMs = positiveInteger(options.maxWallMs, DEFAULT_MAX_WALL_MS, "maxWallMs", 24 * 60 * 60_000);
    const tools = validateAndMapTools(deps.pluginId, options.tools);
    const label = diagnosticLabel(deps.pluginId, options.purpose);

    const deadline = deps.createDeadline?.(maxWallMs) ?? AbortSignal.timeout(maxWallMs);
    const signals = combineSignals({ external: options.signal, plugin: deps.pluginSignal, deadline });
    const conversationId = deps.journal && deps.pluginId !== "minecraft-bot"
      ? `plugin:${deps.pluginId}:${runId}` : `plugin:${deps.pluginId}`;
    if (deps.journal) {
      signals.signal.throwIfAborted();
      await deps.journal.appendUser(conversationId, { turnId: `plugin:${runId}`, runId, text: goal });
    }
    const built = await deps.agentRuntime.buildOptions({
      sessionId: conversationId,
      ...(deps.journal ? { modelContext: await deps.journal.buildModelContext(conversationId) } : {}),
      workspaceBindingSessionId: null,
      executionMode: mode,
      mode,
      promptSource: "plugin-agent",
      promptChannel: deps.pluginId === "minecraft-bot" ? "minecraft" : `plugin:${deps.pluginId}`,
      ...(options.modelProfileId ? { modelProfileId: options.modelProfileId } : {}),
      currentUser: { turnId: `plugin:${runId}`, text: goal, visibleContent: goal },
    });
    const toolSystemContent = buildToolSystemPrompt(mode, tools);
    const promptLayers = buildHarnessPromptLayers({
      ...built.options,
      conversationMode: mode,
      soulRuntimeContext: [built.options.soulRuntimeContext, options.context].filter(Boolean).join("\n\n"),
      toolSystemContent,
      tools,
    });

    const toolNames = new Map<string, string>();
    let usage: PluginAgentRunResult["usage"];
    console.info("[plugin-agent] 无头任务开始", { label, runId });
    const result = await runHarness({
      systemPrompt: promptLayers.stablePrefix,
      promptLayers,
      usageParts: promptLayers.usageParts,
      messages: built.options.messages,
      runId,
      tools,
      ...(deps.journal ? { transcriptSink: deps.journal.createRunSink({ conversationId, runId }) } : {}),
      vendorConfig: {
        provider: built.options.settings.provider,
        baseUrl: built.options.settings.baseUrl,
        model: built.options.settings.model,
        apiKey: built.options.settings.apiKey,
        explicitTransport: built.options.settings.explicitTransport,
        reasoning: built.options.settings.reasoning,
        manualReasoning: built.options.settings.manualReasoning,
      },
      config: {
        maxRounds,
        maxParallelToolCalls: 1,
        totalTimeoutMs: maxWallMs,
        contextWindowTokens: built.options.settings.contextWindowTokens,
      },
      signal: signals.signal,
      onEvent: (event) => projectEvent(options.onEvent, event, toolNames),
      onModelUsage: (reported) => {
        usage ??= { input: 0, output: 0, cachedInput: 0 };
        usage.input += reported.input;
        usage.output += reported.output;
        usage.cachedInput += reported.cachedInput ?? 0;
      },
      includeInteractiveTools: false,
      planState: undefined,
      taskExecutor: undefined,
      checkPermission: async (toolId, args) => {
        if (signals.signal.aborted) return false;
        try { return options.checkTool ? await options.checkTool(toolId, args) : true; }
        catch { return false; }
      },
      toolContext: {
        userQuery: goal,
        conversationId,
        runId,
        signal: signals.signal,
        mode,
        permissionMode: "allow_all",
        metadata: { pluginAgentDiagnosticLabel: label },
      },
      toolOutputStore: new FileToolOutputStore(deps.userDataPath),
      executionLedger: ledgers.forScope(runId),
    });

    const terminal = signals.firstAbortSource() === "deadline"
      ? { status: "timeout" as const, reason: "timeout", externalEffectsMayContinue: true }
      : result.terminal ?? mapTerminateReasonToTerminal(
        result.terminateReason,
        result.finalState.uncertainEffects.length > 0,
      );
    console.info("[plugin-agent] 无头任务结束", { label, runId, status: terminal.status });
    return { text: result.finalAnswer, terminal, rounds: result.rounds, ...(usage ? { usage } : {}) } as PluginAgentRunResult;
  };
}
