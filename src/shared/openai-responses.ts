/** Native Responses features for OpenAI models, including compatible relays.
 * An explicit profile setting wins, so partial implementations can opt out.
 * A GPT model name is a protocol convention, not proof of a cache hit.
 */
export function usesNativeOpenAIResponses(config: {
  baseUrl: string;
  model: string;
  responsesNative?: boolean;
}, officialCapability = false): boolean {
  if (typeof config.responsesNative === "boolean") return config.responsesNative;
  if (/^(?:gpt-\d|o\d(?:-|$))/i.test(config.model.trim())) return true;
  try {
    return officialCapability && new URL(config.baseUrl.trim()).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}
