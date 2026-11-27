import { registerSurfaceSettingsIpc } from "./surface-settings-ipc";
import { app, BrowserWindow, shell } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import type { GeneralSettings } from "./general-settings";
import type { TimeoutSettings } from "../../shared/timeout-types";
import { ensureCustomStylePrompt } from "../style-prompt";
import type { WindowManager } from "../windows/window-manager";
import {
  reactChatWindow,
} from "../windows/window-state";
import type { RuntimeStateService } from "../orchestrator/runtime-state-service";
import { initReranker, getRerankerInstallStatus, isRerankerReady, resetReranker } from "../rag/reranker";
import { isUserMemoryVectorIndexVerified, switchEmbeddingModel } from "../rag";
import { testVendorConnection } from "../orchestrator/vendors/test-connection";
import { getAdapterForConfig } from "../orchestrator/vendors";
import type { VendorConfig } from "../orchestrator/vendors";
import { normalizeModelSettings, getPublicModelConfig, listSavedModelProfiles, saveModelProfile, setDefaultModelProfile, saveModelSettings } from "./model-settings";
import type { ModelSettings } from "./model-settings";
import { getTimeoutSettings, saveTimeoutSettings } from "../timeout-manager";
import type { syncVolcanoSearchMcp } from "./general-settings-lifecycle";
import type { syncPlaywrightMcp, syncFilesystemMcp } from "../sync-mcp-builtin";
import { broadcastChatsChanged } from "../chats/chats-ipc";
import { registerDataDirIpc } from "./data-dir-ipc";
import { getBrowserPanelController } from "../browser/browser-panel-runtime";
import { getMemoryModeVersion, isVectorMemoryEnabled, normalizeMemoryMode, type MemoryMode } from "../memory/memory-mode";
import { watchSystemUiTheme } from "../system-ui-theme";
import { getModelInstallStatus } from "../rag/model-status";
import { installLocalEmbeddingModel, installLocalRerankerModel } from "../rag/install-local-model";
import type { MemoryRagReconciliationReport } from "../memory/memory-rag-reconciliation";
import type { MemoryVectorIndexStatus } from "../../shared/memory-vector-status";
import type { LocalRerankerStatus } from "../../shared/local-reranker-status";

export interface SettingsIpcDependencies {
  get windowManager(): WindowManager | null;
  getGeneralSettings: () => GeneralSettings;
  surfaceRegistered?: boolean;
  saveGeneralSettings: (settings: Partial<GeneralSettings>) => GeneralSettings;
  getModelSettings: () => ModelSettings;
  saveModelSettings: (settings: Partial<ModelSettings>) => ModelSettings;
  runtimeStateService: RuntimeStateService;
  proactiveLifecycle: {
    getProactiveChatService: () => { invalidate: () => void } | null;
    getProactiveStatus?: () => unknown;
  };
  reconcileUserMemoryIndex: () => Promise<MemoryRagReconciliationReport | undefined>;
  switchMemoryMode?: (mode: MemoryMode) => Promise<void>;
  syncVolcanoSearchMcp: typeof syncVolcanoSearchMcp;
  syncPlaywrightMcp: typeof syncPlaywrightMcp;
  syncFilesystemMcp: typeof syncFilesystemMcp;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

const VISION_TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

export function registerSettingsIpc(deps: SettingsIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  const {
    getGeneralSettings,
    saveGeneralSettings,
    getModelSettings,
    saveModelSettings,
    runtimeStateService,
    proactiveLifecycle,
    reconcileUserMemoryIndex,
    switchMemoryMode,
    syncVolcanoSearchMcp,
    syncPlaywrightMcp,
    syncFilesystemMcp,
  } = deps;
  // 注意：windowManager 不解构，统一用 deps.windowManager 实时读取 getter。
  // registerSettingsIpc 在模块加载阶段调用，那时 windowManager 仍为 null，
  // 解构会捕获 null 并导致后续 ?. 永远短路（设置里的打开侧边栏/日程等会失效）。

  watchSystemUiTheme(
    () => getGeneralSettings().uiTheme,
    (theme) => deps.windowManager?.broadcast(IPC.UI_THEME_CHANGED, theme),
  );

  function broadcastToAuxWindows(channel: string, payload: unknown): void {
    const win = reactChatWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  function broadcastModelConfigChanged(settings = getModelSettings()): void {
    broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
    // 聊天窗口不在 aux 窗口里：模型窗口容量变更后它不会自己重读会话，
    // 环形图分母会停在旧快照上。这里顺带广播一次会话变更，触发聊天窗口重载。
    broadcastChatsChanged();
  }

  function broadcastRuntimeStateChanged(): void {
    broadcastToAuxWindows(IPC.RUNTIME_STATE_CHANGED, runtimeStateService.getState());
  }

  if (!deps.surfaceRegistered) registerSurfaceSettingsIpc(ipc, deps);
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_SAVE, (_event, profile) => {
    const saved = saveModelProfile(profile as Parameters<typeof saveModelProfile>[0]);
    if (saved.added) {
      broadcastModelConfigChanged(saved.settings);
    }
    return { added: saved.added, profiles: listSavedModelProfiles(saved.settings), defaultModelProfileId: saved.settings.defaultModelProfileId };
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_DELETE, (_event, id: unknown) => {
    if (typeof id !== "string") return null;
    const settings = getModelSettings();
    const profiles = listSavedModelProfiles(settings).filter((profile) => profile.id !== id);
    const defaultModelProfileId = settings.defaultModelProfileId === id ? profiles[0]?.id : settings.defaultModelProfileId;
    const saved = saveModelSettings({ modelProfiles: profiles, defaultModelProfileId });
    broadcastModelConfigChanged(saved);
    return { profiles: listSavedModelProfiles(saved), defaultModelProfileId: saved.defaultModelProfileId };
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, (_event, id: unknown) => {
    if (typeof id !== "string") return null;
    const saved = setDefaultModelProfile(id);
    broadcastModelConfigChanged(saved);
    return { profiles: listSavedModelProfiles(saved), defaultModelProfileId: saved.defaultModelProfileId };
  });

  ipc.handle(IPC.SETTINGS_GET_PROACTIVE_STATUS, () => deps.proactiveLifecycle.getProactiveStatus?.() ?? ({
    candidateScore: null,
    targetScore: getGeneralSettings().proactiveTargetScore ?? 60,
    sceneId: null,
    evaluatedAt: null,
    state: "no_candidate",
  }));

  ipc.handle(IPC.SETTINGS_GET_TIMEOUT_SETTINGS, () => getTimeoutSettings());

  ipc.handle(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, (_event, settings: Partial<TimeoutSettings>) =>
    saveTimeoutSettings(settings),
  );

  async function saveGeneralWithEffects(tts: Partial<GeneralSettings>) {
    const before = getGeneralSettings();
    const saved = saveGeneralSettings({ ...before, ...tts });

    // 浏览器视口模式切换后立即按当前面板宽度重新判断身份，无需拖动面板。
    if ("browserViewportMode" in tts) getBrowserPanelController()?.refreshViewportMode?.();

    // 搜索 MCP 自动注册/移除：选 MiniMax+有key→注册，否则→移除
    const searchConfigChanged = "searchMinimaxKey" in tts || "searchEngine" in tts;
    if (searchConfigChanged) {
      await syncVolcanoSearchMcp(saved);
    }

    // Playwright MCP：按 settings 字段自动连接/断开
    if ("playwrightMcpEnabled" in tts) {
      await syncPlaywrightMcp(saved);
    }

    // Filesystem MCP：按 settings 字段自动连接/断开（允许目录固定为下载文件夹）
    if ("filesystemMcpEnabled" in tts) {
      await syncFilesystemMcp({
        filesystemMcpEnabled: saved.filesystemMcpEnabled,
        allowedDir: app.getPath("downloads"),
      });
    }

    // 主动聊天总开关变化时使现有评估失效（频率档位由 ProactiveChat 内部判定，无需重启）。
    if (["proactiveChatMode", "proactiveDensity", "proactiveDeliveryTarget", "proactiveTargetScore", "proactiveDailyLimit", "proactiveQuietStartMinute", "proactiveQuietEndMinute", "companionPluginSharingEnabled"].some(key => key in tts)) {
      proactiveLifecycle.getProactiveChatService()?.invalidate();
    }

    return saved;
  }
  ipc.handle(IPC.SETTINGS_SAVE_GENERAL, (_event, settings: Partial<GeneralSettings>) => saveGeneralWithEffects(settings));
  // Retain the historical TTS settings API with the same side effects.
  ipc.handle(IPC.TTS_LOAD_SETTINGS, () => getGeneralSettings());
  ipc.handle(IPC.TTS_SAVE_SETTINGS, (_event, settings: Partial<GeneralSettings>) => saveGeneralWithEffects(settings));

  ipc.handle(IPC.SETTINGS_OPEN_CUSTOM_STYLE_PROMPT, async () => {
    const filePath = ensureCustomStylePrompt();
    await shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  });

  registerDataDirIpc(ipc);

  ipc.on(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, (_event, value: boolean) => {
    const saved = saveGeneralSettings({ ...getGeneralSettings(), petAlwaysOnTop: Boolean(value) });
    deps.windowManager?.setPetWindowAlwaysOnTop(saved.petAlwaysOnTop);
  });

  ipc.on(IPC.SETTINGS_SET_PET_VISIBLE, (_event, value: boolean) => {
    saveGeneralSettings({ ...getGeneralSettings(), petVisible: Boolean(value) });
  });

  ipc.on(IPC.SETTINGS_SET_PET_ZOOM, (_event, value: number) => {
    const saved = saveGeneralSettings({ ...getGeneralSettings(), petZoom: Number(value) });
    deps.windowManager?.applyPetWindowZoom(saved.petZoom);
  });

  ipc.handle(IPC.RUNTIME_STATE_GET, () => runtimeStateService.getState());

  ipc.handle(IPC.SETTINGS_SAVE_CONFIG, async (_event, settings: Partial<ModelSettings>) => {
    const previousMode = normalizeMemoryMode(getModelSettings().memoryMode);
    const nextMode = normalizeMemoryMode(settings.memoryMode ?? previousMode);
    const modeChanged = nextMode !== previousMode;
    let saved: ModelSettings;
    try {
      if (modeChanged) await switchMemoryMode?.(nextMode);
      saved = saveModelSettings({ ...settings, memoryMode: nextMode });
    } catch (error) {
      if (modeChanged) {
        try {
          await switchMemoryMode?.(previousMode);
        } catch (rollbackError) {
          console.error("[Settings] failed to restore memory mode after config update failure:", rollbackError);
        }
      }
      throw error;
    }
    broadcastModelConfigChanged(saved);
    return saved;
  });

  ipc.handle(IPC.SETTINGS_TEST_CONNECTION, async (_event, cfg: VendorConfig) => testVendorConnection({ ...cfg, testTimeoutMs: getTimeoutSettings().testTimeout }));
  ipc.handle(IPC.SETTINGS_PREVIEW_REASONING, (_event, cfg: VendorConfig) => {
    const request = getAdapterForConfig(cfg).buildRequest({
      model: cfg.model,
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    }, cfg);
    // 仅返回请求正文，不将认证头或 API 密钥暴露给设置页。
    return JSON.parse(request.body) as Record<string, unknown>;
  });

  /**
   * 测试视觉模型连通性。
   * 用一张 32x32 纯红 PNG（约 100 字节 base64）做测试图——纯色位图所有视觉模型都能识别，
   * 比 SVG 兼容性好（SVG 是矢量，部分模型不支持）。
   * 32x32 是折中：足够小保持 payload 轻，又满足千问等厂商对图片长宽 > 10 像素的限制。
   * 验连通性（HTTP 2xx + 有内容返回）而非对答案——模型可能只说"一张红色图片"也算成功。
   */
  ipc.handle(
    IPC.SETTINGS_TEST_VISION,
    async (_event, cfg: { baseUrl: string; apiKey: string; model: string }) => {
      const start = Date.now();
      console.log("[Cyrene] test vision: model=" + cfg.model + " url=" + cfg.baseUrl);
      try {
        const { captionImage } = await import("../orchestrator/vision-captioner.js");
        const result = await captionImage(
          { base64: VISION_TEST_IMAGE_BASE64, mime: "image/png" },
          "这张图是什么颜色？用一个词回答。",
          { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
        );
        const latency = Date.now() - start;
        if (result.startsWith("[错误")) {
          return { ok: false, latency, error: result };
        }
        return { ok: true, latency, sample: result.slice(0, 80) };
      } catch (e) {
        return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  async function activateEmbeddingModel(modelKey: string) {
    console.log("[Cyrene] embedding model switch requested:", modelKey);
    try {
      const version = getMemoryModeVersion();
      const result = await switchEmbeddingModel(modelKey);
      if (result.ok) {
        const report = await reconcileUserMemoryIndex();
        if (!report || report.failed || version !== getMemoryModeVersion()) {
          return { ...result, ok: false, error: "未能完成记忆索引同步" };
        }
        saveModelSettings({ embeddingModel: "bgem3" });
        broadcastModelConfigChanged();
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Cyrene] embedding model switch failed:", message);
      return { ok: false, clearedEntries: 0, error: message };
    }
  }

  let vectorRepairPhase: MemoryVectorIndexStatus["phase"] = "idle";
  ipc.handle(IPC.EMBEDDING_SET_MODEL, async (_event, modelKey: string) => {
    if (vectorRepairPhase === "downloading" || vectorRepairPhase === "repairing") {
      return { ok: false, clearedEntries: 0, error: "向量索引正在修复" };
    }
    return activateEmbeddingModel(modelKey);
  });

  function vectorIndexStatus(): MemoryVectorIndexStatus {
    return {
      modelInstalled: getModelInstallStatus().embedding.bgem3,
      indexReady: isUserMemoryVectorIndexVerified(),
      phase: vectorRepairPhase,
    };
  }

  ipc.handle(IPC.MEMORY_PANEL_GET_VECTOR_INDEX, () => vectorIndexStatus());
  ipc.handle(IPC.MEMORY_PANEL_START_VECTOR_REPAIR, (_event, allowDownload: unknown) => {
    if (vectorRepairPhase === "downloading" || vectorRepairPhase === "repairing") return vectorIndexStatus();
    if (!isVectorMemoryEnabled()) {
      vectorRepairPhase = "modeChanged";
      return vectorIndexStatus();
    }
    const download = allowDownload === true && !getModelInstallStatus().embedding.bgem3;
    const version = getMemoryModeVersion();
    vectorRepairPhase = download ? "downloading" : "repairing";
    // Download and backfill can outlive an HTTP request or a settings page.
    void (async () => {
      try {
        if (download) await installLocalEmbeddingModel(app.getPath("userData"));
        if (version !== getMemoryModeVersion()) {
          vectorRepairPhase = "modeChanged";
          return;
        }
        vectorRepairPhase = "repairing";
        const result = await activateEmbeddingModel("bgem3");
        vectorRepairPhase = version !== getMemoryModeVersion() ? "modeChanged" : result.ok ? "complete" : "repairFailed";
      } catch (error) {
        console.error("[Memory/RAG] model download failed:", error);
        vectorRepairPhase = "downloadFailed";
      }
    })();
    return vectorIndexStatus();
  });

  let rerankerSetupPhase: LocalRerankerStatus["phase"] = "idle";
  let rerankerSetupAttempt = 0;
  const rerankerIsBusy = () => rerankerSetupPhase === "downloading" || rerankerSetupPhase === "activating";

  function localRerankerStatus(): LocalRerankerStatus {
    return {
      modelInstalled: getRerankerInstallStatus().standard,
      ready: isVectorMemoryEnabled() && isRerankerReady(),
      enabled: getModelSettings().rerankerMode === "standard",
      phase: rerankerSetupPhase,
    };
  }

  async function configureLocalReranker(download: boolean): Promise<boolean> {
    const attempt = ++rerankerSetupAttempt;
    const version = getMemoryModeVersion();
    rerankerSetupPhase = download ? "downloading" : "activating";
    function stillCurrent() {
      if (attempt !== rerankerSetupAttempt) return false;
      if (version !== getMemoryModeVersion()) {
        rerankerSetupPhase = "modeChanged";
        return false;
      }
      return true;
    }

    try {
      if (download) await installLocalRerankerModel(app.getPath("userData"));
      if (!stillCurrent()) return false;

      rerankerSetupPhase = "activating";
      const ready = await initReranker("standard");
      if (!stillCurrent()) return false;
      if (!ready) {
        rerankerSetupPhase = "activationFailed";
        return false;
      }

      broadcastModelConfigChanged(saveModelSettings({ rerankerMode: "standard" }));
      rerankerSetupPhase = "complete";
      return true;
    } catch (error) {
      if (stillCurrent()) {
        const downloading = rerankerSetupPhase === "downloading";
        rerankerSetupPhase = downloading ? "downloadFailed" : "activationFailed";
        console.error(downloading ? "[RAG] Reranker download failed:" : "[RAG] Reranker activation failed:", error);
      }
      return false;
    }
  }

  ipc.handle(IPC.RERANKER_SET_MODE, async (_event, mode: unknown) => {
    if (mode !== "standard" && mode !== "none") return false;
    if (mode === "none" || !isVectorMemoryEnabled()) {
      rerankerSetupAttempt++;
      rerankerSetupPhase = "idle";
      resetReranker();
      broadcastModelConfigChanged(saveModelSettings({ rerankerMode: mode }));
      return true;
    }
    if (rerankerIsBusy()) return false;
    return configureLocalReranker(false);
  });

  ipc.handle(IPC.RERANKER_GET_STATUS, () => getRerankerInstallStatus());
  ipc.handle(IPC.RERANKER_GET_LOCAL_STATUS, () => localRerankerStatus());
  ipc.handle(IPC.RERANKER_START_LOCAL_SETUP, (_event, allowDownload: unknown) => {
    if (rerankerIsBusy()) return localRerankerStatus();
    if (!isVectorMemoryEnabled()) {
      rerankerSetupPhase = "modeChanged";
      return localRerankerStatus();
    }
    const download = allowDownload === true && !getRerankerInstallStatus().standard;
    void configureLocalReranker(download);
    return localRerankerStatus();
  });

  ipc.handle(IPC.MODEL_GET_INSTALL_STATUS, () => {
    return getModelInstallStatus();
  });

  ipc.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    // mailto: 用于「报告问题」里的发邮件入口，交给系统默认邮件客户端；其余协议一律拒绝
    const allowed = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:");
    if (!allowed) {
      return { ok: false, error: "Invalid URL" };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipc.on(IPC.SETTINGS_PREVIEW_RUNTIME_SYNC, (_event, value: "off" | "local" | "llm") => {
    const current = getModelSettings();
    const preview = normalizeModelSettings({
      ...current,
      runtimeSync: value === "llm" ? "llm" : value === "local" ? "local" : "off",
    });
    broadcastModelConfigChanged(preview);
  });
}
