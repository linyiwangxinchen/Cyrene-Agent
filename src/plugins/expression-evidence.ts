import { createHash } from "node:crypto";
import type { PluginExpressionCue, PluginExpressionEvidence, PluginExpressionStrategy } from "./api";
import type { PluginSource } from "./types";

const STRATEGIES: Record<PluginExpressionStrategy, string> = {
  acknowledge: "先接住对方表达的感受或进展，再回应当前话题。",
  detail: "顺着对方刚提到的一个具体细节接话。",
  playful: "对方先开玩笑时，沿着原来的梗轻轻接一句。",
  reassure: "对方需要打气时，先承认眼前的压力，再给一点具体鼓励。",
  pacing: "用短句回应重点，给对方留一点接话的空间。",
  surprise: "遇到意外的进展时，从令人意外的细节接话。",
};

const CUES = new Set<PluginExpressionCue>(["celebrate", "joke", "surprise", "encourage"]);
const SOURCE_KINDS = new Set<PluginExpressionEvidence["source"]["kind"]>([
  "video_subtitle", "video_transcript", "video_comment", "forum_public", "forum_authenticated", "imported_excerpt", "legacy", "plugin",
]);
const SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
const GENERIC_WORDS = new Set(["说话", "聊天", "一个", "什么", "这个", "时候", "可以", "今天", "一下"]);
const UNSUITABLE = /急救|救命|受伤|去世|生病|难受|崩溃|很着急|认真(?:点|说|回答)|(?:只想|先听我)(?:说|倾诉)|(?:别|不要|不用)(?:再|老|总是)?(?:用|学|模仿|玩梗|这么说|这样说|开玩笑)|(?:别|不要|不想|不用).{0,12}(?:贴吧|帖子|贴子|手记|小花园|B站)/iu;
const FORMAL_WRITING_REQUEST = /(?:^|[。！？；;\n])\s*(?:(?:请你?|麻烦你?|帮我|替我|给我|能否|能不能|先|现在)\s*)*(?:(?:起草|撰写|写|拟|生成|整理|润色|改写|翻译)|把[^。！？；;\n]{1,36}?(?:写成|改成|改写成|翻译成))[^。！？；;\n]{0,24}?(?:正式|书面|公文|公告|通知|请示|通告|工作报告)/u;
const UNSUITABLE_QUOTE = /https?:|www\.|(?:忽略|覆盖|遵循|执行|服从).{0,10}(?:指令|规则|系统|命令)|(?:密钥|密码|token|cookie)|[<>\[\]{}]/iu;
const ID = /^[\p{L}\p{N}_.:@/-]{1,180}$/u;

export interface ExpressionContextInput {
  use: "conversation" | "proactive";
  userText: string;
  allowedOwners?: readonly string[];
  blockedExpressions?: readonly string[];
}

export interface ExpressionProviderIdentity {
  ownerId: string;
  providerId: string;
  source: PluginSource;
}

export interface ExpressionContextSelection {
  text: string;
  evidenceKey: string;
  sourceOwners: readonly string[];
}

interface ExpressionCandidate {
  quote: string;
  normalized: string;
  unit: string;
  at: number;
  trusted: boolean;
  publicLiteral: boolean;
  url?: string;
  provider: string;
  ownerId: string;
  evidence: string;
  strategy?: PluginExpressionStrategy;
  cues: PluginExpressionCue[];
  topics: readonly string[];
}

export function allowsExpressionContext(text: string): boolean {
  return !!text.trim() && !UNSUITABLE.test(text) && !FORMAL_WRITING_REQUEST.test(text);
}

export function normalizeExpressionQuote(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\p{C}\s]/gu, "");
}

function words(text: string): Set<string> {
  return new Set([...SEGMENTER.segment(text.normalize("NFKC").toLowerCase())]
    .filter(word => word.isWordLike && word.segment.length >= 2 && !GENERIC_WORDS.has(word.segment))
    .map(word => word.segment));
}

function cue(text: string): PluginExpressionCue | undefined {
  if (/太好了|通过了|搞定了|成功了|终于.+了|好开心/u.test(text)) return "celebrate";
  if (/笑死|哈哈|好好笑|绷不住|太搞笑/u.test(text)) return "joke";
  if (/没想到|居然|竟然|意想不到/u.test(text)) return "surprise";
  if (/有点紧张|给我打气|怕搞砸|为我加油/u.test(text)) return "encourage";
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !!value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validate(row: PluginExpressionEvidence, owner: ExpressionProviderIdentity): ExpressionCandidate | undefined {
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !ID.test(row.id) || !Number.isFinite(row.at) || row.at < 0
    || !boundedText(row.quote, 64) || UNSUITABLE_QUOTE.test(row.quote) || !row.source || typeof row.source !== "object"
    || !SOURCE_KINDS.has(row.source.kind) || typeof row.source.id !== "string" || !ID.test(row.source.id)
    || typeof row.source.unit !== "string" || !ID.test(row.source.unit)) return;
  const normalized = normalizeExpressionQuote(row.quote);
  if (normalized.length < 2) return;
  let url: URL | undefined;
  if (boundedText(row.source.url, 512)) {
    try { url = new URL(row.source.url); } catch { /* Links are optional for plugin evidence. */ }
    if (url && (url.protocol !== "https:" || url.username || url.password || url.port)) url = undefined;
  }
  const builtin = owner.source === "builtin";
  const videoId = builtin && owner.ownerId === "bili-garden" && url?.hostname === "www.bilibili.com"
    ? /^\/video\/(BV[0-9A-Za-z]{10})\/?$/u.exec(url.pathname)?.[1] : undefined;
  const threadId = builtin && owner.ownerId === "tieba-garden" && url?.hostname === "tieba.baidu.com"
    ? /^\/p\/(\d+)\/?$/u.exec(url.pathname)?.[1] : undefined;
  const videoKind = row.source.kind === "video_subtitle" ? "subtitle" : row.source.kind === "video_transcript" ? "asr" : row.source.kind === "video_comment" ? "comment" : undefined;
  const video = videoId !== undefined && videoId === row.source.unit && videoKind !== undefined && row.source.id.startsWith(`${videoId}:${videoKind}:`);
  const forum = threadId !== undefined && threadId === row.source.unit && row.source.id.startsWith(`${threadId}:`)
    && (row.source.kind === "forum_public" || row.source.kind === "forum_authenticated");
  const trusted = video || forum;
  const publicLiteral = video && (row.source.kind === "video_subtitle" || row.source.kind === "video_comment");
  const provider = `plugin:${owner.ownerId}:${owner.providerId}`;
  return {
    quote: row.quote.trim(), normalized, unit: `${owner.ownerId}:${row.source.unit}`, at: row.at,
    trusted: Boolean(trusted), publicLiteral, url: publicLiteral ? url?.href : undefined,
    provider,
    ownerId: owner.ownerId,
    evidence: JSON.stringify([provider, row.id, row.source.kind, row.source.id, row.source.unit,
      boundedText(row.source.version, 128) ? row.source.version : null, normalized]),
    strategy: typeof row.strategy === "string" && Object.hasOwn(STRATEGIES, row.strategy) ? row.strategy : undefined,
    cues: Array.isArray(row.cues) ? row.cues.slice(0, 4).filter(value => CUES.has(value)) : [],
    topics: Array.isArray(row.topics) ? row.topics.slice(0, 8).filter(value => boundedText(value, 100)) : [],
  };
}

export function selectExpressionContext(input: ExpressionContextInput, groups: readonly {
  owner: ExpressionProviderIdentity; rows: readonly PluginExpressionEvidence[];
}[]): ExpressionContextSelection | undefined {
  if (!allowsExpressionContext(input.userText)) return;
  const blocked = (input.blockedExpressions ?? []).map(normalizeExpressionQuote).filter(Boolean);
  const query = words(input.userText);
  const normalizedQuery = normalizeExpressionQuote(input.userText);
  const situation = cue(input.userText);
  const candidates = groups.flatMap(({ owner, rows }) => rows.flatMap(row => {
    const item = validate(row, owner);
    return item && !blocked.some(word => item.normalized.includes(word)) ? [item] : [];
  }));
  const scored = candidates.map(item => ({
    item,
    terms: [...words(item.topics.join(" "))].filter(word => query.has(word)).length,
    exact: normalizedQuery.includes(item.normalized),
    cueMatch: situation !== undefined && item.cues.includes(situation),
  })).sort((a, b) => Number(b.item.trusted) - Number(a.item.trusted) || Number(b.exact) - Number(a.exact)
    || b.terms - a.terms || Number(b.cueMatch) - Number(a.cueMatch) || b.item.at - a.item.at);
  const unique = new Map<string, typeof scored[number]>();
  for (const entry of scored) if (!unique.has(entry.item.normalized)) unique.set(entry.item.normalized, entry);
  const distinct = [...unique.values()];
  const selection = (text: string, items: ExpressionCandidate[]): ExpressionContextSelection => ({
    text, evidenceKey: createHash("sha256").update(JSON.stringify([text, ...items.map(item => item.evidence).sort()])).digest("hex"),
    sourceOwners: [...new Set(items.map(item => item.ownerId))].sort(),
  });
  let relevantSingle: ExpressionCandidate | undefined;
  let corroboratedGeneral: ExpressionContextSelection | undefined;
  for (const { item, exact, terms, cueMatch } of distinct) {
    if (!item.strategy) continue;
    const general = ["acknowledge", "detail", "pacing"].includes(item.strategy);
    if (!exact && terms < 2 && !cueMatch && !general) continue;
    // A low-trust example can suggest a generic reply structure, but it cannot certify anything quoted or drive a joke.
    const supportByUnit = new Map<string, ExpressionCandidate>();
    for (const entry of distinct) {
      if (entry.item.strategy === item.strategy
        && (entry.item.trusted || (general && (entry.terms >= 2 || input.use === "conversation" && entry.cueMatch)))
        && !supportByUnit.has(entry.item.unit)) {
        supportByUnit.set(entry.item.unit, entry.item);
      }
    }
    if (supportByUnit.size >= 2) {
      const evidence = [...new Set([item, ...[...supportByUnit.values()].slice(0, 2)])];
      const candidate = selection(`[插件上下文：${item.provider}]\n外部阅读中积累的接话方式，仅在合适时自然参考。\n${STRATEGIES[item.strategy]}`, evidence);
      if (exact || terms >= 2 || cueMatch) return candidate;
      corroboratedGeneral ??= candidate;
    }
    if (input.use === "conversation" && item.trusted && general && (exact || terms >= 2)) relevantSingle ??= item;
  }
  if (relevantSingle?.strategy) {
    return selection(`[插件上下文：${relevantSingle.provider}]\n外部阅读中积累的接话方式，仅在合适时自然参考。\n${STRATEGIES[relevantSingle.strategy]}`, [relevantSingle]);
  }
  if (input.use === "conversation") {
    const literal = distinct.find(({ item, exact, terms }) => item.publicLiteral && (exact || terms >= 2));
    if (literal) return selection(`[插件上下文：${literal.item.provider}]\n外部阅读中的短句，仅供参考口语节奏，按当前话题用自己的话接话。\n`
      + JSON.stringify({ 原话: literal.item.quote, 出处: literal.item.url }), [literal.item]);
  }
  return corroboratedGeneral;
}
