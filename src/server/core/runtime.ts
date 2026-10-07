import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../shared/ipc-channels";
import { app, chatWindow, ipcMain, emitHost, webContents, invocation } from "./platform";
import { createIpcScope } from "../../main/application/ipc-scope";
import { setReactChatWindow } from "../../main/windows/window-state";
import { loadGeneralSettings, saveGeneralSettings, onGeneralSettingsChanged } from "../../main/settings/settings-facade";
import { loadModelSettings, saveModelSettings, resolveModelSettingsProfile } from "../../main/settings/model-settings";
import { loadUserProfile } from "../../main/settings-store";
import { registerSettingsIpc } from "../../main/settings/settings-ipc";
import { registerChatUiIpc } from "../../main/chats/chat-ui-ipc";
import { registerChatsIpc, broadcastCompactionPhase } from "../../main/chats/chats-ipc";
import { registerWorkspaceFilesIpc } from "../../main/chats/workspace-files-ipc";
import { registerCodeGitIpc } from "../../main/code-git/code-git-ipc";
import { createGitService } from "../../main/code-git/git-service";
import { resolveGitExecutable } from "../../main/code-git/git-executable";
import * as chatsStore from "../../main/chats/chats-store";
import { activeConversationRegistry } from "../../main/chats/active-conversation-registry";
import { createAgentRuntime } from "../../main/orchestrator/agent-runtime";
import { createRuntimeStateService } from "../../main/orchestrator/runtime-state-service";
import { createLlmClient } from "../../main/services/llm/llm-client";
import { createCitaService } from "../../main/services/cita/cita-service";
import { createSocialContextService } from "../../main/services/social-context/social-context-service";
import { createProactiveLifecycle } from "../../main/proactive/proactive-lifecycle";
import { createTtsSynthesisService } from "../../main/services/tts/tts-synthesis-service";
import { getConversationTranscriptStore } from "../../main/orchestrator/conversation-transcript-store";
import { getHarnessRunStore } from "../../main/orchestrator/harness/run-store";
import { ConversationJournalService } from "../../main/orchestrator/conversation-journal-service";
import { createModelBackedConversationTranscriptCompactor } from "../../main/orchestrator/conversation-transcript-compactor";
import { reconcileCrashedInterruptions } from "../../main/orchestrator/conversation-interruption-reconciliation";
import { registerAgUiIpc, hasActiveConversationRun } from "../../main/agui-bridge";
import { createLifecyclePublisher } from "../../main/plugin-host/lifecycle-publisher";
import { createPendingTurnLifecycle } from "../../main/plugin-host/pending-turn-lifecycle";
import { createSchedulerSubsystem } from "../../main/scheduler/bootstrap";
import { createChannelsSubsystem } from "../../main/channels/bootstrap";
import { startPluginRuntime } from "../../main/plugin-runtime";
import { pluginPromptRegistry } from "../../plugins/prompts";
import { enqueueLLMTask } from "../../main/llm-queue";
import { initSkills, skillRegistry } from "../../main/skills";
import { LspManager } from "../../main/lsp/manager";
import { toolRegistry } from "../../main/orchestrator/tools/registry/tool-registry";
import { registerAllTools, syncBuiltInToolToggles } from "../../main/orchestrator/tools/registry/tool-registration";
import { bootstrapConfigGetters } from "../../main/startup/bootstrap-config";
import { bootstrapPermission } from "../../main/permission/bootstrap";
import { initSandbox } from "../../main/orchestrator/sandbox/sandbox-exec";
import { initializeKnowledgeBase } from "../../main/knowledge-base/knowledge-base-service";
import { registerKnowledgeBaseIpc } from "../../main/knowledge-base/knowledge-base-ipc";
import { registerMemoryUserToolIpc } from "../../main/memory/memory-user-ipc";
import { registerWikiMemoryIpc } from "../../main/memory/wiki-memory-ipc";
import { initializeSummaryMemoryScheduler, enableSummaryMemoryScheduler, scheduleSummaryTurn, flushAllSummaryMemory } from "../../main/memory/summary-memory-scheduler";
import { initializeWikiMemoryScheduler, enableWikiMemoryScheduler, scheduleWikiTurn } from "../../main/memory/wiki-memory-scheduler";
import { createWikiChatSourceReader } from "../../main/memory/wiki-source";
import { createConversationSessionMigration } from "../../main/orchestrator/conversation-session-migration";
import { loadSummaryMemoryContext } from "../../main/memory/summary-memory-context";
import { setMemoryMode, isMemoryEnabled, isSummaryMemoryEnabled } from "../../main/memory/memory-mode";
import { initWorldbook, initVectorMemory, disposeVectorMemory, flushRAGStore, isUserMemoryVectorStoreReady, getEntriesBySource, addL2MemoryVector, deleteUserMemoryVectors } from "../../main/rag";
import { initReranker, resetReranker } from "../../main/rag/reranker";
import { memoryStore } from "../../main/memory/memory-store";
import { backupMemoryRagFiles, reconcileMemoryRag } from "../../main/memory/memory-rag-reconciliation";
import { bootstrapMusicService } from "../../main/music/bootstrap";
import { resolveMusicPaths } from "../../main/music/paths";
import { getEffectiveUiTheme } from "../../main/system-ui-theme";
import { nativeTheme } from "./platform";
import { touchActivity } from "./platform";
import { loadChannelsSettings, saveChannelsSettings } from "../../main/channels/settings-store";
import { initPlanPaths, initPlanStatePersister, initPlanStateBroadcaster, encodePlanSessionKey, restorePlanSession, getPlanState, enterPlanDiscussing, exitPlanMode } from "../../main/orchestrator/plan-mode";
import { registerPopQuizIpc, registerPopQuizTool } from "../../main/orchestrator/pop-quiz";
import { createExamPaperStore } from "../../main/learn/exam-paper-store";
import { createExamDraftStore } from "../../main/learn/exam-draft";
import { registerExamPaperIpc } from "../../main/learn/exam-paper-ipc";
import { registerLearnExamTools } from "../../main/orchestrator/learn-exam-tools";
import { registerMomentsIpc } from "../../main/moments/moments-ipc";
import { momentsService } from "../../main/moments/moments-service";
import { loadStickerTextIndex } from "../../main/sticker-text-matcher";
import { updateLocaleContext } from "../../main/locale-context";
import { getUsageReport, clearUsage, flush as flushUsage } from "../../main/token-usage-store";
import { registerNewsIpc } from "../../main/news/news-feed";
import { registerProtocolHandlers } from "../../main/protocols/bootstrap";
import { registerLearnExamPageIpc } from "../../main/learn/exam-page-ipc";
import { MODE_PROMPT_FILES } from "../../main/orchestrator/mode-prompt-profile-core";
import { loadPromptFile } from "../../main/prompts/prompt-loader";
import { registerHeadlessBrowser } from "./browser";
import { createToastService } from "../../main/toast/toast-service";
import { toastEvents } from "../../main/toast/toast-events";
import { registerTtsIpc } from "../../main/tts/tts-ipc";
import { TtsSessionService } from "../../main/tts/tts-session-service";
import { initMcpManager, listMcpServers } from "../../main/orchestrator/mcp-manager";
import { disconnectMcpServer } from "../../main/orchestrator/mcp-adapter";
import { syncPlaywrightMcp, syncFilesystemMcp } from "../../main/sync-mcp-builtin";
import { syncVolcanoSearchMcp } from "../../main/settings/general-settings-lifecycle";
import { registerHeadlessVoice } from "./voice";

export async function startHeadlessCore() {
  const root = app.getPath("userData");
  for (const filename of new Set(Object.values(MODE_PROMPT_FILES).flat())) {
    if (!loadPromptFile(filename)) throw new Error(`缺少必要提示词 ${filename}，请完整部署 prompts 目录或配置 CYRENE_PROMPTS_DIR`);
  }
  // Encrypt imported plaintext channel credentials using the headless vault.
  if (fs.existsSync(path.join(root, "channels-settings.json"))) saveChannelsSettings(loadChannelsSettings());
  let restoreMcp: Promise<void> = Promise.resolve();
  const scope = createIpcScope(ipcMain as any);
  const ipc = { ...scope, handle(channel: string, listener: (...args: any[]) => unknown) {
    scope.handle(channel, channel.startsWith("mcp:") ? async (...args: any[]) => { await restoreMcp; return listener(...args); } : listener);
  } };
  setReactChatWindow(chatWindow as any);
  chatsStore.initialize();
  await initSkills();
  const runtimeStateService = createRuntimeStateService();
  const broadcast = (channel: string, ...args: unknown[]) => chatWindow.webContents.send(channel, ...args);
  runtimeStateService.onChange(() => broadcast(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState()));
  const llmClient = createLlmClient();
  const journal = new ConversationJournalService({ store: getConversationTranscriptStore(root), runReader: getHarnessRunStore(root) });
  const proactive = createProactiveLifecycle({ loadGeneralSettings, conversationJournal: journal });
  proactive.initializeProactiveChatService();
  const social = createSocialContextService({ llmClient, enqueueLLMTask });
  const cita = createCitaService({ llmClient });
  bootstrapConfigGetters({ loadGeneralSettings });
  updateLocaleContext({ uiLocale: loadGeneralSettings().language });
  bootstrapPermission(ipc);
  await initSandbox();
  const lsp = new LspManager({ getServerOverrides: () => loadGeneralSettings().lspServerOverrides });
  const git = createGitService({ getSession: chatsStore.getSessionRecord, resolveExecutable: () => resolveGitExecutable({ systemCommand: "git", bundledPath: "" }) });
  registerAllTools({ lspManager: lsp });
  const music = bootstrapMusicService(resolveMusicPaths());
  // Desktop-only tools have no target on a headless host. All business tools remain registered.
  for (const id of ["play_live2d_action", "live2d_action", "screenshot", "computer_use"]) if (toolRegistry.getById(id)) toolRegistry.unregister(id);
  const ttsSynthesis = createTtsSynthesisService();
  const ttsSession = new TtsSessionService((request, signal, emit) => ttsSynthesis.synthesizeSession(request, signal, emit));
  registerTtsIpc({ ipc, ttsSessionService: ttsSession, clientOwnership: true });
  const voice = registerHeadlessVoice(ipc);
  initPlanPaths(root);
  initPlanStateBroadcaster((conversationId, state) => broadcast(IPC.PLAN_STATE_CHANGED, { conversationId, state }));
  initPlanStatePersister((id, snapshot) => {
    const file = path.join(root, "plans", encodePlanSessionKey(id), "state.json");
    if (!snapshot) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  });
  const planRoot = path.join(root, "plans");
  if (fs.existsSync(planRoot)) for (const entry of fs.readdirSync(planRoot)) {
    const file = path.join(planRoot, entry, "state.json");
    try {
      if (!fs.existsSync(file)) continue;
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      restorePlanSession(typeof snapshot.conversationId === "string" ? snapshot.conversationId : entry, snapshot);
    } catch (error) { console.warn(`[PlanMode] 读取快照失败 ${file}:`, error); }
  }
  const knowledge = initializeKnowledgeBase(root);
  setMemoryMode(loadModelSettings().memoryMode);
  initializeSummaryMemoryScheduler({ userDataRoot: root, sessions: chatsStore, onError: error => console.error("[SummaryMemory]", error) });
  enableSummaryMemoryScheduler(isSummaryMemoryEnabled());
  const migration = createConversationSessionMigration(root);
  initializeWikiMemoryScheduler({ userDataRoot: root, sourceReader: createWikiChatSourceReader({ transcriptStore: getConversationTranscriptStore(root), listSessions: chatsStore.listSessions, ensureConversationMigrated: id => migration.ensureConversationMigrated(id) }), onError: error => console.error("[WikiMemory]", error) });
  await enableWikiMemoryScheduler(loadModelSettings().memoryMode === "wiki");
  await initWorldbook();
  async function switchMemoryMode(mode: any) {
    enableSummaryMemoryScheduler(mode === "summary");
    await enableWikiMemoryScheduler(mode === "wiki");
    setMemoryMode(mode);
    if (mode === "vector") {
      const settings = loadModelSettings();
      await initVectorMemory("auto", undefined, undefined, settings.embeddingModel, settings.embeddingDimensions);
      await initReranker(settings.rerankerMode);
      await reconcileUserMemoryIndex();
    } else { resetReranker(); await disposeVectorMemory(); }
  }
  async function reconcileUserMemoryIndex() {
    if (!isMemoryEnabled() || !isUserMemoryVectorStoreReady()) return;
    await reconcileMemoryRag({
      getMemories: () => memoryStore.getAllL2(), getVectors: () => getEntriesBySource("user_memory"),
      backup: async () => backupMemoryRagFiles(root), addVector: addL2MemoryVector,
      markSynced: (id, ragId) => memoryStore.markL2SyncStatus(id, "synced", ragId),
      markSyncFailed: (id, error) => memoryStore.markL2SyncStatus(id, "sync_failed", undefined, error),
      deleteVectors: ids => deleteUserMemoryVectors(ids), warn: (message, error) => console.warn(message, error),
    });
  }
  if (isMemoryEnabled()) await switchMemoryMode("vector");
  const transcriptCompactor = createModelBackedConversationTranscriptCompactor({ store: getConversationTranscriptStore(root), runReader: getHarnessRunStore(root), loadModelSettings: () => resolveModelSettingsProfile(loadModelSettings()), onPhase: (phase, id) => broadcastCompactionPhase(id, phase) });
  const lifecycle = createLifecyclePublisher({ publish: (event, payload) => plugins ? plugins.publishHostEvent(event, payload) : Promise.resolve() });
  const pending = createPendingTurnLifecycle({ publisher: lifecycle });
  let plugins: Awaited<ReturnType<typeof startPluginRuntime>> | undefined;
  const runtime = createAgentRuntime({
    runtimeStateService, llmClient, enqueueLLMTask, loadModelSettings, loadGeneralSettings, loadUserProfile,
    toolRegistry, skillRegistry, getStickerTextIndex: loadStickerTextIndex,
    broadcastRuntimeStateChanged: () => broadcast(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState()),
    citaService: cita, socialContextScheduler: social.scheduler, chatsStore,
    buildSummaryMemoryContext: id => loadSummaryMemoryContext({ conversationId: id, userDataRoot: root, getSessionRecord: chatsStore.getSessionRecord }),
    scheduleSummaryTurn, scheduleWikiTurn, socialAtomStore: social.store,
    buildPluginPromptContext: input => pluginPromptRegistry.build(input),
    publishPluginHostEvent: (event, payload) => plugins ? plugins.publishHostEvent(event, payload) : Promise.resolve(),
    publishToolFinished: event => lifecycle.publishToolFinished(event), transcriptCompactor,
  });
  const channels = createChannelsSubsystem({ agentRuntime: runtime, ttsSynthesisService: ttsSynthesis, getReactChatWindow: () => chatWindow as any, ipc, publishLifecycle: lifecycle });
  channels.initialize(); await channels.adaptersRegistered;
  const scheduler = createSchedulerSubsystem({ agentRuntime: runtime, getReactChatWindow: () => chatWindow as any, ipc, publishLifecycle: lifecycle, conversationJournal: journal, getActiveConversation: () => activeConversationRegistry.getMostRecent(), canRunTask: task => !task.ownerPluginId || Boolean(plugins?.isRunning(task.ownerPluginId)) });
  scheduler.initialize();
  plugins = await startPluginRuntime({ llmClient, ipc, agentRuntime: runtime, schedulerStore: scheduler.store, onPluginRunningStateChange: () => scheduler.engine.refreshPluginTasks(), getPanelHostWebContents: () => webContents.getAllWebContents() as any });
  const windowManager = {
    broadcast,
    createStickerManagerWindow: async () => emitHost("host:sticker-manager"),
    openScheduledTasks: async () => emitHost("host:settings", "scheduled-tasks"),
    openSettingsWindow: async (section: string) => emitHost("host:settings", section),
    openReactChatWindow: async (id: string) => broadcast(IPC.CHATS_REACT_SWITCH_SESSION, id),
  } as any;
  registerSettingsIpc({ ipc, windowManager: null, getGeneralSettings: loadGeneralSettings, saveGeneralSettings, getModelSettings: loadModelSettings, saveModelSettings, runtimeStateService, proactiveLifecycle: proactive, reconcileUserMemoryIndex, switchMemoryMode,
    syncVolcanoSearchMcp: async settings => { await restoreMcp; return syncVolcanoSearchMcp(settings); },
    syncPlaywrightMcp: async settings => { await restoreMcp; await syncPlaywrightMcp(settings); },
    syncFilesystemMcp: async settings => { await restoreMcp; await syncFilesystemMcp(settings); },
  });
  registerMemoryUserToolIpc({ ipc, windowManager });
  registerWikiMemoryIpc(ipc); registerKnowledgeBaseIpc(ipc);
  registerChatsIpc(ipc, { llmClient, isPrimaryModelBusy: hasActiveConversationRun, transcriptCompactor });
  registerChatUiIpc({ ipc, windowManager, isTrustedChatSender: sender => webContents.fromId(sender.id) === sender as any, live2dWindowLifecycle: { getDiagnostics: () => ({ available: false, platform: "web" }) } });
  ipc.handle(IPC.SETTINGS_REQUEST_SWITCH_SECTION, (_event, section: string) => { emitHost(IPC.SETTINGS_SWITCH_SECTION, section || "appearance"); return true; });
  ipc.handle("web:system-theme", (_event, dark: boolean) => { nativeTheme.shouldUseDarkColors = !!dark; nativeTheme.emit("updated"); broadcast(IPC.UI_THEME_CHANGED, getEffectiveUiTheme(loadGeneralSettings().uiTheme)); return true; });
  ipc.handle("web:user-activity", () => { touchActivity(); return true; });
  // MusicService replaces this handler when its browser audio port starts.
  ipc.handle("web:audio-get", () => null);
  ipc.handle(IPC.MUSIC_OPEN_PLAYER, () => { emitHost("host:music"); return true; });
  ipc.handle(IPC.MUSIC_OPEN_SETTINGS, (_event, section: string) => { broadcast(IPC.SETTINGS_SWITCH_SECTION, section || "music"); return true; });
  ipc.on(IPC.MUSIC_PLAYER_CLOSE, () => emitHost("host:music-close"));
  ipc.on(IPC.MUSIC_PLAYER_MINIMIZE, () => emitHost("host:music-close"));
  ipc.on(IPC.STICKERS_CLOSE, () => emitHost("host:sticker-manager-close"));
  ipc.on(IPC.STICKERS_MINIMIZE, () => emitHost("host:sticker-manager-close"));
  registerWorkspaceFilesIpc(ipc); registerCodeGitIpc({ ipc, service: git });
  registerMomentsIpc(ipc); registerNewsIpc(ipc);
  const toast = createToastService({
    bus: toastEvents,
    window: { send: broadcast, syncVisibility: () => {}, updateHeight: () => {}, owns: (sender: { id: number }) => webContents.fromId(sender.id) === sender } as any,
    activate: request => { if (request.kind === "chat" && request.sessionId) broadcast(IPC.CHATS_REACT_SWITCH_SESSION, request.sessionId); },
    openTasksWindow: () => broadcast(IPC.SETTINGS_SWITCH_SECTION, "scheduled-tasks"),
    isSoundEnabled: () => loadGeneralSettings().toastSoundEnabled,
  });
  toast.registerIpc(ipc);
  registerProtocolHandlers();
  registerAgUiIpc(input => runtime.buildOptions(input), (result, text, context) => runtime.onRunFinished(result, text, context), () => {
    const sender = invocation.getStore();
    // The invoking browser is the chat target. Returning the aggregate broadcast
    // port here would deliver every delta twice to that browser.
    return sender ? { isDestroyed: () => sender.isDestroyed(), webContents: sender } as any : chatWindow as any;
  }, proactive.proactiveConversationLifecycle, ipc, pending);
  ipc.handle(IPC.PLAN_GET_STATE, (_event, payload: any) => ({ state: payload?.conversationId ? getPlanState(payload.conversationId) : "NORMAL" }));
  ipc.handle(IPC.PLAN_SET_MODE, (_event, payload: any) => {
    if (!payload?.conversationId || !["on", "off"].includes(payload.target)) return { ok: false, reason: "缺少 conversationId 或 target 无效" };
    const state = getPlanState(payload.conversationId);
    if (payload.target === "on" && state === "NORMAL") return { ...enterPlanDiscussing(payload.conversationId, payload.workspaceRoot), state: getPlanState(payload.conversationId) };
    if (payload.target === "off" && state === "EXECUTING") return { ok: false, reason: "计划执行中，不可手动退出", state };
    if (payload.target === "off") exitPlanMode(payload.conversationId);
    return { ok: true, state: getPlanState(payload.conversationId) };
  });
  registerPopQuizIpc(ipc); registerPopQuizTool();
  const examStore = createExamPaperStore(root), examDraft = createExamDraftStore(root, examStore);
  await examStore.recoverInterruptedGrading(); await examDraft.deleteExpired();
  registerExamPaperIpc(examStore, ipc); registerLearnExamTools(examStore, examDraft);
  registerLearnExamPageIpc(examStore, ipc);
  const browser = registerHeadlessBrowser(ipc, examStore);
  ipc.handle(IPC.TOKEN_USAGE_GET, (_event, days: number) => getUsageReport(Math.min(366, Math.max(1, Math.trunc(Number(days) || 7)))));
  ipc.handle(IPC.TOKEN_USAGE_CLEAR, () => clearUsage());
  onGeneralSettingsChanged((before, after) => {
    syncBuiltInToolToggles(after); updateLocaleContext({ uiLocale: after.language });
    if (before.proactiveChatMode !== after.proactiveChatMode) proactive.getProactiveChatService()?.invalidate();
    broadcast(IPC.UI_THEME_CHANGED, getEffectiveUiTheme(after.uiTheme));
    if (before.uiThemeRadius !== after.uiThemeRadius) broadcast(IPC.UI_THEME_RADIUS_CHANGED, after.uiThemeRadius);
    broadcast("web:general-changed", after);
  });
  await reconcileCrashedInterruptions({ runStore: getHarnessRunStore(root), transcriptStore: getConversationTranscriptStore(root), now: Date.now });
  // Replay old collections using the real SQLite index and the original typed scopes.
  const markerPath = path.join(root, "shared-core-migration.json");
  if (fs.existsSync(markerPath)) {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.knowledge && !marker.knowledgeImported) {
      for (const collection of marker.knowledge.collections ?? []) {
        const scope = collection.scope?.kind === "workspace" && typeof collection.scope.workspaceRoot === "string"
          ? collection.scope : { kind: "global" };
        const created = await knowledge.createCollection({ name: collection.name, scope });
        const id = created.collections.find(item => item.name === collection.name)!.id;
        await knowledge.addPaths(id, (collection.paths ?? []).filter((source: any) => fs.existsSync(source.path)).map((source: any) => ({ kind: fs.statSync(source.path).isDirectory() ? "directory" : "file", path: source.path })));
      }
      knowledge.setEnabled(Boolean(marker.knowledge.enabled)); marker.knowledgeImported = true;
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    }
  }
  scheduler.start(); proactive.initializeProactiveTrigger(); momentsService.startReactionScanner();
  await channels.start();
  const mcpAbort = new AbortController();
  restoreMcp = (async () => {
    await initMcpManager({ signal: mcpAbort.signal });
    if (mcpAbort.signal.aborted) return;
    const general = loadGeneralSettings();
    await syncPlaywrightMcp(general);
    if (mcpAbort.signal.aborted) return;
    await syncFilesystemMcp({ filesystemMcpEnabled: general.filesystemMcpEnabled, allowedDir: app.getPath("downloads") });
    if (!mcpAbort.signal.aborted && general.searchEngine === "minimax") await syncVolcanoSearchMcp(general);
  })().catch(error => console.error("[MCP] Restore failed:", error));
  return {
    capabilities: () => ({ handlers: [...ipcMain.handlers.keys()], listeners: ipcMain.eventNames(), engine: "shared-windows-core", desktop: false, version: app.getVersion() }),
    async close() {
      app.emit("before-quit");
      voice.close(); ttsSession.cancelAll();
      mcpAbort.abort(); await restoreMcp;
      await Promise.allSettled(listMcpServers().map(server => disconnectMcpServer(server.id)));
      toast.dispose();
      scheduler.stop(); proactive.stopProactiveTrigger(); momentsService.stopReactionScanner(); await browser.close(); await music.shutdown();
      await channels.shutdown(); await plugins?.stop();
      await flushAllSummaryMemory(); await enableWikiMemoryScheduler(false); await flushRAGStore(); flushUsage();
      await disposeVectorMemory();
      await lsp.disposeAll(); await git.dispose(); await knowledge.close(); ipc.dispose();
    },
  };
}
