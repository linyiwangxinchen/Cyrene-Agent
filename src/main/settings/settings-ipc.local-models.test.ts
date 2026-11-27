import { beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import type { LocalRerankerStatus } from "../../shared/local-reranker-status";
import { setMemoryMode } from "../memory/memory-mode";
import { registerSettingsIpc, type SettingsIpcDependencies } from "./settings-ipc";

const models = vi.hoisted(() => ({
  installed: vi.fn(() => false),
  ready: vi.fn(() => false),
  initialize: vi.fn<(mode: string) => Promise<boolean>>(),
  reset: vi.fn(),
  download: vi.fn<() => Promise<void>>(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "fixture-data" } }));
vi.mock("../style-prompt", () => ({}));
vi.mock("../windows/window-state", () => ({ reactChatWindow: null }));
vi.mock("../rag/reranker", () => ({
  initReranker: models.initialize,
  getRerankerInstallStatus: () => ({ standard: models.installed() }),
  isRerankerReady: models.ready,
  resetReranker: models.reset,
}));
vi.mock("../rag/install-local-model", () => ({ installLocalRerankerModel: models.download }));
vi.mock("../rag", () => ({}));
vi.mock("../orchestrator/vendors/test-connection", () => ({}));
vi.mock("../orchestrator/vendors", () => ({}));
vi.mock("./model-settings", () => ({ getPublicModelConfig: vi.fn() }));
vi.mock("../timeout-manager", () => ({}));
vi.mock("../chats/chats-ipc", () => ({ broadcastChatsChanged: vi.fn() }));
vi.mock("./data-dir-ipc", () => ({ registerDataDirIpc: vi.fn() }));
vi.mock("../browser/browser-panel-runtime", () => ({}));
vi.mock("../system-ui-theme", () => ({ watchSystemUiTheme: vi.fn() }));

let handlers: Map<string, (...args: any[]) => unknown>;
const save = vi.fn();

beforeEach(() => {
  setMemoryMode("vector");
  vi.clearAllMocks();
  models.installed.mockReturnValue(false);
  models.ready.mockReturnValue(false);
  models.initialize.mockReset().mockResolvedValue(false);
  models.download.mockReset().mockResolvedValue(undefined);
  let settings = { rerankerMode: "none" };
  save.mockImplementation(patch => (settings = { ...settings, ...patch }));
  handlers = new Map();
  registerSettingsIpc({
    ipc: { handle(channel, callback) { handlers.set(channel, callback); }, on() {}, removeHandler() {}, dispose() {} },
    surfaceRegistered: true,
    getModelSettings: () => settings,
    saveModelSettings: save,
  } as unknown as SettingsIpcDependencies);
});

const status = (): LocalRerankerStatus => handlers.get(IPC.RERANKER_GET_LOCAL_STATUS)!(null) as LocalRerankerStatus;
const start = (download: unknown): LocalRerankerStatus => handlers.get(IPC.RERANKER_START_LOCAL_SETUP)!(null, download) as LocalRerankerStatus;

it("only downloads on explicit request and configures the model after successful inference", async () => {
  const downloading = Promise.withResolvers<void>();
  const initializing = Promise.withResolvers<boolean>();
  models.download.mockReturnValue(downloading.promise);
  models.initialize.mockReturnValue(initializing.promise);

  expect(start(true)).toMatchObject({ phase: "downloading", enabled: false, ready: false });
  expect(start(true).phase).toBe("downloading");
  expect(models.download).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();

  models.installed.mockReturnValue(true);
  downloading.resolve();
  await vi.waitFor(() => expect(status()).toMatchObject({ modelInstalled: true, phase: "activating", enabled: false }));
  expect(save).not.toHaveBeenCalled();
  models.ready.mockReturnValue(true);
  initializing.resolve(true);
  await vi.waitFor(() => expect(status()).toMatchObject({ phase: "complete", enabled: true, ready: true }));
  expect(save).toHaveBeenCalledExactlyOnceWith({ rerankerMode: "standard" });
});

it("reports failed activation without changing settings or treating another value as download consent", async () => {
  expect(start("true").phase).toBe("activating");
  await vi.waitFor(() => expect(status().phase).toBe("activationFailed"));
  expect(models.download).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("keeps the downloaded files without enabling the model when memory mode changes", async () => {
  const downloading = Promise.withResolvers<void>();
  models.download.mockReturnValue(downloading.promise);
  expect(start(true).phase).toBe("downloading");
  setMemoryMode("summary");
  models.installed.mockReturnValue(true);
  downloading.resolve();
  await vi.waitFor(() => expect(status()).toMatchObject({ modelInstalled: true, phase: "modeChanged", enabled: false }));
  expect(models.initialize).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("does not re-enable a model after a later explicit disable", async () => {
  const initializing = Promise.withResolvers<boolean>();
  models.installed.mockReturnValue(true);
  models.initialize.mockReturnValue(initializing.promise);
  expect(start(true).phase).toBe("activating");
  expect(models.download).not.toHaveBeenCalled();
  expect(await handlers.get(IPC.RERANKER_SET_MODE)!(null, "none")).toBe(true);
  initializing.resolve(true);
  await initializing.promise;
  expect(status()).toMatchObject({ phase: "idle", enabled: false, ready: false });
  expect(save).toHaveBeenCalledExactlyOnceWith({ rerankerMode: "none" });
});
