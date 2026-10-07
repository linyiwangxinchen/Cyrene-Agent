import type { ConversationMode } from "../../shared/chat-types";

export type PromptLoader = (filename: string) => string;

export const MODE_PROMPT_FILES: Record<ConversationMode, readonly string[]> = {
  chat: ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"],
  work: ["work_system.md", "work_identity.md", "work_remark.md", "canon_quotes_lite.md"],
  learn: ["learn_system.md", "learn_identity.md", "canon_quotes.md"],
  code: ["code_system.md", "code_identity.md", "code_remark.md", "canon_quotes_lite.md"],
};


/** Shared composition; platform adapters supply paths and available delegation context. */
export function composeModePrompt(mode: ConversationMode, load: PromptLoader, extra = ""): string {
  return [...MODE_PROMPT_FILES[mode].map(load), extra].filter(Boolean).join("\n\n---\n\n");
}
