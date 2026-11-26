export interface RecallQueryPlan {
  kind: "recent" | "query";
  clauses: readonly string[];
  exactPhrases: readonly string[];
  terms: readonly string[];
  from?: number;
  to?: number;
  timeBasis?: "event" | "conversation";
  dateLabel?: string;
  ambiguousTime?: true;
  /** Independent dates that single-interval consumers must still treat as ambiguous. */
  scoped?: readonly RecallQueryPlan[];
  wantsSessionContext?: true;
  recentVisible?: readonly string[];
}

interface DateRange { fromDay: number; throughDay: number }
interface DateMention extends DateRange { start: number; end: number }

const DAY = 86_400_000;
const FILLER = /^(?:嗯+|唔+|哦+|好[的啊呀]?|行[吧啊]?|收到|谢谢|嗯嗯|ok(?:ay)?|thanks?|thx)[.!?。！？,，~\s]*$/iu;
const PRONOUN = /(?:那(?:个|件|段|次|本|只|位|边|些|天|时候)|这(?:个|件|段|本|只|位|边|些)|刚(?:刚|才)[说提]|\b(?:that one|it|they|he|she)\b)/iu;
const SESSION_CONTEXT = /(?:这(?:个|段|次)\s*(?:聊天|对话|会话)|the current (?:chat|conversation)|this (?:chat|conversation)).{0,14}(?:之前|前面|刚才|进展|到哪|聊了什么|在做什么|so far|earlier)/iu;
const TEMPORAL = /(?<!\d)(\d{4})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})[日号]?(?!\d)|(?<!\d)(\d{1,2})月(\d{1,2})[日号](?!\d)|(?<!\d)(\d{1,2})天前|大前天|前天|昨天|昨日|昨晚|今天|今日|明天|明日|上星期|上周|本周|这周|上个月|上月|本月|这个月|先週|今週|先月|今月|きのう|\b(?:today|yesterday|tomorrow|(?:last|this) (?:week|month))\b/giu;
const CONVERSATION_TIME = /(?:聊(?:了|过|到|的|些)|谈(?:了|过|到|的)|说过|说的|提到|讨论(?:了|过|的)|聊天记录|旧聊天|旧会话|我们(?:聊|谈)|(?:那天|当天|昨天|前天|上周)(?:的)?(?:聊天|会话|对话)(?!软件|应用|功能)|\b(?:conversation|chat|said|talk about|talked about)\b)/iu;
const CLAUSE_SEPARATOR = /[;；。\r\n]+|[?？!！]+(?=\S)|(?:[,，]\s*)?(?:另外|还有一点|顺便|also\b)/iu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TERM_STOP = new Set(["我们", "你们", "我的", "你的", "没有", "什么", "怎么", "之前", "以前", "上次", "刚才", "记得", "请问", "是否", "一下", "那个", "这个", "聊了", "聊过", "说过", "的事", "the", "you", "your", "how", "what", "when", "we", "our", "was", "were", "did", "that", "this", "it", "is", "am", "are", "of", "and", "to", "for", "in", "on"]);
const formatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone?: string): Intl.DateTimeFormat {
  const name = timeZone?.trim() || "Asia/Shanghai";
  const cached = formatters.get(name);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: name, year: "numeric", month: "numeric", day: "numeric" }); }
  catch { return dayFormatter("Asia/Shanghai"); }
  if (formatters.size >= 16) formatters.clear();
  formatters.set(name, formatter);
  return formatter;
}

function localDay(timestamp: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(timestamp);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return Date.UTC(read("year"), read("month") - 1, read("day"));
}

/** Convert a civil-day boundary without assuming each local day has 24 hours. */
function dayBoundary(day: number, formatter: Intl.DateTimeFormat): number {
  let low = day - 2 * DAY;
  let high = day + 2 * DAY;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDay(mid, formatter) < day) low = mid + 1;
    else high = mid;
  }
  return low;
}

function explicitDay(year: number, month: number, date: number): number | undefined {
  if (year < 1900 || year > 2200) return;
  const day = Date.UTC(year, month - 1, date);
  const value = new Date(day);
  if (value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === date) return day;
}

function dateMentions(text: string, today: number): { items: DateMention[]; invalid: boolean } {
  const current = new Date(today);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const items: DateMention[] = [];
  let invalid = false;
  for (const match of text.matchAll(TEMPORAL)) {
    const [cue, fixedYear, fixedMonth, fixedDate, partialMonth, partialDate, daysAgo] = match;
    let fromDay: number | undefined;
    let throughDay: number | undefined;
    if (fixedYear || partialMonth) fromDay = explicitDay(Number(fixedYear ?? year), Number(fixedMonth ?? partialMonth), Number(fixedDate ?? partialDate));
    else if (daysAgo) fromDay = today - Number(daysAgo) * DAY;
    else if (/^(?:上星期|上周|本周|这周|先週|今週|(?:last|this) week)$/iu.test(cue)) {
      const monday = today - ((current.getUTCDay() + 6) % 7) * DAY;
      fromDay = monday - (/^(?:上|先|last)/iu.test(cue) ? 7 * DAY : 0);
      throughDay = fromDay + 7 * DAY;
    } else if (/^(?:上个月|上月|本月|这个月|先月|今月|(?:last|this) month)$/iu.test(cue)) {
      const offset = /^(?:上|先|last)/iu.test(cue) ? -1 : 0;
      fromDay = Date.UTC(year, month + offset, 1);
      throughDay = Date.UTC(year, month + offset + 1, 1);
    } else {
      const delta = /^(?:大前天)$/u.test(cue) ? -3 : /^前天$/u.test(cue) ? -2
        : /^(?:昨天|昨日|昨晚|きのう|yesterday)$/iu.test(cue) ? -1 : /^(?:明天|明日|tomorrow)$/iu.test(cue) ? 1 : 0;
      fromDay = today + delta * DAY;
    }
    if (fromDay === undefined) { invalid = true; continue; }
    items.push({ fromDay, throughDay: throughDay ?? fromDay + DAY, start: match.index, end: match.index + cue.length });
  }
  return { items, invalid };
}

export function tokenizeRecallText(text: string, mode: "document" | "query"): string[] {
  const chunks = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = new Set<string>();
  for (const chunk of chunks) {
    const runs = chunk.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
    for (const run of runs) {
      const letters = Array.from(run);
      if (!CJK.test(run)) {
        if (mode === "document" || !TERM_STOP.has(run)) tokens.add(run);
      } else {
        if (mode === "document" || letters.length === 1) for (const letter of letters) tokens.add(letter);
        for (let index = 1; index < letters.length; index += 1) {
          const pair = letters[index - 1] + letters[index];
          if (mode === "document" || !TERM_STOP.has(pair)) tokens.add(pair);
        }
      }
    }
  }
  return [...tokens];
}

/** Calendar dates and query hints are pure, local and bounded before any storage lookup. */
export function buildRecallQueryPlan(input: { query: string; now?: number; timeZone?: string; topicHint?: string; recentVisible?: readonly string[] }): RecallQueryPlan {
  const query = input.query.normalize("NFKC").trim().slice(0, 320);
  if (!query || FILLER.test(query)) return { kind: "recent", clauses: [], exactPhrases: [], terms: [] };
  const formatter = dayFormatter(input.timeZone);
  const now = Number.isFinite(input.now) ? input.now! : Date.now();
  const { items: dates, invalid } = dateMentions(query, localDay(now, formatter));
  const explicitRange = dates.length === 2 && /^(?:至|到|—|–|-|~|～|through|to)$/iu.test(query.slice(dates[0].end, dates[1].start).trim());
  const compatibleDates = dates.length > 0 && dates.every(date => date.fromDay === dates[0].fromDay && date.throughDay === dates[0].throughDay);
  const independentClauses = dates.length > 1 && !invalid && !explicitRange ? query.split(CLAUSE_SEPARATOR).map(part => part.trim()).filter(Boolean) : [];
  const datedClauses = independentClauses.length >= 2 && independentClauses.length <= 3
    ? independentClauses.map(part => buildRecallQueryPlan({ ...input, query: part, now })) : [];
  const allDated = datedClauses.length > 0 && datedClauses.every(part => part.from !== undefined && part.to !== undefined);
  const mixedTimeBasis = allDated && datedClauses.some(part => part.timeBasis !== datedClauses[0].timeBasis);
  const distinct = allDated && datedClauses.every((part, index) => datedClauses.slice(0, index).every(other =>
    part.from! >= other.to! || other.from! >= part.to!));
  const validDate = !invalid && ((compatibleDates && !mixedTimeBasis) || (explicitRange && dates[1].fromDay >= dates[0].fromDay));
  let body = explicitRange ? `${query.slice(0, dates[0].start)} ${query.slice(dates[1].end)}` : query;
  if (!explicitRange) for (const date of [...dates].reverse()) body = `${body.slice(0, date.start)} ${body.slice(date.end)}`;
  body = body.replace(/\s+/g, " ").trim();
  if (validDate && /^(?:(?:我们|你我|你|我)\s*)?(?:聊(?:过|了)?|谈(?:过|了)?|说(?:过|了)?)(?:些|了|的)?\s*(?:什么|啥)(?:来着|了吗|呢)?[？?。\s]*$/u.test(body)) body = "";
  if (validDate && /^(?:what (?:did|were) (?:we|you) (?:talk(?:ing)?|chat(?:ting)?) about)[?!.\s]*$/iu.test(body)) body = "";
  const clauses = body.split(CLAUSE_SEPARATOR)
    .map(clause => clause.replace(/^[,，:：\s]+|[?？!！,，.。\s]+$/gu, ""))
    .filter(clause => clause && !FILLER.test(clause)).slice(0, 4);
  const hint = input.topicHint?.normalize("NFKC").trim().slice(-120);
  if (hint && clauses.length && query.length <= 48 && PRONOUN.test(body) && !clauses.includes(hint)) {
    if (clauses.length < 4) clauses.push(hint);
  }
  const terms = [...new Set(clauses.flatMap(clause => tokenizeRecallText(clause, "query")))].slice(0, 24);
  const rangeEnd = explicitRange ? dates[1].throughDay : dates[0]?.throughDay;
  const dayLabel = (day: number) => new Date(day).toISOString().slice(0, 10);
  const dateLabel = validDate && rangeEnd !== undefined ? (rangeEnd - dates[0].fromDay === DAY
    ? dayLabel(dates[0].fromDay) : `${dayLabel(dates[0].fromDay)}至${dayLabel(rangeEnd - DAY)}`) : undefined;
  return {
    kind: "query", clauses, exactPhrases: clauses.map(clause => clause.toLowerCase()), terms,
    ...(validDate ? {
      from: dayBoundary(dates[0].fromDay, formatter),
      to: dayBoundary(rangeEnd!, formatter),
      timeBasis: CONVERSATION_TIME.test(query) ? "conversation" : "event",
      dateLabel,
    } : invalid || dates.length ? { ambiguousTime: true as const } : {}),
    ...(distinct ? { scoped: datedClauses } : {}),
    ...(SESSION_CONTEXT.test(query) ? { wantsSessionContext: true as const } : {}),
    ...(input.recentVisible?.length ? { recentVisible: input.recentVisible.slice(-8).map(text => text.slice(-1_200)) } : {}),
  };
}

/** Confirm an event date by an unambiguous, complete calendar date in the user's evidence. */
export function validateRecallEventDate(value: unknown, evidence: string): string | undefined {
  if (typeof value !== "string") return;
  const parts = /^(\d{4})-(\d\d)-(\d\d)$/u.exec(value);
  if (!parts) return;
  const [, year, month, date] = parts;
  if (explicitDay(Number(year), Number(month), Number(date)) === undefined) return;
  const normalized = evidence.normalize("NFKC");
  const datePattern = new RegExp(`(?<!\\d)${year}\\s*(?:年|[-/])\\s*0?${Number(month)}\\s*(?:月|[-/])\\s*0?${Number(date)}(?:日|号)?(?!\\d)`, "u");
  return datePattern.test(normalized) ? value : undefined;
}

export function recallEventDateMatches(plan: RecallQueryPlan, eventDate: string | undefined, timeZone?: string): boolean {
  if (plan.from === undefined || plan.to === undefined || !eventDate) return false;
  const formatter = dayFormatter(timeZone);
  const event = Date.parse(`${eventDate}T00:00:00Z`);
  return Number.isFinite(event) && event >= localDay(plan.from, formatter) && event <= localDay(plan.to - 1, formatter);
}

export function verifiedRecallEventDates(text: string, evidence: string): string[] {
  const dates = new Set<string>();
  for (const match of text.normalize("NFKC").matchAll(/(?<!\d)(\d{4})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})(?:日|号)?(?!\d)/gu)) {
    const [, year, month, day] = match;
    const date = validateRecallEventDate(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, evidence);
    if (date) dates.add(date);
  }
  return [...dates];
}
