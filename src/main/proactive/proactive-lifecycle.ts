import { relationshipOpportunities } from "./relationship-opportunities";
import { followupIdFromScene, followupOpportunities } from "./followup-opportunities";
import { createCompanionLifeStore, type CompanionDeliveryReviewStatus, type CompanionLifeObservationKind, type CompanionLifeStore, type CompanionMoment } from "./companion-life";
import { withConversationRun } from "../orchestrator/conversation-run-guard";
import { buildPersonaContractPrompt } from "../persona/persona-spec";
import { buildRelationshipContext, getRelationshipStore, recordCompanionEvent } from "../relationship/relationship-log";
import { app, powerMonitor } from "electron";
import path from "node:path";
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
import { canCommitProactiveMessage, canStartProactiveGeneration, getGlobalProactiveIntervalMs } from "./proactive-policy";
import { loadProactiveState, saveProactiveState } from "./proactive-state-store";
import { createProactiveTrigger, getZonedDateParts, type ProactiveOpportunity, type ProactiveTriggerController } from "./proactive-trigger";
import { runProactiveModel } from "./proactive-model";
import { DEFAULT_PROACTIVE_TARGET_SCORE } from "../../shared/preferences";
import type { ProactiveCandidate, ProactiveEvaluationStatus, ProactiveRuntimeSnapshot, ProactiveDeliveryContext } from "./proactive-types";
import { getSharedXilianWorldStore, type XilianWorldStore } from "../xilian-world/world-store";
import { buildXilianLifeSnapshot, formatXilianLifeContext } from "../xilian-world/life-context";
import type { XilianTimelineEvent, XilianWorldState, XilianWorldView } from "../../shared/xilian-world";
import { createAmphoreusRuntime } from "../amphoreus-world/runtime";

export interface ProactiveLifecycleOptions {
  loadGeneralSettings: () => GeneralSettings;
  conversationJournal: ConversationJournalService;
}

export interface ProactiveLifecycle {
  initializeProactiveChatService: () => void;
  initializeProactiveTrigger: () => void;
  stopProactiveTrigger: () => void;
  startWorld: () => void;
  stopWorld: () => void;
  getProactiveChatService: () => ProactiveChatService | null;
  getProactiveStatus: () => ProactiveEvaluationStatus;
  getWorldSnapshot: (input?: { now?: number; timezone?: string }) => XilianWorldState;
  queryWorldTimeline: (input?: { dateKey?: string; from?: number; to?: number; limit?: number; order?: "asc" | "desc" }) => XilianTimelineEvent[];
  getWorldView: (input?: { now?: number; timezone?: string; limit?: number }) => XilianWorldView;
  setWorldNarrativeEnabled: (enabled: boolean) => void;
  enqueueCompanionMoment: (moment: Omit<CompanionMoment, "status">) => CompanionMoment;
  observeCompanionActivity: (kind: CompanionLifeObservationKind) => void;
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
  const lifeStore: CompanionLifeStore = createCompanionLifeStore(path.join(app.getPath("userData"), "companion-life.json"));
  const worldStore: XilianWorldStore = getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json"));
  const amphoreus = createAmphoreusRuntime(worldStore);
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
    // Proactive timing must not inherit the Web renderer's activity clock.
    // `web:user-activity` is useful for renderer/session idle UX, but viewing a
    // page must not suppress an unsolicited message. Use conversation/channel
    // messages as the only proactive activity signal; screen lock remains a
    // separate hard delivery gate below.
    const idleSec = lastMessageActivityAt === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor((now - lastMessageActivityAt) / 1000));
    const timezone = resolveChatContextTimezone(loadUserProfile().timezone);
    const zoned = getZonedDateParts(new Date(now), timezone);
    const settings = options.loadGeneralSettings();
    return {
      now,
      // The server's system timezone can differ from the user's timezone.
      // Policy quiet hours must use the same clock as candidate selection.
      localHour: zoned.hour,
      localMinute: zoned.minute,
      localDate: `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`,
      quietStartMinute: settings.proactiveQuietStartMinute,
      quietEndMinute: settings.proactiveQuietEndMinute,
      dailyLimit: settings.proactiveDailyLimit,
      idleSec,
      enabled: settings.proactiveChatMode === "on" && !getRelationshipStore().getControls().paused,
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
    const moment = candidate.momentId ? lifeStore.listPending(Date.now()).find(item => item.id === candidate.momentId) : undefined;
    if (candidate.momentId && !moment) throw new Error("companion_moment_not_pending");
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
    const lifeState = lifeStore.getState({ now: snapshot.now, dateKey: lifeDateKey(snapshot.now) });
    // 用户有效时区：resolver 校验后传给 prompt，禁止未校验的 profile.timezone。
    const profile = loadUserProfile();
    const timezone = resolveChatContextTimezone(profile.timezone);
    const worldState = worldStore.advance({
      now: snapshot.now,
      timezone,
      companion: { energy: lifeState.energy, curiosity: lifeState.curiosity, boredom: lifeState.boredom },
    });
    const worldTimeline = worldStore.queryTimeline({ dateKey: worldState.worldDate, order: "desc", limit: 8 });
    const worldSnapshot = buildXilianLifeSnapshot({
      state: worldState,
      world: worldStore.worldView().amphoreus,
      timeline: worldTimeline,
      now: snapshot.now,
      timezone,
      energy: lifeState.energy,
    });
    return buildProactiveMessages({
      basePersona: buildProactivePersonaPrompt() + "\n\n" + await buildRelationshipContext(historyTarget?.conversationId ?? historyTarget?.sessionId ?? "proactive-local"),
      userProfile: profileContext,
      relevantMemory: [memoryContext, followup ? `用户明确设置的本轮跟进事项：${JSON.stringify(followup.topic)}。只自然关心这件事的近况，不推测结果、不催促、不声称已做任何操作；没有合适话题时可保持安静。` : "", moment ? `这是一条已筛选的陪伴心事，请自然判断是否分享：${moment.summary}` : ""].filter(Boolean).join("\n\n"),
      ordinaryHistory: histories.ordinary,
      proactiveHistory: histories.proactive,
      sceneId: candidate.sceneId,
      localNow: new Date(snapshot.now),
      idleSec: snapshot.idleSec,
      unansweredCount: state.unansweredCount,
      timezone,
      ...(moment ? { momentContext: moment.summary } : {}),
      lifeContext: `${formatXilianLifeContext(worldSnapshot)}\n好奇 ${lifeState.curiosity}/100；无聊 ${lifeState.boredom}/100。`,
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
      const now = Date.now();
      lastMessageActivityAt = now;
      bestEffortConversationStateUpdate("life_user_message", () => lifeStore.observeInteraction({ kind: "user_message", now, dateKey: lifeDateKey(now) }));
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

  function recordProactiveDeliveryMetadata(input: ProactiveCommitInput, result: ProactiveCommitResult): void {
    // Opener 的 todayFired/recentItems 字段已整体废弃（依赖的 SCENE_CONFIGS 与 ShowBubblePayload 来自旧 opener 子系统）。
    // 完整送达才消费心事；部分/未知送达写入明确的复核终态，避免重试造成重复消息。
    try {
      const now = Date.now();
      if (!input.candidate.momentId) return;
      const reviewStatus: CompanionDeliveryReviewStatus | undefined = result.kind === "committed" && (result.deliveryStatus === "unknown" || result.deliveryStatus === "failed" || result.deliveryStatus === "cancelled")
        ? result.deliveryStatus === "unknown" ? "delivery_unknown" : "delivery_partial"
        : result.kind === "cancelled" && result.deliveryStatus === "unknown" ? "delivery_unknown" : undefined;
      if (reviewStatus) {
        lifeStore.markDeliveryReview(input.candidate.momentId, reviewStatus, {
          deliveryStatus: result.deliveryStatus === "unknown" ? "unknown" : "failed",
          ...(result.reason ? { error: result.reason } : {}),
          now,
        });
        return;
      }
      if (result.kind === "committed" && lifeStore.consume(input.candidate.momentId, "consumed", { now, dateKey: lifeDateKey(now) })) {
        void recordCompanionEvent({
          eventId: `moment-shared:${input.candidate.momentId}`,
          kind: "moment_shared",
          source: "system",
          occurredAt: input.intentAt ?? Date.now(),
          summary: "昔涟分享了一条经过筛选的陪伴心事",
          ...(input.deliveryContext?.conversationId ? { conversationId: input.deliveryContext.conversationId } : {}),
        }).catch((error) => console.warn("[Proactive] 羁绊分享事件写入失败", error));
      }
    } catch (error) {
      // Delivery is already authoritative. A metadata write failure must not
      // leave the durable intent in a retryable state and send the same text twice.
      console.warn("[Proactive] companion moment delivery metadata failed", error);
    }
  }

  function lifeDateKey(now: number): string {
    const timezone = resolveChatContextTimezone(loadUserProfile().timezone);
    const date = getZonedDateParts(new Date(now), timezone);
    return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
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
          // A delivery adapter may report all observed parts while still
          // marking the final acknowledgement unknown; that remains a review
          // state until the adapter confirms it explicitly.
          const allDelivered = channelResult.kind === "committed"
            && channelResult.deliveredParts === channelResult.totalParts
            && !channelResult.deliveryStatus;
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
            : { kind: "cancelled" as const, reason: channelResult.reason, ...(channelResult.deliveryStatus ? { deliveryStatus: channelResult.deliveryStatus } : {}) };
        });
      },
    });

    recordProactiveDeliveryMetadata(input, result);
    if (result.kind === "committed") {
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
        const opportunities: ProactiveOpportunity[] = [...relationshipOpportunities(companion.relationship, ctx),
          ...ids.flatMap(id => followupOpportunities(companion.followups ?? [], companion.relationship, id, ctx))];
        const lifeState = lifeStore.refreshState({ now: ctx.now, dateKey: ctx.localDate });
        const timezone = resolveChatContextTimezone(loadUserProfile().timezone);
        const worldState = worldStore.advance({
          now: ctx.now,
          timezone,
          companion: { energy: lifeState.energy, curiosity: lifeState.curiosity, boredom: lifeState.boredom },
        });
        const worldTimeline = worldStore.queryTimeline({ dateKey: worldState.worldDate, order: "desc", limit: 8 });
        const worldSnapshot = buildXilianLifeSnapshot({ state: worldState, timeline: worldTimeline, now: ctx.now, timezone, energy: lifeState.energy });
        lifeStore.ensureDailyFictionalMoment({
          enabled: companion.relationship.innerLifeEnabled && companion.relationship.proactiveLifeEnabled,
          conversationId: route?.available ? (route.recipient.conversationId ?? route.recipient.sessionId) : undefined,
          summary: `【虚构角色小记】${worldSnapshot.currentActivity}。${worldSnapshot.mood}。下一计划：${worldSnapshot.nextPlan}。这是昔涟在翁法罗斯延续世界线中的生活记录，不是现实地点或真实行程。`,
          now: ctx.now,
          dateKey: ctx.localDate,
        });
        lifeStore.ensureIdleMoment({
          enabled: companion.relationship.innerLifeEnabled && companion.relationship.proactiveLifeEnabled && !companion.relationship.paused,
          dateKey: ctx.localDate,
          now: ctx.now,
          idleSec: ctx.snapshot.idleSec,
          conversationId: route?.available ? (route.recipient.conversationId ?? route.recipient.sessionId) : undefined,
        });
        const pluginSharingEnabled = options.loadGeneralSettings().companionPluginSharingEnabled;
        const innerLifeEnabled = companion.relationship.innerLifeEnabled;
        const lifeMoment = !companion.relationship.paused && companion.relationship.proactiveLifeEnabled
          ? lifeStore.getNextShareable({
            now: ctx.now,
            dateKey: ctx.localDate,
            allow: item => (item.source !== "plugin" || pluginSharingEnabled) && (item.source !== "system" || innerLifeEnabled),
          })
          : undefined;
        if (lifeMoment) opportunities.push({
          sceneId: `life:${lifeMoment.id}`,
          score: lifeMoment.kind === "ask" ? 64 : lifeMoment.source === "plugin" ? 70 : 66,
          sceneCooldownMs: 24 * 60 * 60_000,
          reason: lifeMoment.kind === "ask" ? "虚拟日常积累了一点无聊感，是否轻轻问候由模型判断" : "有一条已筛选的虚拟日常或插件心事，是否值得轻轻分享由模型判断",
          momentId: lifeMoment.id,
          momentSummary: lifeMoment.summary,
        });
        // Daytime companionship should have a path even when there is no
        // morning/evening edge, work-break edge, plugin item, or named
        // follow-up. This candidate is deliberately low priority: concrete
        // conversations and life moments win first, while the hard policy,
        // unanswered guard, model silent decision, and daily cap still apply.
        const hasSpecificOpportunity = opportunities.some((item) => item.sceneId.startsWith("followup:") || item.sceneId.startsWith("life:") || item.sceneId === "relationship_milestone" || item.sceneId === "shared_goal_checkin");
        if (!hasSpecificOpportunity && ctx.localHour >= 8 && ctx.localHour < 22) {
          opportunities.push({
            sceneId: "ambient_companion",
            score: 64,
            sceneCooldownMs: Math.max(60 * 60_000, getGlobalProactiveIntervalMs(ctx.snapshot.dailyLimit) * 2),
            reason: "白天没有更具体的触发点，留出一次轻量陪伴机会；是否发送仍由模型判断",
          });
        }
        return opportunities;
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
    setWorldNarrativeEnabled: (enabled) => amphoreus.setNarrativeEnabled(enabled),
    startWorld: () => amphoreus.start(),
    stopWorld: () => amphoreus.stop(),
    initializeProactiveChatService,
    initializeProactiveTrigger,
    stopProactiveTrigger,
    getProactiveChatService: () => proactiveChatService,
    getWorldSnapshot: (input = {}) => {
      const now = input.now ?? Date.now();
      const timezone = input.timezone ?? resolveChatContextTimezone(loadUserProfile().timezone);
      const lifeState = lifeStore.getState({ now, dateKey: lifeDateKey(now) });
      return worldStore.advance({ now, timezone, companion: { energy: lifeState.energy, curiosity: lifeState.curiosity, boredom: lifeState.boredom } });
    },
    queryWorldTimeline: (input = {}) => worldStore.queryTimeline(input),
    getWorldView: (input = {}) => {
      const state = ((): XilianWorldState => {
        const now = input.now ?? Date.now();
        const timezone = input.timezone ?? resolveChatContextTimezone(loadUserProfile().timezone);
        const lifeState = lifeStore.getState({ now, dateKey: lifeDateKey(now) });
        return worldStore.advance({ now, timezone, companion: { energy: lifeState.energy, curiosity: lifeState.curiosity, boredom: lifeState.boredom } });
      })();
      return worldStore.worldView({ dateKey: state.worldDate, limit: input.limit ?? 80 });
    },
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
    enqueueCompanionMoment: (moment) => lifeStore.enqueue(moment),
    observeCompanionActivity: (kind) => {
      const now = Date.now();
      lifeStore.observeInteraction({ kind, now, dateKey: lifeDateKey(now) });
    },
    proactiveConversationLifecycle,
  };
}
