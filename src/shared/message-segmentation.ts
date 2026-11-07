export const MAX_MESSAGE_SEGMENTS = 10;

const SENTENCE_SEGMENT_BREAK = /[。！？!?；;]/;

export function shouldBreakMessageSegmentAfterChar(char: string): boolean {
  return SENTENCE_SEGMENT_BREAK.test(char);
}

export function shouldSkipMessageSegmentLeadingChar(char: string, isAtSegmentStart: boolean): boolean {
  return isAtSegmentStart && /^\s$/.test(char);
}

export function splitTextBySentenceBreaks(text: string, maxParts = MAX_MESSAGE_SEGMENTS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const safeMaxParts = Math.max(1, Math.floor(maxParts));
  const parts: string[] = [];
  let buffer = "";

  for (const char of clean) {
    if (shouldSkipMessageSegmentLeadingChar(char, buffer.length === 0)) continue;
    buffer += char;

    if (parts.length < safeMaxParts - 1 && shouldBreakMessageSegmentAfterChar(char)) {
      parts.push(buffer);
      buffer = "";
    }
  }

  if (buffer) parts.push(buffer);
  return parts;
}

/**
 * Natural mobile pacing: paragraphs and short sentence groups become a small
 * number of readable bubbles. Fenced code, JSON-like payloads and standalone
 * URLs remain intact because splitting them makes them harder to copy.
 */
export function splitTextNaturally(text: string, maxParts = 4): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.includes("```") || /^https?:\/\/\S+$/u.test(clean) || /^[\[{].*[\]}]$/su.test(clean)) return [clean];
  const safeMaxParts = Math.max(1, Math.floor(maxParts));

  const paragraphs = clean.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const sentences = paragraphs.flatMap((paragraph) => {
    const parts = splitTextBySentenceBreaks(paragraph, MAX_MESSAGE_SEGMENTS);
    return parts.length > 0 ? parts : [paragraph];
  });
  if (sentences.length <= safeMaxParts) return sentences;

  const output: string[] = [];
  const targetLength = Math.max(40, Math.ceil(clean.length / safeMaxParts));
  let buffer = "";
  for (const sentence of sentences) {
    const next = buffer ? `${buffer}${sentence}` : sentence;
    if (buffer && output.length < safeMaxParts - 1 && next.length > targetLength) {
      output.push(buffer);
      buffer = sentence;
    } else {
      buffer = next;
    }
  }
  if (buffer) output.push(buffer);
  if (output.length <= safeMaxParts) return output;
  return output.slice(0, safeMaxParts - 1).concat(output.slice(safeMaxParts - 1).join("")).filter(Boolean);
}
