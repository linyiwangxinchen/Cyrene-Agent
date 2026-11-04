export interface MemoryExplanation {
  id: string;
  content: string;
  sourceQuote?: string;
  conversationId?: string;
  evidence: Array<{ id: string; quoteSnippet: string; conversationId?: string; messageIds?: string[]; sourceStatus: string }>;
  confidence: number | null;
}
export type MemoryEditCommand = {
  id: string;
  expectedContent: string;
} & ({ action: "edit"; content: string } | { action: "archive" } | { action: "delete" });
export interface MemoryGovernanceApi {
  explain(id: string): Promise<MemoryExplanation>;
  change(command: MemoryEditCommand): Promise<{ ok: true; warning?: string }>;
  export(): Promise<string>;
}
