import { rankTextCandidates } from "./rag/text-ranking";

export interface StickerTextEntry {
  id: string;
  text: string;
}

export interface StickerTextDescription {
  description?: string;
  phrases?: string[];
}

const DEFAULT_MINIMUM_MATCH_SCORE = 0.9;
const DEFAULT_MINIMUM_LEAD = 0.55;
const MIN_CONFIDENCE_THRESHOLD = 0.3;
const MAX_CONFIDENCE_THRESHOLD = 0.9;

export function buildStickerTextIndex(
  builtIn: Record<string, StickerTextDescription>,
  userStickers: Record<string, StickerTextDescription>,
): StickerTextEntry[] {
  const entries: StickerTextEntry[] = [];
  for (const [id, sticker] of [...Object.entries(builtIn), ...Object.entries(userStickers)]) {
    const text = [...new Set([
      ...(typeof sticker.description === "string" ? [sticker.description] : []),
      ...(Array.isArray(sticker.phrases) ? sticker.phrases : []),
    ].map((phrase) => phrase.trim()).filter(Boolean))].join("\n");
    if (text) entries.push({ id, text });
  }
  return entries;
}

export function matchSticker(
  query: string,
  index: readonly StickerTextEntry[],
  confidenceThreshold = DEFAULT_MINIMUM_LEAD,
): { id: string; score: number } | null {
  if (!query.trim() || index.length === 0) return null;
  const [best, second] = rankTextCandidates(query, index.map((entry) => ({ item: entry, text: entry.text })), 2);
  const threshold = Math.max(MIN_CONFIDENCE_THRESHOLD, Math.min(MAX_CONFIDENCE_THRESHOLD, confidenceThreshold));
  const minimumScore = DEFAULT_MINIMUM_MATCH_SCORE * (threshold / DEFAULT_MINIMUM_LEAD);
  if (!best || best.score < minimumScore) return null;

  const lead = second?.score
    ? (best.score - second.score) / best.score
    : 1;
  const thresholdRange = MAX_CONFIDENCE_THRESHOLD - MIN_CONFIDENCE_THRESHOLD;
  const normalizedThreshold = (threshold - MIN_CONFIDENCE_THRESHOLD) / thresholdRange;
  const minimumLead = DEFAULT_MINIMUM_LEAD * normalizedThreshold;
  if (lead < minimumLead) return null;
  return { id: best.item.id, score: lead };
}
