import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { getRelationshipStore } from "../relationship/relationship-log";
import type { RelationshipLogStore } from "../relationship/relationship-log-core";
import type { ProactiveLifecycle } from "../proactive/proactive-lifecycle";
import { getSharedXilianWorldStore } from "../xilian-world/world-store";
import path from "node:path";
import { app } from "electron";
import { worldUpdate } from "../amphoreus-world/world-update";

/** Same handlers for Electron and authenticated headless core transport. */
export function registerCompanionIpc(
  ipc: IpcScope,
  store: RelationshipLogStore = getRelationshipStore(),
  world?: Pick<ProactiveLifecycle, "getWorldSnapshot" | "queryWorldTimeline" | "getWorldView" | "setWorldNarrativeEnabled">,
): void {
  ipc.handle(IPC.COMPANION_GET, () => store.snapshot());
  const readWorld = () => {
    if (world) return world.getWorldView({ limit: 80 });
    const store = getSharedXilianWorldStore(path.join(app.getPath("userData"), "xilian-world.json"));
    const state = store.advance();
    return store.worldView({ dateKey: state.worldDate, limit: 80 });
  };
  ipc.handle(IPC.COMPANION_WORLD_GET, readWorld);
  ipc.handle(IPC.COMPANION_WORLD_UPDATE, (_event, cursor) => worldUpdate(readWorld(), cursor));
  ipc.handle(IPC.COMPANION_UPDATE, (_event, command) => store.command(command));
  ipc.handle(IPC.COMPANION_WORLD_HISTORY, (_event, query) => getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json")).queryWorldHistory(query));
  ipc.handle(IPC.COMPANION_WORLD_ARTIFACT, (_event, id) => getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json")).readWorldArtifact(id));
  ipc.handle(IPC.COMPANION_WORLD_CONFIGURE, (_event, options: unknown) => {
    if (!options || typeof options !== "object" || typeof (options as { narrativeEnabled?: unknown }).narrativeEnabled !== "boolean") throw new Error("Invalid world settings");
    const enabled = (options as { narrativeEnabled: boolean }).narrativeEnabled;
    if (world) world.setWorldNarrativeEnabled(enabled);
    else getSharedXilianWorldStore(path.join(app.getPath("userData"), "amphoreus-world.json")).updateAmphoreus((state) => { state.narrativeEnabled = enabled; return true; });
  });
  ipc.handle(IPC.COMPANION_EXPORT, () => store.exportData());
}
