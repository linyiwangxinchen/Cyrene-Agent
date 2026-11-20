import { describe, expect, it, vi } from "vitest";
import { amphoreusView, createAmphoreusState } from "../amphoreus-world/engine";
import type { AmphoreusView, WorldSemanticChange } from "../../shared/amphoreus-world";
import type { CompanionLifeState } from "./companion-life";
import { boredomInitiativeOpportunity, relatedConversationOpportunity, worldInitiativeOpportunities } from "./world-initiative";

const NOW = Date.UTC(2026, 10, 17, 2);
const hour = 3_600_000;
function world(): AmphoreusView { return amphoreusView(createAmphoreusState(NOW), NOW, "Asia/Shanghai"); }
function known(view: AmphoreusView, patch: Partial<WorldSemanticChange> = {}): WorldSemanticChange {
  const change: WorldSemanticChange = { id: "knowledge:cyrene:story:1", eventId: "story", version: 1,
    residentId: "cyrene", kind: "experienced", occurredAt: NOW - 60_000, knownAt: NOW,
    text: "整理旧记录时发现自己留下的一张书签", source: "事件结算", locationId: "okhema", ...patch };
  view.personal!.changes.push(change);
  view.personal!.experiences.push({ id: `memory:${change.id}`, eventId: change.eventId, kind: change.kind,
    at: change.knownAt, text: change.text, source: change.source, locationId: change.locationId });
  return change;
}
function life(patch: Partial<CompanionLifeState> = {}): CompanionLifeState {
  return { version: 2, dateKey: "2026-11-17", energy: 70, curiosity: 50, boredom: 50,
    dailyMessageCount: 0, dailyQuestionCount: 0, dailyPluginShareCount: 0,
    lastInteractionAt: NOW, lastMomentAt: null, lastAdvancedAt: NOW, revision: 1, ...patch };
}

describe("world facts become initiative opportunities", () => {
  it("uses only personally known committed changes, without inventing facts from future plans or the observer panel", () => {
    const view = world();
    view.events.push({ id: "future", date: "2026-11-17", startsAt: NOW + hour, endsAt: NOW + 2 * hour,
      locationId: "okhema", participants: ["cyrene"], activity: "study", severity: "routine", title: "未来的安排",
      summary: "还没做的事", developments: [], status: "planned" });
    view.threads.push({ id: "observer-secret", title: "观察页知道的事务", summary: "昔涟尚未知情", nextStep: "秘密进展",
      participants: ["aglaea"], status: "open", updatedAt: NOW });
    expect(worldInitiativeOpportunities(view, NOW)).toEqual([]);
    const change = known(view);
    expect(worldInitiativeOpportunities(view, NOW, "bound-chat")).toEqual([expect.objectContaining({
      sourceEventId: change.eventId, evidenceVersion: change.version, conversationId: "bound-chat", motive: "interesting",
      summary: `亲历：${change.text}`, replyBurden: "none",
    })]);
  });

  it("ignores other residents, future knowledge, stale changes and changes with no matching personal memory", () => {
    const view = world();
    known(view, { id: "other", residentId: "aglaea" });
    known(view, { id: "tomorrow", eventId: "tomorrow", knownAt: NOW + hour });
    known(view, { id: "old", eventId: "old", knownAt: NOW - 7 * hour });
    view.personal!.changes.push({ ...view.personal!.changes[0], id: "unknown", eventId: "unknown", residentId: "cyrene" });
    expect(worldInitiativeOpportunities(view, NOW)).toEqual([]);
    expect(worldInitiativeOpportunities(undefined, NOW)).toEqual([]);
  });

  it("does not turn other residents' public news into a share", () => {
    const view = world();
    known(view, { kind: "heard", occurredAt: NOW - 24 * hour, source: "午饭时听居民转述" });
    expect(worldInitiativeOpportunities(view, NOW)).toEqual([]);
  });

  it("recognizes a completed personal action as progress and remains a read-only projection", () => {
    const view = world();
    const outcome = "给故事里两句想保留的原话画了线，省得誊写时顺手改掉。";
    known(view, { eventId: "personal-action", kind: "routine", text: outcome });
    view.personal!.actions.push({ id: "personal-action", residentId: "cyrene", title: "整理读后感", intent: "留一点自己的感想",
      goalId: "goal", locationId: "okhema", activity: "study", startsAt: NOW - hour, endsAt: NOW,
      status: "completed", version: 2, stage: "整理自己的记录", origin: "local", artifact: "标着原文的故事稿", outcome });
    const before = JSON.stringify(view);
    const random = vi.spyOn(Math, "random");
    try {
      expect(worldInitiativeOpportunities(view, NOW)[0]?.motive).toBe("progress");
      expect(worldInitiativeOpportunities(view, NOW)[0]?.sourceEventId).toBe("personal-action");
      expect(random).not.toHaveBeenCalled();
      expect(JSON.stringify(view)).toBe(before);
    } finally { random.mockRestore(); }
  });

  it("skips routine efforts and old unfinished summaries even with an old artifact", () => {
    const view = world();
    const routine = "抽了点时间继续「整理收到的故事」。";
    const legacy = "为「整理收到的故事」留了一段专心的时间，留下一份还留着空白的清单。还有一点没想明白，想下次接着试。";
    for (const [index, outcome] of [routine, legacy].entries()) {
      const id = `personal-${index}`;
      known(view, { id, eventId: id, kind: "routine", text: outcome });
      view.personal!.actions.push({ id, residentId: "cyrene", title: "整理收到的故事", intent: "整理手头的记录", goalId: "goal",
        locationId: "aedes-elysiae", activity: "study", startsAt: NOW - hour, endsAt: NOW, status: "completed", version: 2,
        stage: "尝试一小段", origin: "local", outcome, ...(index ? { artifact: "一份还留着空白的清单" } : {}) });
    }
    expect(worldInitiativeOpportunities(view, NOW)).toEqual([]);
  });

  it("does not turn a private chat suggestion into a proactive share or association", () => {
    const view = world();
    const eventId = "amphoreus:personal:user:1d";
    known(view, { eventId, kind: "routine", conversationId: "private-a" });
    view.personal!.currentActivity = { residentId: "cyrene", activity: "work", title: "给私聊里提到的花园记笔记",
      locationId: "okhema", startsAt: NOW - hour, endsAt: NOW + hour, source: "personal", eventId };
    expect(worldInitiativeOpportunities(view, NOW, "private-a")).toEqual([]);
    expect(boredomInitiativeOpportunity(view, life(), NOW, "private-a")).toBeUndefined();
    expect(relatedConversationOpportunity(view, { content: "上次聊花园", at: NOW }, NOW, "private-a")).toBeUndefined();
  });
});

describe("boredom is an activity-bound mood episode", () => {
  function resting(): AmphoreusView {
    const view = world();
    view.personal!.currentActivity = { residentId: "cyrene", activity: "rest", title: "把手头的事放下，坐一会儿",
      locationId: "okhema", startsAt: NOW - hour, endsAt: NOW + hour, source: "routine", eventId: "rest:one" };
    return view;
  }
  it("does not need user absence and never reasons about what the user is doing", () => {
    const view = resting();
    const item = boredomInitiativeOpportunity(view, life({ lastInteractionAt: NOW }), NOW, "chat");
    expect(item).toMatchObject({ motive: "boredom", sourceEventId: "rest:one", conversationId: "chat", replyBurden: "question" });
    expect(item?.summary).toContain("自己的念头");
    expect(boredomInitiativeOpportunity(view, life({ boredom: 10, lastInteractionAt: NOW - 7 * 24 * hour }), NOW)).toBeUndefined();
  });
  it("keeps a stable identity while a mood continues, and respects activity changes, rest and available energy", () => {
    const view = resting();
    const state = life({ activitySince: NOW - 30 * 60_000 });
    const first = boredomInitiativeOpportunity(view, state, NOW)!;
    const later = boredomInitiativeOpportunity(view, { ...state, boredom: 70 }, NOW + 60_000)!;
    expect(later.sourceEventId).toBe(first.sourceEventId);
    expect(later.evidenceVersion).toBe(first.evidenceVersion);
    expect(later.occurredAt).toBe(first.occurredAt);
    expect(first.occurredAt).toBe(state.activitySince);
    expect(boredomInitiativeOpportunity(view, life({ energy: 20 }), NOW)).toBeUndefined();
    view.personal!.currentActivity!.activity = "sleep";
    expect(boredomInitiativeOpportunity(view, life(), NOW)).toBeUndefined();
    view.personal!.currentActivity!.activity = "study";
    expect(boredomInitiativeOpportunity(view, life(), NOW)).toBeUndefined();
    view.personal!.currentActivity!.activity = "rest";
    view.personal!.currentActivity!.startsAt = NOW + hour;
    expect(boredomInitiativeOpportunity(view, life(), NOW)).toBeUndefined();
  });
});

describe("associating the current life with a user's explicit words", () => {
  it("requires a literal related topic and preserves the user's words without inferring a preference", () => {
    const view = world();
    view.personal!.goals = [];
    view.personal!.currentActivity = { residentId: "cyrene", activity: "study", title: "读书时整理页边笔记",
      locationId: "okhema", startsAt: NOW - 60_000, endsAt: NOW + hour, source: "routine", eventId: "reading:one" };
    const turn = { content: "我最近也在读书，做了一些笔记", at: NOW - hour };
    const item = relatedConversationOpportunity(view, turn, NOW, "private-chat");
    expect(item).toMatchObject({ motive: "connection", sourceEventId: "reading:one", conversationId: "private-chat", replyBurden: "none" });
    expect(item?.summary).toContain(turn.content);
    expect(item?.evidenceVersion).toContain(String(turn.at));
    expect(item?.summary).not.toContain("用户喜欢");
    expect(relatedConversationOpportunity(view, { content: "今天听了几首音乐", at: NOW }, NOW)).toBeUndefined();
    expect(relatedConversationOpportunity(view, undefined, NOW)).toBeUndefined();
  });

  it("respects explicit refusal, old context, sleep and missing or finished activities", () => {
    const view = world();
    view.personal!.currentActivity = { residentId: "cyrene", activity: "study", title: "读书",
      locationId: "okhema", startsAt: NOW - 60_000, endsAt: NOW + hour, source: "routine", eventId: "reading:one" };
    for (const content of ["不想再聊读书", "别再提读书", "我讨厌读书", "不要问我读书的事"]) {
      expect(relatedConversationOpportunity(view, { content, at: NOW }, NOW)).toBeUndefined();
    }
    expect(relatedConversationOpportunity(view, { content: "读书", at: NOW - 8 * 24 * hour }, NOW)).toBeUndefined();
    view.personal!.currentActivity!.activity = "sleep";
    expect(relatedConversationOpportunity(view, { content: "读书", at: NOW }, NOW)).toBeUndefined();
    view.personal!.currentActivity!.activity = "study"; view.personal!.currentActivity!.endsAt = NOW;
    expect(relatedConversationOpportunity(view, { content: "读书", at: NOW }, NOW)).toBeUndefined();
  });
});
