const OWNER_SCOPE = "owner";

export function resolvePersonalMemoryScope(input: {
  privateRelationshipContext?: boolean;
  promptSource?: string;
  channel?: string;
  memoryScope?: string;
}): string | undefined {
  if (input.privateRelationshipContext === false || input.promptSource === "plugin-agent") return undefined;
  if (!input.channel) return OWNER_SCOPE;
  const scope = input.memoryScope;
  return typeof scope === "string" && /^peer:[a-z0-9_-]{8,96}$/i.test(scope) ? scope : undefined;
}

export function isOwnerMemoryScope(scope?: string): boolean {
  return scope === OWNER_SCOPE;
}

export const PERSON_MEMORY_TOOL_IDS = new Set(["memory_remember", "memory_recall", "memory_forget"]);
export const OWNER_MEMORY_TOOL_IDS = new Set(["user_memory", "read_memory", "write_memory", "recall_history", "wiki_search", "wiki_read_page"]);
