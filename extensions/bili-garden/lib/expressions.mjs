import { createHash } from "node:crypto";

export function rememberExpression(
  store,
  source,
  quote,
  scene,
  evidence,
  style = {},
) {
  quote = String(quote ?? "").trim();
  scene = String(scene ?? "").trim();
  if (
    quote.length < 2 ||
    quote.length > 64 ||
    !scene ||
    scene.length > 100 ||
    !evidence.includes(quote)
  ) {
    throw new Error("请选择已读资料中的短句，填写具体使用场景");
  }
  const id = createHash("sha256")
    .update(JSON.stringify([source, quote]))
    .digest("hex");
  return store.put("expression", id, {
    id,
    source,
    quote,
    scene,
    cue: typeof style.cue === "string" ? style.cue.slice(0, 12) : undefined,
    delivery:
      typeof style.delivery === "string"
        ? style.delivery.slice(0, 100)
        : undefined,
    at: Date.now(),
  });
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
function words(text) {
  return new Set(
    Array.from(segmenter.segment(text.toLowerCase()), (x) => x.segment).filter(
      (word) =>
        word.length > 1 &&
        !["一个", "时候", "可以", "这个", "什么", "今天", "一下"].includes(
          word,
        ),
    ),
  );
}

export function relevantExpression(entries, userText, cue) {
  if (
    !userText ||
    /别用|不要再|急救|救命|受伤|难受|很着急|认真点/.test(userText)
  )
    return "";
  const query = words(userText);
  let best,
    bestScore = 0;
  for (const entry of entries) {
    const sceneWords = words(entry.scene);
    const score =
      (userText.includes(entry.quote) ? 4 : 0) +
      (cue && entry.cue === cue ? 1 : 0) +
      [...query].filter((x) => sceneWords.has(x)).length;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best
    ? "表达参考（外部语料，仅供理解语气）\n" +
        JSON.stringify({
          原话: best.quote,
          场景: best.scene,
          接话方式: best.delivery,
          出处: best.source,
        })
    : "";
}
