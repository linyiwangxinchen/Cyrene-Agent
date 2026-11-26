import { allowsCasualTiebaContext, tiebaSourceThread } from "./conversation-context.mjs";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const commonWords = new Set(["一个", "时候", "可以", "这个", "什么", "今天", "一下", "东西"]);
const techniques = {
  acknowledge: "先顺着对方刚提到的事回应，再自然说一句自己的感受。",
  detail: "顺着对方刚提到的具体细节接话。",
  playful: "对方已经在开玩笑时，顺着原来的梗轻轻接一句。",
  reassure: "对方需要打气时，先承认眼前的压力，再给一点具体的鼓励。",
  pacing: "用短句回应重点，留一点空间让对方说下去。",
  surprise: "有意外进展时，顺着出人意料的细节表达好奇。",
};

export function recognizedStyle(value) {
  return typeof value === "string" && Object.hasOwn(techniques, value) ? value : undefined;
}

function sampleStyle(sample) {
  const stated = recognizedStyle(sample.style);
  if (stated) return stated;
  const { cue, delivery = "" } = sample;
  if (/短句|留.{0,4}空间|说完|先听/u.test(delivery)) return "pacing";
  if (/细节|具体的事|具体事/u.test(delivery)) return "detail";
  if (/接住|承认感受|顺着.{0,8}(?:好消息|感受)/u.test(delivery)) return "acknowledge";
  if (cue === "接梗" || /玩笑|调侃|接梗/u.test(delivery)) return "playful";
  if (cue === "鼓励" || /鼓励|打气|减轻压力/u.test(delivery)) return "reassure";
  if (cue === "惊讶") return "surprise";
  if (cue === "庆祝") return "acknowledge";
}

function words(text) {
  return new Set(Array.from(segmenter.segment(text.toLowerCase()), part => part.isWordLike ? part.segment : "")
    .filter(word => word.length > 1 && !commonWords.has(word)));
}

export function speakingStyle(samples, { userText, conversationCue, isExpressionBlocked }) {
  if (!allowsCasualTiebaContext(userText) || !samples.length) return "";
  const query = words(userText);
  const support = new Map();
  let current;
  let bestScore = 0;

  for (const sample of samples.slice().reverse()) {
    if (typeof sample.quote !== "string" || !sample.quote || isExpressionBlocked?.(sample.quote)) continue;
    const tid = tiebaSourceThread(sample.source);
    const style = sampleStyle(sample);
    if (!tid || !style) continue;
    const corroboration = support.get(style) ?? { quotes: new Set(), threads: new Set() };
    corroboration.quotes.add(sample.quote.normalize("NFKC").trim());
    corroboration.threads.add(tid);
    support.set(style, corroboration);

    const terms = typeof sample.scene === "string" ? [...words(sample.scene)].filter(word => query.has(word)).length : 0;
    const exact = userText.includes(sample.quote);
    const cue = conversationCue && sample.cue === conversationCue;
    if (!exact && terms < 2 && !cue) continue;
    const score = (exact ? 6 : 0) + terms * 2 + (cue ? 3 : 0);
    if (score > bestScore) {
      current = style;
      bestScore = score;
    }
  }

  const habits = [...support].map(([style, { quotes, threads }]) => ({ style, count: Math.min(quotes.size, threads.size) }))
    .filter(({ count }) => count >= 2).sort((a, b) => b.count - a.count).map(({ style }) => style);
  const applicable = [...new Set([current, ...habits].filter(Boolean))].slice(0, 2);
  if (!applicable.length) return "";
  return "贴吧读帖里积累的接话习惯。用户本轮的要求和昔涟平时的语气优先；合适时用自己的话自然借鉴一种，说完眼前的话题即可。\n" +
    applicable.map(style => "- " + techniques[style]).join("\n");
}
