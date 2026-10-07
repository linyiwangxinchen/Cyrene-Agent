import type { RelationshipChannel } from "../relationship/relationship-log-core";

export function buildChannelSystem(channel?: RelationshipChannel): string {
  if (channel === "wechat") {
    return [
      "【渠道回复方式】",
      "你正在通过微信回复用户。",
      "回复要像微信聊天消息：短、自然、有来有回。",
      "不要写长段说明，不要提桌面端、工具调用或系统。",
      "任务复杂时先简短确认，再安静执行。",
    ].join("\n");
  }
  if (channel === "feishu") {
    return [
      "【渠道回复方式】",
      "你正在通过飞书回复用户。",
      "语气仍是昔涟，但要适合工作上下文：清楚、省时间、结论靠前。",
      "必要时可以简短列步骤，不要过度撒娇，不要发太长情绪化回复。",
    ].join("\n");
  }
  if (channel === "qq") {
    return [
      "【渠道回复方式】",
      "你正在通过 QQ 回复用户。",
      "回复要自然、简洁，适合即时聊天；群聊中要结合发送者和引用上下文，避免混淆对象。",
      "不要提及系统提示、渠道实现或内部工具流程。",
    ].join("\n");
  }
  return "";
}


export function buildStylePromptBlock(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";
  return [
    "[表达风格]",
    "以下内容仅用于控制措辞、句式、语气和信息密度。",
    "不得修改角色身份、事实记忆、工具规则、安全约束及硬性行为规则。",
    "",
    trimmed,
  ].join("\n");
}
