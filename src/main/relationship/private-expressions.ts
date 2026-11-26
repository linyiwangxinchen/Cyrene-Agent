import { createHash } from "node:crypto";
import type { RelationshipLogEntry } from "./relationship-log-core";
import { classifyCompanionPragmatics, isDirectCompanionWording, isTemporaryCompanionWording, stripCompanionQuotedBlocks } from "./companion-learning";

type ObservationKind =
  | "definition"
  | "phrase"
  | "opening"
  | "catchphrase"
  | "ending"
  | "block"
  | "restore";
export interface SpeechObservation {
  scope: string;
  kind: ObservationKind;
  quote: string;
  scene: string;
  contextHash?: string;
  id: string;
  conversationId: string;
  turnId: string;
  userEntryId?: string;
  userRevision?: number;
  at: number;
}

const DIRECT_CORRECTION = /^(?:(?:以后|今后|往后|下次|这次|本轮|现在|暂时|先|就|请|你|昔涟)[，,\s]*)*/u;
const QUOTED_EXPRESSION = /^[“‘「『"]([^”’」』"\r\n]{1,32})[”’」』"]/u;
const EXPRESSION_DISLIKE = /(?:不(?:太|怎么|再)?喜欢|不想(?:再)?(?:听|用|说)|不爱(?:听|用)|(?:太|很|有点|听着|听起来)(?:奇怪|怪|别扭|难听|尴尬)|(?:这个词|这词|这种说法).{0,8}(?:不合适|别扭|奇怪|有点怪))/u;

export function expressionCorrection(
  text: string,
  previous?: { reply: string; words: readonly string[] },
): string[] {
  const direct = stripCompanionQuotedBlocks(text).trim();
  if (!isDirectCompanionWording(direct)) return [];
  const request = direct.replace(DIRECT_CORRECTION, "");
  if (
    /^(?:别|不要)(?:再)?(?:这么|这样)(?:说|叫|开头|收尾)(?:了)?[。！!\s]*$/u.test(
      request,
    )
  ) {
    const matches = [
      ...new Set(
        previous?.words.filter((word) => previous.reply.includes(word)) ?? [],
      ),
    ];
    return matches.length === 1 ? matches : [];
  }
  const target = /^(?:别|不要)(?:再)?(?:用|说|叫我|叫)\s*(.+)$/u.exec(request)?.[1];
  if (!target) return [];
  const quoted = QUOTED_EXPRESSION.exec(target)?.[1]?.trim();
  const bare = /^([^”’」』"，。！？\s]{1,16})(?:[。！!]|$)/u.exec(target)?.[1]?.replace(/(?:这个(?:词|梗)|这(?:种说法|个说法))?了$/u, "");
  const word = quoted || (bare && previous?.words.includes(bare) ? bare : undefined);
  return word ? [word] : [];
}

function restoredExpression(text: string): string | undefined {
  const request = text.replace(DIRECT_CORRECTION, "");
  const target = /^(?:可以|还是可以|允许)(?:再|继续|重新|恢复)?(?:用|说|叫我|叫)\s*(.+)$/u.exec(request)?.[1];
  return target ? QUOTED_EXPRESSION.exec(target)?.[1]?.trim() : undefined;
}
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const filler = new Set([
  "一个",
  "可以",
  "这个",
  "什么",
  "今天",
  "还是",
  "时候",
  "真的",
  "觉得",
  "一下",
]);
function words(text: string) {
  return Array.from(segmenter.segment(text), (s) => s.segment).filter(
    (w) => w.length >= 2 && !filler.has(w),
  );
}
export function speechObservations(
  turn: Pick<RelationshipLogEntry, "id" | "conversationId" | "companionTurnId" | "createdAt" | "speechScope" | "channel" | "privateContext" | "learnedExpressions" | "userText">,
  text = turn.userText,
  previous?: { reply: string; words: readonly string[] },
  phase: "explicit" | "passive" | "all" = "all",
): SpeechObservation[] {
  if (
    !turn.conversationId ||
    !turn.companionTurnId ||
    turn.privateContext === false
  )
    return [];
  const scope =
    turn.speechScope ??
    (turn.channel === "desktop" || turn.channel === "web"
      ? "owner"
      : "session:" + turn.conversationId);
  const source = {
    scope,
    id: turn.id,
    conversationId: turn.conversationId,
    turnId: turn.companionTurnId,
    at: turn.createdAt,
  };
  text = stripCompanionQuotedBlocks(text).trim();
  if (!isDirectCompanionWording(text)) return [];
  const nonLearningRequest = /^(?:(?:这次|以后|今后|下次|本轮|请|就|你|先|暂时)[，,\s]*)*(?:别|不要|不用|不再)/u.test(text);
  const banned = expressionCorrection(text, previous);
  const restored = restoredExpression(text);
  if (banned.length || restored) {
    if (phase === "passive" || isTemporaryCompanionWording(text)) return [];
    return (restored ? [restored] : banned).map((quote) => ({
      ...source,
      kind: restored ? "restore" : "block",
      quote,
      scene: "",
    }));
  }
  if (!turn.learnedExpressions || nonLearningRequest) return [];
  const request = text.replace(/^(?:(?:以后|今后|往后|从今以后|记住|我们|咱们|一起|都|请|你)[，,\s]*)*/u, "");
  const alias =
    /^(?:把|管)[“‘「『"]?([^”’」』"，。\n]{1,40}?)[”’」』"]?(?:叫作|叫做|叫成|称作|叫)[“‘「『"]?([^”’」』"，。！？\s]{2,32})/u.exec(
      request,
    );
  const meaning =
    /^[“‘「『"]([^”’」』"]{2,32})[”’」』"](?:就是指|就是|指的是|是说)[“‘「『"]?([^”’」』"，。！？\n]{2,60})/u.exec(
      request,
    );
  const quote = alias?.[2] ?? meaning?.[1],
    scene = alias?.[1] ?? meaning?.[2];
  if (quote && scene)
    return phase === "passive" || isTemporaryCompanionWording(text) ? [] : [{ ...source, kind: "definition", quote, scene }];
  const outsideQuotes = text.replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu, " ");
  if (phase === "explicit" || EXPRESSION_DISLIKE.test(outsideQuotes) || classifyCompanionPragmatics(text).responseMode) return [];
  const found: SpeechObservation[] = [];
  for (const match of text.matchAll(
    /[“‘「『"]([^”’」』"\s]{2,18})[”’」』"]/gu,
  )) {
    const context = [...new Set(words(text.replace(match[0], "")))]
      .slice(0, 4)
      .join("、");
    if (context)
      found.push({
        ...source,
        kind: "phrase",
        quote: match[1],
        scene: context,
      });
  }
  // Repeated conversational interjections and sentence endings generalize across topics.
  // Extract the actual wording from speech, and retain only its function in the reply.
  const opening = /^\s*([\p{Script=Han}]{2,8})[，,！!～~]\s*(?=\S)/u.exec(
    text,
  )?.[1];
  if (
    opening &&
    /^(?:哈+|嘿+|嗯+|好[呀哇嘛耶嘞哒的]+|哎[呀哟嘿]+|笑死(?:我了)?|可恶|芜湖|懂了|懂你|有一说一|怎么说呢|讲真|好家伙|确实|[噗嗷诶哇呜唔欸嚯耶]+)$/u.test(
      opening,
    )
  ) {
    found.push({
      ...source,
      kind: "opening",
      quote: opening,
      scene: "轻松闲聊时，先用简短的口语回应，再接对方的话",
    });
  } else if (
    opening &&
    opening.length >= 4 &&
    !/^(?:今天|明天|昨天|如果|因为|虽然|我的|我在|我是|我们|你是|你在|他说|她说|帮我|请你|不要)/u.test(
      opening,
    )
  ) {
    const rest = text
      .slice(text.indexOf(opening) + opening.length)
      .replace(/[^\p{L}]/gu, "")
      .trim();
    if (rest.length >= 3)
      found.push({
        ...source,
        kind: "catchphrase",
        quote: opening,
        scene: "轻松闲聊时偶尔用作开场，随后接着聊当下的话题",
        contextHash: createHash("sha256").update(rest).digest("hex"),
      });
  }
  const ending =
    /([\p{Script=Han}])([呀啦诶哇嘛呗喔哟呢欸]{1,2})([～~]*)[！!。.]?\s*$/u.exec(
      text,
    );
  if (ending)
    found.push({
      ...source,
      kind: "ending",
      quote: ending[2] + ending[3].slice(0, 1),
      scene: "轻松聊天时用这个句尾语气词，让语气放松一点",
    });
  const normalizedContext = text.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  return found.slice(0, 4).map(item => ({
    ...item,
    contextHash: item.contextHash ?? createHash("sha256").update(normalizedContext.replace(item.quote.replace(/[^\p{L}\p{N}]+/gu, ""), "")).digest("hex"),
  }));
}

export function rememberSpeech(
  rows: SpeechObservation[],
  observations: SpeechObservation[],
) {
  for (const observation of observations) {
    const sameEvidence = (s: SpeechObservation) =>
      s.scope === observation.scope &&
      s.kind === observation.kind &&
      s.quote === observation.quote;
    const previous = rows.filter(sameEvidence);
    if (
      previous.some(
        (s) =>
          s.turnId === observation.turnId &&
          s.conversationId === observation.conversationId &&
          s.userRevision === observation.userRevision,
      )
    )
      continue;
    // Keep distinct citations for source deletion without storing an unbounded history of common endings.
    if (previous.length >= 12) rows.splice(rows.indexOf(previous[0]), 1);
    rows.push(observation);
  }
}

export function isSpeechObservation(row: SpeechObservation): boolean {
  return (
    !!row &&
    [
      "definition",
      "phrase",
      "opening",
      "catchphrase",
      "ending",
      "block",
      "restore",
    ].includes(row.kind) &&
    [row.scope, row.id, row.conversationId, row.turnId, row.quote].every(
      (v) => typeof v === "string" && !!v,
    ) &&
    typeof row.scene === "string" &&
    Number.isFinite(row.at)
  );
}

interface PrivateExpressionSample {
  quote: string;
  scene: string;
  kind: ObservationKind;
  turn: SpeechObservation;
}

export function collectPrivateExpressions(rows: readonly SpeechObservation[]) {
  const samples = new Map<string, PrivateExpressionSample>();
  const bans = new Map<string, string>();
  const contexts = new Map<string, Set<string>>();
  const earlier = new Map<string, { turn: string; contextHash?: string }>();
  const savedBeforeBlock = new Map<string, PrivateExpressionSample>();
  for (const row of rows) {
    const key = JSON.stringify([row.scope, row.quote]);
    if (row.kind === "block") {
      bans.set(key, row.quote);
      const sample = samples.get(key);
      if (sample) savedBeforeBlock.set(key, sample);
      samples.delete(key);
      continue;
    }
    if (row.kind === "restore") {
      if (bans.delete(key)) {
        const saved = savedBeforeBlock.get(key);
        if (saved) samples.set(key, saved);
      }
      continue;
    }
    if (bans.has(key)) continue;
    const observationKey = JSON.stringify([key, row.kind]);
    const turn = JSON.stringify([row.conversationId, row.turnId]);
    if (row.kind === "catchphrase" && row.contextHash) {
      const evidence = contexts.get(observationKey) ?? new Set<string>();
      evidence.add(row.contextHash);
      contexts.set(observationKey, evidence);
    }
    const prior = earlier.get(observationKey);
    const confirmed =
      row.kind === "catchphrase"
        ? (contexts.get(observationKey)?.size ?? 0) >= 3
        : row.kind === "definition" ||
          (prior && prior.turn !== turn && (!prior.contextHash || !row.contextHash || prior.contextHash !== row.contextHash));
    if (confirmed) {
      samples.set(key, {
        quote: row.quote,
        scene: row.scene,
        kind: row.kind,
        turn: row,
      });
    }
    earlier.set(observationKey, { turn, contextHash: row.contextHash });
  }
  return { samples: [...samples.values()], blocked: [...bans.values()] };
}

export function privateExpressionHint(
  samples: ReturnType<typeof collectPrivateExpressions>["samples"],
  text: string,
  onSelected?: (sample: PrivateExpressionSample) => void,
) {
  if (
    expressionCorrection(text).length ||
    classifyCompanionPragmatics(text).responseMode ||
    /认真点|难受|救命|生病|崩溃|去世|算了别说/u.test(text)
  )
    return "";
  const terms = words(text);
  const matches = samples.slice().reverse();
  const phrase = matches.find(
    (s) =>
      (s.kind === "definition" || s.kind === "phrase") &&
      (text.includes(s.quote) ||
        text.includes(s.scene) ||
        terms.some((w) => s.scene.includes(w))),
  );
  const habit = matches.find(
    (s) =>
      s.kind === "opening" || s.kind === "catchphrase" || s.kind === "ending",
  );
  const hint = phrase ? { 说法: phrase.quote, 使用场景: phrase.scene }
    : habit ? { 习惯: habit.scene, 示例: habit.quote } : undefined;
  const selected = phrase ?? habit;
  if (selected) onSelected?.(selected);
  return hint ? "你们在私聊中形成的说话习惯。保留昔涟自己的语气，合适时自然用一处，无需解释来源。\n" + JSON.stringify(hint) : "";
}
