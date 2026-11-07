import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { getRelationshipStore } from "../relationship/relationship-log";
import type { RelationshipLogStore } from "../relationship/relationship-log-core";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { getSharedXilianWorldStore } from "../proactive/xilian-world-store";
import path from "node:path";
import { app } from "electron";

/** Same handlers for Electron and authenticated headless core transport. */
export function registerCompanionIpc(
  ipc: IpcScope,
  store: RelationshipLogStore = getRelationshipStore(),
  world?: Pick<ProactiveLifecycle, "getWorldSnapshot" | "queryWorldTimeline">,
): void {
  ipc.handle(IPC.COMPANION_GET, () => store.snapshot());
  ipc.handle(IPC.COMPANION_WORLD_GET, () => {
    const state = world?.getWorldSnapshot() ?? getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json")).advance();
    const timeline = world?.queryWorldTimeline({ dateKey: state.worldDate, order: "asc", limit: 24 })
      ?? getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json")).queryTimeline({ dateKey: state.worldDate, order: "asc", limit: 24 });
    return { state, timeline };
  });
  ipc.handle(IPC.COMPANION_UPDATE, (_event, command) => store.command(command));
  ipc.handle(IPC.COMPANION_EXPORT, () => store.exportData());
}
