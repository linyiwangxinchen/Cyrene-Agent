import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InitiativeOpportunityStore, type InitiativeOpportunityInput } from "./initiative-opportunities";

const NOW = Date.UTC(2026, 10, 17, 9);
const minute = 60_000;
function opportunity(patch: Partial<InitiativeOpportunityInput> = {}): InitiativeOpportunityInput {
  return { id: "story", source: "world", sourceEventId: "event-a", evidenceVersion: 1,
    motive: "interesting", summary: "刚才整理书页时找到了自己留下的批注", occurredAt: NOW,
    expiresAt: NOW + 8 * 3_600_000, strengthPerHour: 1, replyBurden: "none", ...patch };
}
describe("persistent initiative opportunities", () => {
  let root: string;
  let file: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "initiative-core-")); file = path.join(root, "thoughts.json"); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("does not create timer-only opportunities or replay a historical backlog on first enable", () => {
    const random = vi.fn(() => 0.5);
    const store = new InitiativeOpportunityStore(file, random);
    expect(store.select({ now: NOW, opportunities: [], eligible: true })).toBeUndefined();
    const old = opportunity({ occurredAt: NOW - 16 * minute });
    expect(store.select({ now: NOW + minute, opportunities: [old], eligible: true })).toBeUndefined();
    expect(random).not.toHaveBeenCalled();
    expect(store.select({ now: NOW + 31 * minute, opportunities: [], eligible: true })).toBeUndefined();
  });

  it("retains one threshold and elapsed fractions across polling frequencies and reloads", () => {
    const random = vi.fn(() => 0.1); // threshold > 2, so no selection in this hour
    const item = opportunity();
    const run = (filename: string, step: number) => {
      const store = new InitiativeOpportunityStore(path.join(root, filename), random);
      store.select({ now: NOW, opportunities: [item], eligible: true, continuous: true });
      for (let elapsed = step; elapsed <= 60; elapsed += step) store.select({ now: NOW + elapsed * minute, opportunities: [item], eligible: true, continuous: true });
      return store.find(item.id)!;
    };
    const eachMinute = run("minute.json", 1);
    const once = run("hour.json", 60);
    expect(eachMinute.accumulated).toBeCloseTo(once.accumulated, 10);
    expect(eachMinute.threshold).toBe(once.threshold);
    expect(random).toHaveBeenCalledTimes(2);
    const restarted = new InitiativeOpportunityStore(path.join(root, "minute.json"), () => { throw new Error("rerolled"); });
    restarted.select({ now: NOW + 61 * minute, opportunities: [item], eligible: true });
    const resumed = restarted.find(item.id)!;
    expect(resumed.threshold).toBe(eachMinute.threshold);
    expect(resumed.accumulated).toBe(eachMinute.accumulated); // restart interval is offline
  });

  it("does not accrue during suppression, long gaps, absent sources, or the arrival tick", () => {
    const store = new InitiativeOpportunityStore(file, () => 0.1);
    const item = opportunity();
    store.select({ now: NOW, opportunities: [item], eligible: true });
    store.select({ now: NOW + minute, opportunities: [item], eligible: true });
    const before = store.find(item.id)!.accumulated;
    store.suspend(NOW + 2 * minute);
    store.select({ now: NOW + 60 * minute, opportunities: [item], eligible: true });
    expect(store.find(item.id)!.accumulated).toBe(before);
    store.select({ now: NOW + 120 * minute, opportunities: [item], eligible: true });
    expect(store.find(item.id)!.accumulated).toBe(before);
    const added = opportunity({ id: "new", sourceEventId: "new-source", occurredAt: NOW + 121 * minute });
    store.select({ now: NOW + 121 * minute, opportunities: [added], eligible: true });
    expect(store.find(added.id)!.accumulated).toBe(0);
    store.select({ now: NOW + 122 * minute, opportunities: [item], eligible: true });
    expect(store.find(item.id)!.accumulated).toBe(before);
  });

  it("integrates source freshness identically with minute or hourly polling", () => {
    const item = opportunity({ strengthPerHour: 4, decayPerHour: 1 });
    const run = (filename: string, step: number) => {
      const store = new InitiativeOpportunityStore(path.join(root, filename), () => Math.exp(-5));
      store.select({ now: NOW, opportunities: [item], eligible: true, continuous: true });
      for (let elapsed = step; elapsed <= 60; elapsed += step) {
        expect(store.select({ now: NOW + elapsed * minute, opportunities: [item], eligible: true, continuous: true })).toBeUndefined();
      }
      return store.find(item.id)!;
    };
    const minuteResult = run("decay-minute.json", 1);
    const hourlyResult = run("decay-hour.json", 60);
    expect(minuteResult.accumulated).toBeCloseTo(4 * (1 - Math.exp(-1)), 10);
    expect(minuteResult.accumulated).toBeCloseTo(hourlyResult.accumulated, 10);
    const restarted = new InitiativeOpportunityStore(path.join(root, "decay-minute.json"), () => { throw new Error("rerolled"); });
    restarted.select({ now: NOW + 61 * minute, opportunities: [item], eligible: true });
    expect(restarted.find(item.id)!.threshold).toBe(minuteResult.threshold);
    expect(restarted.find(item.id)!.accumulated).toBe(minuteResult.accumulated);
    restarted.select({ now: NOW + 62 * minute, opportunities: [item], eligible: true });
    expect(restarted.find(item.id)!.accumulated).toBeCloseTo(minuteResult.accumulated
      + 4 * (Math.exp(-61 / 60) - Math.exp(-62 / 60)), 10);
  });

  it("lets a decaying desire remain below its threshold and expire naturally", () => {
    const store = new InitiativeOpportunityStore(file, () => Math.exp(-5));
    const item = opportunity({ strengthPerHour: 4, decayPerHour: 1 });
    store.select({ now: NOW, opportunities: [item], eligible: true, continuous: true });
    for (let hour = 1; hour <= 8; hour++) {
      expect(store.select({ now: NOW + hour * 60 * minute, opportunities: [item], eligible: true, continuous: true })).toBeUndefined();
    }
    const expired = store.find(item.id)!;
    expect(expired.accumulated).toBeCloseTo(4 * (1 - Math.exp(-7)), 10);
    expect(expired.accumulated).toBeLessThan(4); // lifetime integral cannot exceed strength / decay
    expect(expired.threshold).toBe(5);
    expect(expired.status).toBe("expired");
  });

  it("ages freshness during blocked time without accumulating blocked desire", () => {
    const store = new InitiativeOpportunityStore(file, () => Math.exp(-5));
    const item = opportunity({ strengthPerHour: 4, decayPerHour: 1 });
    store.select({ now: NOW, opportunities: [item], eligible: true, continuous: true });
    store.select({ now: NOW + 60 * minute, opportunities: [item], eligible: false, continuous: true });
    store.suspend(NOW + 90 * minute);
    store.select({ now: NOW + 120 * minute, opportunities: [item], eligible: true, continuous: true });
    expect(store.find(item.id)!.accumulated).toBe(0);
    store.select({ now: NOW + 180 * minute, opportunities: [item], eligible: true, continuous: true });
    expect(store.find(item.id)!.accumulated).toBeCloseTo(4 * (Math.exp(-2) - Math.exp(-3)), 10);
  });

  it("applies rate and decay changes to subsequent intervals only", () => {
    const store = new InitiativeOpportunityStore(file, () => Math.exp(-10));
    const item = opportunity({ strengthPerHour: 4, decayPerHour: 1 });
    store.select({ now: NOW, opportunities: [item], eligible: true, continuous: true });
    const changed = { ...item, strengthPerHour: 6, decayPerHour: 2 };
    store.select({ now: NOW + 30 * minute, opportunities: [changed], eligible: true, continuous: true });
    expect(store.find(item.id)!.accumulated).toBeCloseTo(4 * (1 - Math.exp(-0.5)), 10);
    store.select({ now: NOW + 60 * minute, opportunities: [changed], eligible: true, continuous: true });
    expect(store.find(item.id)!.accumulated).toBeCloseTo(4 * (1 - Math.exp(-0.5))
      + 3 * (Math.exp(-1) - Math.exp(-2)), 10);
  });

  it("rejects invalid decay inputs and preserves invalid persisted evidence", () => {
    const random = vi.fn(() => 0.5);
    const store = new InitiativeOpportunityStore(file, random);
    store.select({ now: NOW, opportunities: [-1, Number.NaN, Number.POSITIVE_INFINITY].map((decayPerHour, index) =>
      opportunity({ id: `invalid-${index}`, sourceEventId: `invalid-${index}`, decayPerHour })), eligible: true });
    expect(random).not.toHaveBeenCalled();
    const item = opportunity({ decayPerHour: 1 });
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.entries[0].decayPerHour = -1;
    const corrupted = JSON.stringify(data);
    fs.writeFileSync(file, corrupted);
    expect(() => store.select({ now: NOW + minute, opportunities: [item], eligible: true })).toThrow("Invalid initiative opportunity");
    expect(fs.readFileSync(file, "utf8")).toBe(corrupted);
  });

  it("selects per-opportunity eligible content and marks real attempts separately", () => {
    const store = new InitiativeOpportunityStore(file, () => 0.99);
    const high = opportunity({ id: "question", sourceEventId: "q", replyBurden: "question", score: 95 });
    const low = opportunity({ id: "share", sourceEventId: "s", replyBurden: "none", score: 65 });
    const eligible = (item: InitiativeOpportunityInput) => item.replyBurden === "none";
    store.select({ now: NOW, opportunities: [high, low], eligible });
    const selected = store.select({ now: NOW + minute, opportunities: [high, low], eligible });
    expect(selected?.id).toBe("share");
    expect(store.markAttempt(selected!.key, NOW + minute, "2026-11-17", 1)).toBe(true);
    expect(store.markAttempt(selected!.key, NOW + minute, "2026-11-17", 1)).toBe(false);
    store.resolve(selected!.key, "hold", { now: NOW + minute });
    const second = opportunity({ id: "second", sourceEventId: "second", occurredAt: NOW + 2 * minute });
    store.select({ now: NOW + 2 * minute, opportunities: [second], eligible: true });
    expect(store.select({ now: NOW + 3 * minute, opportunities: [second], eligible: true,
      dayKey: "2026-11-17", dailyAttemptLimit: 1 })).toBeUndefined();
    const next = store.select({ now: NOW + 4 * minute, opportunities: [second], eligible: true,
      dayKey: "2026-11-18", dailyAttemptLimit: 1 });
    expect(next?.id).toBe("second");
  });

  it("holds unchanged evidence without reattempts, exposes read-only thoughts and permits genuine new evidence", () => {
    const random = vi.fn(() => 0.99);
    const store = new InitiativeOpportunityStore(file, random);
    const item = opportunity();
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    expect(store.resolve(ready.key, "hold", { now: NOW + minute })).toBe(true);
    const bytes = fs.readFileSync(file, "utf8");
    expect(store.summarize({ now: NOW + 2 * minute })).toEqual([item.summary]);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    store.resume("user_message", NOW + 2 * minute); // default hold requires new evidence
    expect(store.select({ now: NOW + 31 * minute, opportunities: [item], eligible: true })).toBeUndefined();
    expect(random).toHaveBeenCalledTimes(1);
    const next = { ...item, evidenceVersion: 2, occurredAt: NOW + 32 * minute, summary: "这件事又有了新的进展" };
    store.select({ now: NOW + 32 * minute, opportunities: [next], eligible: true });
    expect(store.select({ now: NOW + 33 * minute, opportunities: [next], eligible: true })?.evidenceVersion).toBe(2);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("explicitly resumes a thought on user return but expiry never becomes a send timer", () => {
    const store = new InitiativeOpportunityStore(file, () => 0.99);
    const item = opportunity();
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    store.resolve(ready.key, "hold", { now: NOW + minute, resumeOn: "user_message", holdUntil: NOW + 60 * minute });
    store.resume("user_message", NOW + 10 * minute);
    expect(store.find(ready.key)?.status).toBe("pending");
    store.select({ now: NOW + 10 * minute, opportunities: [item], eligible: true });
    const resumed = store.select({ now: NOW + 11 * minute, opportunities: [item], eligible: true })!;
    store.resolve(resumed.key, "hold", { now: NOW + 11 * minute, holdUntil: NOW + 12 * minute });
    expect(store.select({ now: NOW + 12 * minute, opportunities: [item], eligible: true })).toBeUndefined();
    expect(store.find(ready.key)?.status).toBe("expired");
  });

  it.each(["send", "drop", "delivery_partial", "delivery_unknown"] as const)("retains %s as a durable no-replay identity scoped to the conversation", decision => {
    const store = new InitiativeOpportunityStore(file, () => 0.99);
    const item = opportunity({ conversationId: "private-a" });
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    store.resolve(ready.key, decision, { now: NOW + minute });
    const restarted = new InitiativeOpportunityStore(file, () => 0.99);
    expect(restarted.select({ now: NOW + 2 * minute, opportunities: [item], eligible: true })).toBeUndefined();
    const other = { ...item, conversationId: "private-b" };
    restarted.select({ now: NOW + 3 * minute, opportunities: [other], eligible: true });
    expect(restarted.select({ now: NOW + 4 * minute, opportunities: [other], eligible: true })?.conversationId).toBe("private-b");
  });

  it("preserves unsupported or damaged files instead of erasing tombstones", () => {
    fs.writeFileSync(file, '{"version":99}');
    const store = new InitiativeOpportunityStore(file);
    expect(() => store.select({ now: NOW, opportunities: [], eligible: true })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe('{"version":99}');
  });

  it("recovers an abandoned generation without replaying its evidence or losing a durable ACK", () => {
    const store = new InitiativeOpportunityStore(file, () => 0.99);
    const item = opportunity();
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    store.markAttempt(ready.key, NOW + minute, "2026-11-17", 8);
    const restarted = new InitiativeOpportunityStore(file, () => { throw new Error("rerolled"); });
    expect(restarted.select({ now: NOW + 2 * minute, opportunities: [item], eligible: true })).toBeUndefined();
    expect(restarted.find(ready.key)?.status).toBe("held");
    // An already durable intent can still acknowledge its fixed payload.
    expect(restarted.resolve(ready.key, "send", { now: NOW + 2 * minute })).toBe(true);
    expect(restarted.resolve(ready.key, "send", { now: NOW + 3 * minute })).toBe(true);
    expect(restarted.find(ready.key)?.status).toBe("sent");
  });

  it("keeps a bounded queue over ninety days of lively world activity and weekly restarts", () => {
    let store = new InitiativeOpportunityStore(file, () => 0.5);
    for (let day = 0; day < 90; day++) {
      if (day % 7 === 0) store = new InitiativeOpportunityStore(file, () => 0.5);
      const now = NOW + day * 86_400_000;
      const items = Array.from({ length: 40 }, (_, index) => opportunity({
        id: `day:${day}:${index}`, sourceEventId: `event:${day}:${index}`, occurredAt: now,
        expiresAt: now + 3_600_000, strengthPerHour: 0,
      }));
      expect(store.select({ now, opportunities: items, eligible: true })).toBeUndefined();
    }
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted.entries.length).toBeLessThan(90 * 40 / 2);
    expect(store.find("day:89:0")?.status).toBe("pending");
    expect(store.find("day:0:0")).toBeUndefined();
  });

  it("retains a sent identity until thirty days after its source TTL, rather than thirty days after selection", () => {
    const store = new InitiativeOpportunityStore(file, () => 0.99);
    const item = opportunity({ expiresAt: NOW + 6 * 3_600_000 });
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    store.resolve(ready.key, "send", { now: NOW + minute });
    const restarted = new InitiativeOpportunityStore(file, () => { throw new Error("replayed"); });
    restarted.select({ now: NOW + 30 * 86_400_000 + 5 * 3_600_000, opportunities: [], eligible: true });
    expect(restarted.find(ready.key)?.status).toBe("sent");
    restarted.select({ now: item.expiresAt + 30 * 86_400_000 + 1, opportunities: [], eligible: true });
    expect(restarted.find(ready.key)).toBeUndefined();
  });

  it("keeps an unknown delivery review past the ordinary tombstone horizon", () => {
    const store = new InitiativeOpportunityStore(file, () => 0.99);
    const item = opportunity();
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    store.resolve(ready.key, "delivery_unknown", { now: NOW + minute });
    const restarted = new InitiativeOpportunityStore(file, () => { throw new Error("replayed"); });
    expect(restarted.select({ now: NOW + 100 * 86_400_000, opportunities: [], eligible: true })).toBeUndefined();
    expect(restarted.find(ready.key)?.status).toBe("delivery_unknown");
  });

  it("reclaims an orphaned selection after a failed acknowledgement without resending or rerolling", () => {
    const random = vi.fn(() => 0.99);
    const store = new InitiativeOpportunityStore(file, random);
    const item = opportunity();
    store.select({ now: NOW, opportunities: [item], eligible: true });
    const ready = store.select({ now: NOW + minute, opportunities: [item], eligible: true })!;
    // Simulate a transient atomic-write failure while cancelling this selection.
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("temporarily locked"); });
    try { expect(() => store.resolve(ready.key, "drop", { now: NOW + minute })).toThrow("temporarily locked"); }
    finally { rename.mockRestore(); }
    expect(store.find(ready.key)?.status).toBe("selected");
    expect(store.select({ now: NOW + 12 * minute, opportunities: [item], eligible: true })).toBeUndefined();
    expect(store.find(ready.key)).toMatchObject({ status: "held", threshold: ready.threshold, resumeOn: "evidence_change" });
    expect(random).toHaveBeenCalledTimes(1);
    expect(store.readThoughts(NOW + 12 * minute)).toHaveLength(1);
  });
});
