import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { getRelationshipStore } from "../relationship/relationship-log";
import type { RelationshipLogStore } from "../relationship/relationship-log-core";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { getSharedXilianWorldStore } from "../xilian-world/world-store";
import path from "node:path";
import { app } from "electron";

/** Same handlers for Electron and authenticated headless core transport. */
export function registerCompanionIpc(
  ipc: IpcScope,
  store: RelationshipLogStore = getRelationshipStore(),
  world?: Pick<ProactiveLifecycle, "getWorldSnapshot" | "queryWorldTimeline" | "getWorldView">,
): void {
  ipc.handle(IPC.COMPANION_GET, () => store.snapshot());
  ipc.handle(IPC.COMPANION_WORLD_GET, () => {
    if (world) return world.getWorldView({ limit: 80 });
    const store = getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json"));
    const state = store.advance();
    return store.worldView({ dateKey: state.worldDate, limit: 80 });
  });
  ipc.handle(IPC.COMPANION_UPDATE, (_event, command) => store.command(command));
  ipc.handle(IPC.COMPANION_EXPORT, () => store.exportData());
}
