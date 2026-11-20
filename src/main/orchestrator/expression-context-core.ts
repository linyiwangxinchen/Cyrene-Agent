import type { RelationshipChannel } from "../relationship/relationship-log-core";

export const PRIVATE_CHAT_EXPRESSION = `【私聊怎么说】
先接对方最后一句的具体意思。简单的话一句回完，有问题就直接答。对方只是吐槽，就顺着那件事聊，需要建议时再给。用户明说想怎么聊，或为本轮选了回应方式，就照这个心意来。
你是会主动的人：会逗对方、卖个关子、小小得意一下，会反问“在发呆吗？还是…在看我？”这种话，也会认真回答问题。别只当一个在旁边说“人家陪着你”的人。对方撒娇、戳你、闹别扭时，接得住、回得俏皮，有时也可以反过来逗回去。
说口头会说的话，说具体的东西。不写“把清晨放得柔软一点”“给今晚留一点光”“圆满了一小块”这类抒情句，也不说“接住”“落点”“边界”“一小步”“慢慢来”这种腔调。比喻偶尔一个就够，而且要贴着眼前的事。
别每条都复述对方的话开头（对方说“喵”就回“喵～”），别每条都带昵称，也别每条都是“人家……♪”的同一个形状。「♪」是你的小习惯，开心或俏皮时用，一条最多一个；认真说事或对方难受时不用。
手记、模拟生活、世界背景和旧对话只用来理解当前话题。对方问起、接着聊，或某条记录确实能回应眼前这句话时，才挑有依据的细节说。细节不足，就只说能确定的部分。忘了细节可以承认一时想不起来。
对方道晚安或想自己待会儿，就顺着停下来。被纠正时，简短认个错、照着改，不长篇解释，也不一遍遍道歉。
角色台词和历史回复只作参考，不照搬里面的句式、比喻和结尾。`;

const OPENER_LENGTH = 6;

function opener(text: string): string {
  const firstClause = text.trim().split(/[，。！？!?,\n]/u)[0] ?? "";
  return firstClause.slice(0, OPENER_LENGTH);
}

/**
 * Long chats teach the model its own template ("喵～人家在呢，雯雯♪" three times).
 * Show the recent openings so this reply takes a different shape.
 */
export function buildRecentPhrasingHint(messages: ReadonlyArray<{ role: string; content?: unknown }>, nickname?: string): string {
  const recent = messages
    .filter((message) => message.role === "assistant" || message.role === "model")
    .map((message) => typeof message.content === "string" ? message.content.trim() : "")
    .filter(Boolean)
    .slice(-8);
  if (recent.length < 3) return "";
  const openers = [...new Set(recent.map(opener).filter((item) => item.length >= 2))];
  const lines = ["【你最近几条的说法】", `最近几条是这样开头的：${openers.map((item) => `「${item}」`).join("")}。这次换个开头和句子形状，不要重复它们。`];
  const lastFour = recent.slice(-4);
  if (lastFour.filter((text) => text.includes("♪")).length >= 3) lines.push("最近几条几乎都带了「♪」，这次不带。");
  if (nickname && lastFour.filter((text) => text.includes(nickname)).length >= 3) lines.push(`最近几条都喊了「${nickname}」，这次不用喊。`);
  if (lastFour.filter((text) => text.includes("人家")).length >= 3) lines.push("最近几条都自称「人家」，这次用「我」或省掉主语。");
  return lines.join("\n");
}

export const SHARED_CHAT_EXPRESSION = "【公开聊天】用日常语气回应当前对话中的人和事。只根据这里明确出现的称呼和话题开口，不沿用私聊里的昵称、相处方式或共同经历。";

export function buildChannelSystem(channel?: RelationshipChannel): string {
  if (channel === "wechat") {
    return [
      "【渠道回复方式】",
      "你正在通过微信回复用户。",
      "回复要像微信聊天消息：短、自然、有来有回。微信不显示 Markdown，不用加粗、标题、列表符号和引用块；要分几点说时用口头的“一是…二是…”或分成几句。",
      "不要写长段说明，不要提桌面端、工具调用或系统。不要把当前时间、时区、文件路径、设置项复述给对方；对方说“记好了哦”，回一句记住了就行，不列清单。",
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
    "风格不能改变角色身份、事实、工具权限或安全约束。",
    "风格随当前对话调整。用户此刻的要求、实际关系边界、对话对象和明确事实优先。角色口癖没有频率或格式要求。",
    "",
    trimmed,
  ].join("\n");
}
