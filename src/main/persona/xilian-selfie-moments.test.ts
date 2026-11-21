import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSelfieOfferHint,
  classifySelfieMoment,
  createSelfieLog,
  normalizeSelfieFrequency,
  relationshipAllowsSelfie,
} from "./xilian-selfie-moments";

const HOUR = 3_600_000;
const always = () => 0;
const never = () => 0.99;

describe("classifySelfieMoment", () => {
  it("recognizes affectionate, celebrating, tired and curious messages", () => {
    expect(classifySelfieMoment("好想你呀")).toBe("missing");
    expect(classifySelfieMoment("我考试通过了！")).toBe("celebrate");
    expect(classifySelfieMoment("今天加班好累")).toBe("cheer");
    expect(classifySelfieMoment("你在干嘛呢")).toBe("life");
    expect(classifySelfieMoment("早安")).toBe("greeting");
  });

  it("skips tasks, serious topics and long messages", () => {
    expect(classifySelfieMoment("帮我整理一下这个文件，好想你")).toBeUndefined();
    expect(classifySelfieMoment("外婆去世了，好想她")).toBeUndefined();
    expect(classifySelfieMoment(`好想你${"。".repeat(220)}`)).toBeUndefined();
    expect(classifySelfieMoment("今天天气一般")).toBeUndefined();
  });
});

describe("relationshipAllowsSelfie", () => {
  const base = { paused: false, affection: true, relationshipMode: "partner" as const, selfieFrequency: "normal" as const };
  it("requires an affectionate companion or partner relationship", () => {
    expect(relationshipAllowsSelfie(base)).toBe(true);
    expect(relationshipAllowsSelfie({ ...base, relationshipMode: "companion" })).toBe(true);
    expect(relationshipAllowsSelfie({ ...base, relationshipMode: "assistant" })).toBe(false);
    expect(relationshipAllowsSelfie({ ...base, affection: false })).toBe(false);
    expect(relationshipAllowsSelfie({ ...base, paused: true })).toBe(false);
    expect(relationshipAllowsSelfie({ ...base, selfieFrequency: "off" })).toBe(false);
  });

  it("defaults unknown frequencies to normal", () => {
    expect(normalizeSelfieFrequency(undefined)).toBe("normal");
    expect(normalizeSelfieFrequency("weird")).toBe("normal");
    expect(normalizeSelfieFrequency("high")).toBe("high");
  });
});

describe("selfie log", () => {
  it("offers once, counts the saved image and then cools down", () => {
    const log = createSelfieLog();
    const now = 10 * HOUR;
    expect(log.offerForReply({ conversationId: "c", userText: "想你", frequency: "normal", now, random: always })).toBe("missing");
    // A second offer within 30 minutes is suppressed even if the first was not taken.
    expect(log.offerForReply({ conversationId: "c", userText: "想你", frequency: "normal", now: now + 60_000, random: always })).toBeUndefined();
    log.recordImageSaved("c", now + 2 * 60_000);
    expect(log.entries().at(-1)).toMatchObject({ status: "sent", origin: "reply" });
    // The normal preset keeps three hours between selfies.
    expect(log.offerForReply({ conversationId: "c", userText: "想你", frequency: "normal", now: now + 2 * HOUR, random: always })).toBeUndefined();
    expect(log.offerForReply({ conversationId: "c", userText: "想你", frequency: "normal", now: now + 4 * HOUR, random: always })).toBe("missing");
  });

  it("respects the random chance and the off preset", () => {
    const log = createSelfieLog();
    expect(log.offerForReply({ conversationId: "c", userText: "想你", frequency: "normal", now: HOUR, random: never })).toBeUndefined();
    expect(log.offerForReply({ conversationId: "c", userText: "想你", frequency: "off", now: HOUR, random: always })).toBeUndefined();
  });

  it("does not count images saved long after an offer or in another conversation", () => {
    const log = createSelfieLog();
    log.offerForReply({ conversationId: "c", userText: "想你", frequency: "high", now: HOUR, random: always });
    log.recordImageSaved("other", HOUR + 60_000);
    log.recordImageSaved("c", HOUR + 20 * 60_000);
    expect(log.entries().every(entry => entry.status === "offered")).toBe(true);
  });

  it("caps proactive selfies per window and persists them", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "selfie-log-"));
    try {
      const file = path.join(directory, "xilian-selfies.json");
      const log = createSelfieLog(file);
      const now = 100 * HOUR;
      expect(log.canSendProactive("normal", now)).toBe(true);
      log.recordProactiveSent("c", now);
      expect(createSelfieLog(file).canSendProactive("normal", now + 4 * HOUR)).toBe(false);
      expect(createSelfieLog(file).canSendProactive("normal", now + 25 * HOUR)).toBe(true);
      expect(createSelfieLog(file).canSendProactive("high", now + 2 * HOUR)).toBe(true);
      expect(createSelfieLog(file).canSendProactive("off", now + 25 * HOUR)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("buildSelfieOfferHint", () => {
  it("makes the selfie optional and picks a pose by time of day", () => {
    const morning = buildSelfieOfferHint("greeting", 8);
    expect(morning).toContain("[这一轮可以发自拍]");
    expect(morning).toContain("只是可以，不是必须");
    expect(morning).toContain("刚起床");
    expect(buildSelfieOfferHint("greeting", 23)).toContain("准备睡觉");
  });
});
