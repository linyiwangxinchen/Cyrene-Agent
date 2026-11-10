import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XilianWorldStore } from "../xilian-world/world-store";
import { AMPHOREUS_FACTS, AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import type { AmphoreusState, WorldEffect } from "../../shared/amphoreus-world";
import { applyResolutions, formatAmphoreusContext } from "./engine";
import { parseDailyPlan, parseResolutions } from "./narrative";
import { residentActivity, routineProfile, travelMinutes } from "./life";
import { createAmphoreusService } from "./service";
import { worldClock, worldInstant } from "./clock";
import { plan, resolutionOutput, rotatingPlan } from "./test-fixtures";
import { buildXilianLifeSnapshot } from "../xilian-world/life-context";

let root: string, now: number, store: XilianWorldStore;
const at = (time: string) => Date.parse(`2026-11-10T${time}:00Z`);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "amphoreus-continuity-")); now = at("08:00");
  store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now); store.advance({ now, timezone: "UTC" });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
function install(value = plan(undefined, true)) { store.updateAmphoreus((s) => { s.days.push(parseDailyPlan(JSON.stringify(value), value.date, "UTC", now, s)); return true; }); }
function advance(time: string) { now = at(time); store.advance({ now, timezone: "UTC" }); }
function resolve(effects: WorldEffect[] = [], mutate?: (value: ReturnType<typeof JSON.parse>) => void) {
  store.updateAmphoreus((s) => {
    const value = JSON.parse(resolutionOutput(s, effects)); mutate?.(value);
    const events = s.days.flatMap((d) => d.events).filter((e) => e.status === "awaiting_resolution").slice(0, 6);
    return applyResolutions(s, parseResolutions(JSON.stringify(value), events, s), now, s.revision);
  });
  store.advance({ now, timezone: "UTC" });
}
const state = () => store.readDataSnapshot().amphoreus!;

describe("events change an enduring world", () => {
  it("applies resources, personal goals and relationships once, including after restart", () => {
    install(); advance("10:30");
    resolve([
      { kind: "place", placeId: "okhema", field: "supplies", delta: -12, reason: "公共储备拨给了今日配送" },
      { kind: "goal", residentId: "aglaea", goalId: "aglaea:personal:0", delta: 10, reason: "一起落实了具体安排" },
      { kind: "relationship", residentId: "aglaea", otherId: "demeter", delta: 1, reason: "协商兑现，信任有所增加" },
    ]);
    const applied = state();
    expect(applied.places.find((p) => p.id === "okhema")!.supplies).toBe(58);
    expect(applied.residents[0].goals[0].progress).toBe(10);
    expect(applied.residents[0].relations[0]).toMatchObject({ residentId: "demeter", trust: 1 });
    store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now);
    store.advance({ now, timezone: "UTC" });
    expect(state().places).toEqual(applied.places);
    expect(state().residents[0].memories.filter((m) => m.kind === "experienced")).toHaveLength(1);
  });
  it("a failed prerequisite cancels its dependent event without pretending it was witnessed", () => {
    const value = plan(); value.events[1].conditions = [{ kind: "event", eventId: "today:0" }]; install(value);
    advance("10:30"); resolve([], (raw) => { raw.resolutions[0].status = "failed"; raw.resolutions[0].outcome = "协商没有达成一致，配送尚未开始。"; raw.resolutions[0].developments = []; });
    advance("15:30");
    const event = state().days[0].events[1];
    expect(event).toMatchObject({ status: "cancelled", resolutionSource: "engine", effects: [] });
    expect(state().residents.find((r) => r.id === "anaxa")!.memories.find((m) => m.eventId === event.id)!.kind).toBe("routine");
  });
  it("resource shortages defer work, and repeated unmet conditions end it", () => {
    const value = plan(); value.events[0].conditions = [{ kind: "place", placeId: "okhema", field: "supplies", minimum: 90 }]; install(value);
    for (let i = 0; i < 4; i++) { now = state().days[0].events[0].startsAt; store.advance({ now, timezone: "UTC" }); }
    expect(state().days[0].events[0]).toMatchObject({ status: "cancelled", effects: [] });
    expect(state().places[0].supplies).toBe(70);
  });
  it("keeps every open affair instead of silently evicting the oldest", () => {
    store.updateAmphoreus((s) => { for (let i = 0; i < 100; i++) s.threads.push({ id: `open-${i}`, title: `待办${i}`, summary: "尚未解决", nextStep: "等待协商", participants: ["demeter"], status: "open", updatedAt: now }); return true; });
    install(); advance("10:30"); resolve();
    expect(state().threads.some((t) => t.id === "open-0")).toBe(true);
    expect(state().threads).toHaveLength(103);
    expect(state().threads.find((t) => t.id === "daily-supplies")!.participants).toEqual(expect.arrayContaining(["aphro", "hatonus", "aglaea"]));
  });
  it("bounds travel, respects meals after a timezone change, and preserves completed history", () => {
    install(); advance("10:30"); resolve();
    const completed = state().days[0].events[0];
    store.advance({ now, timezone: "Asia/Shanghai" });
    expect(state().days[0].events[0]).toEqual(completed);
    const s = state();
    for (const event of s.days[0].events.filter((e) => e.status === "deferred")) for (const id of event.participants) {
      const person = AMPHOREUS_RESIDENTS.find((r) => r.id === id)!;
      const minute = worldClock(event.startsAt, "Asia/Shanghai").minute, profile = routineProfile(id);
      expect(minute < profile.dinner || minute >= profile.dinner + 45).toBe(true);
      expect(residentActivity(s, person, worldInstant(event.date, profile.lunch + 5, "Asia/Shanghai"), "Asia/Shanghai").activity).toBe("meal");
    }
    expect(travelMinutes("grove", "aedes-elysiae", s.places)).toBeGreaterThan(0);
    const normal = travelMinutes("grove", "aedes-elysiae", s.places);
    s.places.find((p) => p.id === "grove")!.access = "limited";
    expect(travelMinutes("grove", "aedes-elysiae", s.places)).toBeGreaterThan(normal);
    expect(travelMinutes("grove", "aedes-elysiae", s.places)).toBe(travelMinutes("aedes-elysiae", "grove", s.places));
    s.places.find((p) => p.id === "grove")!.access = "closed";
    expect(travelMinutes("aedes-elysiae", "grove", s.places)).toBe(Infinity);
    expect(travelMinutes("grove", "aedes-elysiae", s.places)).toBe(Infinity);
  });
});

describe("knowledge and continuity", () => {
  it("distinguishes private events, witnessed facts and public news learned later", () => {
    install(); advance("10:30"); resolve();
    expect(formatAmphoreusContext(store.worldView().amphoreus!)).not.toContain("协商供给留下了新的记录");
    advance("12:35");
    expect(formatAmphoreusContext(store.worldView().amphoreus!)).toContain("听闻（城邦公开消息）：协商供给留下了新的记录");
    store.updateAmphoreus((s) => { const e = s.days[0].events[1]; e.visibility = "participants"; return true; });
    advance("16:00"); resolve(); advance("19:00");
    expect(state().residents.find((r) => r.id === "cyrene")!.memories.some((m) => m.text.includes("整理研究记录留下了"))).toBe(false);
  });
  it("does not relearn an old public event after short memory compaction", () => {
    install(); advance("10:30"); resolve(); advance("12:35");
    const event = state().days[0].events[0];
    store.updateAmphoreus((s) => { const cyrene = s.residents.find((r) => r.id === "cyrene")!; cyrene.memories = []; return true; });
    advance("19:00");
    expect(state().residents.find((r) => r.id === "cyrene")!.memories.some((m) => m.eventId === event.id)).toBe(false);
  });
  it("uses resolved results and the same energy in ordinary conversation and the world", () => {
    install(); advance("20:30"); resolve();
    const data = store.readDataSnapshot(), view = store.worldView().amphoreus!;
    const snapshot = buildXilianLifeSnapshot({ state: data.state, timeline: data.timeline, now, timezone: "UTC", energy: 1, world: view });
    expect(snapshot.energy).toBe(view.residentStates.find((r) => r.id === "cyrene")!.energy);
    expect(snapshot.recentEvent).toContain("讨论村落往来留下了新的记录");
    expect(snapshot.worldContext).not.toContain("亲历：协商供给");
  });
  it("records offline gaps without inventing missed public outcomes", () => {
    install(); now += 9 * 86_400_000; store.advance({ now, timezone: "UTC" });
    expect(state().gaps).toHaveLength(1);
    expect(state().days[0].events.every((e) => !e.outcome)).toBe(true);
    expect(store.queryWorldHistory().entries.some((e) => e.kind === "gap")).toBe(true);
  });
});

describe("validated model boundary", () => {
  it.each(["白厄将负世火种永久转让给昔涟。", "铁墓已经复活。", "昔涟拥有真我火种。", "白厄没有转让火种，但是铁墓已经复活。"])("rejects explicit canon conflicts: %s", (conflict) => {
    const value = plan(); value.events[0].summary = conflict;
    expect(() => parseDailyPlan(JSON.stringify(value), value.date, "UTC", now, state())).toThrow("invalid_output");
  });
  it("rejects duplicate effects, fabricated goals and stale resolutions as a whole", () => {
    install(); advance("10:30"); const s = state(), events = s.days[0].events.filter((e) => e.status === "awaiting_resolution");
    const effect: WorldEffect = { kind: "place", placeId: "okhema", field: "supplies", delta: 20, reason: "收到物资" };
    expect(() => parseResolutions(resolutionOutput(s, [effect, effect]), events, s)).toThrow();
    expect(() => parseResolutions(resolutionOutput(s, [{ kind: "goal", residentId: "aglaea", goalId: "new-goal", delta: 5, reason: "完成目标" }]), events, s)).toThrow();
    const parsed = parseResolutions(resolutionOutput(s), events, s), before = structuredClone(s);
    expect(applyResolutions(s, parsed, now, s.revision - 1)).toBe(false); expect(s).toEqual(before);
  });
  it("rejects a month of excluding the same residents", () => {
    install(); now += 30 * 86_400_000;
    const value = plan(worldClock(now, "UTC").date, true);
    expect(() => parseDailyPlan(JSON.stringify(value), value.date, "UTC", now, state())).toThrow();
    expect(() => parseDailyPlan(JSON.stringify(rotatingPlan(state(), value.date, now)), value.date, "UTC", now, state())).not.toThrow();
  });
  it("a new daily plan respects yesterday's postponed appointments", () => {
    install();
    const s = state();
    const postponed = s.days[0].events[0]; postponed.date = "2026-11-11"; postponed.startsAt += 86_400_000; postponed.endsAt += 86_400_000; postponed.status = "deferred";
    const next = plan("2026-11-11");
    expect(() => parseDailyPlan(JSON.stringify(next), next.date, "UTC", now + 86_400_000, s)).toThrow();
  });
  it("recovers an expired third-attempt lease without another request", async () => {
    store.updateAmphoreus((s) => { s.attempts.push({ key: "plan:2026-11-10", date: "2026-11-10", timezone: "UTC", purpose: "plan", status: "generating", count: 3, attemptedAt: now - 300_000, retryAt: now - 1 }); return true; });
    const generate = vi.fn(); const runtime = createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate });
    await runtime.tick(); runtime.stop();
    expect(state().attempts[0]).toMatchObject({ status: "cancelled", count: 3, error: "interrupted" }); expect(generate).not.toHaveBeenCalled();
  });
  it.each([true, false])("requires a separate canon review for major outcomes (accepted=%s)", async (consistent) => {
    const value = plan(); value.events[0].severity = "major"; install(value); advance("10:30");
    const generate = vi.fn(async (messages) => JSON.parse(messages[1].content).purpose === "review" ? JSON.stringify({ consistent, factIds: AMPHOREUS_FACTS.slice(0, 2).map((f) => f.id) }) : resolutionOutput(state()));
    const runtime = createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate }); await runtime.tick(); runtime.stop();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(state().days[0].events[0].status).toBe(consistent ? "completed" : "awaiting_resolution");
    expect(store.worldView().amphoreus!.budget.used).toBe(2);
  });
  it("enforces the total daily model budget and cancels an uncooperative provider", async () => {
    store.updateAmphoreus((s) => { s.dailyModelBudget = 3; s.attempts = [0, 1, 2].map((n) => ({ key: `old:${n}`, date: "2026-11-10", timezone: "UTC", count: 1, status: "success", attemptedAt: now - n, retryAt: 0 })); return true; });
    const generate = vi.fn(() => new Promise<string>(() => {}));
    const runtime = createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate }); await runtime.tick(); expect(generate).not.toHaveBeenCalled();
    store.updateAmphoreus((s) => { s.dailyModelBudget = 8; return true; }); const pending = runtime.tick(); runtime.stop(); await pending;
    expect(state().attempts.at(-1)!.status).toBe("cancelled");
  });
  it("times out a provider that never resolves, releasing its lease", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtime = createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate: () => new Promise<string>(() => {}) });
    const pending = runtime.tick(); await vi.advanceTimersByTimeAsync(90_001); await pending; runtime.stop();
    expect(state().attempts[0]).toMatchObject({ status: "failed", error: "request_failed", count: 1 });
  });
});

describe("durable history and upgrades", () => {
  it("backs up schema 1 bytes and expands the three siblings without rewriting completed facts", () => {
    install(); advance("10:30"); resolve();
    const data = store.readDataSnapshot(), file = path.join(root, "amphoreus-world.json");
    const old = data.amphoreus! as unknown as { schema: number; days: AmphoreusState["days"] }; old.schema = 1;
    old.days[0].events[0].participants = ["tribios"]; old.days[0].events[1].outcome = "这是旧版预写的未来结果。";
    const bytes = JSON.stringify(data); fs.writeFileSync(file, bytes);
    store = new XilianWorldStore(file, () => now);
    expect(state().days[0].events[0].participants).toEqual(["tribbie", "trian", "trinnon"]);
    expect(state().days[0].events[0].outcome).toContain("留下了新的记录");
    expect(state().days[0].events[1].outcome).toBeUndefined();
    expect(fs.readFileSync(`${file}.schema1-backup.json`, "utf8")).toBe(bytes);
    expect(new XilianWorldStore(file, () => now).readDataSnapshot().amphoreus!.schema).toBe(2);
  });
  it("retains the authoritative snapshot when the archive is unavailable, then recovers history", () => {
    const archive = path.join(root, "amphoreus-history.sqlite"); fs.renameSync(archive, archive + ".saved"); fs.mkdirSync(archive);
    expect(() => install()).toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(root, "amphoreus-world.json"), "utf8")).amphoreus.days).toHaveLength(1);
    fs.rmdirSync(archive); fs.renameSync(archive + ".saved", archive);
    store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now); advance("10:30"); resolve();
    expect(store.queryWorldHistory().entries.some((e) => e.title === "协商供给")).toBe(true);
  });
  it("only previews a generated bound image inside the data directory", () => {
    const file = path.join(root, "picture.png"); fs.writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));
    const artifact = store.claimArtifact({ eventId: store.readSnapshot().currentActivity!.id, kind: "selfie", promptFingerprint: "asset", now })!;
    store.completeArtifact(artifact.id, { outputPath: file, now });
    expect(store.readWorldArtifact(artifact.id)?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(store.readWorldArtifact(file)).toBeNull();
    fs.writeFileSync(file, "not-an-image"); expect(store.readWorldArtifact(artifact.id)).toBeNull();
  });
  it("preserves 90 days of searchable history, gives every resident a life and paginates without gaps", () => {
    const start = now; let eventCount = 0;
    for (let day = 0; day < 90; day++) {
      now = start + day * 86_400_000; store.advance({ now, timezone: "UTC" });
      store.updateAmphoreus((s) => { const date = worldClock(now, "UTC").date; const p = parseDailyPlan(JSON.stringify(rotatingPlan(s, date, now)), date, "UTC", now, s); eventCount += p.events.length; s.days.push(p); return true; });
      now += 15 * 3_600_000; store.advance({ now, timezone: "UTC" });
      while (state().days.some((d) => d.events.some((e) => e.status === "awaiting_resolution"))) resolve();
      if (day % 7 === 0) store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now);
      if (day === 13) expect(state().residents.every((r) => r.memories.some((m) => m.kind === "experienced"))).toBe(true);
    }
    expect(state().days).toHaveLength(60);
    expect(state().residents.every((r) => r.goals.some((g) => g.progress > 0) && r.memories.length <= 48)).toBe(true);
    const entries = []; let page = store.queryWorldHistory({ limit: 80 });
    entries.push(...page.entries);
    while (page.next) { page = store.queryWorldHistory({ limit: 80, ...page.next }); entries.push(...page.entries); }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(entries.filter((e) => e.kind === "event")).toHaveLength(eventCount);
    expect(entries.some((e) => e.id.startsWith("amphoreus:2026-11-10:"))).toBe(true);
    expect(store.queryWorldHistory({ residentId: "cyrene", limit: 80 }).entries.every((e) => e.residentIds.includes("cyrene"))).toBe(true);
    expect(() => store.queryWorldHistory({ before: NaN })).toThrow();
  }, 120_000);
});
