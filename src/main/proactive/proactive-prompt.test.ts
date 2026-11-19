import { describe, expect, it } from "vitest";
import { buildProactiveMessages, parseProactiveDecision, repeatsRecentProactiveMessage } from "./proactive-prompt";

// 所有测试显式传 timezone，不依赖 runner 机器的系统时区。
// 选 Asia/Shanghai 作为默认测试 tz（与默认 DEFAULT_CHAT_CONTEXT_TIMEZONE 一致）。
const TIMEZONE = "Asia/Shanghai";

const turn = (role: "user" | "model", index: number) => ({ role, content: `${role}-${index}`, at: index });

describe("proactive prompt", () => {
  it("labels and limits ordinary and proactive histories independently", () => {
    const messages = buildProactiveMessages({
      basePersona: "PERSONA",
      userProfile: "PROFILE",
      relevantMemory: "MEMORY",
      ordinaryHistory: Array.from({ length: 20 }, (_, index) => turn(index % 2 ? "model" : "user", index)),
      proactiveHistory: Array.from({ length: 18 }, (_, index) => ({
        role: index % 2 ? "model" as const : "user" as const,
        content: `proactive-${index}`,
        at: index,
      })),
      sceneId: "work_break",
      localNow: new Date(Date.UTC(2026, 6, 13, 6, 0)), // 14:00 Asia/Shanghai
      idleSec: 0,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });

    const system = String(messages[0].content);
    expect(system).toContain("PERSONA");
    expect(system).toContain("[最近使用的普通聊天会话]");
    expect(system).toContain("[主动聊天专用会话]");
    expect(system).toContain("user-4");
    expect(system).not.toContain("user-2");
    expect(system).toContain("proactive-2");
    expect(system).toContain("不要把历史聊天中的最后一句当作用户刚刚发来的消息");
  });

  it("adds night system only during an active local night", () => {
    // 23:00 Asia/Shanghai（夜）：构造 UTC 时间戳使 Asia/Shanghai 下为 23:00
    const nightUtc = Date.UTC(2026, 6, 13, 15, 0); // = 23:00 Asia/Shanghai (UTC+8)
    const night = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "late_night",
      localNow: new Date(nightUtc),
      idleSec: 20,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    // 14:00 Asia/Shanghai（白）
    const dayUtc = Date.UTC(2026, 6, 13, 6, 0); // = 14:00 Asia/Shanghai
    const day = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "work_break",
      localNow: new Date(dayUtc),
      idleSec: 0,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });

    expect(String(night[0].content)).toContain("[night_system]");
    expect(String(night[0].content)).toContain("不要透露你检测到了用户的键盘");
    expect(String(day[0].content)).not.toContain("[night_system]");
  });

  it("adds strict final-followup rules after one unanswered message", () => {
    const dayUtc = Date.UTC(2026, 6, 13, 6, 0); // 14:00 Asia/Shanghai
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "rainy_day",
      localNow: new Date(dayUtc),
      idleSec: 0,
      unansweredCount: 1,
      timezone: TIMEZONE,
    });
    expect(String(messages[0].content)).toContain("[followup_system]");
    expect(String(messages[0].content)).toContain("最后一次主动机会");
    expect(String(messages[0].content)).toContain("不要机械地重复");
  });

  it("asks for strict JSON without tool instructions", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "morning",
      localNow: new Date(2026, 6, 13, 1, 0), // 09:00 Asia/Shanghai
      idleSec: 0,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    const combined = messages.map((message) => String(message.content)).join("\n");
    expect(combined).toContain('{"decision":"send","text":"要发送的一条自然消息"}');
    expect(combined).toContain('{"decision":"hold","resumeOn":"user_message"}');
    expect(combined).toContain('{"decision":"hold","resumeOn":"evidence_change"}');
    expect(combined).toContain('{"decision":"drop"}');
    expect(combined).not.toContain("工具目录");
    expect(combined).not.toContain("Tool Calling");
  });

  it("keeps proactive companionship language human instead of task-like", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "evening_checkin",
      localNow: new Date(Date.UTC(2026, 6, 13, 15, 0)), // 23:00 Asia/Shanghai
      idleSec: 20,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    const combined = messages.map((message) => String(message.content)).join("\n");
    expect(combined).toContain("开口就说这次想说的事，一两句够了就停");
    expect(combined).toContain("都随语气自然出现或省略");
    expect(combined).toContain("仍在说同一件没变化的事，就返回 drop");
  });

  it("does not ask the model to invent a reason from history for an old ambient scene", () => {
    const messages = buildProactiveMessages({
      basePersona: "P", ordinaryHistory: [{ role: "user", content: "我还在准备答辩", at: Date.UTC(2026, 6, 13, 2) }], proactiveHistory: [],
      sceneId: "ambient_companion", localNow: new Date(Date.UTC(2026, 6, 13, 6)), idleSec: 900, unansweredCount: 1, timezone: TIMEZONE,
    });
    const system = String(messages[0].content);
    expect(system).not.toContain("[ambient_system]");
    expect(system).toContain("不要从历史里另找一个借口填补频率");
    expect(system).toContain("只允许分享一件新的、无需回复也成立的小事");
    expect(system).toContain("不提问、不追问旧话题");
  });

  it("allows a short private message and uses the local date after midnight", () => {
    const localNow = new Date("2026-07-21T16:30:00.000Z");
    const at = localNow.getTime() - 30 * 60_000;
    const messages = buildProactiveMessages({
      basePersona: "P",
      userProfile: "私聊称呼",
      relevantMemory: "之前的私事",
      ordinaryHistory: [{ role: "user", content: "前几天在准备答辩", at }],
      proactiveHistory: [{ role: "model", content: "愿你今晚过得轻松一点。", at }],
      momentContext: "虚构世界里的计划",
      sceneId: "standalone_care",
      careContext: { kind: "standalone_care" },
      replyBurden: "none",
      localNow,
      idleSec: 20,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });

    const system = String(messages[0].content);
    expect(system).toContain("[本轮日常关心]");
    expect(system).toContain("话说到了就停，半句也可以");
    expect(system).toContain("别先解释怎么想起了对方，再补一句客套祝福");
    expect(system).toContain("要是这会儿只能说些客套话，就返回 drop");
    expect(system).toContain("过了当地午夜，“今天”按新日期算");
    expect(system).toContain("省去问句、提醒和索要回应的话");
    expect(system).toContain("对方在做什么、几点睡、心情怎样，消息里只说已知的事");
    expect(system).toContain("刚说过类似的话、上一条主动消息还没收到回复，或此刻说了会打扰，就返回 drop");
    expect(system).toContain("[2026-07-22 00:00] assistant: 愿你今晚过得轻松一点。");
    for (const unrelated of ["私聊称呼", "之前的私事", "前几天在准备答辩", "虚构世界里的计划", "[care_system]", "[night_system]"]) {
      expect(system).not.toContain(unrelated);
    }
    expect(String(messages[1].content)).toContain("用户当地时间：2026-07-22 00:30（星期三，Asia/Shanghai）");
  });

  it("grounds sharing in the supplied moment and permits saving it for a relevant conversation", () => {
    const messages = buildProactiveMessages({
      basePersona: "P", ordinaryHistory: [], proactiveHistory: [], sceneId: "life:world:note-1",
      localNow: new Date(Date.UTC(2026, 6, 13, 6)), idleSec: 0, unansweredCount: 0, timezone: TIMEZONE,
      momentContext: "午餐时听到一个故事，来自她的个人听闻记录。下一页的整理还没有完成。", replyBurden: "none",
    });
    const system = String(messages[0].content);
    expect(system).toContain("午餐时听到一个故事");
    expect(system).toContain("不要把计划写成已经完成");
    expect(system).toContain("缺少具体可分享的信息，就返回 drop");
    expect(system).toContain("可留到用户回来或事情有进展时再说");
    expect(system).toContain("一句无需回复也成立的关心或分享就够了");
  });
});

describe("proactive repetition", () => {
  const now = Date.UTC(2026, 10, 19, 6);
  const prior = { role: "model" as const, at: now - 3_600_000,
    content: "今天整理收到的故事时留了一份还空着的清单。有一小段还没想明白，等下次再接着试……偶尔留一点空白，也挺好的♪" };
  const repeat = "今天在村边散步时，又把那条没想明白的问题记进手记里了……先留一点空白，等下次有了新线索再继续写♪";

  it("treats the same unresolved world note as a repeat even when the activity changes", () => {
    expect(repeatsRecentProactiveMessage(repeat, [prior], now, true)).toBe(true);
    expect(repeatsRecentProactiveMessage(repeat, [{ ...prior, at: now - 25 * 3_600_000 }], now, true)).toBe(false);
  });

  it("compares exact and close edits but allows a concrete change on the same topic", () => {
    expect(repeatsRecentProactiveMessage(prior.content.replace("♪", "！"), [prior], now, false)).toBe(true);
    expect(repeatsRecentProactiveMessage(`刚才${prior.content}`, [prior], now, false)).toBe(true);
    expect(repeatsRecentProactiveMessage("我把那两张故事页按讲述人分开了。现在一眼就能看出哪张是谁写的。", [prior], now, true)).toBe(false);
  });
});

// ── 时区专项测试 ───────────────────────────────────────────
describe("proactive prompt timezone", () => {
  // 固定 UTC 时间戳：2026-07-21T15:30:00.000Z
  const FIXED_UTC = Date.UTC(2026, 6, 21, 15, 30, 0);
  const FIXED_DATE = new Date(FIXED_UTC);

  it("formatLocalTime uses specified timezone", () => {
    // Asia/Taipei (UTC+8) → 23:30 同日
    const taipeiMessages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "evening_checkin",
      localNow: FIXED_DATE,
      idleSec: 0,
      unansweredCount: 0,
      timezone: "Asia/Taipei",
    });
    const taipeiCombined = taipeiMessages.map((m) => String(m.content)).join("\n");
    expect(taipeiCombined).toContain("用户当地时间：2026-07-21 23:30（星期二，Asia/Taipei）");

    // UTC → 15:30 同日
    const utcMessages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "work_break",
      localNow: FIXED_DATE,
      idleSec: 0,
      unansweredCount: 0,
      timezone: "UTC",
    });
    const utcCombined = utcMessages.map((m) => String(m.content)).join("\n");
    expect(utcCombined).toContain("用户当地时间：2026-07-21 15:30（星期二，UTC）");

    // America/Los_Angeles (PDT, UTC-7) → 08:30 同日
    const laMessages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "morning_greeting",
      localNow: FIXED_DATE,
      idleSec: 0,
      unansweredCount: 0,
      timezone: "America/Los_Angeles",
    });
    const laCombined = laMessages.map((m) => String(m.content)).join("\n");
    expect(laCombined).toContain("用户当地时间：2026-07-21 08:30（星期二，America/Los_Angeles）");
  });

  it("history row timestamps use specified timezone", () => {
    // at: 2026-07-21T15:30:00.000Z 的 epoch ms
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [{ role: "user", content: "hi", at: FIXED_UTC }],
      proactiveHistory: [],
      sceneId: "evening_checkin",
      localNow: FIXED_DATE,
      idleSec: 0,
      unansweredCount: 0,
      timezone: "Asia/Taipei",
    });
    const system = String(messages[0].content);
    expect(system).toContain("[2026-07-21 23:30] user: hi");
  });

  it("Asia/Taipei 23:30 is recognized as active night", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "late_night",
      localNow: FIXED_DATE,
      idleSec: 30, // < 60 触发
      unansweredCount: 0,
      timezone: "Asia/Taipei",
    });
    expect(String(messages[0].content)).toContain("[night_system]");
  });

  it("America/Los_Angeles 同一时刻 08:30 不被识别为 active night", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "morning_greeting",
      localNow: FIXED_DATE,
      idleSec: 0,
      unansweredCount: 0,
      timezone: "America/Los_Angeles",
    });
    expect(String(messages[0].content)).not.toContain("[night_system]");
  });

  it("22:00 与 08:00 边界保持现有语义", () => {
    // 2026-07-21T14:00:00.000Z = Asia/Shanghai 22:00 → 视为夜间
    const t22 = new Date(Date.UTC(2026, 6, 21, 14, 0, 0));
    const night22 = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "evening_checkin",
      localNow: t22,
      idleSec: 30,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    expect(String(night22[0].content)).toContain("[night_system]");

    // 2026-07-21T23:00:00.000Z = Asia/Shanghai 07:00 → 视为夜间（< 8）
    const t07 = new Date(Date.UTC(2026, 6, 21, 23, 0, 0));
    const night07 = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "evening_checkin",
      localNow: t07,
      idleSec: 30,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    expect(String(night07[0].content)).toContain("[night_system]");

    // 08:00 Asia/Shanghai → 视为白天（hour<8 不含 8；hour>=22 不含 8）
    const t08 = new Date(Date.UTC(2026, 6, 22, 0, 0, 0));
    const day08 = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "morning_greeting",
      localNow: t08,
      idleSec: 0,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    expect(String(day08[0].content)).not.toContain("[night_system]");

    // 2026-07-22T01:00:00.000Z = Asia/Shanghai 09:00 → 视为白天
    const t09 = new Date(Date.UTC(2026, 6, 22, 1, 0, 0));
    const day09 = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "morning_greeting",
      localNow: t09,
      idleSec: 0,
      unansweredCount: 0,
      timezone: TIMEZONE,
    });
    expect(String(day09[0].content)).not.toContain("[night_system]");
  });

  it("missing or invalid timezones use the configured application default", () => {
    const messages = buildProactiveMessages({
      basePersona: "P",
      ordinaryHistory: [],
      proactiveHistory: [],
      sceneId: "evening_checkin",
      localNow: FIXED_DATE,
      idleSec: 0,
      unansweredCount: 0,
      timezone: "Foo/Bar",
    });
    const combined = messages.map((m) => String(m.content)).join("\n");
    expect(combined).toContain("用户当地时间：2026-07-21 23:30（星期二，Asia/Shanghai）");
    expect(combined).toContain("候选场景：evening_checkin");
  });
});

describe("parseProactiveDecision", () => {
  it("parses send and silent decisions", () => {
    expect(parseProactiveDecision('{"decision":"send","text":"早点休息呀♪"}')).toEqual({
      kind: "send",
      text: "早点休息呀♪",
    });
    expect(parseProactiveDecision('{"decision":"silent","text":""}')).toEqual({ kind: "silent" });
    expect(parseProactiveDecision('{"decision":"silent"}')).toEqual({ kind: "silent" });
  });

  it("parses both explicit hold conditions and drop without generating text", () => {
    expect(parseProactiveDecision('{"decision":"hold","resumeOn":"user_message"}')).toEqual({ kind: "hold", resumeOn: "user_message" });
    expect(parseProactiveDecision('{"decision":"hold","resumeOn":"evidence_change"}')).toEqual({ kind: "hold", resumeOn: "evidence_change" });
    expect(parseProactiveDecision('{"decision":"drop"}')).toEqual({ kind: "drop" });
    expect(parseProactiveDecision('{"decision":"send","text":"  记下一件有趣的小事。  "}')).toEqual({ kind: "send", text: "记下一件有趣的小事。" });
  });

  it.each([
    null, [], true, 42, "send", {}, { decision: "unknown" },
    { decision: "hold" }, { decision: "hold", resumeOn: "timer" },
    { decision: "hold", resumeOn: 3 }, { decision: "hold", resumeOn: "user_message", text: "仍然发送" },
    { decision: "send", text: 42 }, { decision: "send", text: "消息", resumeOn: "user_message" },
    { decision: "drop", text: "仍然发送" }, { decision: "drop", resumeOn: "evidence_change" },
    { decision: "silent", text: "不可发送的内容" }, { decision: "silent", text: null },
    { decision: "send", text: "消息", tools: [] }, { decision: "hold", resumeOn: "user_message", retryAt: 1800 },
  ])("rejects malformed, contradictory or unrecognized fields: %j", (value) => {
    expect(parseProactiveDecision(JSON.stringify(value)).kind).toBe("invalid");
  });

  it("rejects prose wrappers, empty send text, and oversized output", () => {
    expect(parseProactiveDecision('好的：{"decision":"silent","text":""}').kind).toBe("invalid");
    expect(parseProactiveDecision('{"decision":"send","text":"   "}').kind).toBe("invalid");
    expect(parseProactiveDecision(JSON.stringify({ decision: "send", text: "x".repeat(501) })).kind).toBe("invalid");
  });
});
