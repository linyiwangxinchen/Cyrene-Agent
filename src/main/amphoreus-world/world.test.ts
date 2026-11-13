import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XilianWorldStore, getSharedXilianWorldStore } from "../xilian-world/world-store";
import { AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import { amphoreusView, createAmphoreusState, formatAmphoreusContext, residentNow } from "./engine";
import { worldClock, worldInstant } from "./clock";
import { narrativeMessages, parseDailyPlan } from "./narrative";
import { createAmphoreusService } from "./service";

import { plan, resolutionOutput } from "./test-fixtures";
import { applyResolutions } from "./engine";
import { parseResolutions } from "./narrative";
import { routineProfile } from "./life";

const at = (time: string) => Date.parse(`2026-11-10T${time}:00Z`);
let root: string;
let current: number;
let store: XilianWorldStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "amphoreus-test-"));
  current = at("08:00");
  store = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => current);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

function settle() {
  store.updateAmphoreus((state) => {
    const pending = state.days.flatMap((d) => d.events).filter((e) => e.status === "awaiting_resolution");
    return applyResolutions(state, parseResolutions(resolutionOutput(state), pending, state), current, state.revision);
  });
  store.advance({ now: current, timezone: "UTC" });
}

describe("real clock and resident life", () => {
  it("uses IANA dates across midnight and an explicit fallback for invalid zones", () => {
    expect(worldClock(at("18:30"), "Asia/Shanghai")).toMatchObject({ date: "2026-11-11", time: "02:30", phase: "night" });
    expect(worldClock(at("18:30"), "invalid/zone")).toMatchObject({ date: "2026-11-10", timezone: "UTC", time: "18:30" });
  });
  it("keeps meal times local across daylight-saving transitions", () => {
    expect(new Date(worldInstant("2026-03-08", 720, "America/New_York")).toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(new Date(worldInstant("2026-11-01", 720, "America/New_York")).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
  it("gives every resident individual meal times, sleep and a persistent private life without a model", () => {
    store.advance({ now: at("03:00"), timezone: "UTC" });
    const view = store.worldView().amphoreus!;
    expect(new Set(view.residents.filter((r) => r.kind === "golden_heir").map((r) => r.heirSeat)).size).toBe(12);
    expect(view.residents).toHaveLength(21);
    expect(view.activities.every((a) => a.activity === "sleep")).toBe(true);
    const state = store.readDataSnapshot().amphoreus!;
    for (const person of AMPHOREUS_RESIDENTS) {
      const lunch = routineProfile(person.id).lunch;
      expect(residentNow(state, person, worldInstant("2026-11-10", lunch + 5, "UTC"), "UTC").activity).toBe("meal");
    }
    current = at("20:30"); store.advance({ now: current, timezone: "UTC" });
    expect(store.readDataSnapshot().amphoreus!.residents.every((r) => r.memories.length && r.goals.some((g) => g.progress > 0))).toBe(true);
  });
  it("does not write on every minute, and keeps the next sleep interval across midnight", () => {
    current = at("23:30"); store.advance({ now: current, timezone: "UTC" });
    const first = store.readDataSnapshot();
    current += 60_000; store.advance({ now: current, timezone: "UTC" });
    expect(store.readDataSnapshot().revision).toBe(first.revision);
    expect(store.readSnapshot().nextPlannedEvent).toMatchObject({ dateKey: "2026-11-11", activityTitle: "夜间睡眠", status: "planned" });
  });
  it("keeps public events independent of Cyrene and hides future outcomes", () => {
    const world = createAmphoreusState(current);
    world.days.push(parseDailyPlan(JSON.stringify(plan()), "2026-11-10", "UTC", current));
    const view = amphoreusView(world, current, "UTC");
    expect(view.events.every((e) => !e.participants.includes("cyrene") && !e.outcome)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("已经完成");
    expect(formatAmphoreusContext(view)).not.toContain("已经完成");
  });
  it("carries distinct continuation texture for every golden-heir seat", () => {
    const heirs = AMPHOREUS_RESIDENTS.filter((person) => person.kind === "golden_heir");
    expect(new Set(heirs.map((person) => person.heirSeat)).size).toBe(12);
    expect(heirs.every((person) => (person.signatureDetails?.length ?? 0) >= 2 && (person.relationshipHooks?.length ?? 0) >= 1 && (person.avoidances?.length ?? 0) >= 1)).toBe(true);
    expect(new Set(heirs.map((person) => person.signatureDetails?.[0])).size).toBeGreaterThan(heirs.length / 2);
  });
  it("requires a verified resolution, applies it once and carries the change into the next day", () => {
    store.advance({ now: current, timezone: "UTC" });
    store.updateAmphoreus((s) => { s.days.push(parseDailyPlan(JSON.stringify(plan()), "2026-11-10", "UTC", current)); return true; });
    current = at("09:30"); store.advance({ now: current, timezone: "UTC" });
    expect(store.worldView().amphoreus!.threads[0].summary).not.toContain("供需核对");
    current = at("10:15"); store.advance({ now: current, timezone: "UTC" });
    expect(store.readDataSnapshot().amphoreus!.days[0].events[0].status).toBe("awaiting_resolution");
    settle();
    expect(store.worldView().amphoreus!.threads.find((t) => t.id === "daily-supplies")!.summary).toBe("已完成一次供需核对。");
    const once = store.readDataSnapshot().amphoreus!.appliedEventIds;
    store.advance({ now: current, timezone: "UTC" });
    expect(store.readDataSnapshot().amphoreus!.appliedEventIds).toEqual(once);
    const restored = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => current);
    current = Date.parse("2026-11-11T08:00:00Z"); restored.advance({ now: current, timezone: "UTC" });
    const messages = narrativeMessages(restored.readDataSnapshot().amphoreus!, current, "UTC");
    expect(messages[1].content).toContain("明天核对配送情况");
    expect(restored.worldView().amphoreus!.events.find((e) => e.title === "协商供给")!.status).toBe("completed");
  });
  it("only records Cyrene’s participation and never resurrects a finished routine ID", () => {
    store.advance({ now: current, timezone: "UTC" });
    store.updateAmphoreus((s) => { s.days.push(parseDailyPlan(JSON.stringify(plan(undefined, true)), "2026-11-10", "UTC", current)); return true; });
    current = at("19:15"); store.advance({ now: current, timezone: "UTC" });
    const routineId = store.readSnapshot().currentActivity!.id;
    current = at("19:45"); store.advance({ now: current, timezone: "UTC" });
    expect(store.readSnapshot().currentActivity!.activityTitle).toBe("讨论村落往来");
    expect(store.readSnapshot().currentActivity).not.toHaveProperty("outcome");
    current = at("20:30"); store.advance({ now: current, timezone: "UTC" }); settle();
    expect(store.readSnapshot().currentActivity!.id).not.toBe(routineId);
    expect(store.queryDiary({ limit: 100 }).some((d) => d.text.includes("讨论村落往来留下了新的记录"))).toBe(true);
    expect(store.queryDiary({ limit: 100 }).some((d) => d.text.includes("供需核对"))).toBe(false);
    store.advance({ now: at("19:00"), timezone: "UTC" });
    expect(store.worldView().amphoreus!.events.find((e) => e.participants.includes("cyrene"))!.status).toBe("completed");
  });
});

describe("migration and persistence", () => {
  it("preserves the legacy file, diary and artifact bindings; migration is repeatable", () => {
    const oldPath = path.join(root, "xilian-world.json");
    const old = new XilianWorldStore(oldPath, () => current);
    old.advance({ now: current, timezone: "UTC" });
    const oldData = old.readDataSnapshot();
    const event = oldData.timeline[0];
    const artifact = old.claimArtifact({ eventId: event.id, kind: "selfie", promptFingerprint: "test", now: current })!;
    old.completeArtifact(artifact.id, { outputPath: "private-photo-path", now: current });
    const bytes = fs.readFileSync(oldPath);
    store.advance({ now: current, timezone: "UTC" });
    expect(fs.readFileSync(oldPath).equals(bytes)).toBe(true);
    expect(store.readDataSnapshot().version).toBe(3);
    expect(store.queryDiary({ limit: 100 }).map((d) => d.id)).toEqual(expect.arrayContaining(oldData.diary.map((d) => d.id)));
    expect(store.listArtifacts()[0].id).toBe(artifact.id);
    expect(JSON.stringify(store.worldView())).not.toContain("private-photo-path");
    expect(store.readSnapshot().currentLocationId).toBe("aedes-elysiae");
    const restored = getSharedXilianWorldStore(oldPath);
    expect(restored).toBe(getSharedXilianWorldStore(path.join(root, "amphoreus-world.json")));
    restored.advance({ now: current, timezone: "UTC" });
    expect(restored.queryDiary({ limit: 100 }).map((d) => d.id)).toEqual(store.queryDiary({ limit: 100 }).map((d) => d.id));
  });
  it("backs up invalid JSON but refuses to overwrite a future schema", () => {
    const file = path.join(root, "amphoreus-world.json");
    fs.writeFileSync(file, "{broken");
    store.advance({ now: current, timezone: "UTC" });
    const backup = fs.readdirSync(root).find((f) => f.includes(".corrupt-"))!;
    expect(fs.readFileSync(path.join(root, backup), "utf8")).toBe("{broken");
    fs.writeFileSync(file, '{"version":99,"important":"keep"}');
    expect(() => new XilianWorldStore(file).advance()).toThrow("Unsupported");
    expect(fs.readFileSync(file, "utf8")).toContain('"important":"keep"');
  });
  it.each(["null", "[]", '{"version":3,"important":"keep"}'])("preserves malformed world documents before recovery: %s", (original) => {
    const file = path.join(root, "amphoreus-world.json");
    fs.writeFileSync(file, original);
    store.advance({ now: current, timezone: "UTC" });
    const backup = fs.readdirSync(root).find((f) => f.includes(".corrupt-"))!;
    expect(fs.readFileSync(path.join(root, backup), "utf8")).toBe(original);
    expect(store.readDataSnapshot().version).toBe(3);
  });
  it("does not reset existing state when reading it fails", () => {
    const file = path.join(root, "amphoreus-world.json");
    store.advance({ now: current, timezone: "UTC" });
    const original = fs.readFileSync(file);
    const read = fs.readFileSync;
    const denied = Object.assign(new Error("read denied"), { code: "EACCES" });
    const reader = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) throw denied;
      return read(...args);
    }) as typeof fs.readFileSync);
    expect(() => new XilianWorldStore(file).advance()).toThrow("read denied");
    reader.mockRestore();
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(fs.readdirSync(root).some((f) => f.includes(".corrupt-"))).toBe(false);
  });
});

describe("model output boundary", () => {
  it("accepts fenced intentions and rejects mutations to the character catalog", () => {
    expect(parseDailyPlan("```json\n" + JSON.stringify(plan()) + "\n```", "2026-11-10", "UTC", current).events).toHaveLength(3);
    expect(() => parseDailyPlan(JSON.stringify({ ...plan(), residents: [] }), "2026-11-10", "UTC", current)).toThrow();
    expect(AMPHOREUS_RESIDENTS.find((r) => r.id === "cyrene")).not.toHaveProperty("coreflame");
  });
  it.each(["unknown-person", "unknown-place", "mealtime", "overlap", "cyrene-central", "too-small", "oversized", "wrong-date", "garbage"])("rejects %s as a whole", (kind) => {
    const value = plan();
    if (kind === "unknown-person") value.events[0].participants = ["made-up-person"];
    if (kind === "unknown-place") value.events[0].locationId = "prologue-city";
    if (kind === "mealtime") value.events[0].startMinute = 720;
    if (kind === "overlap") { value.events[1].startMinute = 540; value.events[1].locationId = "okhema"; value.events[1].participants.push("aglaea"); }
    if (kind === "cyrene-central") { value.events[0].participants.push("cyrene"); value.events[1].participants.push("cyrene"); }
    if (kind === "too-small") value.events.pop();
    if (kind === "oversized") value.events[0].summary = "x".repeat(1000);
    if (kind === "wrong-date") value.date = "2026-11-09";
    expect(() => parseDailyPlan(kind === "garbage" ? "not json" : JSON.stringify(value), "2026-11-10", "UTC", current)).toThrow();
  });
});

describe("autonomous daily service", () => {
  function service(generate = vi.fn(async () => JSON.stringify(plan())), configured = () => true, timezone = () => "UTC") {
    return { generate, runtime: createAmphoreusService({ store, now: () => current, timezone, configured, generate }) };
  }
  it("makes one successful request per day, even with concurrent ticks and restarts", async () => {
    const { generate, runtime } = service();
    await Promise.all([runtime.tick(), runtime.tick(), runtime.tick()]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.worldView().amphoreus!.narrative?.status).toBe("success");
    const restored = new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => current);
    const restarted = createAmphoreusService({ store: restored, now: () => current, timezone: () => "UTC", configured: () => true, generate });
    await restarted.tick(); expect(generate).toHaveBeenCalledTimes(1);
    runtime.stop(); restarted.stop();
  });
  it("backs off across restarts and caps failure attempts without persisting error secrets", async () => {
    const generate = vi.fn(async () => { throw new Error("PRIVATE_KEY=https://private.example"); });
    const { runtime } = service(generate);
    await runtime.tick(); await runtime.tick();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, "amphoreus-world.json"), "utf8")).not.toContain("PRIVATE_KEY");
    for (let i = 0; i < 4; i++) { current += 31 * 60_000; await service(generate).runtime.tick(); }
    expect(generate).toHaveBeenCalledTimes(3);
    expect(store.worldView().amphoreus!.events).toHaveLength(0);
    runtime.stop();
  });
  it("continues meals and sleep while disabled or awaiting configuration", async () => {
    const { runtime, generate } = service(undefined, () => false);
    await runtime.tick(); expect(store.worldView().amphoreus!.narrative?.status).toBe("unconfigured");
    runtime.setNarrativeEnabled(false); current = at("12:35"); await runtime.tick();
    expect(store.worldView().amphoreus!.activities.every((a) => a.activity === "meal")).toBe(true);
    expect(generate).not.toHaveBeenCalled(); runtime.stop();
  });
  it.each(["stop", "disable", "midnight", "timezone"])("discards a reply after %s", async (kind) => {
    let resolve!: (text: string) => void;
    let timezone = "UTC";
    const generate = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const { runtime } = service(generate, () => true, () => timezone);
    const pending = runtime.tick();
    if (kind === "stop") runtime.stop();
    if (kind === "disable") runtime.setNarrativeEnabled(false);
    if (kind === "midnight") current = Date.parse("2026-11-11T00:01:00Z");
    if (kind === "timezone") timezone = "Asia/Shanghai";
    resolve(JSON.stringify(plan())); await pending;
    expect(store.readDataSnapshot().amphoreus!.days).toHaveLength(0);
    expect(store.readDataSnapshot().amphoreus!.attempts[0].status).toBe("cancelled");
    runtime.stop();
  });
  it("preserves an artifact written while a model request is in flight", async () => {
    let resolve!: (text: string) => void;
    const { runtime } = service(vi.fn(() => new Promise<string>((r) => { resolve = r; })));
    const pending = runtime.tick();
    const id = store.readSnapshot().currentActivity!.id;
    const artifact = store.claimArtifact({ eventId: id, kind: "selfie", promptFingerprint: "concurrent", now: current })!;
    store.completeArtifact(artifact.id, { now: current, outputPath: "private" });
    resolve(JSON.stringify(plan())); await pending;
    expect(store.listArtifacts()[0]).toMatchObject({ id: artifact.id, status: "generated", outputPath: "private" });
    expect(store.readDataSnapshot().amphoreus!.days).toHaveLength(1); runtime.stop();
  });
  it("records an abort-aware model cancellation as cancelled rather than a network failure", async () => {
    const runtime = createAmphoreusService({ store, now: () => current, timezone: () => "UTC", configured: () => true,
      generate: (_messages, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
    });
    const pending = runtime.tick(); runtime.setNarrativeEnabled(false); await pending;
    expect(store.readDataSnapshot().amphoreus!.attempts[0]).toMatchObject({ status: "cancelled", error: "interrupted" });
    runtime.stop();
  });
  it("uses a persisted lease to prevent a second service from issuing the same request", async () => {
    let resolve!: (text: string) => void;
    const generate = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const first = service(generate).runtime;
    const pending = first.tick();
    const second = service(generate).runtime;
    await second.tick(); expect(generate).toHaveBeenCalledTimes(1);
    resolve(JSON.stringify(plan())); await pending;
    first.stop(); second.stop();
  });
});
