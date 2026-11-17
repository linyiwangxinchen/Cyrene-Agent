import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XilianWorldStore } from "../xilian-world/world-store";
import { createAmphoreusState, formatAmphoreusContext } from "./engine";
import { advancePersonalActions, planPersonalLife } from "./personal-life";
import { readAmphoreusState } from "./state";
import { advanceResidents } from "./life";
import { narrativeMessages, parseDailyPlan, parsePersonalPlans } from "./narrative";
import { createAmphoreusService } from "./service";
import { plan } from "./test-fixtures";
import { buildXilianLifeSnapshot, formatXilianLifeContext } from "../xilian-world/life-context";

let root: string, now: number;
const at = (hour: string) => Date.parse(`2026-11-17T${hour}:00Z`);
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "amphoreus-personal-")); now = at("08:00"); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const createStore = () => new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now);

describe("a private life with committed evidence", () => {
  it("keeps intentions out of memories until an action ends, then survives replay and restart once", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    const action = store.readDataSnapshot().amphoreus!.personalActions[0];
    expect(action).toMatchObject({ status: "planned", version: 1 });
    expect(action).not.toHaveProperty("outcome");
    expect(store.worldView().amphoreus!.personal!.experiences.some((m) => m.eventId === action.id)).toBe(false);
    now = action.startsAt + 60_000; store.advance({ now, timezone: "UTC" });
    expect(store.readDataSnapshot().amphoreus!.personalActions[0].status).toBe("active");
    expect(store.worldView().amphoreus!.personal!.experiences.some((m) => m.eventId === action.id)).toBe(false);
    now = action.endsAt; store.advance({ now, timezone: "UTC" });
    const personal = store.worldView().amphoreus!.personal!;
    expect(personal.actions[0]).toMatchObject({ status: "completed", version: 2 });
    expect(personal.goals.find((g) => g.id === action.goalId)).toMatchObject({ progress: 8, lastActionId: action.id });
    expect(personal.changes.filter((c) => c.eventId === action.id)).toHaveLength(1);
    expect(personal.experiences.find((m) => m.eventId === action.id)).toMatchObject({ sourceVersion: 2, occurredAt: action.endsAt });
    const restarted = createStore(); restarted.advance({ now, timezone: "UTC" });
    expect(restarted.worldView().amphoreus!.personal).toEqual(personal);
    expect(restarted.queryWorldHistory({ residentId: "cyrene" }).entries.some((entry) => entry.id === action.id)).toBe(true);
  });

  it("does not turn a missed morning or a read-only view into newly completed actions", () => {
    now = at("20:00"); const store = createStore(); store.advance({ now, timezone: "UTC" });
    const before = fs.readFileSync(path.join(root, "amphoreus-world.json"), "utf8");
    expect(store.worldView().amphoreus!.personal!.actions.every((a) => a.startsAt >= now)).toBe(true);
    expect(store.worldView().amphoreus!.personal!.changes).toHaveLength(0);
    store.worldView(); store.worldView();
    expect(fs.readFileSync(path.join(root, "amphoreus-world.json"), "utf8")).toBe(before);
  });

  it("archives a timezone interruption at its actual time and proposes only new local future actions", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    store.advance({ now, timezone: "Asia/Shanghai" });
    const actions = store.readDataSnapshot().amphoreus!.personalActions;
    expect(actions.some((action) => action.status === "interrupted" && action.resolvedAt === now)).toBe(true);
    expect(actions.filter((action) => action.status === "planned").every((action) => action.startsAt >= now)).toBe(true);
    expect(store.queryWorldHistory({ residentId: "cyrene", limit: 80 }).entries.filter((entry) => entry.kind === "event").every((entry) => entry.at <= now)).toBe(true);
  });

  it("lets a public appointment interrupt the private project without awarding progress", () => {
    const state = createAmphoreusState(now); planPersonalLife(state, now, "UTC");
    const action = state.personalActions[0];
    state.days.push({ date: "2026-11-17", timezone: "UTC", generatedAt: now, events: [{ id: "appointment", date: "2026-11-17", startsAt: action.startsAt, endsAt: action.endsAt, locationId: action.locationId, participants: ["cyrene"], activity: "social", severity: "routine", title: "事先约好的见面", summary: "按约见面", developments: [], status: "planned", version: 1 }] });
    advancePersonalActions(state, action.endsAt);
    expect(action).toMatchObject({ status: "interrupted", reason: "有了公共约定，自己的小事留到下次" });
    expect(state.residents.find((r) => r.id === "cyrene")!.goals.every((g) => g.progress === 0)).toBe(true);
    expect(state.changes.find((c) => c.eventId === action.id)?.text).not.toContain("留下");
  });

  it("can choose rest, and never awards progress merely because dinner has arrived", () => {
    const state = createAmphoreusState(now); planPersonalLife(state, now, "UTC");
    state.residents.find((r) => r.id === "cyrene")!.energy = 10;
    advancePersonalActions(state, state.personalActions[0].endsAt);
    expect(state.personalActions[0].status).toBe("interrupted");
    state.lastLifeTick = at("18:00");
    advanceResidents(state, at("18:30"), "UTC");
    expect(state.residents.find((r) => r.id === "cyrene")!.goals.every((g) => g.progress === 0)).toBe(true);
  });

  it("integrates observed practice independently of tick frequency and keeps action evidence", () => {
    const simulate = (stepMinutes: number) => {
      const state = createAmphoreusState(now); state.lastLifeTick = now;
      for (let elapsed = stepMinutes; elapsed <= 180; elapsed += stepMinutes) advanceResidents(state, now + elapsed * 60_000, "UTC");
      return state.residents.filter((r) => r.id !== "cyrene").map(({ id, energy, goals }) => ({ id, energy, goals }));
    };
    expect(simulate(1)).toEqual(simulate(180));
    expect(simulate(1).some((r) => r.goals.some((g) => g.progress > 0 && g.lastActionId?.startsWith("practice:")))).toBe(true);
  });

  it("retains the same project result and source version with minute or coarse advancement", () => {
    const simulate = (stepMinutes: number) => {
      const state = createAmphoreusState(now); state.lastLifeTick = now; planPersonalLife(state, now, "UTC");
      for (let elapsed = stepMinutes; elapsed <= 180; elapsed += stepMinutes) {
        const tick = now + elapsed * 60_000;
        advanceResidents(state, tick, "UTC", (checkpoint) => advancePersonalActions(state, checkpoint));
        advancePersonalActions(state, tick);
      }
      return { actions: state.personalActions, goals: state.residents.find((r) => r.id === "cyrene")!.goals, changes: state.changes.filter((c) => c.residentId === "cyrene") };
    };
    expect(simulate(1)).toEqual(simulate(180));
  });

  it("starts a new small project phase after completed work without rewriting the old result", () => {
    const state = createAmphoreusState(now);
    const resident = state.residents.find((r) => r.id === "cyrene")!;
    for (const goal of resident.goals) { goal.status = "completed"; goal.progress = 100; }
    for (let day = 0; day < 4 && resident.goals.every((g) => g.status === "completed"); day++) planPersonalLife(state, now + day * 86_400_000, "UTC");
    expect(resident.goals.some((g) => g.status === "active" && g.progress === 0 && g.cycle === 2)).toBe(true);
    expect(state.personalActions.some((a) => a.status === "planned")).toBe(true);
    expect(state.changes).toHaveLength(0);
  });

  it("accepts explicit suggestions idempotently as plans and preserves their provenance", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    const input = { id: "chat-turn-7", title: "试着列一张小清单", intent: "下次可以把想读的内容列出来", conversationId: "chat-1" };
    const first = store.addPersonalIntention(input)!;
    expect(first).toMatchObject({ status: "planned", origin: "user_suggestion", conversationId: "chat-1" });
    expect(first.startsAt).toBeGreaterThan(now);
    expect(first).not.toHaveProperty("outcome");
    expect(store.addPersonalIntention(input)).toEqual(first);
    const restored = createStore().readDataSnapshot().amphoreus!;
    expect(restored.personalActions.filter((action) => action.id === first.id)).toHaveLength(1);
    expect(restored.changes).toHaveLength(0);
  });

  it("keeps explicit suggestion IDs scoped and deduplicated after their live actions are archived", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    const input = { id: "same-turn", title: "一件小事", intent: "试着整理一下", conversationId: "private-a" };
    const first = store.addPersonalIntention(input)!;
    const other = store.addPersonalIntention({ ...input, conversationId: "private-b" })!;
    expect(other.id).not.toBe(first.id);
    now = first.endsAt; store.advance({ now, timezone: "UTC" });
    now += 16 * 86_400_000; store.advance({ now, timezone: "UTC" });
    expect(store.readDataSnapshot().amphoreus!.personalActions.some((action) => action.id === first.id)).toBe(false);
    expect(store.addPersonalIntention(input)).toBeUndefined();
    expect(store.readDataSnapshot().amphoreus!.personalActions.some((action) => action.id === first.id)).toBe(false);
  });

  it("rejects late public backstory that would overwrite an already-lived private interval", () => {
    const state = createAmphoreusState(now); planPersonalLife(state, now, "UTC");
    const action = state.personalActions[0];
    Object.assign(action, { startsAt: at("19:45"), endsAt: at("20:30"), status: "completed", resolvedAt: at("20:30") });
    expect(() => parseDailyPlan(JSON.stringify(plan("2026-11-17", true)), "2026-11-17", "UTC", at("21:00"), state)).toThrow("invalid_output");
    action.status = "planned";
    expect(() => parseDailyPlan(JSON.stringify(plan("2026-11-17", true)), "2026-11-17", "UTC", now, state)).not.toThrow();
  });

  it("uses the same daily request for varied personal intentions and never accepts prewritten outcomes", async () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    const state = store.readDataSnapshot().amphoreus!, goalId = state.residents.find((r) => r.id === "cyrene")!.goals[0].id;
    const personalPlan = { goalId, title: "把两页记录并排比较", intent: "想从不同写法里挑一种自己更喜欢的", activity: "study", startMinute: 900, durationMinutes: 35 };
    const value = { ...plan("2026-11-17"), personalPlans: [personalPlan] };
    const generate = vi.fn(async () => JSON.stringify(value));
    const runtime = createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate });
    await runtime.tick(); runtime.stop();
    expect(generate).toHaveBeenCalledTimes(1);
    const action = store.worldView().amphoreus!.personal!.actions.find((a) => a.origin === "model")!;
    expect(action).toMatchObject({ title: personalPlan.title, intent: personalPlan.intent, status: "planned" });
    expect(store.worldView().amphoreus!.personal!.changes).toHaveLength(0);
    const forbidden = JSON.stringify({ ...value, personalPlans: [{ ...personalPlan, outcome: "已经完成了一幅地图" }] });
    expect(() => parseDailyPlan(forbidden, "2026-11-17", "UTC", now, state)).toThrow("invalid_output");
    expect(parsePersonalPlans(JSON.stringify(value), state, "2026-11-17", "UTC", at("18:00"))).toEqual([]);
  });

  it("reserves a review request before attempting pending outcomes at the daily limit", async () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    store.updateAmphoreus((state) => {
      state.days.push(parseDailyPlan(JSON.stringify(plan("2026-11-17")), "2026-11-17", "UTC", now, state));
      state.dailyModelBudget = 3;
      state.attempts = [0, 1].map((index) => ({ date: "2026-11-17", timezone: "UTC", key: `old:${index}`, count: 1, status: "success", attemptedAt: now, retryAt: 0 }));
      return true;
    });
    now = at("10:30");
    const generate = vi.fn(async () => "{}");
    const runtime = createAmphoreusService({ store, now: () => now, timezone: () => "UTC", configured: () => true, generate });
    await runtime.tick(); runtime.stop();
    expect(generate).not.toHaveBeenCalled();
    expect(store.readDataSnapshot().amphoreus!.days[0].events[0].status).toBe("awaiting_resolution");
  });
});

describe("personal knowledge and migration", () => {
  it("keeps private suggestions and their derived memories out of other conversations and world planning", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    const action = store.addPersonalIntention({ id: "private-topic", title: "私聊专属的小标题", intent: "私聊专属的建议正文", conversationId: "private-a" })!;
    now = action.startsAt + 60_000; store.advance({ now, timezone: "UTC" });
    const snapshot = () => store.readDataSnapshot();
    const view = store.worldView().amphoreus!;
    const context = (conversationId?: string) => formatXilianLifeContext(buildXilianLifeSnapshot({ state: snapshot().state, timeline: snapshot().timeline, now, timezone: "UTC", world: view, conversationId }));
    expect(context("private-a")).toContain("私聊专属");
    expect(context("private-b")).not.toContain("私聊专属");
    expect(context()).not.toContain("私聊专属");
    expect(narrativeMessages(snapshot().amphoreus!, now, "UTC")[1].content).not.toContain("私聊专属");
    now = action.endsAt; store.advance({ now, timezone: "UTC" });
    const memory = snapshot().amphoreus!.residents.find((r) => r.id === "cyrene")!.memories.find((memory) => memory.eventId === action.id)!;
    expect(memory.conversationId).toBe("private-a");
    expect(snapshot().amphoreus!.changes.find((change) => change.eventId === action.id)?.conversationId).toBe("private-a");
    store.updateAmphoreus((state) => { state.residents.find((r) => r.id === "cyrene")!.memories.find((memory) => memory.eventId === action.id)!.text = "私聊专属的经历内容"; return true; });
    expect(formatAmphoreusContext(store.worldView().amphoreus!, "private-a")).toContain("私聊专属");
    expect(formatAmphoreusContext(store.worldView().amphoreus!, "private-b")).not.toContain("私聊专属");
    expect(formatAmphoreusContext(store.worldView().amphoreus!)).not.toContain("私聊专属");
    expect(narrativeMessages(snapshot().amphoreus!, now, "UTC")[1].content).not.toContain("私聊专属");
    expect(new XilianWorldStore(path.join(root, "amphoreus-world.json"), () => now).readDataSnapshot().amphoreus!.changes.find((change) => change.eventId === action.id)?.conversationId).toBe("private-a");
  });

  it("attributes public news to a known teller at the same place without spreading private events", () => {
    const state = createAmphoreusState(now);
    const event = { id: "shared-news", date: "2026-11-17", startsAt: at("15:00"), endsAt: at("16:00"), resolvedAt: at("16:00"), locationId: "aedes-elysiae", participants: ["phainon"], activity: "work" as const, severity: "routine" as const, title: "整理公共记录", summary: "尝试整理", outcome: "两份公开记录已放到一起", developments: [], status: "completed" as const, version: 2, visibility: "public" as const };
    state.days.push({ date: "2026-11-17", timezone: "UTC", generatedAt: now, events: [event, { ...event, id: "private-news", visibility: "participants" }] });
    const teller = state.residents.find((r) => r.id === "phainon")!;
    teller.memories.push({ id: "teller-memory", eventId: event.id, at: at("16:00"), kind: "experienced", text: event.outcome, source: "亲历", locationId: event.locationId });
    state.lastLifeTick = at("20:00");
    advanceResidents(state, at("20:30"), "UTC");
    const cyrene = state.residents.find((r) => r.id === "cyrene")!;
    expect(cyrene.memories.find((m) => m.eventId === event.id)?.source).toContain("白厄");
    expect(cyrene.memories.some((m) => m.eventId === "private-news")).toBe(false);
    expect(state.changes.find((change) => change.residentId === "cyrene" && change.eventId === event.id)).toMatchObject({ kind: "heard", occurredAt: at("16:00"), knownAt: at("20:30"), version: 2 });
  });

  it("backs up schema 2 byte for byte without releasing old memories as new opportunities", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    const original = store.readDataSnapshot();
    Object.assign(original.amphoreus!, { schema: 2 });
    original.amphoreus!.residents.find((r) => r.id === "cyrene")!.memories.push({ id: "old", eventId: "old", at: now - 1000, text: "旧经历", source: "旧档", kind: "routine", locationId: "aedes-elysiae" });
    const bytes = JSON.stringify(original);
    fs.writeFileSync(path.join(root, "amphoreus-world.json"), bytes);
    const migrated = createStore().readDataSnapshot().amphoreus!;
    expect(migrated.schema).toBe(3);
    expect(migrated.changes).toHaveLength(0);
    expect(migrated.personalActions).toHaveLength(0);
    expect(migrated.residents.find((r) => r.id === "cyrene")!.memories.some((m) => m.id === "old")).toBe(true);
    expect(fs.readFileSync(path.join(root, "amphoreus-world.json.schema2-backup.json"), "utf8")).toBe(bytes);
    expect(() => readAmphoreusState({ ...migrated, schema: 4 }, now)).toThrow("Unsupported");
  });

  it("does not expose another resident's private attention or future results in conversation", () => {
    const store = createStore(); store.advance({ now, timezone: "UTC" });
    store.updateAmphoreus((state) => {
      state.residents[0].attention = "只有阿格莱雅知道的秘密";
      state.threads.push({ id: "secret", title: "私下的安排", summary: "秘密细节", nextStep: "秘密未来", participants: ["aglaea"], status: "open", updatedAt: now });
      return true;
    });
    const view = store.worldView().amphoreus!;
    expect(JSON.stringify(view)).toContain("只有阿格莱雅知道的秘密");
    expect(formatAmphoreusContext(view)).not.toContain("只有阿格莱雅知道的秘密");
    expect(formatAmphoreusContext(view)).not.toContain("秘密未来");
    expect(view.personal!.changes.every((change) => change.residentId === "cyrene")).toBe(true);
  });
});
