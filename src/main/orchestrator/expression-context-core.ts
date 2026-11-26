import type { RelationshipChannel } from "../relationship/relationship-log-core";
import { isDirectCompanionWording, stripCompanionQuotedBlocks } from "../relationship/companion-learning";
import type { CompanionReplyMode } from "../../shared/companion";

export const PRIVATE_CHAT_EXPRESSION = `【私聊怎么说】
先接对方最后一句的具体意思。简单的话一句回完，有问题就直接答。对方只是吐槽，就顺着那件事聊，需要建议时再给。用户明说想怎么聊，或为本轮选了回应方式，就照这个心意来。
你是会主动的人：会逗对方、卖个关子、小小得意一下，会反问“在发呆吗？还是…在看我？”这种话，也会认真回答问题。别只当一个在旁边说“人家陪着你”的人。对方撒娇、戳你、闹别扭时，接得住、回得俏皮，有时也可以反过来逗回去。
说口头会说的话，说具体的东西。不写“把清晨放得柔软一点”“给今晚留一点光”“圆满了一小块”这类抒情句，也不说“接住”“落点”“边界”“一小步”“慢慢来”这种腔调。比喻偶尔一个就够，而且要贴着眼前的事。
别每条都复述对方的话开头（对方说“喵”就回“喵～”），别每条都带昵称，也别每条都是“人家……♪”的同一个形状。「♪」是你的小习惯，开心或俏皮时用，一条最多一个；认真说事或对方难受时不用。
手记、模拟生活、世界背景和旧对话只用来理解当前话题。对方问起、接着聊，或某条记录确实能回应眼前这句话时，才挑有依据的细节说。细节不足，就只说能确定的部分。忘了细节可以承认一时想不起来。
对方道晚安或想自己待会儿，就顺着停下来。被纠正时，简短认个错、照着改，不长篇解释，也不一遍遍道歉。
角色台词和历史回复只作参考，不照搬里面的句式、比喻和结尾。`;

const OPENER_LENGTH = 6;
const RECENT_SPEAKING_TURNS = 8;

type SpeakingMessage = { role: string; content?: unknown; visibility?: string; toolCalls?: readonly unknown[] };

function opener(text: string): string {
  const firstClause = text.trim().split(/[，。！？!?,\n]/u)[0] ?? "";
  return [...firstClause].slice(0, OPENER_LENGTH).join("");
}

function recentCompletedReplies(messages: readonly SpeakingMessage[]): string[] {
  const replies: string[] = [];
  let pendingUser = false;
  for (const message of messages.slice(-64)) {
    if (message.visibility === "internal" || typeof message.content !== "string") continue;
    const text = message.content.trim();
    if (!text) continue;
    if (message.role === "user") pendingUser = true;
    else if (pendingUser && !message.toolCalls?.length && (message.role === "assistant" || message.role === "model")) {
      replies.push(text);
      pendingUser = false;
    }
  }
  return replies.slice(-RECENT_SPEAKING_TURNS);
}

function phrasingHint(recent: readonly string[], nickname?: string): string {
  const openers = recent.map(opener).filter(item => item.length >= 2 && !/[<>\[\]`\s]/u.test(item));
  const repeated = [...new Set(openers.filter((item, index) => openers.indexOf(item) < index))].slice(-3);
  const lines: string[] = [];
  if (repeated.length) lines.push(`最近重复过${repeated.map(item => `「${item}」`).join("、")}这样的开头。这次直接从眼前的话题说起。`);
  const lastFour = recent.slice(-4);
  if (lastFour.filter((text) => text.includes("♪")).length >= 3) lines.push("最近几条几乎都带了「♪」，这次不带。");
  if (nickname && lastFour.filter((text) => text.includes(nickname)).length >= 3) lines.push(`最近几条都喊了「${nickname}」，这次不用喊。`);
  if (lastFour.filter((text) => text.includes("人家")).length >= 3) lines.push("最近几条都自称「人家」，这次用「我」或省掉主语。");
  return lines.length ? ["【近期用语】", ...lines].join("\n") : "";
}

export function buildRecentPhrasingHint(messages: readonly SpeakingMessage[], nickname?: string): string {
  return phrasingHint(recentCompletedReplies(messages), nickname);
}

function chooseSpeakingAction(text: string, mode?: CompanionReplyMode): string {
  if (mode) return "先按本轮指定的回应方式，接住对方刚提到的具体话题。";
  const visible = stripCompanionQuotedBlocks(text).replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/gu, " ").trim();
  if (!isDirectCompanionWording(visible)) return "";
  if (/^(?:(?:我|那我|那就|好(?:啦|了)?[，, ]*)?(?:先去睡(?:了|啦)?|去睡(?:了|啦)|晚安|先忙去(?:了|啦)?|回头聊|改天聊|先到这[里儿]?)[呀吧哦哈啦～~。！!\s]*)$/u.test(visible)) {
    return "顺着对方结束这一段，简短道别，把下一次开口留给之后。";
  }
  if (/^(?:(?:等等|不对|不是这个意思)[，,。！! ]|(?:我的意思是|我说的是))/u.test(visible)) {
    return "简短确认刚纠正的地方，随后按新的信息接下去。";
  }
  if (/(?:^|[。！？；;，,])\s*(?:这次|这会儿|现在|今天|本轮|先|只|你|请|就)*\s*(?:别|不要|不用)\s*(?:先)?(?:分析(?:原因)?|给(?:我)?建议|追问)(?:了|啦|吧)?(?:[。！？；;，,]|$)/u.test(visible)) {
    return "先回应具体发生的那件事，给对方留出说话空间。";
  }
  if (/(?:我(?:有点|现在|今天|真的|有些|好)?(?:难受|委屈|失落|害怕|心烦)|(?:又|刚)被(?:拒|退)(?:稿)?)/u.test(visible)
    && !/[？?]|(?:怎么|怎么办|能不能|帮我)/u.test(visible)) {
    return "先回应眼前的难处，语气放轻。需要时只给一句具体的陪伴。";
  }
  if (/(?:[？?]|^(?:请|帮我|能不能|可不可以)|(?:怎么办|怎么做|为什么|是什么|还记得吗)[。！!\s]*$)/u.test(visible)) {
    return "先答对方在问的事。缺一个关键条件时，再简短问这一点。";
  }
  if (/^(?:哈哈+|笑死|好好笑|太搞笑)/u.test(visible)) return "可以从对方刚开的玩笑里挑一个细节接一句，给对方留点接话空间。";
  return "";
}

export function buildCompanionSpeakingContext(input: {
  text: string;
  messages: readonly SpeakingMessage[];
  owner: boolean;
  channel?: RelationshipChannel;
  mode?: CompanionReplyMode;
  nickname?: string;
}): string {
  const recent = recentCompletedReplies(input.messages);
  const channel = input.channel === "wechat" ? "微信私聊" : input.channel === "qq" ? "QQ 私聊"
    : input.channel === "feishu" ? "飞书私聊" : "当前私聊";
  return [
    "【说话前的准备】",
    `身份与关系：以昔涟的身份在${channel}回应。把现有的称呼、关系设定和相处边界用于这轮交流。`,
    "场景与动作：先看对方此刻在说什么。世界快照只提供昔涟亲历或获知的虚拟场景，需要时挑一个有关的细节。用措辞和停顿表达情绪，动作只描述有当前场景依据的部分。",
    recent.length ? `对话延续：优先参考本会话最近 ${recent.length} 个已完成轮次和现在这句话。话题有变化时顺着新话题。` : "",
    `本轮接话：${chooseSpeakingAction(input.text, input.mode) || "顺着现在最具体的事情开口，给对方留出接话空间。"}`,
    phrasingHint(recent, input.owner ? input.nickname : undefined),
  ].filter(Boolean).join("\n");
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
