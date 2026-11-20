import { describe, expect, it } from "vitest";
import { buildProactiveComposeMessages, parseComposedMessage, parseProactiveDecision } from "./proactive-prompt";
import { memoryFollowupOpportunities, MEMORY_FOLLOWUP_DELAY_MS } from "./memory-initiative";
import type { SocialAtom } from "../social-context/types";

const TIMEZONE = "Asia/Shanghai";
const NOW = Date.parse("2026-11-20T13:00:00+08:00");
const minute = 60_000;

describe("two-step proactive generation", () => {
  it("reads the decision as a plan, accepting the old text field", () => {
    expect(parseProactiveDecision('{"decision":"send","plan":"问问组会开完没有"}')).toEqual({ kind: "send", text: "问问组会开完没有" });
    expect(parseProactiveDecision('{"decision":"send","text":"旧协议"}')).toEqual({ kind: "send", text: "旧协议" });
  });

  it("continues the real conversation and ends with a private instruction", () => {
    const messages = buildProactiveComposeMessages({
      persona: "PERSONA",
      personMemory: "【你记得的关于对方的事】\n- 对方叫雯雯",
      history: [
        { role: "model", content: "早安呀♪", at: NOW - 300 * minute },
        { role: "user", content: "呜～", at: NOW - 60 * minute },
        { role: "model", content: "怎么啦？", at: NOW - 59 * minute },
        { role: "user", content: "开了一上午会", at: NOW - 58 * minute },
        { role: "user", content: "好累", at: NOW - 58 * minute + 1 },
      ],
      plan: "问问午饭吃了没",
      localNow: new Date(NOW),
      timezone: TIMEZONE,
      replyBurden: "none",
    });
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(String(messages[0].content)).toContain("PERSONA");
    expect(String(messages[0].content)).toContain("对方叫雯雯");
    // A conversation cannot start with her own turn; consecutive user turns are merged.
    expect(messages.slice(1).map(message => message.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(String(messages[1].content)).toBe("[11月20日 12:00] 呜～");
    expect(String(messages[2].content)).toBe("怎么啦？");
    expect(String(messages[3].content)).toContain("开了一上午会\n[11月20日 12:02] 好累");
    const instruction = String(messages.at(-1)!.content);
    expect(instruction).toContain("这条不是对方发来的");
    expect(instruction).toContain("问问午饭吃了没");
    expect(instruction).toContain("58 分钟 前");
    expect(instruction).toContain("别用问句收尾");
  });

  it("returns plain text and refuses structured or empty output", () => {
    expect(parseComposedMessage("「锵锵——午饭吃了没？」")).toEqual({ kind: "send", text: "锵锵——午饭吃了没？" });
    expect(parseComposedMessage("[11月20日 13:00] 午饭吃了没？")).toEqual({ kind: "send", text: "午饭吃了没？" });
    expect(parseComposedMessage('{"decision":"send","text":"x"}')).toMatchObject({ kind: "invalid" });
    expect(parseComposedMessage("  ")).toMatchObject({ kind: "invalid" });
  });
});

describe("asking about things she remembers", () => {
  const atom = (id: string, fields: Partial<SocialAtom>): SocialAtom => ({
    id, conversationId: "wechat-chat", type: "open_loop", content: "对方11月21日上午面试", evidenceTurnId: "u", evidenceQuote: "明天面试",
    createdAt: NOW - 20 * 3_600_000, status: "active", expiresAt: NOW + 2 * 86_400_000, ...fields,
  });

  it("waits a while, stays in the conversation, and skips closed loops", () => {
    const opportunities = memoryFollowupOpportunities([
      atom("ready", {}),
      atom("too-soon", { createdAt: NOW - 2 * 3_600_000 }),
      atom("resolved", { status: "resolved" }),
      atom("other-chat", { conversationId: "desktop" }),
      atom("fact", { type: "long_term", expiresAt: undefined }),
    ], NOW, "wechat-chat");
    expect(opportunities.map(item => item.sourceEventId)).toEqual(["ready"]);
    expect(opportunities[0]).toMatchObject({
      source: "memory_followup", motive: "followup", replyBurden: "question", conversationId: "wechat-chat",
      occurredAt: NOW - 20 * 3_600_000 + MEMORY_FOLLOWUP_DELAY_MS,
    });
  });
});
