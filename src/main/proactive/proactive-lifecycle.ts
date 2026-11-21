import { canAskAboutRecentWellbeing, relationshipOpportunities, standaloneCareOpportunity, standaloneCareWindowDate, STANDALONE_CARE_SCENE, userCareOpportunity } from "./relationship-opportunities";
import { followupIdFromScene, followupOpportunities } from "./followup-opportunities";
import { createCompanionLifeStore, type CompanionDeliveryReviewStatus, type CompanionLifeObservationKind, type CompanionLifeStore, type CompanionMoment } from "./companion-life";
import { withConversationRun } from "../orchestrator/conversation-run-guard";
import { buildPersonaContractPrompt } from "../persona/persona-spec";
import { buildRelationshipContext, getRelationshipStore, recordCompanionEvent } from "../relationship/relationship-log";
import { app, powerMonitor } from "electron";
import path from "node:path";
import { createHash } from "node:crypto";
import * as chatsStore from "../chats/chats-store";
import { broadcastChatsChanged } from "../chats/chats-ipc";
import type { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { setChannelsConversationLifecycle } from "../channels/init";
import { channelManager } from "../channels/manager";
import { getChannelRecoveryStore } from "../channels/recovery-store";
import { isGroupBoundConversation } from "../channels/conversation-binding-store";
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
import { buildProactiveComposeMessages, buildProactiveMessages, repeatsRecentProactiveMessage, restatesRecentReply, type ProactiveHistoryTurn } from "./proactive-prompt";
import { canCommitProactiveMessage, canStartProactiveGeneration } from "./proactive-policy";
import { loadProactiveState, saveProactiveState } from "./proactive-state-store";
import { createProactiveTrigger, formatLocalDate, getZonedDateParts, type ProactiveOpportunity, type ProactiveTriggerController } from "./proactive-trigger";
import { runProactiveModel } from "./proactive-model";
import { DEFAULT_PROACTIVE_TARGET_SCORE, normalizeProactiveDensity } from "../../shared/preferences";
import { InitiativeOpportunityStore, type InitiativeOpportunityInput } from "./initiative-opportunities";
import { worldInitiativeOpportunities, boredomInitiativeOpportunity, relatedConversationOpportunity } from "./world-initiative";
import type { ProactiveCandidate, ProactiveEvaluationStatus, ProactiveRuntimeSnapshot, ProactiveDeliveryContext } from "./proactive-types";
import { getSharedXilianWorldStore, type XilianWorldStore } from "../xilian-world/world-store";
import type { ChatMessage } from "../../shared/chat-types";
import type { XilianTimelineEvent, XilianWorldState, XilianWorldView } from "../../shared/xilian-world";
import { createAmphoreusRuntime } from "../amphoreus-world/runtime";
import { buildChannelSystem, buildRecentPhrasingHint, PRIVATE_CHAT_EXPRESSION } from "../orchestrator/expression-context-core";
import { buildPersonMemoryContext } from "../social-context/context";
import type { SocialAtom } from "../social-context/types";
import type { RelationshipChannel } from "../relationship/relationship-log-core";
import { isMemoryFollowupAtomOpen, MEMORY_FOLLOWUP_SOURCE, memoryFollowupOpportunities } from "./memory-initiative";
import { createGeneratedImageStore } from "../chats/generated-image-store";
import { buildXilianLifeSnapshot, buildXilianSelfiePrompt } from "../xilian-world/life-context";
import { listXilianReferenceImages } from "../persona/xilian-reference-images";
import { getSharedSelfieLog, normalizeSelfieFrequency, relationshipAllowsSelfie } from "../persona/xilian-selfie-moments";
import { generateProactiveSelfie, SELFIE_CAPTION_NOTE, SELFIE_SOURCE, selfieOpportunity, selfieSlot } from "./proactive-selfie";

export interface ProactiveLifecycleOptions {
  loadGeneralSettings: () => GeneralSettings;
  conversationJournal: ConversationJournalService;
  /** What she remembers about the person in a conversation (chat social atoms). */
  listPersonMemory?: (conversationId: string, now: number) => SocialAtom[];
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
  retryWorldNarrative: () => void;
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
  const initiativeStore = new InitiativeOpportunityStore(path.join(app.getPath("userData"), "initiative-opportunities.json"));
  const worldStore: XilianWorldStore = getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json"));
  const amphoreus = createAmphoreusRuntime(worldStore);
  const generatedImageStore = createGeneratedImageStore({ rootDirectory: path.join(app.getPath("userData"), "chat-media", "generated-images") });
  const selfieLog = getSharedSelfieLog(path.join(app.getPath("userData"), "xilian-selfies.json"));
  let normalConversationBusyCount = 0;
  let proactiveScreenLocked = false;
  let lastMessageActivityAt: number | null = null;
  let generationRelationshipRevision: number | undefined;
  let generationRecipient: RecentProactiveChannelRecipient | undefined;
  let generationDeliveryContext: ProactiveDeliveryContext | undefined;
  let generationShares: {
    history: ProactiveHistoryTurn[]; ordinary: ProactiveHistoryTurn[]; worldShare: boolean; careStale?: boolean;
    /** Material for the compose step, frozen with the decision prompt. */
    compose?: { persona: string; personMemory: string; history: ProactiveHistoryTurn[]; timezone: string; replyBurden?: ProactiveCandidate["replyBurden"] };
    /** 主动自拍：先生成图片，再写配文。 */
    selfie?: { scene: string; conversationId: string };
  } = { history: [], ordinary: [], worldShare: false };
  let lastOutcome: ProactiveEvaluationStatus["lastOutcome"];
  let proactiveStatus: ProactiveEvaluationStatus = {
    candidateScore: null,
    targetScore: DEFAULT_PROACTIVE_TARGET_SCORE,
    sceneId: null,
    evaluatedAt: null,
    state: "no_candidate",
  };

  function initiativeCandidate(opportunity: InitiativeOpportunityInput, key?: string): ProactiveCandidate {
    return {
      sceneId: opportunity.sceneId ?? opportunity.id, score: opportunity.score ?? 70,
      sceneCooldownMs: opportunity.sceneCooldownMs ?? 0,
      ...(key ? { opportunityId: key } : {}),
      sourceEventId: opportunity.sourceEventId, evidenceVersion: String(opportunity.evidenceVersion),
      replyBurden: opportunity.replyBurden, momentSummary: opportunity.summary,
      ...(opportunity.momentId ? { momentId: opportunity.momentId } : {}),
    };
  }

  function imageGenerationSettings(): { enabled: boolean; model: string } | undefined {
    const image = resolveSessionModelSettings(loadModelSettings(), {}).imageGeneration;
    return image?.enabled && image.model.trim() ? image : undefined;
  }

  function currentLifeSnapshot(now: number): ReturnType<typeof buildXilianLifeSnapshot> | undefined {
    try {
      const timezone = resolveChatContextTimezone(loadUserProfile().timezone);
      const state = worldStore.advance({ now, timezone });
      const timeline = worldStore.queryTimeline({ dateKey: state.worldDate, order: "desc", limit: 8 });
      return buildXilianLifeSnapshot({ state, timeline, now, timezone, world: worldStore.worldView().amphoreus });
    } catch (error) {
      console.warn("[XilianSelfie] 生活快照读取失败", error);
      return undefined;
    }
  }

  function validateInitiative(candidate: ProactiveCandidate): string | undefined {
    if (!candidate.opportunityId) return undefined;
    const opportunity = initiativeStore.find(candidate.opportunityId);
    if (!opportunity || ["dropped", "expired"].includes(opportunity.status)) return "opportunity_unavailable";
    if (opportunity.source === "moment:plugin" && !options.loadGeneralSettings().companionPluginSharingEnabled) return "plugin_sharing_disabled";
    const target = options.loadGeneralSettings().proactiveDeliveryTarget;
    if (opportunity.conversationId && target !== "local") {
      const route = getProactiveChannelAvailability(target, channelManager);
      if (!route.available || opportunity.conversationId !== (route.recipient.conversationId ?? route.recipient.sessionId)) return "opportunity_recipient_changed";
    }
    // A sent source can only be replayed through its already durable intent.
    if (["sent", "delivery_review", "delivery_partial", "delivery_unknown"].includes(opportunity.status)) {
      return loadProactiveState().pendingCommitIntent?.candidate.opportunityId === candidate.opportunityId ? undefined : "opportunity_consumed";
    }
    if (opportunity.expiresAt <= Date.now()) return "opportunity_expired";
    if (opportunity.source === "user_care") {
      if (!opportunity.conversationId || isGroupBoundConversation(opportunity.conversationId)) return "care_source_private_chat_required";
      const timezone = resolveChatContextTimezone(loadUserProfile().timezone);
      const now = Date.now();
      if (!canAskAboutRecentWellbeing(opportunity.occurredAt, now, getZonedDateParts(new Date(now), timezone).hour)) return "care_source_time_not_suitable";
    }
    if (opportunity.source === STANDALONE_CARE_SCENE) {
      if (!opportunity.conversationId || isGroupBoundConversation(opportunity.conversationId)) return "care_source_private_chat_required";
      const clock = getProactiveRuntimeSnapshot();
      if (standaloneCareWindowDate(clock.localDate, clock.localHour) !== opportunity.evidenceVersion) return "care_source_time_not_suitable";
      if (loadProactiveState().unansweredCount !== 0) return "unanswered_limit";
    }
    if (opportunity.source === "amphoreus") {
      const personal = worldStore.worldView().amphoreus?.personal;
      if (!personal?.changes.some(change => change.eventId === opportunity.sourceEventId && String(change.version) === String(opportunity.evidenceVersion))) return "world_source_changed";
    }
    if (opportunity.source === SELFIE_SOURCE) {
      if (!opportunity.conversationId || isGroupBoundConversation(opportunity.conversationId)) return "selfie_private_chat_required";
      if (!imageGenerationSettings()) return "selfie_image_generation_disabled";
      if (selfieSlot(getProactiveRuntimeSnapshot().localHour) !== opportunity.evidenceVersion) return "selfie_time_not_suitable";
    }
    if (["inner_life", "shared_interest"].includes(opportunity.source) && worldStore.worldView().amphoreus?.personal?.currentActivity?.eventId !== opportunity.sourceEventId) return "life_activity_changed";
    // 对方已经说了结果（提取器关闭了这条），就不再问。
    if (opportunity.source === MEMORY_FOLLOWUP_SOURCE && opportunity.conversationId
      && !isMemoryFollowupAtomOpen(options.listPersonMemory?.(opportunity.conversationId, Date.now()).find(atom => atom.id === opportunity.sourceEventId), Date.now())) return "memory_resolved";
    const controls = getRelationshipStore().getControls();
    if (controls.paused) return "relationship_paused";
    return undefined;
  }

  function buildProactivePersonaPrompt(): string {
    const parts: string[] = [buildPersonaContractPrompt()];
    const soul = loadPromptFile("soul.md");
    if (soul) {
      // 主动轮完全不携带工具说明；Soul 尾部的 Live2D/联网章节由正常聊天使用。
      parts.push(soul.split("\n## Live2D 与聊天文字的分工")[0].trim());
    }
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

  function isProactiveMessage(message: ChatMessage): boolean {
    return message.role === "model" && /^proactive-intent-\d+$/.test(message.runSnapshot?.runId ?? "");
  }

  async function getProactiveHistories(recipient?: RecentProactiveChannelRecipient): Promise<{ ordinary: ProactiveHistoryTurn[]; proactive: ProactiveHistoryTurn[]; conversationId?: string; careAllowed: boolean }> {
    if (recipient) {
      const conversationId = recipient.conversationId ?? recipient.sessionId;
      const { messages } = await conversationJournal.readProjection(conversationId);
      return {
        ordinary: toProactiveHistory(messages.filter(message => !isProactiveMessage(message))),
        proactive: toProactiveHistory(messages.filter(isProactiveMessage)),
        careAllowed: !isGroupBoundConversation(conversationId) && !messages.some(message => message.channelSource?.chatType === "group"),
        conversationId,
      };
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
      ordinary: toProactiveHistory(ordinaryProjection?.messages.filter(message => !isProactiveMessage(message)) ?? []),
      proactive: toProactiveHistory(proactiveProjection?.messages ?? []),
      careAllowed: !!ordinaryMeta && !ordinaryMeta.purpose && ordinaryMeta.mode === "chat" && !isGroupBoundConversation(ordinaryMeta.id)
        && !ordinaryProjection?.messages.some(message => message.channelSource?.chatType === "group"),
      ...(ordinaryMeta ? { conversationId: ordinaryMeta.id } : {}),
    };
  }

  function getProactiveRuntimeSnapshot(): ProactiveRuntimeSnapshot & { timezone: string } {
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
      timezone,
      // The server's system timezone can differ from the user's timezone.
      // Policy quiet hours must use the same clock as candidate selection.
      localHour: zoned.hour,
      localMinute: zoned.minute,
      localDate: formatLocalDate(new Date(now), timezone),
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

  function isDraftTimeCurrent(context: ProactiveDeliveryContext, snapshot: ProactiveRuntimeSnapshot): boolean {
    if (context.composedAt === undefined || context.timezone === undefined) return true;
    if (context.timezone !== snapshot.timezone || snapshot.now < context.composedAt || snapshot.now - context.composedAt > 5 * 60_000) return false;
    const drafted = new Date(context.composedAt);
    const { hour, minute } = getZonedDateParts(drafted, context.timezone);
    const elapsedMinutes = Math.floor(snapshot.now / 60_000) - Math.floor(context.composedAt / 60_000);
    return formatLocalDate(drafted, context.timezone) === snapshot.localDate
      && hour === snapshot.localHour && minute + elapsedMinutes === snapshot.localMinute;
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
    const initiative = candidate.opportunityId ? initiativeStore.find(candidate.opportunityId) : undefined;
    const standaloneCare = initiative?.source === STANDALONE_CARE_SCENE;
    const localConversationId = followup?.conversationId ?? moment?.conversationId ?? initiative?.conversationId;
    const historyTarget = generationRecipient ?? (localConversationId ? { conversationId: localConversationId, sessionId: localConversationId, targetId: "", updatedAt: 0 } : undefined);
    generationDeliveryContext = { relationshipRevision: companion.revision,
      ...(historyTarget ? { conversationId: historyTarget.conversationId ?? historyTarget.sessionId } : {}),
      ...(generationRecipient ? { sessionId: generationRecipient.sessionId, targetId: generationRecipient.targetId, ...(generationRecipient.threadId ? { threadId: generationRecipient.threadId } : {}) } : {}),
      ...(followupId ? { followupId } : {}) };
    const histories = await getProactiveHistories(historyTarget);
    generationShares = { history: histories.proactive, ordinary: histories.ordinary, worldShare: initiative?.source === "amphoreus" || candidate.sceneId.startsWith("world:") };
    const recentTopic = histories.ordinary.slice(-4).map((turn) => turn.content).join("\n");
    const retrievalQuery = `${candidate.sceneId}\n${recentTopic}`.trim();
    const [profileContext, memoryContext] = standaloneCare ? ["", ""] : await Promise.all([
      buildAlwaysOnContext(retrievalQuery, histories.ordinary.map((turn) => ({ role: turn.role, content: turn.content }))).catch(() => ""),
      buildMemoryInjection(retrievalQuery).catch(() => ""),
    ]);
    const relationshipContext = await buildRelationshipContext(historyTarget?.conversationId ?? historyTarget?.sessionId ?? "proactive-local", true, undefined, false, false);
    const state = loadProactiveState();
    const snapshot = getProactiveRuntimeSnapshot();
    generationDeliveryContext.composedAt = snapshot.now;
    generationDeliveryContext.timezone = snapshot.timezone;
    const memoryConversationId = histories.conversationId ?? historyTarget?.conversationId;
    const personAtoms = memoryConversationId && histories.careAllowed ? options.listPersonMemory?.(memoryConversationId, snapshot.now) ?? [] : [];
    const personMemory = buildPersonMemoryContext(personAtoms, retrievalQuery, { now: snapshot.now, timezone: snapshot.timezone }).contextBlock;
    const rememberedAtom = initiative?.source === MEMORY_FOLLOWUP_SOURCE ? personAtoms.find(atom => atom.id === initiative.sourceEventId) : undefined;
    if (initiative?.source === MEMORY_FOLLOWUP_SOURCE && !isMemoryFollowupAtomOpen(rememberedAtom, snapshot.now)) generationShares.careStale = true;
    const channelSystem = target === "local" ? "" : buildChannelSystem(target as RelationshipChannel);
    generationShares.compose = {
      persona: [buildProactivePersonaPrompt(), channelSystem, PRIVATE_CHAT_EXPRESSION, relationshipContext,
        buildRecentPhrasingHint([...histories.ordinary, ...histories.proactive].sort((a, b) => a.at - b.at).map(turn => ({ role: turn.role, content: turn.content })), companion.relationship.userLabel)]
        .filter(part => part?.trim()).join("\n\n---\n\n"),
      personMemory,
      history: [...histories.ordinary, ...histories.proactive],
      timezone: snapshot.timezone,
      replyBurden: candidate.replyBurden,
    };
    if (initiative?.source === SELFIE_SOURCE) {
      const life = currentLifeSnapshot(snapshot.now);
      generationShares.selfie = {
        scene: life ? buildXilianSelfiePrompt(life) : "生成昔涟一张日常生活自拍，单人物、竖构图、脸部清晰。",
        conversationId: generationDeliveryContext.conversationId ?? historyTarget?.sessionId ?? "proactive-local",
      };
      if (!histories.careAllowed) generationShares.careStale = true;
    }
    const lastUser = histories.ordinary.filter(turn => turn.role === "user").at(-1);
    if (standaloneCare) {
      generationShares.careStale = !companion.relationship.proactiveLifeEnabled || !histories.careAllowed
        || standaloneCareOpportunity(lastUser, histories.conversationId, {
          now: snapshot.now, localDate: snapshot.localDate, localHour: snapshot.localHour, lastActivity: histories.ordinary.at(-1)?.at,
        })?.evidenceVersion !== initiative.evidenceVersion;
    } else if (initiative?.source === "user_care") {
      generationShares.careStale = !histories.careAllowed || userCareOpportunity(lastUser, histories.conversationId, snapshot.now)?.evidenceVersion !== initiative.evidenceVersion;
    }
    const careContext = followup ? { kind: "requested_followup" as const, at: followup.nextEligibleAt, topic: followup.topic }
      : initiative?.source === "user_care" ? { kind: "user_message" as const, at: initiative.occurredAt }
      : rememberedAtom ? { kind: "remembered" as const, at: rememberedAtom.createdAt, topic: rememberedAtom.content }
      : standaloneCare ? { kind: "standalone_care" as const }
      : undefined;
    return buildProactiveMessages({
      basePersona: buildProactivePersonaPrompt() + "\n\n" + relationshipContext,
      userProfile: profileContext,
      relevantMemory: [careContext ? "" : memoryContext, personMemory].filter(part => part?.trim()).join("\n\n"),
      ordinaryHistory: standaloneCare ? [] : histories.ordinary,
      proactiveHistory: histories.proactive,
      sceneId: candidate.sceneId,
      localNow: new Date(snapshot.now),
      idleSec: snapshot.idleSec,
      unansweredCount: state.unansweredCount,
      replyBurden: candidate.replyBurden,
      timezone: snapshot.timezone,
      careContext,
      ...((moment?.summary ?? candidate.momentSummary) ? { momentContext: moment?.summary ?? candidate.momentSummary } : {}),
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
      bestEffortConversationStateUpdate("initiative_user_activity", () => initiativeStore.suspend(now));
      bestEffortConversationStateUpdate("life_user_message", () => lifeStore.observeInteraction({ kind: "user_message", now, dateKey: lifeDateKey(now) }));
      bestEffortConversationStateUpdate("user_message", () => proactiveChatService?.invalidateForUserMessage());
    },
    onConversationStarted: () => {
      updateNormalConversationBusy(1);
      bestEffortConversationStateUpdate("initiative_conversation_busy", () => initiativeStore.suspend(Date.now()));
      bestEffortConversationStateUpdate("conversation_started", () => proactiveChatService?.normalConversationStarted());
    },
    onConversationEnded: () => {
      updateNormalConversationBusy(-1);
      if (normalConversationBusyCount === 0) {
        bestEffortConversationStateUpdate("initiative_user_returned", () => initiativeStore.resume("user_message", Date.now()));
        bestEffortConversationStateUpdate("conversation_ended", () => proactiveChatService?.normalConversationEnded());
      }
    },
  };

  function getProactiveCommitDecision(candidate: ProactiveCandidate, generationEpoch: number) {
    if (generationRelationshipRevision !== undefined && getRelationshipStore().getControls().revision !== generationRelationshipRevision) return { allowed: false, reason: "stale_epoch" as const };
    if (validateInitiative(candidate)) return { allowed: false, reason: "stale_epoch" as const };
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
    if (input.deliveryContext && !isDraftTimeCurrent(input.deliveryContext, getProactiveRuntimeSnapshot())) return { kind: "cancelled", reason: "draft_time_changed" };
    if (!getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed) return { kind: "cancelled", reason: "stale_epoch" };
    const sink = conversationJournal.createRunSink({ conversationId: session.id, runId });
    const assistantEntryId = await sink.appendAssistant({
      message: { role: "assistant", content: input.text, ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
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
        const operationId = `proactive:${runId}`;
        const assistantTurnId = `${runId}:assistant`;
        return withConversationRun(conversationId, async () => {
          // A prior outbox operation may already have sent some or all parts.
          // Allow receipt reconciliation while blocking any new stale sends.
          if (frozen && !isDraftTimeCurrent(frozen, getProactiveRuntimeSnapshot()) && !getChannelRecoveryStore()?.get(operationId)) {
            return { kind: "cancelled" as const, reason: "draft_time_changed" };
          }
          if (!getProactiveCommitDecision(input.candidate, input.generationEpoch).allowed) return { kind: "cancelled" as const, reason: "stale_epoch" };
          const current = getProactiveChannelAvailability(channel, channelManager);
          if (!current.available || current.recipient.targetId !== recipient.targetId || current.recipient.conversationId !== recipient.conversationId) return { kind: "cancelled" as const, reason: "binding_changed" };
          // CTA 是外发的前置事实：失败重试使用同一 intent、同一 assistant、同一 outbox。
          const sink = conversationJournal.createRunSink({ conversationId, runId, assistantTurnId });
          const messageId = await sink.appendAssistant({ message: { role: "assistant", content: input.text,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}) }, roundId: "proactive" });
          await conversationJournal.appendPresentationNext(conversationId, messageId, `${runId}:presentation`, {
            content: input.text, channelSource: { channel, chatType: "private" },
            runSnapshot: { runId, status: "terminal", updatedAt: input.intentAt ?? 0 },
          });
          const channelResult = await sendProactiveChannelMessage({
            operationId, assistantTurnId, runId,
            channel, text: input.text, mobileMessageSegmentation: settings.mobileMessageSegmentation,
            ...(input.attachments?.length ? { imagePaths: input.attachments.map(item => item.filePath) } : {}),
            manager: channelManager, recipient,
            // authoritative assistant already exists; callback never creates a second reply.
            recordDelivery: async () => undefined,
            canContinue: () => {
              if (frozen && !isDraftTimeCurrent(frozen, getProactiveRuntimeSnapshot())) return false;
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
    if (result.kind === "committed" && input.attachments?.length) {
      try { selfieLog.recordProactiveSent(input.deliveryContext?.conversationId, Date.now()); } catch (error) { console.warn("[XilianSelfie] 自拍记录写入失败", error); }
    }
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
      isDraftTimeCurrent,
      onDraftTimeChanged: (candidate, now) => {
        if (candidate.opportunityId) initiativeStore.requeue(candidate.opportunityId, now);
      },
      validateCandidate: validateInitiative,
      beforeModel: candidate => !candidate.opportunityId || initiativeStore.markAttempt(candidate.opportunityId, Date.now(), lifeDateKey(Date.now()), Math.min(60, Math.max(8, (options.loadGeneralSettings().proactiveDailyLimit ?? 3) * 2 + 4))),
      onOpportunityDecision: (candidate, decision, input) => {
        if (candidate.opportunityId) initiativeStore.resolve(candidate.opportunityId, decision, input);
      },
      buildMessages: async (candidate) => buildProactiveAgentMessages(candidate),
      runModel: async (messages, deliveryTarget) => {
        if (generationShares.careStale) return { kind: "drop" };
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
        const vendorSettings = {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          explicitTransport: settings.explicitTransport,
          reasoning: settings.reasoning,
          manualReasoning: settings.manualReasoning,
        };
        const decision = await runProactiveModel({ settings: vendorSettings, messages, timeoutMs: 45_000 });
        const compose = generationShares.compose;
        if (decision.kind !== "send" || !compose) return decision;
        const selfie = generationShares.selfie;
        let attachments: import("../../shared/generated-image").GeneratedImageAttachment[] | undefined;
        if (selfie) {
          const image = settings.imageGeneration?.enabled && settings.imageGeneration.model.trim() ? settings.imageGeneration : undefined;
          if (!image) return { kind: "drop" };
          try {
            const saved = await generateProactiveSelfie({
              config: vendorSettings, imageModel: image.model, conversationId: selfie.conversationId, store: generatedImageStore,
              scene: `${selfie.scene}\n她发这张自拍时想说的：${decision.text}`,
              referencePaths: listXilianReferenceImages([
                app.getPath("userData"),
                typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
                path.join(process.cwd(), "resources"),
              ]),
            });
            if (!saved) return { kind: "drop" };
            attachments = [saved];
            console.log("[XilianSelfie] 主动自拍已生成");
          } catch (error) {
            console.warn("[XilianSelfie] 主动自拍生成失败", error);
            return { kind: "error", reason: "selfie_generation_failed" };
          }
        }
        // Step two: write the message as an ordinary turn of this private chat.
        const result = await runProactiveModel({
          settings: vendorSettings,
          messages: buildProactiveComposeMessages({
            persona: compose.persona, personMemory: compose.personMemory, history: compose.history,
            plan: selfie ? `${decision.text}\n${SELFIE_CAPTION_NOTE}` : decision.text,
            localNow: new Date(), timezone: compose.timezone, replyBurden: compose.replyBurden,
          }),
          timeoutMs: 45_000,
          parse: "message",
        });
        if (result.kind === "invalid") return { kind: "error", reason: `compose_${result.reason}` };
        if (result.kind === "send" && (repeatsRecentProactiveMessage(result.text, generationShares.history, Date.now(), generationShares.worldShare)
          || restatesRecentReply(result.text, generationShares.ordinary, Date.now()))) {
          return { kind: "drop" };
        }
        return result.kind === "send" && attachments ? { ...result, attachments } : result;
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
      bestEffortConversationStateUpdate("initiative_lock", () => initiativeStore.suspend(Date.now()));
      proactiveChatService?.invalidate();
    });
    powerMonitor.on("unlock-screen", () => { proactiveScreenLocked = false; });
    powerMonitor.on("suspend", () => {
      proactiveScreenLocked = true;
      bestEffortConversationStateUpdate("initiative_suspend", () => initiativeStore.suspend(Date.now()));
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
      useEventOpportunitiesOnly: true,
      onSuppressed: snapshot => initiativeStore.suspend(snapshot.now),
      getPendingCandidate: () => loadProactiveState().pendingCommitIntent?.candidate,
      onCandidateSuppressed: candidate => {
        if (candidate.opportunityId) initiativeStore.resolve(candidate.opportunityId, "hold", { now: Date.now(), resumeOn: "user_message" });
      },
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
        const settings = options.loadGeneralSettings();
        const target = settings.proactiveDeliveryTarget;
        const route = target === "local" ? null : getProactiveChannelAvailability(target, channelManager);
        const conversationId = route?.available ? route.recipient.conversationId ?? route.recipient.sessionId : undefined;
        const ids = route?.available ? [route.recipient.conversationId ?? route.recipient.sessionId]
          : target === "local" ? [...new Set((companion.followups ?? []).map(item => item.conversationId))] : [];
        const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
        const opportunities: InitiativeOpportunityInput[] = relationshipOpportunities(companion.relationship, ctx).map(item => ({
          id: item.sceneId, source: "relationship", sourceEventId: item.sceneId === "relationship_milestone" ? `${item.sceneId}:${ctx.localDate}` : item.sceneId,
          evidenceVersion: hash(JSON.stringify(item.sceneId === "relationship_milestone" ? companion.relationship.milestones : companion.relationship.sharedGoals)),
          ...(conversationId ? { conversationId } : {}), motive: "connection", summary: item.reason,
          occurredAt: ctx.now, expiresAt: ctx.now + 6 * 3_600_000, strengthPerHour: 1, decayPerHour: 0.5,
          replyBurden: item.sceneId === "relationship_milestone" ? "none" : "question", ...item,
        }));
        for (const item of ids.flatMap(id => followupOpportunities(companion.followups ?? [], companion.relationship, id, ctx))) {
          const followup = companion.followups?.find(followup => followup.id === followupIdFromScene(item.sceneId));
          if (!followup) continue;
          opportunities.push({ id: item.sceneId, source: "followup", sourceEventId: item.sceneId,
            evidenceVersion: String(followup.nextEligibleAt), conversationId: followup.conversationId, motive: "followup",
            summary: `用户明确希望跟进的事项：${followup.topic}。只自然关心近况，不推测结果，不催答。`,
            occurredAt: ctx.now, expiresAt: ctx.now + 24 * 3_600_000, strengthPerHour: 2, decayPerHour: 0.1,
            replyBurden: "question", ...item });
        }
        worldStore.advance({ now: ctx.now, timezone: ctx.timezone });
        const world = worldStore.worldView().amphoreus;
        const personal = world?.personal;
        const lifeState = lifeStore.refreshState({ now: ctx.now, dateKey: ctx.localDate,
          ...(personal ? { energy: personal.energy, activity: personal.currentActivity?.activity === "rest" && personal.energy >= 55 ? "idle" : personal.currentActivity?.activity } : {}) });
        if (!companion.relationship.paused && companion.relationship.proactiveLifeEnabled) {
          if (ctx.state.unansweredCount === 0 && (route === null || route.available)) {
            const histories = await getProactiveHistories(route?.available ? route.recipient : undefined);
            const lastUser = histories.ordinary.filter(turn => turn.role === "user").at(-1);
            if (histories.careAllowed) {
              const care = userCareOpportunity(lastUser, histories.conversationId, ctx.now);
              if (care) opportunities.push(care);
              if (!care || !canAskAboutRecentWellbeing(care.occurredAt, ctx.now, ctx.localHour)) {
                const greeting = standaloneCareOpportunity(lastUser, histories.conversationId, {
                  now: ctx.now, localDate: ctx.localDate, localHour: ctx.localHour, lastActivity: histories.ordinary.at(-1)?.at,
                });
                if (greeting) opportunities.push(greeting);
              }
              if (histories.conversationId && options.listPersonMemory) {
                opportunities.push(...memoryFollowupOpportunities(options.listPersonMemory(histories.conversationId, ctx.now), ctx.now, histories.conversationId));
              }
              if (histories.conversationId && relationshipAllowsSelfie(companion.relationship) && imageGenerationSettings()
                && selfieLog.canSendProactive(normalizeSelfieFrequency(companion.relationship.selfieFrequency), ctx.now)) {
                const life = companion.relationship.innerLifeEnabled ? currentLifeSnapshot(ctx.now) : undefined;
                const selfie = selfieOpportunity({ now: ctx.now, localDate: ctx.localDate, localHour: ctx.localHour,
                  conversationId: histories.conversationId, location: life?.location, activity: life?.currentActivity });
                if (selfie) opportunities.push(selfie);
              }
            }
            if (companion.relationship.innerLifeEnabled && histories.conversationId) {
              const association = relatedConversationOpportunity(world, lastUser, ctx.now, histories.conversationId);
              if (association) opportunities.push(association);
            }
          }
          if (companion.relationship.innerLifeEnabled) {
            opportunities.push(...worldInitiativeOpportunities(world, ctx.now, conversationId));
            const bored = boredomInitiativeOpportunity(world, lifeState, ctx.now, conversationId);
            if (bored) opportunities.push(bored);
          }
          for (const moment of lifeStore.listPending(ctx.now)) {
            if (moment.id.startsWith("daily:") || moment.id.startsWith("idle:")) continue;
            if (moment.source === "plugin" && !settings.companionPluginSharingEnabled || moment.source === "system" && !companion.relationship.innerLifeEnabled) continue;
            if (conversationId && moment.conversationId && conversationId !== moment.conversationId) continue;
            opportunities.push({ id: moment.id, source: `moment:${moment.source}`,
              sourceEventId: `${moment.pluginId ?? moment.source}:${hash(moment.summary.replace(/\s+/gu, ""))}`, evidenceVersion: 1,
              ...(moment.conversationId ?? conversationId ? { conversationId: moment.conversationId ?? conversationId } : {}),
              motive: moment.kind === "followup" ? "followup" : "interesting", summary: moment.summary,
              occurredAt: moment.occurredAt, expiresAt: moment.expiresAt ?? moment.occurredAt + 6 * 3_600_000,
              strengthPerHour: 3, decayPerHour: 0.8, replyBurden: moment.kind === "ask" || moment.kind === "checkin" ? "question" : "none",
              sceneId: `life:${moment.id}`, momentId: moment.id, score: 72, sceneCooldownMs: 0 });
          }
        }
        const selected = initiativeStore.select({ now: ctx.now, opportunities,
          density: normalizeProactiveDensity(settings.proactiveDensity), dayKey: ctx.localDate,
          dailyAttemptLimit: Math.min(60, Math.max(8, (settings.proactiveDailyLimit ?? 3) * 2 + 4)),
          eligible: opportunity => (route === null || route.available)
            && (opportunity.source !== "user_care" || canAskAboutRecentWellbeing(opportunity.occurredAt, ctx.now, ctx.localHour))
            && (opportunity.score ?? 70) >= (settings.proactiveTargetScore ?? DEFAULT_PROACTIVE_TARGET_SCORE)
            && canStartProactiveGeneration(ctx.snapshot, ctx.state, initiativeCandidate(opportunity)).allowed });
        return selected ? [{ ...initiativeCandidate(selected, selected.key), reason: selected.summary }] : [];
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
    bestEffortConversationStateUpdate("initiative_stopped", () => initiativeStore.suspend(Date.now()));
    if (proactiveTrigger) bestEffortConversationStateUpdate("initiative_cancelled", () => proactiveChatService?.invalidate());
    proactiveTrigger?.stop();
    proactiveTrigger = null;
  }

  return {
    setWorldNarrativeEnabled: (enabled) => amphoreus.setNarrativeEnabled(enabled),
    retryWorldNarrative: () => amphoreus.retryNarrative(),
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
