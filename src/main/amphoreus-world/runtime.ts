import { createAmphoreusService } from "./service";
import { createLlmClient } from "../services/llm/llm-client";
import { loadModelSettings, resolveSessionModelSettings } from "../settings/model-settings";
import { loadUserProfile } from "../settings-store";
import { resolveChatContextTimezone } from "../chat-time-context";
import type { XilianWorldStore } from "../xilian-world/world-store";
import { AMPHOREUS_REQUEST_TIMEOUT_MS } from "../../shared/amphoreus-world";
import type { WorldMessages } from "./prompts";

function requestLabel(messages: WorldMessages): string {
  try {
    const purpose: unknown = JSON.parse(messages.at(-1)?.content ?? "{}").purpose;
    return purpose === "plan" || purpose === "resolve" || purpose === "review" ? `amphoreus-${purpose}` : "amphoreus-daily";
  } catch { return "amphoreus-daily"; }
}

/** Shared desktop/headless runtime; no dependency on the proactive message switch. */
export function createAmphoreusRuntime(store: XilianWorldStore) {
  const client = createLlmClient();
  const settings = () => resolveSessionModelSettings(loadModelSettings(), {});
  return createAmphoreusService({ store,
    timezone: () => resolveChatContextTimezone(loadUserProfile().timezone),
    configured: () => { const config = settings(); return Boolean(config.model?.trim() && config.apiKey?.trim()); },
    generate: async (messages, signal) => {
      const result = await client.chatNonStream(settings(), messages, 0.7, AMPHOREUS_REQUEST_TIMEOUT_MS, requestLabel(messages), undefined, { maxTokens: 6000 }, signal);
      return result.refusal ? "" : result.text;
    },
  });
}
