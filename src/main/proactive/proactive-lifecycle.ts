import { powerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import * as chatsStore from "../chats/chats-store";
import { broadcastChatsChanged } from "../chats/chats-ipc";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { setChannelsConversationLifecycle } from "../channels/init";
import { channelManager } from "../channels/manager";
import {
  getProactiveChannelAvailability,
  sendProactiveChannelMessage,
  type RecentProactiveChannelRecipient,
} from "../channels/proactive-delivery";
import { resolveChatContextTimezone } from "../chat-time-context";
import { buildAlwaysOnContext, buildMemoryInjection } from "../orchestrator";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { GeneralSettings } from "../settings/general-settings";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import { loadUserProfile } from "../settings-store";
import { createProactiveChatService } from "./proactive-service";
import type {
  ProactiveChatService,
  ProactiveCommitInput,
  ProactiveCommitResult,
} from "./proactive-service";
import { routeProactiveDelivery } from "./proactive-delivery-routing";
import { buildProactiveMessages, type ProactiveHistoryTurn } from "./proactive-prompt";
import { canCommitProactiveMessage, canStartProactiveGeneration } from "./proactive-policy";
import { loadProactiveState, saveProactiveState } from "./proactive-state-store";
import { createProactiveTrigger, getZonedDateParts, type ProactiveTriggerController } from "./proactive-trigger";
import { runProactiveModel } from "./proactive-model";
import { DEFAULT_PROACTIVE_TARGET_SCORE } from "../../shared/preferences";
import type { ProactiveCandidate, ProactiveEvaluationStatus, ProactiveRuntimeSnapshot } from "./proactive-types";

export interface ProactiveLifecycleOptions {
  loadGeneralSettings: () => GeneralSettings;
  conversationJournal: ConversationJournalService;
}

export interface ProactiveLifecycle {
  initializeProactiveChatService: () => void;
  initializeProactiveTrigger: () => void;
  stopProactiveTrigger: () => void;
  getProactiveChatService: () => ProactiveChatService | null;
  getProactiveStatus: () => ProactiveEvaluationStatus;
  proactiveConversationLifecycle: {
    onUserMessage: () => void;
    onConversationStarted: () => void;
    onConversationEnded: () => void;
  };
}

export function createProactiveLifecycle(options: ProactiveLifecycleOptions): ProactiveLifecycle {
  let proactiveChatService: ProactiveChatService | null = null;
  let proactiveTrigger: ProactiveTriggerController | null = null;
  const proactiveBackoffMap = new Map<string, number>();
  const conversationJournal = options.conversationJournal;
  let normalConversationBusyCount = 0;
  let proactiveScreenLocked = false;
  let lastMessageActivityAt: number | null = null;
  let generationRecipient: RecentProactiveChannelRecipient | undefined;
  let lastOutcome: ProactiveEvaluationStatus["lastOutcome"];
  let proactiveStatus: ProactiveEvaluationStatus = {
    candidateScore: null,
    targetScore: DEFAULT_PROACTIVE_TARGET_SCORE,
    sceneId: null,
    evaluatedAt: null,
    state: "no_candidate",
  };

  function buildProactivePersonaPrompt(): string {
    const parts: string[] = [];
    const chatSystem = loadPromptFile("chat_system.md");
    if (chatSystem) parts.push(chatSystem);
    const soul = loadPromptFile("soul.md");
    if (soul) {
      // 主动轮完全不携带工具说明；Soul 尾部的 Live2D/联网章节由正常聊天使用。
      parts.push(soul.split("\n## Live2D 与聊天文字的分工")[0].trim());
    }
    const canon = loadPromptFile("canon_quotes.md");
    if (canon) parts.push(canon);
    const style = loadPromptFile("styles/01_default.md");
    if (style) parts.push(style);
    return parts.join("\n\n---\n\n");
  }

  function toProactiveHistory(
    messages: Array<{ role: "user" | "model"; content: string; at: number }>,
  ): ProactiveHistoryTurn[] {
    return messages
      .filter((message) => message.content.trim())
      .slice(-16)
      .map((message) => ({ role: message.role, content: message.content, at: message.at }));
  }

  async function getProactiveHistories(recipient?: RecentProactiveChannelRecipient): Promise<{ ordinary: ProactiveHistoryTurn[]; proactive: ProactiveHistoryTurn[] }> {
    if (recipient) {
      const projection = await conversationJournal.readProjection(recipient.conversationId ?? recipient.sessionId);
      return { ordinary: toProactiveHistory(projection.messages), proactive: [] };
    }
    // Read the session index once so both projections come from the same
    // snapshot. listSessions is sorted by recent activity, so the first
    // ordinary session is the current conversation and the proactive session
    // remains the singleton dedicated history.
    const sessions = await chatsStore.listSessions();
    const ordinaryMeta = sessions.find((session) => session.purpose !== "proactive-chat");
    const proactiveMeta = sessions.find((session) => session.purpose === "proactive-chat");
    const [ordinaryProjection, proactiveProjection] = await Promise.all([
      ordinaryMeta ? conversationJournal.readProjection(ordinaryMeta.id) : Promise.resolve(null),
      proactiveMeta ? conversationJournal.readProjection(proactiveMeta.id) : Promise.resolve(null),
    ]);
    return {
      ordinary: toProactiveHistory(ordinaryProjection?.messages ?? []),
      proactive: toProactiveHistory(proactiveProjection?.messages ?? []),
    };
  }

  function getProactiveRuntimeSnapshot(): ProactiveRuntimeSnapshot {
    const now = Date.now();
    let idleSec = Number.POSITIVE_INFINITY;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch { /* app 尚未 ready */ }
    if (lastMessageActivityAt !== null) idleSec = Math.min(idleSec, Math.max(0, Math.floor((now - lastMessageActivityAt) / 1000)));
    return {
      now,
      // The server's system timezone can differ from the user's timezone.
      // Policy quiet hours must use the same clock as candidate selection.
      localHour: getZonedDateParts(new Date(now), resolveChatContextTimezone(loadUserProfile().timezone)).hour,
      idleSec,
      enabled: options.loadGeneralSettings().proactiveChatMode === "on",
      conversationBusy: normalConversationBusyCount > 0,
      generationBusy: false,
      screenLocked: proactiveScreenLocked,
    };
  }

  async function buildProactiveAgentMessages(candidate: ProactiveCandidate) {
    const target = options.loadGeneralSettings().proactiveDeliveryTarget;
    const route = target === "local" ? null : getProactiveChannelAvailability(target, channelManager);
    if (route && !route.available) throw new Error(route.reason);
    generationRecipient = route?.available ? { ...route.recipient } : undefined;
    const histories = await getProactiveHistories(generationRecipient);
    const recentTopic = histories.ordinary.slice(-4).map((turn) => turn.content).join("\n");
    const retrievalQuery = `${candidate.sceneId}\n${recentTopic}`.trim();
    const [profileContext, memoryContext] = await Promise.all([
      buildAlwaysOnContext(retrievalQuery, histories.ordinary.map((turn) => ({ role: turn.role, content: turn.content }))).catch(() => ""),
      buildMemoryInjection(retrievalQuery).catch(() => ""),
    ]);
    const state = loadProactiveState();
    const snapshot = getProactiveRuntimeSnapshot();
    // 用户有效时区：resolver 校验后传给 prompt，禁止未校验的 profile.timezone。
    const profile = loadUserProfile();
    const timezone = resolveChatContextTimezone(profile.timezone);
    return buildProactiveMessages({
      basePersona: buildProactivePersonaPrompt(),
      userProfile: profileContext,
      relevantMemory: memoryContext,
      ordinaryHistory: histories.ordinary,
      proactiveHistory: histories.proactive,
      sceneId: candidate.sceneId,
      localNow: new Date(snapshot.now),
      idleSec: snapshot.idleSec,
      unansweredCount: state.unansweredCount,
      timezone,
    });
  }

  function updateNormalConversationBusy(delta: 1 | -1): void {
    normalConversationBusyCount = Math.max(0, normalConversationBusyCount + delta);
  }

  function bestEffortConversationStateUpdate(label: string, update: () => void): void {
    try {
      update();
    } catch (error) {
      // Conversation delivery remains authoritative; a telemetry/cooldown state
      // write failure must not replace the original AG-UI or channel error.
      console.warn(`[Proactive] ${label} state update failed`, error);
    }
  }

  const proactiveConversationLifecycle = {
    onUserMessage: () => {
      lastMessageActivityAt = Date.now();
      bestEffortConversationStateUpdate("user_message", () => proactiveChatService?.invalidateForUserMessage());
    },
    onConversationStarted: () => {
      updateNormalConversationBusy(1);
      bestEffortConversationStateUpdate("conversation_started", () => proactiveChatService?.normalConversationStarted());
    },
    onConversationEnded: () => {
      updateNormalConversationBusy(-1);
      if (normalConversationBusyCount === 0) {
        bestEffortConversationStateUpdate("conversation_ended", () => proactiveChatService?.normalConversationEnded());
      }
    },
  };

  function getProactiveCommitDecision(candidate: ProactiveCandidate, generationEpoch: number) {
    return canCommitProactiveMessage(
      getProactiveRuntimeSnapshot(),
      loadProactiveState(),
      candidate,
      generationEpoch,
    );
  }

  function recordProactiveDeliveryMetadata(input: ProactiveCommitInput): void {
    // Opener 的 todayFired/recentItems 字段已整体废弃（依赖的 SCENE_CONFIGS 与 ShowBubblePayload 来自旧 opener 子系统）。
    // ProactiveChat 这边只需持久化 committed 副作用；当前 implementation 已无副作用，留空占位即可。
    void input;
  }

  async function commitLocalProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const initialDecision = getProactiveCommitDecision(input.candidate, input.generationEpoch);
    if (!initialDecision.allowed) return { kind: "cancelled", reason: initialDecision.reason };
    if (!input.intentId) return { kind: "cancelled", reason: "durable_intent_required" };

    const session = (await chatsStore.getOrCreateSessionByPurpose("proactive-chat", {
      title: "昔涟的主动消息",
      identityId: null,
    }));
    // Stable business identity makes a retry after a derived snapshot failure
    // resolve the same canonical assistant entry instead of duplicating it.
    const commitKey = input.intentId;
    const runId = commitKey;
    const intentAt = input.intentAt ?? 0;
    const sink = conversationJournal.createRunSink({ conversationId: session.id, runId });
    const assistantEntryId = await sink.appendAssistant({
      message: { role: "assistant", content: input.text },
      roundId: "proactive",
    });
    await conversationJournal.appendPresentationNext(
      session.id,
      assistantEntryId,
      `${commitKey}:presentation`,
      { content: input.text, runSnapshot: { runId, status: "terminal", updatedAt: intentAt } },
    );
    broadcastChatsChanged();

    // 文本已落库；上次落库后没有 panel/show 步骤要做（opener 气泡已被移除，fallback 路径没有了）。
    void input;
    return { kind: "committed" };
  }

  async function commitSelectedProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const settings = options.loadGeneralSettings();
    const target = input.deliveryTarget ?? settings.proactiveDeliveryTarget;
    const result = await routeProactiveDelivery(target, {
      commitLocal: () => commitLocalProactiveMessage(input),
      commitChannel: async (channel) => {
        const recipient = generationRecipient;
        if (!recipient) return { kind: "cancelled", reason: "recipient_unavailable" };
        const channelResult = await sendProactiveChannelMessage({
          channel,
          text: input.text,
          mobileMessageSegmentation: settings.mobileMessageSegmentation,
          manager: channelManager,
          recipient,
          recordDelivery: async (deliveredRecipient, text) => {
            const conversationId = deliveredRecipient.conversationId ?? deliveredRecipient.sessionId;
            const runId = `proactive-channel-${randomUUID()}`;
            const assistantTurnId = runId;
            const sink = conversationJournal.createRunSink({ conversationId, runId, assistantTurnId });
            const messageId = await sink.appendAssistant({ message: { role: "assistant", content: text }, roundId: "proactive" });
            await conversationJournal.appendPresentationNext(conversationId, messageId, `${runId}:presentation`, {
              content: text,
              channelSource: { channel, chatType: "private" },
              runSnapshot: { runId, status: "terminal", updatedAt: Date.now() },
            });
            await conversationJournal.appendDeliveryReceipt(conversationId, { assistantTurnId, channel, status: "delivered", runId });
            broadcastChatsChanged();
          },
          canContinue: () => {
            if (options.loadGeneralSettings().proactiveDeliveryTarget !== channel) return false;
            const latest = getProactiveChannelAvailability(channel, channelManager);
            if (!latest.available || latest.recipient.targetId !== recipient.targetId || latest.recipient.conversationId !== recipient.conversationId) return false;
            return getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed;
          },
        });
        return channelResult.kind === "committed"
          ? { kind: "committed" }
          : { kind: "cancelled", reason: channelResult.reason };
      },
    });

    if (result.kind === "committed") recordProactiveDeliveryMetadata(input);
    return result;
  }

  function initializeProactiveChatService(): void {
    proactiveChatService = createProactiveChatService({
      loadState: loadProactiveState,
      saveState: (state) => {
        saveProactiveState(state);
      },
      getSnapshot: getProactiveRuntimeSnapshot,
      buildMessages: async (candidate) => buildProactiveAgentMessages(candidate),
      runModel: async (messages) => {
        // The model catalog is the source of truth for Web and desktop alike.
        // The top-level fields are only a compatibility mirror and may be
        // empty when the user has configured a saved default profile (this is
        // especially common after migrating web-data.json to the shared core).
        // Reading the raw settings here made normal chat work while proactive
        // chat incorrectly reported `missing_api_key` and dropped the message.
        const settings = resolveModelSettingsProfile(loadModelSettings());
        if (!settings.apiKey) return { kind: "error", reason: "missing_api_key" };
        return runProactiveModel({
          settings: {
            provider: settings.provider,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: settings.apiKey,
            explicitTransport: settings.explicitTransport,
            reasoning: settings.reasoning,
            manualReasoning: settings.manualReasoning,
          },
          messages,
          timeoutMs: 45_000,
        });
      },
      // Model failure is fail-closed: the proactive service cancels this
      // attempt instead of sending a generic canned message.
      getFallback: async () => null,
      canStartDelivery: () => {
        const target = options.loadGeneralSettings().proactiveDeliveryTarget;
        return target === "local" || getProactiveChannelAvailability(target, channelManager).available;
      },
      requiresDurableIntent: () => options.loadGeneralSettings().proactiveDeliveryTarget === "local",
      getDeliveryTarget: () => options.loadGeneralSettings().proactiveDeliveryTarget,
      commitMessage: commitSelectedProactiveMessage,
      log: (event, detail) => {
        const info = detail as { reason?: string; scene?: string } | undefined;
        const state = event === "message_committed" ? "sent"
          : event === "model_silent" ? "silent"
          : event === "fallback_unavailable" || event === "evaluation_failed" ? "failed"
          : event.endsWith("blocked") || event === "commit_cancelled" || event === "generation_discarded" ? "blocked" : null;
        if (state) lastOutcome = { state, ...(info?.reason ? { reason: info.reason } : {}), at: Date.now(), sceneId: info?.scene ?? null };
        console.log(`[Proactive] ${event}`, detail ?? "");
      },
    });

    setChannelsConversationLifecycle(proactiveConversationLifecycle);

    powerMonitor.on("lock-screen", () => {
      proactiveScreenLocked = true;
      proactiveChatService?.invalidate();
    });
    powerMonitor.on("unlock-screen", () => { proactiveScreenLocked = false; });
    powerMonitor.on("suspend", () => {
      proactiveScreenLocked = true;
      proactiveChatService?.invalidate();
    });
    powerMonitor.on("resume", () => { proactiveScreenLocked = false; });
  }

  function initializeProactiveTrigger(): void {
    if (proactiveTrigger) return; // 幂等
    if (!proactiveChatService) {
      console.warn("[Proactive] trigger skipped: service not initialized");
      return;
    }
    const service = proactiveChatService;
    proactiveTrigger = createProactiveTrigger({
      evaluateCandidate: (c) => service.evaluateCandidate(c),
      getRuntimeSnapshot: getProactiveRuntimeSnapshot,
      getProactiveState: loadProactiveState,
      getTimezone: () => resolveChatContextTimezone(loadUserProfile().timezone),
      getTargetScore: () => options.loadGeneralSettings().proactiveTargetScore ?? DEFAULT_PROACTIVE_TARGET_SCORE,
      getCandidateBlockReason: (candidate) => {
        const decision = canStartProactiveGeneration(getProactiveRuntimeSnapshot(), loadProactiveState(), candidate);
        if (!decision.allowed) return decision.reason;
        const target = options.loadGeneralSettings().proactiveDeliveryTarget;
        const route = target === "local" ? null : getProactiveChannelAvailability(target, channelManager);
        return route && !route.available ? route.reason : undefined;
      },
      getConversationLastActivity: async () => {
        const target = options.loadGeneralSettings().proactiveDeliveryTarget;
        const route = target === "local" ? null : getProactiveChannelAvailability(target, channelManager);
        if (route && !route.available) return null;
        const histories = await getProactiveHistories(route?.available ? route.recipient : undefined);
        if (!histories.ordinary.some(turn => turn.role === "user")) return null;
        return histories.ordinary.at(-1)?.at ?? null;
      },
      onEvaluation: (status: ProactiveEvaluationStatus) => { proactiveStatus = status; },
      // getWeatherContext 第一版不传：未来天气缓存接入后填，函数体无需改
      getLastEvaluatedAtByScene: () => new Map(proactiveBackoffMap),
      setLastEvaluatedAtByScene: (next) => {
        proactiveBackoffMap.clear();
        for (const [k, v] of next) proactiveBackoffMap.set(k, v);
      },
    });
    proactiveTrigger.start();
  }

  function stopProactiveTrigger(): void {
    proactiveTrigger?.stop();
    proactiveTrigger = null;
  }

  return {
    initializeProactiveChatService,
    initializeProactiveTrigger,
    stopProactiveTrigger,
    getProactiveChatService: () => proactiveChatService,
    getProactiveStatus: () => {
      const settings = options.loadGeneralSettings();
      const route = settings.proactiveDeliveryTarget === "local" ? null : getProactiveChannelAvailability(settings.proactiveDeliveryTarget, channelManager);
      const state = loadProactiveState();
      return {
        ...proactiveStatus,
        targetScore: settings.proactiveTargetScore ?? DEFAULT_PROACTIVE_TARGET_SCORE,
        lastOutcome,
        delivery: { target: settings.proactiveDeliveryTarget, ready: route === null || route.available, ...(route && !route.available ? { reason: route.reason } : {}) },
        unansweredCount: state.unansweredCount,
        lastProactiveAt: state.lastProactiveAt,
      };
    },
    proactiveConversationLifecycle,
  };
}
