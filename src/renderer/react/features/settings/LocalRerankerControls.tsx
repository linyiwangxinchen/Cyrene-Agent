import { useSyncExternalStore } from "react";
import { Alert, Button } from "antd";
import type { LocalRerankerStatus } from "../../../../shared/local-reranker-status";
import type { SettingsApi } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";

type LocalRerankerApi = Required<Pick<SettingsApi, "getLocalRerankerStatus" | "startLocalRerankerSetup">>
  & Pick<SettingsApi, "rerankerSetMode">;
interface SetupState { status?: LocalRerankerStatus; pending: boolean; requestFailed: boolean }

const running = (status?: LocalRerankerStatus) => status?.phase === "downloading" || status?.phase === "activating";

function createController(api: LocalRerankerApi) {
  let state: SetupState = { pending: false, requestFailed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let operation = 0;
  const listeners = new Set<() => void>();

  function publish(update: Partial<SetupState>) {
    state = { ...state, ...update };
    for (const listener of listeners) listener();
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (!listeners.size || state.pending) return;
    if (state.requestFailed || running(state.status)) {
      timer = setTimeout(() => void refresh(), state.requestFailed ? 3_000 : 1_500);
    }
  }

  async function refresh() {
    if (reading || state.pending) return;
    reading = true;
    const version = operation;
    try {
      const status = await api.getLocalRerankerStatus();
      if (version === operation) publish({ status, requestFailed: false });
    } catch {
      if (version === operation) publish({ requestFailed: true });
    } finally {
      reading = false;
      scheduleRefresh();
    }
  }

  async function change(disable: boolean) {
    if (!state.status || state.pending || running(state.status)) return;
    const allowDownload = !state.status.modelInstalled;
    operation++;
    publish({ pending: true, requestFailed: false });
    try {
      if (disable) {
        if (!await api.rerankerSetMode?.("none")) throw new Error("Reranker was not disabled");
        publish({ status: await api.getLocalRerankerStatus() });
      } else {
        publish({ status: await api.startLocalRerankerSetup(allowDownload) });
      }
    } catch {
      publish({ requestFailed: true });
    } finally {
      publish({ pending: false });
      scheduleRefresh();
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
    },
    snapshot: () => state,
    setup: () => change(false),
    disable: api.rerankerSetMode ? () => change(true) : undefined,
  };
}

type Controller = ReturnType<typeof createController>;
const controllers = new WeakMap<LocalRerankerApi, Controller>();

function getController(api: LocalRerankerApi): Controller {
  let controller = controllers.get(api);
  if (!controller) {
    controller = createController(api);
    controllers.set(api, controller);
  }
  return controller;
}

const label = (key: string) => `settingsPage.memory.localReranker.${key}`;

function RerankerStatusRow({ controller, searchId }: { controller: Controller; searchId: string }) {
  const { t } = useTranslation();
  const { status, pending, requestFailed } = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const busy = pending || running(status);
  const active = status?.enabled && status.ready;
  const availability = !status ? "checking" : !status.modelInstalled ? "modelMissing"
    : active ? "ready" : status.enabled ? "needsActivation" : "disabled";
  const notice = requestFailed ? "requestFailed" : status?.phase === "complete" && !active ? undefined : status?.phase;
  const action = !status?.modelInstalled ? "install" : status.enabled || status.phase === "activationFailed" ? "retry" : "enable";

  return <>
    <div className="cy-settings-row">
      <div className="cy-settings-row__copy">
        <strong data-settings-search-id={searchId}>{t(label("title"))}</strong>
        <span>{t(label(availability))}</span>
      </div>
      <div className="cy-settings-row__control cy-settings-button-group">
        {status?.enabled && controller.disable && <Button disabled={busy} onClick={() => void controller.disable?.()}>
          {t(label("disable"))}
        </Button>}
        {!active && <Button loading={busy} disabled={!status || busy} onClick={() => void controller.setup()}>
          {t(label(action))}
        </Button>}
      </div>
    </div>
    {notice && notice !== "idle" && <Alert showIcon type={notice === "complete" ? "success" : notice.endsWith("Failed") ? "error" : "info"}
      title={t(label(notice))} />}
  </>;
}

export function LocalRerankerControls({ "data-settings-search-id": searchId }: { "data-settings-search-id": string }) {
  const { t } = useTranslation();
  const api = window.settings;
  if (typeof api?.getLocalRerankerStatus !== "function" || typeof api.startLocalRerankerSetup !== "function") {
    return <div className="cy-settings-row"><div className="cy-settings-row__copy">
      <strong data-settings-search-id={searchId}>{t(label("title"))}</strong>
      <span>{t(label("unavailable"))}</span>
    </div></div>;
  }
  return <RerankerStatusRow controller={getController(api as LocalRerankerApi)} searchId={searchId} />;
}
