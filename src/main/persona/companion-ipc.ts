import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { getRelationshipStore } from "../relationship/relationship-log";
import type { RelationshipLogStore } from "../relationship/relationship-log-core";

/** Same handlers for Electron and authenticated headless core transport. */
export function registerCompanionIpc(ipc: IpcScope, store: RelationshipLogStore = getRelationshipStore()): void {
  ipc.handle(IPC.COMPANION_GET, () => store.snapshot());
  ipc.handle(IPC.COMPANION_UPDATE, (_event, command) => store.command(command));
  ipc.handle(IPC.COMPANION_EXPORT, () => store.exportData());
}
