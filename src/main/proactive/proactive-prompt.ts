import type { ChatMessage } from "../orchestrator/vendors/types";
import { resolveChatContextTimezone } from "../chat-time-context";
import { getZonedDateParts } from "./proactive-trigger";

export interface ProactiveHistoryTurn {
  role: "user" | "model";
  content: string;
  at: number;
}

export interface BuildProactiveMessagesInput {
  basePersona: string;
  userProfile?: string;
  relevantMemory?: string;
  ordinaryHistory: ProactiveHistoryTurn[];
  proactiveHistory: ProactiveHistoryTurn[];
  sceneId: string;
  localNow: Date;
  idleSec: number;
  unansweredCount: 0 | 1 | 2;
  /**
   * 已 resolver 后的用户有效时区（合法 IANA 字符串）。
   * 所有本地时间解释（早晚判定、历史消息时间、当前时间）都基于该时区。
   * 不接受未校验的 profile.timezone 字符串；调用方需先经 resolveChatContextTimezone。
   */
  timezone: string;
  /** Sanitized virtual-life/plugin observation; never raw credentials or tool output. */
  momentContext?: string;
  careContext?:
    | { kind: "standalone_care" }
    | { kind: "user_message" | "requested_followup"; at: number; topic?: string };
  replyBurden?: "none" | "light" | "question";
}

export type ProactiveModelDecision =
  | { kind: "send"; text: string }
  | { kind: "hold"; resumeOn: "user_message" | "evidence_change" }
  | { kind: "drop" }
  | { kind: "silent" }
  | { kind: "invalid"; reason: string };

const MAX_HISTORY_MESSAGES = 16;
const MAX_PROACTIVE_TEXT_LENGTH = 500;

const PROACTIVE_SYSTEM = `[proactive_system]
你正在判断是否要主动向用户发起一次对话，而不是回答用户的新消息。
不要把历史聊天中的最后一句当作用户刚刚发来的消息；历史只用于理解用户最近的状态和话题。
如果内容值得留着但现在不适合，请返回 hold；重复、过时或没有值得说的内容请返回 drop。不要为了完成任务而强行寒暄。
这次只围绕给定的具体动机开口；不要从历史里另找一个借口填补频率。她也可以安静地继续自己的生活。
最近的主动消息用于避免重复。换时间、地点或换一种说法，仍在说同一件没变化的事，就返回 drop。
不要提及系统检测、触发规则、评分、上下文、用户画像或内部状态。
消息应当简短自然，可以关心、分享、跟进或轻轻询问，但不要连续提出多个问题。
不要声称自己调用了工具、读取了屏幕或执行了任何外部动作。`;

const CARE_SYSTEM = `[care_system]
主动联系优先关心对方。有具体来由时，顺着对方亲口提过的事或约好要跟进的事，轻轻问一句近况，或者说一句不用回复也成立的关心。具体、简短，不催答，不诊断，不替对方总结情绪。
过去说过的感受只代表当时。用一个轻轻的问候确认现在怎么样，不默认对方还累着、还在忙、已经睡了，或事情已经结束。没有合适的关心理由可以保持安静；虚构世界的生活分享只在有值得说的新细节时偶尔发。`;

const STANDALONE_CARE_SYSTEM = `[本轮日常关心]
像你和对方平时私聊那样说。就算没有新话题，也可以直接表达一点心意。话说到了就停，半句也可以。
别用固定的开头和收尾，尤其别先解释怎么想起了对方，再补一句客套祝福。要是这会儿只能说些客套话，就返回 drop。
用用户当地时间核对日期和时段。过了当地午夜，“今天”按新日期算。合适时也可以完全不提时间。省去问句、提醒和索要回应的话。对方在做什么、几点睡、心情怎样，消息里只说已知的事。
主动会话历史只用来检查最近有没有说过意思相近的话。刚说过类似的话、上一条主动消息还没收到回复，或此刻说了会打扰，就返回 drop。`;

const TIME_SYSTEM = `[time_system]
以候选里给出的用户当地日期、星期和时间为现在。“今天”“昨天”“明天”按用户当地日历算。读历史消息时，先在那条消息的发送日期上理解它当时说的“今天”“明天”“今晚”，再和现在的日期比较。
消息的发送时间只说明对方何时提到这件事，不能证明事情何时开始或结束。约好的最早跟进时间也不是事情的完成时间。具体日期或进度不清楚时，用事件本身来称呼它，或者问近况，不猜、不把旧事写成刚发生，也不把虚构世界的时间当成用户的现实时间。
晚了可以问候，但只知道当地时间时，不推测对方醒着或正在熬夜。不要复述时间标签或内部判断。`;

const COMPANION_LANGUAGE_SYSTEM = `[companion_language_system]
像平常发一条私聊。开口就说这次想说的事，一两句够了就停。关系和情绪用日常话说，少用项目进度词或抒情结语。
昵称、自称「人家」、省略号和「♪」都随语气自然出现或省略，不设比例，也不用凑固定开头和结尾。日常消息按这里的语气写，角色台词只用于理解人物。`;

const MOMENT_SYSTEM = `[moment_system]
这次候选来自一条有具体来源的陪伴心事。可以自然分享它；只有确实适合邀请对方时才提一个轻量问题。
不要提及队列、插件、评分或内部来源；不要把虚构角色小记说成现实经历。
分享自己的见闻时，说清楚发生了什么或哪一点有趣，只用来源里确实有的细节。如果只有行程、整理记录或还没想明白，缺少具体可分享的信息，就返回 drop，不补一个悬念或感悟。
自己的小事也可以分享，但不要把计划写成已经完成。若此刻打扰感太强，可留到用户回来或事情有进展时再说。`;

const NIGHT_SYSTEM = `[night_system]
用户当地已是夜间。可以放轻语气，用户刚提过累或睡不着时可以顺着关心一句。只凭时间不推测对方的作息。
不要每次都提睡觉；如果上下文中有更自然、更重要的话题，可以先回应那个话题，再轻轻带到休息。
不要透露你检测到了用户的键盘、鼠标、屏幕或系统状态。
如果此刻没有值得主动说的话，请选择保持安静。`;

const FOLLOWUP_SYSTEM = `[followup_system]
这是用户未回复情况下允许的最后一次主动机会。
本地系统已经确认出现了不同于上一次的新场景理由，但你仍应判断它是否值得打扰用户。
不要责怪、催促、卖惨或表现出被冷落，也不要机械地重复"在吗"。
只允许分享一件新的、无需回复也成立的小事，不提问、不追问旧话题。没有这样的内容就保持安静。`;

/** 早晚判定：基于用户时区的 hour。保留原 22:00-08:00 + idle<60 语义。 */
function isActiveNight(date: Date, timezone: string, idleSec: number): boolean {
  const { hour } = getZonedDateParts(date, timezone);
  return (hour >= 22 || hour < 8) && idleSec < 60;
}

/** 用户时区下的"本地时间"格式化：`YYYY-MM-DD HH:MM`。 */
function formatLocalTime(date: Date, timezone: string): string {
  const p = getZonedDateParts(date, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const min = String(p.minute).padStart(2, "0");
  return `${p.year}-${mm}-${dd} ${hh}:${min}`;
}

function formatHistory(label: string, history: ProactiveHistoryTurn[], timezone: string, now: number): string {
  const recent = history
    .filter((turn) => turn && (turn.role === "user" || turn.role === "model") && turn.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);
  const lines = recent.map((turn) => {
    const role = turn.role === "model" ? "assistant" : "user";
    const date = new Date(turn.at);
    const sentAt = Number.isFinite(date.getTime()) && turn.at <= now ? formatLocalTime(date, timezone) : "时间未知";
    return `[${sentAt}] ${role}: ${turn.content.trim()}`;
  });
  return `[${label}]\n${lines.length > 0 ? lines.join("\n") : "（暂无）"}`;
}

export function buildProactiveMessages(input: BuildProactiveMessagesInput): ChatMessage[] {
  const timezone = resolveChatContextTimezone(input.timezone);
  const now = input.localNow.getTime();
  const standaloneCare = input.careContext?.kind === "standalone_care";
  const systemParts = [input.basePersona.trim(), PROACTIVE_SYSTEM, standaloneCare ? "" : CARE_SYSTEM, TIME_SYSTEM, COMPANION_LANGUAGE_SYSTEM];
  if (!standaloneCare) {
    if (input.userProfile?.trim()) systemParts.push(`[用户画像]\n${input.userProfile.trim()}`);
    if (input.relevantMemory?.trim()) systemParts.push(`[相关长期记忆]\n${input.relevantMemory.trim()}`);
    systemParts.push(formatHistory("最近使用的普通聊天会话", input.ordinaryHistory, timezone, now));
  }
  systemParts.push(formatHistory("主动聊天专用会话", input.proactiveHistory, timezone, now));
  if (!standaloneCare && isActiveNight(input.localNow, timezone, input.idleSec)) systemParts.push(NIGHT_SYSTEM);
  if (!standaloneCare && input.unansweredCount === 1) systemParts.push(FOLLOWUP_SYSTEM);
  if (input.careContext?.kind === "standalone_care") {
    systemParts.push(STANDALONE_CARE_SYSTEM);
  } else if (input.careContext) {
    const { kind, at, topic } = input.careContext;
    const timing = formatLocalTime(new Date(at), timezone);
    systemParts.push(kind === "user_message"
      ? `[本轮关心依据]\n对方在 ${timing} 的私聊里表达了当时的感受。只围绕这条用户消息关心近况，尊重对方有没有想聊的意思。`
      : `[本轮约定跟进]\n对方约好要跟进的事：${JSON.stringify(topic)}。最早可问候时间：${timing}（用户当地时间）。按约问候一次，不把这个时间当作事件结果。`);
  } else if (input.momentContext?.trim()) {
    systemParts.push(MOMENT_SYSTEM, `[陪伴心事]\n${input.momentContext.trim()}`);
  }
  if (input.replyBurden === "none" && !standaloneCare) systemParts.push("一句无需回复也成立的关心或分享就够了。省去问句和索要回应的话。");

  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, weekday: "long" }).format(input.localNow);
  const trigger = `[本次主动聊天候选]
用户当地时间：${formatLocalTime(input.localNow, timezone)}（${weekday}，${timezone}）
候选场景：${input.sceneId}
连续未回复次数：${input.unansweredCount}

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"decision":"send","text":"要发送的一条自然消息"}
或
{"decision":"hold","resumeOn":"user_message"}
或
{"decision":"hold","resumeOn":"evidence_change"}
或
{"decision":"drop"}
silent 作为旧协议兼容，也表示本次保持安静。`;

  return [
    { role: "system", content: systemParts.filter(Boolean).join("\n\n---\n\n") },
    { role: "user", content: trigger },
  ];
}

const RECENT_SHARE_WINDOW_MS = 24 * 3_600_000;

function normalizeMessage(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, MAX_PROACTIVE_TEXT_LENGTH);
}

function fourCharacterPhrases(text: string): Set<string> {
  const phrases = new Set<string>();
  for (let index = 0; index + 4 <= text.length; index++) phrases.add(text.slice(index, index + 4));
  return phrases;
}

function isUnfinishedWorldNote(text: string): boolean {
  return /(?:没(?:有)?|尚未)(?:想明白|想清楚|弄明白|搞懂)/u.test(text)
    && /(?:留|留下|留着)(?:一(?:点|些)|个)?空白|下次.{0,12}(?:接着|继续|再)|等.{0,10}新线索/u.test(text);
}

/** Only compare recent proactive messages from the same delivery conversation. */
export function repeatsRecentProactiveMessage(text: string, history: ProactiveHistoryTurn[], now: number, worldShare: boolean): boolean {
  const normalized = normalizeMessage(text);
  if (!normalized) return false;
  const phrases = fourCharacterPhrases(normalized);
  const unfinishedNote = worldShare && isUnfinishedWorldNote(normalized);
  return history.some(turn => {
    if (turn.role !== "model" || turn.at <= now - RECENT_SHARE_WINDOW_MS || turn.at > now) return false;
    const previous = normalizeMessage(turn.content);
    if (previous === normalized || (unfinishedNote && isUnfinishedWorldNote(previous))) return true;
    if (Math.min(normalized.length, previous.length) < 18) return false;
    const previousPhrases = fourCharacterPhrases(previous);
    const shared = [...phrases].filter(phrase => previousPhrases.has(phrase)).length;
    return shared / Math.max(phrases.size, previousPhrases.size) >= 0.72;
  });
}

export function parseProactiveDecision(text: string): ProactiveModelDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const value = parsed as { decision?: unknown; text?: unknown; resumeOn?: unknown };
  const only = (...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  if (value.decision === "silent") return only("decision", "text") && (value.text === undefined || value.text === "") ? { kind: "silent" } : { kind: "invalid", reason: "invalid_shape" };
  if (value.decision === "drop") return only("decision") ? { kind: "drop" } : { kind: "invalid", reason: "invalid_shape" };
  if (value.decision === "hold") {
    if (!only("decision", "resumeOn")) return { kind: "invalid", reason: "invalid_shape" };
    if (value.resumeOn !== "user_message" && value.resumeOn !== "evidence_change") return { kind: "invalid", reason: "invalid_resume_condition" };
    return { kind: "hold", resumeOn: value.resumeOn };
  }
  if (value.decision !== "send") return { kind: "invalid", reason: "invalid_decision" };
  if (!only("decision", "text")) return { kind: "invalid", reason: "invalid_shape" };
  if (typeof value.text !== "string" || !value.text.trim()) return { kind: "invalid", reason: "empty_text" };
  const cleaned = value.text.trim();
  if (cleaned.length > MAX_PROACTIVE_TEXT_LENGTH) return { kind: "invalid", reason: "text_too_long" };
  return { kind: "send", text: cleaned };
}
