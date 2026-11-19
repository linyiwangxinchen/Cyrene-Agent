import { buildPersonaContractPrompt } from "../persona/persona-spec";
import { buildRelationshipContext } from "../relationship/relationship-log";
import { buildAlwaysOnContext, buildMemoryInjection } from "../orchestrator";
import { resolveChatContextTimezone } from "../chat-time-context";
import { getDateLocale } from "../locale-context";
import { loadPromptFile } from "../prompts/prompt-loader";
import { loadUserProfile } from "../settings-store";
import { searchMemoryEntries } from "../rag";
import { memoryStore } from "../memory/memory-store";
import { l2DmaeManager } from "../memory/l2-dmae-manager";
import { isMemoryEnabled } from "../memory/memory-mode";

/**
 * 通话共享人设与记忆，使用专用口语约定。
 */
export async function buildCallSystemPrompt(
  userText: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  // 常驻上下文（世界书与用户画像）
  let alwaysOnContext = "";
  try { alwaysOnContext = await buildAlwaysOnContext(userText, messages); } catch { /* ignore */ }

  // 先向量召回，再更新 L2 激活状态。
  if (isMemoryEnabled()) {
    try {
      const allL2 = await memoryStore.getAllL2();
      const recalled = await searchMemoryEntries(userText, "user_memory", 4);
      const recalledIds = recalled
        .map((r) => r.metadata?.l2Id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant")
        ?.content ?? "";
      await l2DmaeManager.updateActivation(allL2, userText, lastAssistant, recalledIds);
    } catch (err) {
      console.warn("[CallPromptBuilder] L2 DMAE update failed:", err);
    }
  }

  let memoryInjection = "";
  try { memoryInjection = await buildMemoryInjection(userText); } catch { /* ignore */ }

  const relationshipContext = await buildRelationshipContext("call", true, userText);
  const userTz = resolveChatContextTimezone(loadUserProfile().timezone);
  const localTime = new Intl.DateTimeFormat(getDateLocale(), {
    timeZone: userTz,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());

  return [
    buildPersonaContractPrompt(),
    `用户当地时间：${localTime}（${userTz}）`,
    alwaysOnContext,
    memoryInjection,
    relationshipContext,
    loadPromptFile("soul.md"),
    loadPromptFile("phone_identity.md"),
    loadPromptFile("phone_system.md"),
    loadPromptFile("phone_style.md"),
  ].filter(Boolean).join("\n\n---\n\n");
}
