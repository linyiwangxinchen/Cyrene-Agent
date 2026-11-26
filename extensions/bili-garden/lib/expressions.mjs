import { createHash } from "node:crypto";
import { videoId } from "./config.mjs";

const cues = { 庆祝: "celebrate", 惊讶: "surprise", 接梗: "joke", 鼓励: "encourage" };
const cueStrategies = { celebrate: "acknowledge", surprise: "surprise", joke: "playful", encourage: "reassure" };
const strategies = new Set(["acknowledge", "detail", "playful", "reassure", "pacing", "surprise"]);
const version = text => createHash("sha256").update(text).digest("hex");

function fingerprint(source, quote) {
  const video = /^https:\/\/www\.bilibili\.com\/video\/(BV[\da-z]{10})(?:[/?#]|$)/iu.exec(source)?.[1];
  const normalized = quote.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\p{C}\s]/gu, "");
  return createHash("sha256").update(JSON.stringify([video ?? source, normalized])).digest("hex");
}

export function locateVideoExpression(bvid, quote, { video, comments = [], segmentIndex, commentId } = {}) {
  const unit = videoId(bvid);
  const base = `https://www.bilibili.com/video/${unit}`;
  const comment = comments.find(row => /^\d+$/u.test(row.id) && (commentId === undefined || row.id === commentId) && row.text.includes(quote));
  if (commentId !== undefined && !comment) return undefined;
  if (comment && segmentIndex === undefined) return { text: comment.text, source: { kind: "video_comment", id: `${unit}:comment:${comment.id}`, unit, url: `${base}/#reply${comment.id}`, version: version(comment.text) } };
  const segments = video?.segments ?? [];
  const index = segmentIndex ?? segments.findIndex(row => Number.isFinite(row.from) && row.to > row.from && row.text.includes(quote));
  const segment = segments[index];
  if (segment && Number.isInteger(index) && Number.isFinite(segment.from) && segment.from >= 0 && Number.isFinite(segment.to)
    && segment.to > segment.from && segment.text.includes(quote) && ["asr", "subtitle"].includes(video.source)) {
    return { text: segment.text, source: { kind: video.source === "asr" ? "video_transcript" : "video_subtitle",
      id: `${unit}:${video.source}:${index}:${segment.from}:${segment.to}`, unit, url: `${base}?t=${Math.floor(segment.from)}`, version: version(segment.text) } };
  }
  if (segmentIndex === undefined && video?.text?.includes(quote)) return { text: video.text, source: { kind: "legacy", id: `${unit}:full`, unit, url: base } };
}

export function forgetExpression(store, id) {
  const row = store.get("expression", id);
  if (!row) return false;
  return store.transaction(() => {
    store.put("expression-forgotten", fingerprint(row.source, row.quote), { at: Date.now() });
    store.remove("expression", id);
    return true;
  });
}

export function visibleExpressions(store, limit = 500) {
  return store.list("expression", limit).filter(row => typeof row.source === "string" && typeof row.quote === "string"
    && !store.get("expression-forgotten", fingerprint(row.source, row.quote)));
}

export function listVideoExpressionEvidence(store, limit) {
  return visibleExpressions(store, limit).map(row => {
    const situation = Object.hasOwn(cues, row.cue) ? cues[row.cue] : undefined;
    const strategy = strategies.has(row.style) ? row.style : cueStrategies[situation];
    const unit = /^https:\/\/www\.bilibili\.com\/video\/(BV[\da-z]{10})(?:[/?#]|$)/iu.exec(row.source)?.[1] ?? row.id;
    return { id: row.id, quote: row.quote, at: row.at,
      source: row.evidence ?? { kind: "legacy", id: row.id, unit, url: row.source },
      topics: [row.scene], ...(situation ? { cues: [situation] } : {}), ...(strategy ? { strategy } : {}),
    };
  });
}

export function rememberExpression(
  store,
  source,
  quote,
  scene,
  evidence,
  style = {},
  reference,
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
  const key = fingerprint(source, quote);
  const legacyId = createHash("sha256")
    .update(JSON.stringify([source, quote]))
    .digest("hex");
  if (store.get("expression-forgotten", key)) {
    throw new Error("用户已忘记这条表达，重新阅读不会恢复");
  }
  const existing = store.get("expression", key) ?? store.get("expression", legacyId);
  const id = existing?.id ?? key;
  const technique = strategies.has(style.style) ? style.style : existing?.style;
  if (existing && (!reference || reference.kind === "legacy" && existing.evidence?.kind !== "legacy"
    || existing.evidence?.version === reference.version && existing.evidence?.id === reference.id && technique === existing.style)) return existing;
  return store.put("expression", id, {
    id,
    source,
    quote,
    scene,
    ...(technique ? { style: technique } : {}),
    cue: typeof style.cue === "string" ? style.cue.slice(0, 12) : undefined,
    delivery:
      typeof style.delivery === "string"
        ? style.delivery.slice(0, 100)
        : undefined,
    ...(reference ? { evidence: reference } : {}),
    at: existing?.at ?? Date.now(),
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
