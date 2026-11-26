export type MemoryMode = "vector" | "summary" | "wiki" | "off";

let activeMemoryMode: MemoryMode = "vector";
let memoryModeVersion = 0;

export function normalizeMemoryMode(value: unknown): MemoryMode {
  return value === "summary" || value === "wiki" || value === "off" ? value : "vector";
}

export function isVectorMemoryEnabled(): boolean {
  return activeMemoryMode === "vector";
}

export function isSummaryMemoryEnabled(): boolean {
  return activeMemoryMode === "summary";
}

export function isWikiMemoryEnabled(): boolean {
  return activeMemoryMode === "wiki";
}

export function isPersonalMemoryEnabled(): boolean {
  return activeMemoryMode !== "off";
}

export function getMemoryModeVersion(): number {
  return memoryModeVersion;
}

/** Existing RAG/L0/L1/L2 call sites remain vector-only. */
export function isMemoryEnabled(): boolean {
  return isVectorMemoryEnabled();
}

export function setMemoryMode(mode: MemoryMode): void {
  if (activeMemoryMode !== mode) memoryModeVersion++;
  activeMemoryMode = mode;
}
