import type { ConversationMode } from "../../shared/chat-types";
import { loadPromptFile } from "../prompts/prompt-loader";
import { buildGoldenDescendantsPrompt } from "../tasks/task-character-pool";
import { composeModePrompt, type PromptLoader } from "./mode-prompt-profile-core";
export type { PromptLoader } from "./mode-prompt-profile-core";

export function buildModePrompt(mode: ConversationMode, load: PromptLoader = loadPromptFile): string {
  return composeModePrompt(mode, load, mode === "work" || mode === "code" ? buildGoldenDescendantsPrompt() : "");
}
