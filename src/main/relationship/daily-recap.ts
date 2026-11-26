import { createHash } from "node:crypto";
import type { DailyRecap } from "../../shared/companion";
import type { ExpressionSample } from "../../shared/memory-graph";
import type { XilianDiaryEntry } from "../../shared/xilian-world";
import { worldClock } from "../amphoreus-world/clock";
import type { RelationshipLogStore, SavedDailyRecap } from "./relationship-log-core";

interface Fact {
  date: string;
  at: number;
  kind: DailyRecap["sources"][number]["kind"];
  text: string;
  turn?: SavedDailyRecap["turns"][number];
  expressionId?: string;
  privateWord?: string;
}

interface Dependencies {
  material: () => ReturnType<RelationshipLogStore["dailyRecapMaterial"]>;
  worldDiary: () => readonly XilianDiaryEntry[];
  expressions: () => readonly ExpressionSample[];
  timezone: () => string;
  configured: () => boolean;
  write: (date: string, sources: DailyRecap["sources"], signal: AbortSignal) => Promise<string>;
  save: (entry: SavedDailyRecap) => void;
  now?: () => number;
}

const HOUR = 3_600_000;
const factHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = (text: string, length: number) => text.replace(/\s+/gu, " ").trim().slice(0, length);

export function createDailyRecaps(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;

  function collect() {
    const at = now();
    const zone = deps.timezone();
    const clock = worldClock(at, zone);
    const material = deps.material();
    const days = new Map<string, Fact[]>();
    function add(fact: Fact) {
      if (!fact.text || !Number.isFinite(fact.at) || fact.at > at || fact.date > clock.date) return;
      let rows = days.get(fact.date);
      if (!rows) days.set(fact.date, rows = []);
      rows.push(fact);
    }
    for (const e of material.turns) {
      if (!Number.isFinite(e.createdAt)) continue;
      add({ date: worldClock(e.createdAt, zone).date, at: e.createdAt, kind: "chat", turn: { id: e.id, conversationId: e.conversationId!, turnId: e.companionTurnId! },
        text: "你说：" + clip(e.userText, 160) + "　我回：" + clip(e.assistantText, 120) });
    }
    for (const { turn, quote, scene } of material.expressions) {
      add({ date: worldClock(turn.at, zone).date, at: turn.at, kind: "expression", turn: { id: turn.id, conversationId: turn.conversationId, turnId: turn.turnId }, privateWord: quote,
        text: "私聊里学到「" + quote + "」：" + clip(scene, 110) });
    }
    const samples = deps.expressions();
    for (const sample of samples) {
      if (!Number.isFinite(sample.at)) continue;
      const origin = new URL(sample.source).hostname === "tieba.baidu.com" ? "贴吧" : "B 站";
      add({ date: worldClock(sample.at, zone).date, at: sample.at, kind: "expression", expressionId: sample.id,
        text: origin + "里学到「" + sample.quote + "」：" + clip(sample.scene, 110) });
    }
    const privateWorldFacts = new Set<string>();
    for (const event of deps.worldDiary()) {
      const fact: Fact = { date: event.dateKey, at: event.writtenAt, kind: "world", text: clip(event.title + "：" + event.text, 210) };
      if (event.visibility === "shareable") add(fact);
      else privateWorldFacts.add(factHash(fact));
    }
    // Old recaps used the same fact hashes without preserving world visibility.
    const usableSaved = material.saved.filter(entry => !entry.factHashes.some(hash => privateWorldFacts.has(hash)));
    const configured = deps.configured();
    const activeSamples = new Set(samples.map(s => s.id));
    const activeWords = new Set(material.expressions.map(s => s.quote));
    const archive = usableSaved.filter(s => s.text && s.date < clock.date && (!s.turns.length || material.enabled)
      && s.expressionIds.every(id => activeSamples.has(id)) && s.privateWords.every(word => activeWords.has(word)));
    for (const entry of archive) if (!days.has(entry.date)) days.set(entry.date, []);
    return [...days.keys()].sort().reverse().slice(0, 90).map(date => {
      const rows = days.get(date)!.sort((a, b) => a.at - b.at || a.text.localeCompare(b.text));
      // Sample across the whole day while reserving room for each source.
      const selected: Fact[] = [];
      for (const kind of ["chat", "expression", "world"] as const) {
        const sameKind = rows.filter(row => row.kind === kind);
        const cap = kind === "chat" ? 8 : 4;
        const count = Math.min(cap, sameKind.length);
        for (let i = 0; i < count; i++) selected.push(sameKind[Math.round(i * (sameKind.length - 1) / Math.max(1, count - 1))]);
      }
      const sources = selected.map(({ kind, text }) => ({ kind, text }));
      const digest = factHash(selected);
      const saved = usableSaved.find(row => row.date === date);
      // A completed day survives normal source-window rollover. Explicit deletion,
      // rewind and disabled sources revoke its provenance before it may be displayed.
      const archived = archive.find(entry => entry.date === date && rows.every(row => row.at <= (entry.writtenAt ?? 0)));
      const current = saved?.digest === digest ? saved : archived;
      const liveHashes = new Set(rows.map(factHash));
      const previous = saved?.text && saved.factHashes.every(hash => liveHashes.has(hash)) ? saved : undefined;
      const text = current?.text ?? previous?.text;
      const due = date < clock.date || clock.minute >= 21 * 60;
      const status: DailyRecap["status"] = current?.text ? "written" : !due ? "collecting"
        : !configured ? "unconfigured" : current ? "retry" : "pending";
      const view: DailyRecap = { date, status, sources, ...(text && { text }) };
      return { view, digest, due: due && configured && !current?.text && (!saved || at - saved.attemptedAt >= HOUR),
        factHashes: selected.map(factHash), previous,
        turns: selected.flatMap(row => row.turn ? [row.turn] : []),
        expressionIds: selected.flatMap(row => row.expressionId ? [row.expressionId] : []),
        privateWords: selected.flatMap(row => row.privateWord ? [row.privateWord] : []) };
    });
  }

  async function tick() {
    if (controller) return;
    const request = controller = new AbortController();
    try {
      const day = collect().find(row => row.due);
      if (!day) return;
      const { date, sources } = day.view;
      const record: SavedDailyRecap = { date, digest: day.digest, turns: day.turns, expressionIds: day.expressionIds, privateWords: day.privateWords, factHashes: day.factHashes, attemptedAt: now() };
      try {
        const text = (await deps.write(date, sources, request.signal)).trim();
        if (text && text.length <= 2400) { record.text = text; record.writtenAt = record.attemptedAt; }
      } catch { /* Keep the evidence visible and retry after the cooldown. */ }
      if (!request.signal.aborted && collect().find(row => row.view.date === date)?.digest === day.digest) {
        deps.save(!record.text && day.previous ? { ...day.previous, attemptedAt: record.attemptedAt } : record);
      }
    } finally {
      if (controller === request) controller = undefined;
    }
  }
  const run = () => { void tick().catch(error => console.warn("[DailyRecap] 无法更新每日回顾", error instanceof Error ? error.name : "error")); };
  return {
    list: () => collect().map(row => row.view),
    tick,
    start() {
      if (timer) return;
      run(); timer = setInterval(run, 15 * 60_000); timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; controller?.abort(); controller = undefined; },
  };
}
