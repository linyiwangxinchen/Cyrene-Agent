import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import type { MemoryVectorIndexStatus } from "../../../../shared/memory-vector-status";
import type { MemoryPanelApi } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";

type Repair = NonNullable<MemoryPanelApi["startVectorIndexRepair"]>;
const pendingRepairs = new WeakMap<Repair, Promise<MemoryVectorIndexStatus>>();

function requestVectorRepair(repair: Repair, allowDownload: boolean) {
  const pending = pendingRepairs.get(repair);
  if (pending) return pending;
  const request = repair(allowDownload).finally(() => pendingRepairs.delete(repair));
  pendingRepairs.set(repair, request);
  return request;
}

export function VectorMemoryIndexControls({ onChanged, "data-settings-search-id": searchId }: {
  onChanged?: () => Promise<void>;
  "data-settings-search-id": string;
}) {
  const { t } = useTranslation();
  const getStatus = window.memoryPanel?.getVectorIndexStatus;
  const startRepair = window.memoryPanel?.startVectorIndexRepair;
  const [status, setStatus] = useState<MemoryVectorIndexStatus>();
  const [requestFailed, setRequestFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const running = status?.phase === "downloading" || status?.phase === "repairing";

  useEffect(() => {
    if (!getStatus || !startRepair) return;
    const readStatus = getStatus;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await readStatus();
        if (!active) return;
        setStatus(next);
        setRequestFailed(false);
        if (next.phase === "downloading" || next.phase === "repairing") {
          timer = setTimeout(() => void refresh(), 1500);
        } else if (running) {
          await onChanged?.();
        }
      } catch {
        if (!active) return;
        setRequestFailed(true);
        timer = setTimeout(() => void refresh(), 3000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [getStatus, startRepair, running, onChanged]);

  if (!getStatus || !startRepair) return null;
  const availability = status?.indexReady ? "ready" : status?.modelInstalled ? "needsRepair" : "modelMissing";
  const phase = status?.phase;
  const notice = requestFailed ? "requestFailed" : phase === "idle" ? undefined : phase;
  const alertType = notice === "complete" ? "success" : notice?.endsWith("Failed") ? "error" : "info";

  async function repair() {
    if (!status || !startRepair || running || starting) return;
    setStarting(true);
    setRequestFailed(false);
    try {
      setStatus(await requestVectorRepair(startRepair, !status.modelInstalled));
    } catch {
      setRequestFailed(true);
    } finally {
      setStarting(false);
    }
  }

  return <>
    <div className="cy-settings-row">
      <div className="cy-settings-row__copy">
        <strong data-settings-search-id={searchId}>{t("settingsPage.memory.vectorIndex.title")}</strong>
        <span>{t(`settingsPage.memory.vectorIndex.${status ? availability : "checking"}`)}</span>
      </div>
      <Button loading={starting || running} disabled={!status || starting || running} onClick={() => void repair()}>
        {t(`settingsPage.memory.vectorIndex.${status?.modelInstalled ? "repair" : "install"}`)}
      </Button>
    </div>
    {notice && <Alert showIcon type={alertType} title={t(`settingsPage.memory.vectorIndex.${notice}`)} />}
  </>;
}
