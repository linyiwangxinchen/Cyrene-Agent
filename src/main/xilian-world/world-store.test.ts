import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XilianWorldStore } from "./world-store";

describe("XilianWorldStore", () => {
  let root = "";
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("persists a schedule and does not duplicate it after a restart", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xilian-world-store-"));
    const file = path.join(root, "xilian-world.json");
    const now = new Date("2026-11-07T10:00:00.000Z").getTime();
    const first = new XilianWorldStore(file, () => now);
    const state = first.advance({ now, timezone: "UTC", companion: { energy: 70, curiosity: 60, boredom: 20 } });
    const before = first.queryTimeline({ dateKey: "2026-11-07", order: "asc" });
    expect(first.queryDiary({ dateKey: "2026-11-07", order: "asc" }).length).toBeGreaterThan(0);
    const restarted = new XilianWorldStore(file, () => now);
    const afterState = restarted.advance({ now, timezone: "UTC", companion: { energy: 70, curiosity: 60, boredom: 20 } });
    expect(afterState.currentActivity?.id).toBe(state.currentActivity?.id);
    expect(restarted.queryTimeline({ dateKey: "2026-11-07", order: "asc" })).toEqual(before);
    expect(restarted.worldView({ dateKey: "2026-11-07" }).diary.length).toBeGreaterThan(0);
  });

  it("deduplicates custom events and supports timeline queries", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xilian-world-event-"));
    const store = new XilianWorldStore(path.join(root, "xilian-world.json"), () => 1_000);
    store.advance({ now: 1_000, timezone: "UTC" });
    const event = {
      id: "external:one",
      dateKey: "1970-01-01",
      slotId: "dawn",
      occurredAt: 1_000,
      locationId: "prologue-city",
      activityKind: "social" as const,
      activityTitle: "听到一条消息",
      summary: "一条可回放的事件",
      mood: "好奇",
      energyAfter: 60,
      status: "completed" as const,
      visibility: "shareable" as const,
      source: "plugin_observation" as const,
    };
    expect(store.appendEvent(event)).toEqual(event);
    expect(store.appendEvent(event)).toEqual(event);
    expect(store.queryTimeline({ from: 0, to: 2_000, order: "asc" }).filter((item) => item.id === event.id)).toHaveLength(1);
  });

  it("binds one selfie artifact to one event and allows retry after failure", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xilian-world-artifact-"));
    const store = new XilianWorldStore(path.join(root, "xilian-world.json"), () => 1_000);
    store.advance({ now: 1_000, timezone: "UTC" });
    const event = store.queryTimeline({ order: "asc" })[0]!;
    const claimed = store.claimArtifact({ eventId: event.id, kind: "selfie", promptFingerprint: "abc", now: 1_000 });
    expect(claimed?.status).toBe("planned");
    expect(store.claimArtifact({ eventId: event.id, kind: "selfie", promptFingerprint: "new", now: 2_000 })?.id).toBe(claimed?.id);
    store.markArtifactGenerating(claimed!.id, 2_000);
    store.failArtifact(claimed!.id, "timeout", 3_000);
    const retried = store.claimArtifact({ eventId: event.id, kind: "selfie", promptFingerprint: "retry", now: 4_000 });
    expect(retried).toMatchObject({ id: claimed?.id, status: "planned", promptFingerprint: "retry" });
    store.markArtifactGenerating(retried!.id, 5_000);
    expect(store.completeArtifact(retried!.id, { imageModel: "gpt-image-2.5-flare", outputPath: "selfie.png", now: 6_000 })).toMatchObject({ status: "generated", imageModel: "gpt-image-2.5-flare" });
  });

  it("backs up corrupted data and restores a safe default world", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xilian-world-corrupt-"));
    const file = path.join(root, "xilian-world.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    const store = new XilianWorldStore(file, () => 1_000);
    expect(store.readSnapshot().version).toBe(1);
    expect(fs.readdirSync(root).some((name) => name.startsWith("xilian-world.json.corrupt-") && name.endsWith(".json"))).toBe(true);
  });

  it("upgrades legacy generic events into concrete scenes and diary entries", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xilian-world-legacy-"));
    const file = path.join(root, "xilian-world.json");
    const now = new Date("2026-11-07T18:00:00.000Z").getTime();
    const store = new XilianWorldStore(file, () => now);
    store.advance({ now, timezone: "UTC" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as any;
    raw.timeline = raw.timeline.map((event: any) => { delete event.detail; delete event.diaryText; delete event.outcome; return event; });
    raw.diary = [];
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");
    const upgraded = new XilianWorldStore(file, () => now);
    upgraded.advance({ now, timezone: "UTC" });
    expect(upgraded.queryTimeline({ dateKey: "2026-11-07" }).some(event => Boolean(event.detail && event.diaryText))).toBe(true);
    expect(upgraded.queryDiary({ dateKey: "2026-11-07" }).length).toBeGreaterThan(0);
  });
});
