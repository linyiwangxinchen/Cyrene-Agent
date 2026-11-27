export interface LocalRerankerStatus {
  modelInstalled: boolean;
  ready: boolean;
  enabled: boolean;
  phase: "idle" | "downloading" | "activating" | "complete" | "downloadFailed" | "activationFailed" | "modeChanged";
}
