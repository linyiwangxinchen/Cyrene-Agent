import { affectPresentation } from "../character-packs/xilian-pack";
import { app } from "electron";
import path from "node:path";
import { InitiativeOpportunityStore } from "../proactive/initiative-opportunities";
import { isMemoryFollowupAtomOpen, MEMORY_FOLLOWUP_SOURCE } from "../proactive/memory-initiative";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { ScheduledTask } from "../scheduler/types";
import type { ChannelId } from "../channels/types";
import type { ModelSettings } from "../settings/model-settings";
import type { GeneralSettings } from "../settings/general-settings";
import type { UserProfile } from "../settings-store";
import { resolveCaptionVisionConfig } from "./image-router";
import { getTimeoutSettings } from "../timeout-manager";
import { resolveModelSettingsProfile } from "../settings/model-settings";
import { normalizeChatMessages } from "../chat-api-utils";
import { parseObserverFeeling } from "../chat-stream-utils";
import { captionImageSafe, IMAGE_CAPTION_PROMPT } from "../chat/image-caption";
import { buildEnvironmentContext } from "./environment";
import { buildToneInjection } from "./tone-injector";
import { buildAlwaysOnContext, buildVectorMemoryContext, scheduleMemoryWrite } from "./index";
import { buildMemoryCompatibilityContext } from "../memory/memory-compatibility-context";
import { filterActiveSocialAtoms } from "../memory/memory-owner-recall";
import { getMemoryModeVersion, isPersonalMemoryEnabled, normalizeMemoryMode } from "../memory/memory-mode";
import { isOwnerMemoryScope, resolvePersonalMemoryScope } from "../memory/memory-scope";
import { scheduleSummaryTurn } from "../memory/summary-memory-scheduler";
import { scheduleWikiTurn } from "../memory/wiki-memory-scheduler";
import { matchSticker } from "../sticker-text-matcher";
import type { StickerTextEntry } from "../sticker-text-matcher";
import { buildRelationshipContext, recordRelationshipTurn, getRelationshipStore, type CompanionFeedbackInput } from "../relationship/relationship-log";
import { buildPersonMemoryContext, socialAtomDisplayText } from "../social-context/context";
import { listXilianReferenceImages } from "../persona/xilian-reference-images";
import { buildSelfieOfferHint, getSharedSelfieLog, normalizeSelfieFrequency, relationshipAllowsSelfie } from "../persona/xilian-selfie-moments";
import * as momentsStore from "../moments/moments-store";
import { momentsService } from "../moments/moments-service";
import { buildMomentsContextBlock } from "../moments/moments-context";
import {
  buildSkillCatalog,
  buildAutoInjectedSkillContext,
  buildAutoInjectedSoulContext,
  skillRegistry,
  getUserCommandsDirectory,
} from "../skills";
import { feelingToExpression } from "../runtime-state";
import { resolveSlashActivation } from "../skills/slash-activation";
import { expandLatestUserCommand } from "../skills/file-commands";
import type { CitaService } from "../cita";
import type { SocialAtom, SocialExtractionInput } from "../social-context/types";
import type { ToolDefinition, ToolModeOverrides } from "./tools/registry/tool-registry";
import type { ConversationMode } from "../../shared/chat-types";
import type { CompanionReference } from "../../shared/companion-references";
import type { XilianTimelineEvent } from "../../shared/xilian-world";
import {
  buildAgentRunOptions,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
  type BuildOptionsInput,
  type ModelSettingsLite,
} from "./build-options";
import { buildModelContext } from "./conversation-transcript-context";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { resolveChatContextTimezone } from "../chat-time-context";
import { buildXilianLifeSnapshot, buildXilianPromptFingerprint, buildXilianSelfiePrompt, formatXilianLifeContext, isXilianSelfieRequest, type XilianLifeContextInput } from "../xilian-world/life-context";
import { getSharedXilianWorldStore } from "../xilian-world/world-store";
import { createGeneratedImageStore } from "../chats/generated-image-store";
import { getHarnessRunStore } from "./harness/run-store";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import { type CyreneRunResult, type CyreneRunOptions } from "./cyrene-agent";
import type { HarnessToolFinishedEvent } from "./harness/types";
import type { ToolFinishedInput } from "../plugin-host/lifecycle-publisher";
import {
  buildToolSystemPrompt,
  buildSoulSystemBasePrompt,
  readStylePrompt,
  resolveSoulSamplingForStyle,
  loadSoulFeelingContext,
} from "./system-prompt-builder";
import { buildModePrompt } from "./mode-prompt-profile";
import { resolveRunCapabilities } from "./run-capabilities";
import { loadStickerSettings } from "./sticker-settings";
import type { RuntimeStateService } from "./runtime-state-service";
import type { LlmClient } from "../services/llm/llm-client";
import type {
  PluginTurnCompletedEvent,
  PluginPromptBuildInput,
  PluginPromptMode,
} from "../../plugins/types";

type EnqueueLLMTask = <T>(
  label: string,
  task: () => Promise<T>,
  options?: { log?: boolean; retryRateLimit?: boolean },
) => Promise<T>;

export interface AgentRuntimeDeps {
  waitForPromptSkills?(signal?: AbortSignal): Promise<void>;
  waitForStartup?(mode: PluginPromptMode, toolIds?: readonly string[], signal?: AbortSignal): Promise<void>;
  runtimeStateService: RuntimeStateService;
  llmClient: LlmClient;
  enqueueLLMTask: EnqueueLLMTask;
  loadModelSettings: () => ModelSettings;
  loadGeneralSettings: () => GeneralSettings;
  loadUserProfile: () => UserProfile;
  toolRegistry: {
    getEnabledTools: () => ToolDefinition[];
    getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) => ToolDefinition[];
  };
  skillRegistry: typeof skillRegistry;
  getStickerTextIndex: () => readonly StickerTextEntry[];
  broadcastRuntimeStateChanged: () => void;
  citaService: CitaService;
  socialContextScheduler: { schedule: (input: SocialExtractionInput) => void | Promise<void> };
  chatsStore: { getWorkspaceBinding: (conversationId: string) => ({ workspaceRoot: string; displayName: string; boundAt: number } | undefined) | Promise<{ workspaceRoot: string; displayName: string; boundAt: number } | undefined> };
  socialAtomStore: { listActive: (conversationId: string, now: number, memoryScope?: string) => SocialAtom[] };
  buildSummaryMemoryContext?: BuildOptionsDeps["buildSummaryMemoryContext"];
  scheduleSummaryTurn?: (input: Parameters<typeof scheduleSummaryTurn>[0]) => void;
  scheduleWikiTurn?: (input: Parameters<typeof scheduleWikiTurn>[0]) => void;
  buildPluginPromptContext: (input: PluginPromptBuildInput, speechScope?: string) => Promise<string>;
  publishPluginHostEvent: <T>(event: string, payload: T) => Promise<void>;
  /** 工具完成事件发布入口；缺省不发布（早期装配与测试场景）。 */
  publishToolFinished?: (event: ToolFinishedInput) => void;
  /** Composition-root-owned singleton shared with manual CHATS_COMPACT. */
  transcriptCompactor?: ConversationTranscriptCompactor;
}

type SchedulerRunOptions = Omit<CyreneRunOptions, "toolSystemContent" | "soulSystemBaseContent">;

function publicLifeSnapshotInput(
  state: XilianLifeContextInput["state"],
  timeline: XilianLifeContextInput["timeline"],
  now: number,
  timezone: string,
): XilianLifeContextInput {
  const isPublic = (event?: XilianTimelineEvent): event is XilianTimelineEvent =>
    !!event && event.source === "simulated_world" && event.visibility !== "private" && event.slotId !== "amphoreus";
  return {
    state: {
      ...state,
      currentActivity: isPublic(state.currentActivity) ? state.currentActivity : undefined,
      nextPlannedEvent: isPublic(state.nextPlannedEvent) ? state.nextPlannedEvent : undefined,
    },
    timeline: timeline.filter(isPublic),
    now,
    timezone,
  };
}

export interface AgentRunFinishedContext {
  source: PluginTurnCompletedEvent["source"];
  mode: PluginPromptMode;
  conversationId: string;
  channel?: string;
  runId?: string;
  assistantEntryId?: string;
  privateRelationshipContext?: boolean;
  memoryScope?: string;
  speechScope?: string;
  userTurnId?: string;
  companionFeedback?: CompanionFeedbackInput;
}

export interface AgentRuntime {
  buildOptions(input: BuildOptionsInput & { signal?: AbortSignal }, toolIds?: readonly string[]): Promise<{ options: CyreneRunOptions; latestUserText: string; companionReferences?: CompanionReference[] }>;
  onRunFinished(result: CyreneRunResult, latestUserText: string, context: AgentRunFinishedContext): Promise<{ sticker: string | null }>;
  buildSchedulerOptions(task: ScheduledTask): Promise<SchedulerRunOptions>;
}

export function createAgentRuntime(rawDeps: AgentRuntimeDeps): AgentRuntime {
  const runtimeStateService = rawDeps.runtimeStateService;
  const xilianWorldStore = getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json"));
  const initiativeStore = new InitiativeOpportunityStore(path.join(app.getPath("userData"), "initiative-opportunities.json"));
  const transcriptStore = getConversationTranscriptStore(app.getPath("userData"));
  const generatedImageStoreBase = createGeneratedImageStore({
    rootDirectory: path.join(app.getPath("userData"), "chat-media", "generated-images"),
  });
  const selfieLog = getSharedSelfieLog(path.join(app.getPath("userData"), "xilian-selfies.json"));
  // 图片落盘时，把这段时间内的自拍提议或请求记为已发出，用于冷却和上限。
  const generatedImageStore: typeof generatedImageStoreBase = {
    ...generatedImageStoreBase,
    save: async (input) => {
      const saved = await generatedImageStoreBase.save(input);
      selfieLog.recordImageSaved(input.conversationId, Date.now());
      return saved;
    },
  };
  const transcriptRunStore = getHarnessRunStore(app.getPath("userData"));
  // Production composition owns the singleton; unit/fallback callers retain
  // the same service contract but fail closed until one is injected.
  const transcriptCompactor = rawDeps.transcriptCompactor ?? new ConversationTranscriptCompactor({
    store: transcriptStore,
    runReader: transcriptRunStore,
    summarize: async () => { throw new Error("TRANSCRIPT_COMPACTION_REQUIRED"); },
  });

  function prepareXilianSelfieArtifact(userText: string, settings?: ModelSettingsLite): CyreneRunOptions["xilianSelfieArtifact"] {
    if (!settings?.imageGeneration?.enabled || !isXilianSelfieRequest(userText)) return undefined;
    try {
      const now = Date.now();
      const timezone = resolveChatContextTimezone(rawDeps.loadUserProfile().timezone);
      const state = xilianWorldStore.advance({ now, timezone });
      const timeline = xilianWorldStore.queryTimeline({ dateKey: state.worldDate, order: "desc", limit: 8 });
      const snapshot = buildXilianLifeSnapshot({ state, timeline, now, timezone, world: xilianWorldStore.worldView().amphoreus });
      if (!snapshot.sourceEventId || snapshot.sourceEventId === "xilian:none") return undefined;
      const artifact = xilianWorldStore.claimArtifact({
        eventId: snapshot.sourceEventId,
        kind: "selfie",
        promptFingerprint: buildXilianPromptFingerprint(snapshot),
        now,
      });
      return artifact ? { artifactId: artifact.id, store: xilianWorldStore } : undefined;
    } catch (error) {
      console.warn("[XilianWorld] 自拍 artifact 准备失败，继续使用普通生图流程", error);
      return undefined;
    }
  }

  async function observeRuntimeState(
    settings: ModelSettingsLite,
    _recentMessages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
    _latestUserText: string,
    chatContent: string,
  ): Promise<void> {
    const recentDialogue = [{ role: "assistant" as const, content: chatContent }];

    await rawDeps.enqueueLLMTask(
      "心情观察器",
      async () => {
        const observerContent = await rawDeps.llmClient.chat(
          settings as ModelSettings,
          [
            {
              role: "system",
              content:
                "你是一个情绪分析器。以下是昔涟的完整人格设定：\n\n" +
                loadSoulFeelingContext() +
                "\n\n根据以上人格设定和以下对话，判断昔涟当前的心情状态。可选心情值（只能选其中一个）：平静 / 开心 / 温柔 / 激动 / 撒娇 / 担心 / 难过 / 感动 / 害羞。只返回 JSON，不要任何多余文字：{\"feeling\": \"心情值\"}。判断规则：以最后一轮对话为主，之前几轮为辅；判断的是昔涟的心情，不是用户的心情；无法判断时返回 平静。",
            },
            {
              role: "user",
              content: JSON.stringify({ recentDialogue }),
            },
          ],
          undefined,
          30000,
          "心情观察器",
          false,
        );
        const feeling = parseObserverFeeling(observerContent);
        if (feeling) {
          runtimeStateService.smoothFeeling(feeling);
        }
      },
      { log: false },
    ).catch((err) => {
      console.warn("[Cyrene] observe runtime failed; keeping current feeling:", err);
    });
  }

  function buildBuildOptionsDeps(sessionId?: string, scope?: string, toolIds?: readonly string[]): BuildOptionsDeps {
    const ownerContext = isOwnerMemoryScope(scope);
    return {
      waitForPromptSkills: rawDeps.waitForPromptSkills,
      waitForStartup: (mode, signal) => rawDeps.waitForStartup?.(mode, toolIds, signal),
      loadModelSettings: (modelProfileId?: string) => resolveModelSettingsProfile(rawDeps.loadModelSettings(), modelProfileId),
      loadGeneralSettings: () => rawDeps.loadGeneralSettings(),
      loadUserProfile: () => rawDeps.loadUserProfile(),
      buildEnvironmentContext,
      buildSkillCatalog: ((skills) =>
        buildSkillCatalog(skills as any)) as BuildOptionsDeps["buildSkillCatalog"],
      buildAutoInjectedSkillContext: ((skills) =>
        buildAutoInjectedSkillContext(skills as any, (id) =>
          rawDeps.skillRegistry.getBody(id),
        )) as BuildOptionsDeps["buildAutoInjectedSkillContext"],
      buildAutoInjectedSoulContext: ((skills) =>
        buildAutoInjectedSoulContext(skills as any, (id) =>
          rawDeps.skillRegistry.getBody(id),
        )) as BuildOptionsDeps["buildAutoInjectedSoulContext"],
      skillRegistry: {
        getEnabled: () => rawDeps.skillRegistry.getEnabled() as unknown[],
        getEnabledForMode: (mode, overrides) =>
          rawDeps.skillRegistry.getEnabledForMode(mode, overrides) as unknown[],
        getBody: (id) => rawDeps.skillRegistry.getBody(id),
      },
      resolveSlashActivation: ((messages, mode, overrides) =>
        resolveSlashActivation(messages as any, mode, overrides)) as BuildOptionsDeps["resolveSlashActivation"],
      expandFileCommand: (messages, mode, workspaceRoot) => {
        const expansion = expandLatestUserCommand(messages, { userDir: getUserCommandsDirectory(), workspaceRoot }, mode);
        return expansion ? { name: expansion.name, source: expansion.source } : null;
      },
      buildToneInjection: (() => buildToneInjection()) as BuildOptionsDeps["buildToneInjection"],
      buildAlwaysOnContext: ((userText, messages, includeProfile) =>
        buildAlwaysOnContext(userText, messages as any, includeProfile, true)) as BuildOptionsDeps["buildAlwaysOnContext"],
      buildVectorMemoryContext,
      buildMemoryCompatibilityContext,
      buildXilianLifeContext: async (userText) => {
        if (!scope) return "";
        try {
          const now = Date.now();
          const timezone = resolveChatContextTimezone(rawDeps.loadUserProfile().timezone);
          const state = xilianWorldStore.advance({ now, timezone });
          const timeline = xilianWorldStore.queryTimeline({ dateKey: state.worldDate, order: "desc", limit: 8 });
          const life = formatXilianLifeContext(buildXilianLifeSnapshot(ownerContext
            ? { state, timeline, now, timezone, world: xilianWorldStore.worldView().amphoreus, conversationId: sessionId }
            : publicLifeSnapshotInput(state, timeline, now, timezone)));
          if (!ownerContext) return life;
          if (!/(?:什么|有没有|有没|有什么|还有|之前|刚才).{0,12}(?:想.{0,4}(?:说|分享)|没说)|想.{0,4}(?:说|分享).{0,10}什么/u.test(userText)
            || getRelationshipStore().getControls().paused) return life;
          const held = initiativeStore.readThoughts({ now, limit: 20 })
            .filter(thought => thought.source !== "user_care")
            .filter(thought => thought.source !== "moment:plugin" || rawDeps.loadGeneralSettings().companionPluginSharingEnabled)
            .filter(thought => thought.conversationId ? thought.conversationId === sessionId : !sessionId?.startsWith("channel:"));
          const memoryVersion = getMemoryModeVersion();
          const memoryIds = new Set(held.filter(thought => thought.source === MEMORY_FOLLOWUP_SOURCE
            && thought.conversationId === sessionId).map(thought => thought.sourceEventId));
          const active = sessionId && memoryIds.size && isPersonalMemoryEnabled() && normalizeMemoryMode(rawDeps.loadModelSettings().memoryMode) !== "off"
            ? await filterActiveSocialAtoms(rawDeps.socialAtomStore.listActive(sessionId, now, "owner")
              .filter(atom => memoryIds.has(atom.id) && isMemoryFollowupAtomOpen(atom, now))).catch(() => [])
            : [];
          const checkedAt = Date.now();
          const memoryThoughts = getMemoryModeVersion() === memoryVersion
            ? new Map(active.filter(atom => isMemoryFollowupAtomOpen(atom, checkedAt)).map(atom => [atom.id, socialAtomDisplayText(atom)]))
            : new Map<string, string>();
          const thoughts = held.map(thought => thought.source === MEMORY_FOLLOWUP_SOURCE
            ? memoryThoughts.get(thought.sourceEventId) : thought.summary)
            .filter((text): text is string => text !== undefined).slice(0, 3);
          return thoughts.length ? `${life}\n\n【此前留着没有主动说的念头】\n挑一件和对方问的事有关的说。\n${thoughts.join("\n")}` : life;
        } catch (error) {
          console.warn("[XilianWorld] 构建桌面生活上下文失败，已降级为空", error);
          return "";
        }
      },
      offerXilianSelfie: async ({ conversationId, userText }) => {
        if (!ownerContext) return undefined;
        const { relationship } = await getRelationshipStore().snapshot();
        if (!relationshipAllowsSelfie(relationship)) return undefined;
        const now = Date.now();
        const trigger = selfieLog.offerForReply({ conversationId, userText, frequency: normalizeSelfieFrequency(relationship.selfieFrequency), now });
        if (!trigger) return undefined;
        const timezone = resolveChatContextTimezone(rawDeps.loadUserProfile().timezone);
        const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now));
        console.log(`[XilianSelfie] 本轮可以发自拍 trigger=${trigger}`);
        return { hint: buildSelfieOfferHint(trigger, hour) };
      },
      noteXilianSelfieRequested: (conversationId) => selfieLog.noteRequested(conversationId, Date.now()),
      listXilianReferenceImages: () => listXilianReferenceImages([
        app.getPath("userData"),
        typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
        // 源码运行与 Linux 服务：仓库根目录下的 resources/
        path.join(process.cwd(), "resources"),
      ]),
      buildXilianSelfieContext: (userText) => {
        try {
          const now = Date.now();
          const timezone = resolveChatContextTimezone(rawDeps.loadUserProfile().timezone);
          const state = xilianWorldStore.advance({ now, timezone });
          const timeline = xilianWorldStore.queryTimeline({ dateKey: state.worldDate, order: "desc", limit: 8 });
          const snapshot = buildXilianLifeSnapshot(ownerContext
            ? { state, timeline, now, timezone, world: xilianWorldStore.worldView().amphoreus }
            : publicLifeSnapshotInput(state, timeline, now, timezone));
          return `${buildXilianSelfiePrompt(snapshot)}\n用户请求：${userText.slice(0, 500)}`;
        } catch (error) {
          console.warn("[XilianWorld] 构建自拍生活上下文失败，已降级为稳定视觉约束", error);
          return "";
        }
      },
      buildRelationshipContext,
      buildModePrompt,
      buildToolSystemPrompt: ((mode, enabledTools, deferredToolIds) =>
        buildToolSystemPrompt(mode, enabledTools as ToolDefinition[], deferredToolIds)) as BuildOptionsDeps["buildToolSystemPrompt"],
      buildSoulSystemBasePrompt,
      resolveRunCapabilities: ({ mode, activeSearchBackend, toolModeOverrides, skillModeOverrides, chatToolsEnabled, hasFileAttachments }) => resolveRunCapabilities({
        mode, activeSearchBackend, toolModeOverrides, skillModeOverrides, chatToolsEnabled, hasFileAttachments,
        toolRegistry: rawDeps.toolRegistry,
        skillRegistry: rawDeps.skillRegistry,
      }),
      readStylePrompt,
      resolveSoulSampling: resolveSoulSamplingForStyle,
      toolRegistry: {
        getEnabled: () => rawDeps.toolRegistry.getEnabledTools() as unknown[],
        getEnabledToolsForMode: (mode: ConversationMode, overrides?: ToolModeOverrides) =>
          rawDeps.toolRegistry.getEnabledToolsForMode(mode, overrides) as unknown[],
      },
      normalizeChatMessages: ((raw) =>
        normalizeChatMessages(raw as any)) as BuildOptionsDeps["normalizeChatMessages"],
      chatRequestTimeoutMs: getTimeoutSettings().chatRequestTimeout,
      captionImageForFallback: async (filePath: string) => {
        // 走注入的设置加载（与 buildSchedulerOptions 同策略），保证可测且不绕过依赖装配
        const settings = resolveModelSettingsProfile(rawDeps.loadModelSettings());
        const vision = resolveCaptionVisionConfig(settings);
        if (!vision.ok) return { ok: false, error: vision.error };
        return captionImageSafe(filePath, IMAGE_CAPTION_PROMPT, vision.config);
      },
      prepareCitaTurn: (input) => rawDeps.citaService.prepareTurn(input),
      buildChatSocialContext: async ({ conversationId, memoryScope, query, timezone }) => {
        const now = Date.now();
        const active = await filterActiveSocialAtoms(rawDeps.socialAtomStore.listActive(conversationId, now, memoryScope));
        return buildPersonMemoryContext(active, query, { now, timezone: timezone ?? "Asia/Shanghai" });
      },
      buildMomentsContext: (query, conversationId) => {
        // 只读本地 moments 数据（内存缓存），同步返回。
        // 读模型由 registerMomentsIpc 的 await initialize 装载（先于任何运行入口）；
        // 万一装配顺序被打乱，这里降级为无 moments 上下文而不是抛错。
        if (!momentsStore.isReady()) return "";
        return buildMomentsContextBlock(momentsStore.listFeed({ limit: 20 }), query, Date.now(), conversationId);
      },
      getWorkspaceBinding: async (conversationId: string) => {
        return (await rawDeps.chatsStore.getWorkspaceBinding(conversationId));
      },
      buildSummaryMemoryContext: rawDeps.buildSummaryMemoryContext,
      buildPluginPromptContext: (input, scope) => scope ? rawDeps.buildPluginPromptContext(input, scope) : rawDeps.buildPluginPromptContext(input),
      // 权威轨迹上下文（CTA Phase 1）：桌面端与 bridge 共用同一 userData 根下的单例 store
      buildModelContext: (conversationId, retainTokens) => buildModelContext({
        store: transcriptStore,
        conversationId,
        retainTokens,
        runReader: transcriptRunStore,
      }),
      compactTranscript: (input) => transcriptCompactor.compact(input),
    };
  }

  function buildOnRunFinishedDeps(): OnRunFinishedDeps {
    return {
      loadModelSettings: () => resolveModelSettingsProfile(rawDeps.loadModelSettings()),
      scheduleMemoryWrite,
      scheduleSummaryTurn: rawDeps.scheduleSummaryTurn ?? ((input) => scheduleSummaryTurn(input)),
      scheduleWikiTurn: rawDeps.scheduleWikiTurn ?? ((input) => scheduleWikiTurn(input)),
      scheduleSocialAtomExtraction: (input) => rawDeps.socialContextScheduler.schedule(input),
      scheduleMomentsTurn: (input) => momentsService.scheduleTurn(input),
      inferRuntimeState: ((userText, reply, flag) =>
        runtimeStateService.inferFromText(userText, reply, flag)) as OnRunFinishedDeps["inferRuntimeState"],
      runtimeState: runtimeStateService.getState(),
      feelingToExpression,
      getAffectPresentation: async () => {
        const state = await getRelationshipStore().getState();
        return state.relationshipState.paused ? null : affectPresentation(state.affectState);
      },
      setRuntimeState: ((next) =>
        runtimeStateService.setStateWithoutNotify(next as any)) as OnRunFinishedDeps["setRuntimeState"],
      stickerTextIndex: rawDeps.getStickerTextIndex(),
      matchSticker,
      loadStickerSettings,
      broadcastRuntimeStateChanged: rawDeps.broadcastRuntimeStateChanged,
      observeRuntimeState: ((settings, history, userText, reply) =>
        observeRuntimeState(settings as ModelSettingsLite, history as any, userText, reply)) as OnRunFinishedDeps["observeRuntimeState"],
      recordRelationshipTurn,
    };
  }

  // 工具完成观察回调：harness 事件结构与插件事件字段一一对应，直接透传；
  // 未配置发布入口时不注入，harness 侧零开销。
  const onToolFinished = rawDeps.publishToolFinished
    ? (event: HarnessToolFinishedEvent) => rawDeps.publishToolFinished!(event)
    : undefined;

  return {
    buildOptions: async (input, toolIds) => {
      const scope = resolvePersonalMemoryScope(input);
      const buildOptionsDeps = buildBuildOptionsDeps(input.sessionId, scope, toolIds);
      const { options, latestUserText, companionReferences } = await buildAgentRunOptions(input, buildOptionsDeps);
      const xilianSelfieArtifact = isOwnerMemoryScope(scope) ? prepareXilianSelfieArtifact(latestUserText, options.settings) : undefined;
      return {
        options: {
          ...options,
          onToolFinished,
          assistantTurnId: input.assistantTurnId,
          generatedImageStore,
          ...(xilianSelfieArtifact ? { xilianSelfieArtifact } : {}),
        },
        latestUserText,
        companionReferences,
      };
    },

    onRunFinished: async (result, latestUserText, context) => {
      const onRunFinishedDeps = buildOnRunFinishedDeps();
      const terminalStatus = result.terminal?.status;
      const companionFeedback = (terminalStatus === undefined || terminalStatus === "success")
        && context.mode === "chat" && context.privateRelationshipContext !== false
        ? context.companionFeedback : undefined;
      const effects = await onAgentRunFinished(
        result,
        latestUserText,
        onRunFinishedDeps,
        context.channel as ChannelId | undefined,
        context.conversationId,
        { runId: context.runId, source: context.source, mode: context.mode,
          speechScope: context.speechScope,
          companionTurnId: context.speechScope && (terminalStatus === undefined || terminalStatus === "success") && (context.mode === "chat" || (context.source === "channel" && ["wechat","qq"].includes(context.channel ?? ""))) && context.privateRelationshipContext !== false ? context.userTurnId : undefined,
          privateRelationshipContext: context.privateRelationshipContext,
          memoryScope: context.memoryScope,
          assistantEntryId: context.assistantEntryId, userTurnId: context.userTurnId,
          ...(companionFeedback ? { companionFeedback } : {}),
          vectorMemorySource: context.userTurnId && context.assistantEntryId
            ? { userTurnId: context.userTurnId, assistantEntryId: context.assistantEntryId }
            : undefined },
      );
      // 调用方应只在成功终态进入收尾；此处再守住插件事件契约，避免未来新增入口误报完成。
      if (terminalStatus !== undefined && terminalStatus !== "success") {
        return effects;
      }
      const payload: PluginTurnCompletedEvent = {
        source: context.source,
        mode: context.mode,
        conversationId: context.conversationId,
        ...(context.channel ? { channel: context.channel } : {}),
        ...(context.runId ? { runId: context.runId } : {}),
      };
      // 插件监听器属于旁路扩展：不等待它们，避免第三方插件延迟主回复的终态事件。
      void rawDeps.publishPluginHostEvent("turn:completed", payload).catch((error) => {
        console.warn("[plugins] 发布对话轮次完成事件失败", error);
      });
      return effects;
    },

    buildSchedulerOptions: async (task) => {
      // 与 channel bot / 聊天路径同策略：先展开默认模型档案再取顶层镜像，
      // 否则用户只在档案里配模型时顶层 baseUrl/apiKey 可能为空，定时任务会调不到 LLM。
      const settings = resolveModelSettingsProfile(rawDeps.loadModelSettings());
      const profile = rawDeps.loadUserProfile();
      const generalSettings = rawDeps.loadGeneralSettings();
      const ownerContext = !task.delivery && !task.ownerPluginId;
      // 会话模式取任务冻结字段（旧任务默认 work）：skill 过滤、模式提示词
      // 和插件提示词上下文都跟随该模式。
      const mode = task.mode ?? "work";
      const messages = [{
        role: "user" as const,
        content: task.delivery
          ? `这是用户之前约定的延时任务，现在已经到触发时间了。请结合你的昔涟人格，自然地完成或回应这件事；不要解释调度器、后台任务或内部实现。任务意图：${task.prompt}`
          : task.prompt,
      }];
      // 定时任务按任务模式过滤 skill，并尊重 skill-模式覆盖层；
      // 与聊天路径同约定：chat 模式不暴露 skill。
      const scheduledSkills = mode === "chat"
        ? []
        : rawDeps.skillRegistry.getEnabledForMode(mode, generalSettings.skillModeOverrides);
      const systemContent = [
        buildModePrompt(mode),
        buildEnvironmentContext(profile, ownerContext),
        buildSkillCatalog(scheduledSkills),
        await buildAlwaysOnContext(task.prompt, messages, false),
        ownerContext ? await buildRelationshipContext() : "",
        await rawDeps.buildPluginPromptContext({
          source: "scheduler",
          mode,
          userText: task.prompt,
        }),
      ].join("\n\n---\n\n");
      return {
        settings: {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          // 协议与推理偏好需与聊天路径一致透传，否则定时任务会按默认协议发请求。
          explicitTransport: settings.explicitTransport,
          responsesNative: settings.responsesNative,
          reasoning: settings.reasoning,
          manualReasoning: settings.manualReasoning,
          contextWindowTokens: settings.contextWindowTokens,
          modelRequestMaxRetries: settings.modelRequestMaxRetries ?? 5,
        },
        messages: [{ role: "system" as const, content: systemContent }, ...messages],
        // 定时任务也不因整轮耗时被中断；仍保留单次模型/工具自身的超时。
        timeoutMs: 0,
        onToolFinished,
      };
    },
  };
}
