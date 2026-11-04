import { IPC } from "../../shared/ipc-channels";
import type { IpcScope } from "../application/ipc-scope";
import { memoryStore } from "./memory-store";
import { createMemoryGovernance } from "./memory-governance";
import { addL2MemoryVector, deleteUserMemoryVectors, flushRAGStore } from "../rag";

export function registerMemoryGovernanceIpc(ipc: IpcScope): void {
  const service = createMemoryGovernance({
    load: () => memoryStore.load(),
    save: state => memoryStore.save(state),
    deleteVectors: async ids => { deleteUserMemoryVectors(ids); await flushRAGStore(); },
    sync: async (id, content) => {
      try {
        const ragId = await addL2MemoryVector(content, id, { source: "user_correction" });
        const current = (await memoryStore.getAllL2()).find(item => item.id === id);
        if (!current || current.content !== content) { deleteUserMemoryVectors([ragId]); await flushRAGStore(); return; }
        await memoryStore.markL2SyncStatus(id, "synced", ragId);
        await flushRAGStore();
      } catch (error) { await memoryStore.markL2SyncStatus(id, "sync_failed", undefined, error); throw error; }
    },
  });
  ipc.handle(IPC.MEMORY_GOVERNANCE_EXPLAIN, (_event, id) => service.explain(id));
  ipc.handle(IPC.MEMORY_GOVERNANCE_CHANGE, (_event, command) => service.change(command));
  ipc.handle(IPC.MEMORY_GOVERNANCE_EXPORT, () => service.export());
}
