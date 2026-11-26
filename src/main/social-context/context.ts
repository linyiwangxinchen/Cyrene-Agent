import { rankSocialAtoms } from "./retrieval";
import type { SocialAtom } from "./types";

export function socialAtomDisplayText(atom: SocialAtom): string {
  return atom.quoteOnly ? `原话 ${JSON.stringify(atom.evidenceQuote)}` : atom.content;
}

export function compileSocialContextBlock(atoms: readonly SocialAtom[]): string {
  if (atoms.length === 0) return "";
  const past = atoms.filter((atom) => atom.type !== "open_loop").slice(0, 5);
  const openLoops = atoms.filter((atom) => atom.type === "open_loop").slice(0, 5);
  const lines = [
    "【本轮可用的对话背景】",
    "只在确实相关时自然使用；不要复述这份背景，不要展示或强调你具有记忆能力。",
  ];
  if (past.length > 0) {
    lines.push("相关的过去：", ...past.map((atom) => `- ${atom.content}`));
  }
  if (openLoops.length > 0) {
    lines.push("尚未接上的话题：", ...openLoops.map((atom) => `- ${atom.content}`));
  }
  return lines.join("\n");
}

const MAX_LONG_TERM = 8;
const MAX_RECENT = 6;
const MAX_OPEN = 4;

function dateLabel(at: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric", day: "numeric" }).formatToParts(new Date(at));
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${value("month")}月${value("day")}日`;
  } catch {
    const date = new Date(at);
    return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  }
}

function newestFirst(atoms: readonly SocialAtom[]): SocialAtom[] {
  return [...atoms].sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * What she knows about this person, injected every private turn. "戳～" has no
 * words to search with, so lexical retrieval alone left her knowing nothing.
 * Long-term facts are always present (relevant ones first); recent happenings
 * and unfinished things are listed by date so "明天" in an old message is not
 * read as tomorrow.
 */
export function buildPersonMemoryContext(
  atoms: readonly SocialAtom[],
  query: string,
  options: { now: number; timezone: string },
): { contextBlock: string; retrievedAtoms: SocialAtom[] } {
  const active = atoms.filter((atom) => atom.status === "active"
    && (typeof atom.expiresAt !== "number" || atom.expiresAt > options.now));
  const longTerm = active.filter((atom) => atom.type === "long_term");
  const relevant = rankSocialAtoms(query, longTerm, { now: options.now, limit: MAX_LONG_TERM });
  const facts = [...relevant, ...newestFirst(longTerm).filter((atom) => !relevant.includes(atom))].slice(0, MAX_LONG_TERM);
  const recent = newestFirst(active.filter((atom) => atom.type === "short_term")).slice(0, MAX_RECENT);
  const open = newestFirst(active.filter((atom) => atom.type === "open_loop")).slice(0, MAX_OPEN);
  const retrievedAtoms = [...facts, ...recent, ...open];
  if (retrievedAtoms.length === 0) return { contextBlock: "", retrievedAtoms };
  const lines = [
    "【你记得的关于对方的事】",
    "这是对方亲口说过的事，日期是对方说起的那天。相关时自然地接上，像本来就记得；不要复述清单，也不要说“我记得”“根据记录”。和对方现在说的冲突时，以现在说的为准。",
  ];
  if (facts.length) lines.push(facts.some(atom => atom.quoteOnly) ? "与对方相关的长期背景：" : "对方是怎样的人：",
    ...facts.map((atom) => `- ${socialAtomDisplayText(atom)}`));
  if (recent.length) lines.push("对方最近的事：", ...recent.map((atom) => `- ${dateLabel(atom.createdAt, options.timezone)}说：${socialAtomDisplayText(atom)}`));
  if (open.length) lines.push("还没有下文、之后可以问问的：", ...open.map((atom) => `- ${dateLabel(atom.createdAt, options.timezone)}说：${socialAtomDisplayText(atom)}`));
  return { contextBlock: lines.join("\n"), retrievedAtoms };
}
