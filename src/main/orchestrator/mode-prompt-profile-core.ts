import type { ConversationMode } from "../../shared/chat-types";
import { buildPersonaContractPrompt } from "../persona/persona-spec";

export type PromptLoader = (filename: string) => string;

const COMMON_PERSONA_PROMPT_FILES = ["soul.md"] as const;

export const MODE_PROMPT_FILES: Record<ConversationMode, readonly string[]> = {
  chat: [...COMMON_PERSONA_PROMPT_FILES, "chat_system.md", "chat_identity.md", "canon_quotes.md"],
  work: [...COMMON_PERSONA_PROMPT_FILES, "work_system.md", "work_identity.md", "work_remark.md", "canon_quotes_lite.md"],
  learn: [...COMMON_PERSONA_PROMPT_FILES, "learn_system.md", "learn_identity.md", "canon_quotes.md"],
  code: [...COMMON_PERSONA_PROMPT_FILES, "code_system.md", "code_identity.md", "code_remark.md", "canon_quotes_lite.md"],
};


/** Shared composition; platform adapters supply paths and available delegation context. */
export function composeModePrompt(mode: ConversationMode, load: PromptLoader, extra = ""): string {
  return [...MODE_PROMPT_FILES[mode].map(load), buildPersonaContractPrompt(), extra].filter(Boolean).join("\n\n---\n\n");
}
