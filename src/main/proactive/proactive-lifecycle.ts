import { relationshipOpportunities } from "./relationship-opportunities";
import { followupIdFromScene, followupOpportunities } from "./followup-opportunities";
import { withConversationRun } from "../orchestrator/conversation-run-guard";
import { buildPersonaContractPrompt } from "../persona/persona-spec";
import { buildRelationshipContext, getRelationshipStore } from "../relationship/relationship-log";
import { powerMonitor } from "electron";
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
import { loadModelSettings, resolveSessionModelSettings } from "../settings/model-settings";
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
import type { ProactiveCandidate, ProactiveEvaluationStatus, ProactiveRuntimeSnapshot, ProactiveDeliveryContext } from "./proactive-types";

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
  let generationRelationshipRevision: number | undefined;
  let generationRecipient: RecentProactiveChannelRecipient | undefined;
  let generationDeliveryContext: ProactiveDeliveryContext | undefined;
  let lastOutcome: ProactiveEvaluationStatus["lastOutcome"];
  let proactiveStatus: ProactiveEvaluationStatus = {
    candidateScore: null,
    targetScore: DEFAULT_PROACTIVE_TARGET_SCORE,
    sceneId: null,
    evaluatedAt: null,
    state: "no_candidate",
  };

  function buildProactivePersonaPrompt(): string {
    const parts: string[] = [buildPersonaContractPrompt()];
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
      enabled: options.loadGeneralSettings().proactiveChatMode === "on" && !getRelationshipStore().getControls().paused,
      conversationBusy: normalConversationBusyCount > 0,
      generationBusy: false,
      screenLocked: proactiveScreenLocked,
    };
  }

  async function buildProactiveAgentMessages(candidate: ProactiveCandidate) {
    const companion = await getRelationshipStore().snapshot();
    generationRelationshipRevision = companion.revision;
    const target = options.loadGeneralSettings().proactiveDeliveryTarget;
    const route = target === "local" ? null : getProactiveChannelAvailability(target, channelManager);
    if (route && !route.available) throw new Error(route.reason);
    generationRecipient = route?.available ? { ...route.recipient } : undefined;
    const followupId = followupIdFromScene(candidate.sceneId);
    const followup = followupId ? companion.followups?.find(item => item.id === followupId) : undefined;
    if (followupId && (!followup || followup.status !== "active" || followup.nextEligibleAt > Date.now() || !companion.relationship.proactiveLifeEnabled)) throw new Error("followup_not_eligible");
    if (followup && generationRecipient && followup.conversationId !== (generationRecipient.conversationId ?? generationRecipient.sessionId)) throw new Error("followup_recipient_changed");
    const historyTarget = generationRecipient ?? (followup ? { conversationId: followup.conversationId, sessionId: followup.conversationId, targetId: "", updatedAt: 0 } : undefined);
    generationDeliveryContext = { relationshipRevision: companion.revision,
      ...(historyTarget ? { conversationId: historyTarget.conversationId ?? historyTarget.sessionId } : {}),
      ...(generationRecipient ? { sessionId: generationRecipient.sessionId, targetId: generationRecipient.targetId, ...(generationRecipient.threadId ? { threadId: generationRecipient.threadId } : {}) } : {}),
      ...(followupId ? { followupId } : {}) };
    const histories = await getProactiveHistories(historyTarget);
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
      basePersona: buildProactivePersonaPrompt() + "\n\n" + await buildRelationshipContext(historyTarget?.conversationId ?? historyTarget?.sessionId ?? "proactive-local"),
      userProfile: profileContext,
      relevantMemory: [memoryContext, followup ? `用户明确设置的本轮跟进事项：${JSON.stringify(followup.topic)}。只自然关心这件事的近况，不推测结果、不催促、不声称已做任何操作；没有合适话题时可保持安静。` : ""].filter(Boolean).join("\n\n"),
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
    if (generationRelationshipRevision !== undefined && getRelationshipStore().getControls().revision !== generationRelationshipRevision) return { allowed: false, reason: "stale_epoch" as const };
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

    const selectedId = input.deliveryContext?.conversationId;
    const session = selectedId ? await chatsStore.getSessionRecord(selectedId) : (await chatsStore.getOrCreateSessionByPurpose("proactive-chat", {
      title: "昔涟的主动消息",
      identityId: null,
    }));
    if (!session) return { kind: "cancelled", reason: "conversation_unavailable" };
    // Stable business identity makes a retry after a derived snapshot failure
    // resolve the same canonical assistant entry instead of duplicating it.
    const commitKey = input.intentId;
    const runId = commitKey;
    const intentAt = input.intentAt ?? 0;
    return withConversationRun(session.id, async (): Promise<ProactiveCommitResult> => {
    if (!getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed) return { kind: "cancelled", reason: "stale_epoch" };
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
    });
  }

  async function commitSelectedProactiveMessage(input: ProactiveCommitInput): Promise<ProactiveCommitResult> {
    const settings = options.loadGeneralSettings();
    const target = input.deliveryTarget ?? settings.proactiveDeliveryTarget;
    if (!input.intentId) return { kind: "cancelled", reason: "durable_intent_required" };
    if (target !== settings.proactiveDeliveryTarget) return { kind: "cancelled", reason: "delivery_target_changed" };
    const frozen = input.deliveryContext;
    if (frozen) generationRelationshipRevision = frozen.relationshipRevision;
    if (frozen?.followupId) {
      const companion = await getRelationshipStore().snapshot();
      const item = companion.followups?.find(item => item.id === frozen.followupId && item.conversationId === frozen.conversationId);
      if (item?.lastIntentId === input.intentId && item.status === "awaiting_reply") return { kind: "committed" };
      if (!item || item.status !== "active" || !companion.relationship.proactiveLifeEnabled) return { kind: "cancelled", reason: "followup_not_eligible" };
    }
    const decision = getProactiveCommitDecision(input.candidate, input.generationEpoch);
    if (!decision.allowed) return { kind: "cancelled", reason: decision.reason };
    const result = await routeProactiveDelivery(target, {
      commitLocal: () => commitLocalProactiveMessage(input),
      commitChannel: async (channel) => {
        const frozen = input.deliveryContext;
        const recipient = frozen?.sessionId && frozen.targetId ? {
          targetId: frozen.targetId, sessionId: frozen.sessionId, conversationId: frozen.conversationId,
          ...(frozen.threadId ? { threadId: frozen.threadId } : {}), updatedAt: input.intentAt ?? 0,
        } : generationRecipient;
        if (!recipient || !input.intentId) return { kind: "cancelled", reason: "recipient_unavailable" };
        const conversationId = recipient.conversationId ?? recipient.sessionId;
        const runId = input.intentId;
        const assistantTurnId = `${runId}:assistant`;
        return withConversationRun(conversationId, async () => {
          if (!getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed) return { kind: "cancelled" as const, reason: "stale_epoch" };
          const current = getProactiveChannelAvailability(channel, channelManager);
          if (!current.available || current.recipient.targetId !== recipient.targetId || current.recipient.conversationId !== recipient.conversationId) return { kind: "cancelled" as const, reason: "binding_changed" };
          // CTA 是外发的前置事实：失败重试使用同一 intent、同一 assistant、同一 outbox。
          const sink = conversationJournal.createRunSink({ conversationId, runId, assistantTurnId });
          const messageId = await sink.appendAssistant({ message: { role: "assistant", content: input.text }, roundId: "proactive" });
          await conversationJournal.appendPresentationNext(conversationId, messageId, `${runId}:presentation`, {
            content: input.text, channelSource: { channel, chatType: "private" },
            runSnapshot: { runId, status: "terminal", updatedAt: input.intentAt ?? 0 },
          });
          const channelResult = await sendProactiveChannelMessage({
            operationId: `proactive:${input.intentId}`, assistantTurnId, runId,
            channel, text: input.text, mobileMessageSegmentation: settings.mobileMessageSegmentation,
            manager: channelManager, recipient,
            // authoritative assistant already exists; callback never creates a second reply.
            recordDelivery: async () => undefined,
            canContinue: () => {
              if (options.loadGeneralSettings().proactiveDeliveryTarget !== channel) return false;
              const latest = getProactiveChannelAvailability(channel, channelManager);
              if (!latest.available || latest.recipient.targetId !== recipient.targetId || latest.recipient.conversationId !== recipient.conversationId) return false;
              return getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed;
            },
          });
          const allDelivered = channelResult.kind === "committed" && channelResult.deliveredParts === channelResult.totalParts;
          const deliveryUnknown = channelResult.deliveryStatus === "unknown";
          await conversationJournal.appendDeliveryReceipt(conversationId, { assistantTurnId, channel, runId,
            status: allDelivered ? "delivered" : "failed",
            ...(!allDelivered ? { errorCode: deliveryUnknown ? "DELIVERY_UNCONFIRMED" : channelResult.kind === "committed" ? "PARTIAL_DELIVERY" : channelResult.reason } : {}),
          });
          broadcastChatsChanged();
          if (!allDelivered && (deliveryUnknown || channelResult.kind === "committed") && frozen?.followupId) {
            await getRelationshipStore().settleFollowup(frozen.followupId, conversationId, input.intentId!, Date.now(), deliveryUnknown ? "unknown" : "incomplete");
          }
          return channelResult.kind === "committed" ? { kind: "committed" as const,
            ...(!allDelivered ? { deliveryStatus: channelResult.deliveryStatus ?? "failed" as const, reason: channelResult.error ?? "PARTIAL_DELIVERY" } : {}) }
            : { kind: "cancelled" as const, reason: channelResult.reason };
        });
      },
    });

    if (result.kind === "committed") {
      recordProactiveDeliveryMetadata(input);
      if (!result.deliveryStatus && frozen?.followupId && frozen.conversationId) await getRelationshipStore().settleFollowup(frozen.followupId, frozen.conversationId, input.intentId, Date.now(), "asked");
    }
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
      runModel: async (messages, deliveryTarget) => {
        // Resolve the delivery conversation, not whichever ordinary chat is open.
        // Use the route frozen by the service before building messages.
        const target = deliveryTarget ?? options.loadGeneralSettings().proactiveDeliveryTarget;
        const sessionId = target === "local"
          ? generationDeliveryContext?.conversationId ?? (await chatsStore.listSessions()).find((session) => session.purpose === "proactive-chat")?.id
          : undefined;
        // Like ordinary channel Chat, external routes use the default profile.
        // Their channel:<...> history IDs are not desktop Chat records, and
        // sharing desktop history does not currently inherit its model binding.
        const session = sessionId ? await chatsStore.getSessionRecord(sessionId) : null;
        if (sessionId && !session) return { kind: "error", reason: "session_unavailable" };
        // A not-yet-created local proactive conversation follows Chat's default
        // profile chain without creating a session just to generate a candidate.
        const settings = resolveSessionModelSettings(loadModelSettings(), session ?? {});
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
      requiresDurableIntent: () => true,
      getDeliveryContext: () => generationDeliveryContext,
      getDeliveryTarget: () => options.loadGeneralSettings().proactiveDeliveryTarget,
      commitMessage: commitSelectedProactiveMessage,
      log: (event, detail) => {
        const info = detail as { reason?: string; scene?: string } | undefined;
        const state = event === "message_committed" ? "sent"
          : event === "model_silent" ? "silent"
          : event === "fallback_unavailable" || event === "evaluation_failed" || event === "message_delivery_incomplete" ? "failed"
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
      getAdditionalCandidates: async ctx => {
        const companion = await getRelationshipStore().snapshot();
        const target = options.loadGeneralSettings().proactiveDeliveryTarget;
        const route = target === "local" ? null : getProactiveChannelAvailability(target, channelManager);
        const ids = route?.available ? [route.recipient.conversationId ?? route.recipient.sessionId]
          : target === "local" ? [...new Set((companion.followups ?? []).map(item => item.conversationId))] : [];
        return [...relationshipOpportunities(companion.relationship, ctx),
          ...ids.flatMap(id => followupOpportunities(companion.followups ?? [], companion.relationship, id, ctx))];
      },
      onExplanation: explanation => { proactiveStatus.explanation = explanation; },
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
