export interface MemoryVectorIndexStatus {
  modelInstalled: boolean;
  indexReady: boolean;
  phase: "idle" | "downloading" | "repairing" | "complete" | "downloadFailed" | "repairFailed" | "modeChanged";
}
