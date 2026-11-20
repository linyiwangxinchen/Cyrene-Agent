import { describe, expect, it } from "vitest";
import { parseProactiveDecision, restatesRecentReply, type ProactiveHistoryTurn } from "./proactive-prompt";
import { isShareableWorldDetail, worldInitiativeOpportunities } from "./world-initiative";

const NOW = Date.parse("2026-11-16T17:41:54+08:00");

describe("proactive messages that read like a person", () => {
  it("accepts the decision JSON inside a Markdown fence", () => {
    expect(parseProactiveDecision('```json\n{"decision":"send","text":"锵锵——"}\n```')).toEqual({ kind: "send", text: "锵锵——" });
    expect(parseProactiveDecision('```\n{"decision":"drop"}\n```')).toEqual({ kind: "drop" });
    expect(parseProactiveDecision("好的，我来发一条")).toEqual({ kind: "invalid", reason: "invalid_json" });
  });

  it("drops a proactive message that restates her reply from half an hour ago", () => {
    const ordinary: ProactiveHistoryTurn[] = [
      { role: "user", content: "呜呜呜呜呜上午在开组会，下午在开方案讨论会", at: NOW - 31 * 60_000 },
      { role: "model", content: "呜呜……上午组会，下午方案讨论会，整天都被会议占满了，难怪雯雯这么累。先抱抱，晚饭还没吃的话，结束后先去吃点热乎的，好不好？", at: NOW - 31 * 60_000 },
    ];
    const restated = "雯雯，今天上午组会、下午方案讨论会，听着就够累啦……现在有空的话，先找点热乎的吃，别让晚饭也被会议拐走。今晚想吃点什么呀？";
    expect(restatesRecentReply(restated, ordinary, NOW)).toBe(true);
    expect(restatesRecentReply("锵锵——今天在村口捡到一颗特别圆的石头，像不像一颗小月亮？", ordinary, NOW)).toBe(false);
    // Older than the window: may be picked up again as a real follow-up.
    expect(restatesRecentReply(restated, ordinary, NOW + 4 * 3_600_000)).toBe(false);
  });

  it("refuses world details written as records or plans", () => {
    for (const text of [
      "长夜月先把表达边界确认清楚，只记录愿意保存的愿望；丹恒·腾荒也把列车沿途见闻标成可复查来源",
      "前面的安排没能继续下去",
      "为「整理收到的故事」留了一段专心的时间，还有一点没想明白，想下次接着试。",
      "有了公共约定，自己的小事留到下次",
    ]) expect(isShareableWorldDetail(text)).toBe(false);
    expect(isShareableWorldDetail("白厄在村边教一只小羊过独木桥，结果自己先掉进了水沟")).toBe(true);
  });

  it("does not share other residents' public news", () => {
    const change = (id: string, kind: "heard" | "experienced", text: string) => ({
      id, eventId: `amphoreus:2026-11-20:${id}`, kind, text, version: 1, residentId: "cyrene", knownAt: NOW - 60_000, source: "城邦公开消息",
    });
    const world = {
      personal: {
        residentId: "cyrene",
        actions: [],
        changes: [
          change("a", "heard", "白厄在村边教一只小羊过独木桥，结果自己先掉进了水沟"),
          change("b", "experienced", "和风堇一起把晒干的花瓣装进小罐子，罐子上画了一只歪歪的猫"),
        ],
        experiences: [
          { eventId: "amphoreus:2026-11-20:a", kind: "heard" },
          { eventId: "amphoreus:2026-11-20:b", kind: "experienced" },
        ],
      },
    } as never;
    expect(worldInitiativeOpportunities(world, NOW).map(item => item.id)).toEqual(["b"]);
  });
});
