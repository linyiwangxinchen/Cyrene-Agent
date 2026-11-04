import type { CompanionFollowup } from "../../shared/companion";

export function normalizeFollowups(value: unknown): CompanionFollowup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("具体跟进事项最多100项");
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.topic !== "string" || !item.topic.trim() || item.topic.length > 200
      || typeof item.conversationId !== "string" || !item.conversationId.trim() || item.conversationId.length > 200
      || !Number.isFinite(item.nextEligibleAt) || item.nextEligibleAt < 0
      || !["active", "awaiting_reply", "completed", "paused", "cancelled"].includes(item.status)
      || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)
      || (item.lastAskedAt !== undefined && !Number.isFinite(item.lastAskedAt))
      || (item.lastIntentId !== undefined && typeof item.lastIntentId !== "string")
      || (item.resolutionReason !== undefined && typeof item.resolutionReason !== "string")) throw new Error("具体跟进事项格式无效，原始数据已保留");
    ids.add(item.id);
    return { ...item, topic: item.topic.trim(), conversationId: item.conversationId.trim() };
  });
}

/** 只识别同会话、完整事项名称与直接明确的结束表达；引用、疑问、否定和省略一律不猜。 */
export function resolveExplicitFollowupReply(topic: string, userText: string): "completed" | "cancelled" | undefined {
  const text = userText.trim();
  if (!text || text.length > 1000 || /[?？“”"「」『』]|(?:还没|没有|未完成|没完成|没做完)/.test(text)) return undefined;
  const literal = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subject = `(?:关于)?${literal}(?:这件事|这个事|的事)?[，,:：\\s]*`;
  if (new RegExp(`^(?:${subject}(?:不用|不要|别)再(?:问|追问|提醒)(?:了|我)?|(?:不用|不要|别)再(?:问|追问|提醒)(?:我)?${literal}(?:这件事|的事)?)[。！!\\s]*$`).test(text)) return "cancelled";
  if (new RegExp(`^(?:${subject}(?:已经|已)?|我(?:已经|已)?(?:把)?${literal})(?:完成了|完成|结束了|办好了|搞定了|做完了)[。！!\\s]*$`).test(text)) return "completed";
  return undefined;
}
