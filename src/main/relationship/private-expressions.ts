import { createHash } from "node:crypto";
import type { RelationshipLogEntry } from "./relationship-log-core";

type ObservationKind =
  | "definition"
  | "phrase"
  | "opening"
  | "catchphrase"
  | "ending"
  | "block";
export interface SpeechObservation {
  scope: string;
  kind: ObservationKind;
  quote: string;
  scene: string;
  contextHash?: string;
  id: string;
  conversationId: string;
  turnId: string;
  at: number;
}

export function expressionCorrection(
  text: string,
  previous?: { reply: string; words: readonly string[] },
): string[] {
  if (
    /^(?:以后|下次|请|你)*\s*(?:别|不要)(?:再)?(?:这么|这样)(?:说|叫|开头|收尾)(?:了)?[。！!\s]*$/u.test(
      text.trim(),
    )
  ) {
    const matches = [
      ...new Set(
        previous?.words.filter((word) => previous.reply.includes(word)) ?? [],
      ),
    ];
    return matches.length === 1 ? matches : [];
  }
  const match =
    /(?:别再?用|别再?说|不要再?用|不要再?说|别叫我|别叫)\s*[“‘「『"]?([^”’」』"，。！？\s]{1,32})/u.exec(
      text,
    );
  return match
    ? [
        match[1].replace(/(?:这个(?:词|梗)|这(?:种说法|个说法))?了$/u, ""),
      ].filter(Boolean)
    : [];
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
  turn: RelationshipLogEntry,
  text = turn.userText,
  previous?: { reply: string; words: readonly string[] },
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
  const banned = expressionCorrection(text, previous);
  if (banned.length)
    return banned.map((quote) => ({
      ...source,
      kind: "block",
      quote,
      scene: "",
    }));
  if (
    !turn.learnedExpressions ||
    /~~~|\x60\x60\x60|^>|(?:翻译|改写|分析|转述)(?:这|下面)|(?:朋友|同事|他|她)说[：:“"]/mu.test(
      text,
    )
  )
    return [];
  const alias =
    /(?:把|管)[“‘「『"]?([^”’」』"，。\n]{1,40}?)[”’」』"]?(?:叫作|叫做|叫成|称作|叫)[“‘「『"]?([^”’」』"，。！？\s]{2,32})/u.exec(
      text,
    );
  const meaning =
    /[“‘「『"]([^”’」』"]{2,32})[”’」』"](?:就是指|就是|指的是|是说)[“‘「『"]?([^”’」』"，。！？\n]{2,60})/u.exec(
      text,
    );
  const quote = alias?.[2] ?? meaning?.[1],
    scene = alias?.[1] ?? meaning?.[2];
  if (quote && scene) return [{ ...source, kind: "definition", quote, scene }];
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
  return found.slice(0, 4);
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
          s.conversationId === observation.conversationId,
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
    ].includes(row.kind) &&
    [row.scope, row.id, row.conversationId, row.turnId, row.quote].every(
      (v) => typeof v === "string" && !!v,
    ) &&
    typeof row.scene === "string" &&
    Number.isFinite(row.at)
  );
}

export function collectPrivateExpressions(rows: readonly SpeechObservation[]) {
  const samples = new Map<
    string,
    {
      quote: string;
      scene: string;
      kind: ObservationKind;
      turn: SpeechObservation;
    }
  >();
  const bans = new Map<string, string>();
  const contexts = new Map<string, Set<string>>();
  const earlier = new Map<string, string>();
  for (const row of rows) {
    const key = JSON.stringify([row.scope, row.quote]);
    if (row.kind === "block") {
      bans.set(key, row.quote);
      samples.delete(key);
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
    const confirmed =
      row.kind === "catchphrase"
        ? (contexts.get(observationKey)?.size ?? 0) >= 3
        : row.kind === "definition" ||
          (earlier.has(observationKey) && earlier.get(observationKey) !== turn);
    if (confirmed) {
      samples.set(key, {
        quote: row.quote,
        scene: row.scene,
        kind: row.kind,
        turn: row,
      });
    }
    earlier.set(observationKey, turn);
  }
  return { samples: [...samples.values()], blocked: [...bans.values()] };
}

export function privateExpressionHint(
  samples: ReturnType<typeof collectPrivateExpressions>["samples"],
  text: string,
) {
  if (
    expressionCorrection(text).length ||
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
  if (!phrase && !habit) return "";
  const lines = [
    "你们在私聊中形成的说话习惯。保留昔涟自己的语气，合适时自然用一处，无需解释来源。",
  ];
  if (phrase)
    lines.push(JSON.stringify({ 说法: phrase.quote, 使用场景: phrase.scene }));
  if (habit)
    lines.push(JSON.stringify({ 习惯: habit.scene, 示例: habit.quote }));
  return lines.join("\n");
}
