import { splitTextBySentenceBreaks, splitTextNaturally } from "../../shared/message-segmentation";
import type { MobileMessageSegmentationMode } from "../../shared/preferences";
import type { OutgoingPart } from "./types";

/** Build text parts without exceeding a platform's code-point limit. */
export function buildCapabilityTextParts(
  text: string,
  maxTextLength: number | undefined,
  segmentation: MobileMessageSegmentationMode | "on" | "off" = "off",
): OutgoingPart[] {
  const source = segmentation === "on"
    ? splitTextBySentenceBreaks(text)
    : segmentation === "natural"
      ? splitTextNaturally(text)
      : [text.trim()].filter(Boolean);
  const max = Number.isFinite(maxTextLength) && (maxTextLength ?? 0) > 0 ? Math.floor(maxTextLength!) : 0;
  return source.flatMap(value => {
    const codePoints = Array.from(value);
    if (!max || codePoints.length <= max) return [{ kind: "text" as const, text: value }];
    const parts: OutgoingPart[] = [];
    for (let offset = 0; offset < codePoints.length; offset += max) {
      parts.push({ kind: "text", text: codePoints.slice(offset, offset + max).join("") });
    }
    return parts;
  });
}
