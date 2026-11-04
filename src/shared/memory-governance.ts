export interface MemoryExplanation {
  id: string;
  content: string;
  sourceQuote?: string;
  conversationId?: string;
  evidence: Array<{ id: string; quoteSnippet: string; conversationId?: string; messageIds?: string[]; sourceStatus: string }>;
  confidence: number | null;
  related?: MemoryDeletionPreview;
}
export interface MemorySourceLocator { conversationId: string; messageId: string }
export interface MemoryDeletionPreview {
  revision: string;
  memories: Array<{ id: string; content: string; summary: boolean }>;
  profiles: Array<{ key: string; content: string }>;
  wikiClaims: Array<{ pageId: string; claimId: string; title: string; content: string }>;
  sources: MemorySourceLocator[];
  wikiAvailable: boolean;
  notes: string[];
}
export interface MemoryDeletionSelection {
  revision: string;
  memoryIds: string[];
  profileKeys: string[];
  wikiClaims: Array<{ pageId: string; claimId: string }>;
  preventReplay: boolean;
}
export type MemoryEditCommand = {
  id: string;
  expectedContent: string;
} & ({ action: "edit"; content: string } | { action: "archive" } | { action: "delete"; selection?: MemoryDeletionSelection });
export interface MemoryGovernanceApi {
  explain(id: string): Promise<MemoryExplanation>;
  change(command: MemoryEditCommand): Promise<{ ok: true; warning?: string }>;
  export(): Promise<string>;
}
