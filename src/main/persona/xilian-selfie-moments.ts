import * as fs from "node:fs";
import * as path from "node:path";
import type { RelationshipState, SelfieFrequency } from "../../shared/companion";

/**
 * 昔涟在合适的时刻主动发自拍。本地规则只决定“这一轮可以发”，发不发由模型决定；
 * 冷却与上限按实际发出的照片计算。
 */
export type SelfieTrigger = "missing" | "celebrate" | "cheer" | "life" | "greeting";
export type SelfieOrigin = "reply" | "proactive" | "requested";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 提议后在这段时间内生成的图片算作这次自拍。 */
const OFFER_MATCH_MS = 15 * 60_000;
/** 模型没接提议时，至少隔这么久再提议，避免每轮都塞提示。 */
const OFFER_RETRY_MS = 30 * 60_000;

export interface SelfieFrequencyPreset {
  /** 回复里 24 小时内最多几张。 */
  replyPerDay: number;
  /** 任意两张自拍之间的最小间隔。 */
  minGapMs: number;
  /** 主动自拍的条数与时间窗。 */
  proactive: { count: number; windowMs: number };
}

export const SELFIE_FREQUENCY_PRESETS: Record<SelfieFrequency, SelfieFrequencyPreset> = {
  off: { replyPerDay: 0, minGapMs: Number.POSITIVE_INFINITY, proactive: { count: 0, windowMs: DAY } },
  low: { replyPerDay: 1, minGapMs: 12 * HOUR, proactive: { count: 2, windowMs: 7 * DAY } },
  normal: { replyPerDay: 3, minGapMs: 3 * HOUR, proactive: { count: 1, windowMs: DAY } },
  high: { replyPerDay: 5, minGapMs: 90 * 60_000, proactive: { count: 2, windowMs: DAY } },
};
export const DEFAULT_SELFIE_FREQUENCY: SelfieFrequency = "normal";

export function normalizeSelfieFrequency(value: unknown): SelfieFrequency {
  return value === "off" || value === "low" || value === "normal" || value === "high" ? value : DEFAULT_SELFIE_FREQUENCY;
}

const SERIOUS = /去世|走了|葬礼|分手|离婚|崩溃|想死|不想活|自杀|抑郁|住院|医院|生病了|吵架|绝望|哭了一晚|对不起|纠正/u;
const TASK = /帮我|帮忙|文件|pdf|代码|整理|查一下|翻译|报告|表格|论文|改一下|发我|做一个|生成一个|提醒我|算一下/iu;
const MISSING = /想你|想见你|好想|抱抱|要抱|抱一下|抱[～~]|贴贴|蹭蹭|亲亲|亲一下|啾|么么|爱你/u;
const CELEBRATE = /生日|好消息|通过了|过了！|上岸|录取|拿到|offer|中了|成功了|太好了|开心死|好开心|发工资|涨工资/iu;
const CHEER = /好累|累死|累了|加班|开了一天会|一天的会|组会|呜呜|不开心|烦死|压力好大|熬夜|好困/u;
const LIFE = /在干嘛|在做什么|干什么呢|你在哪|在哪呢|今天穿|穿的什么|让我看看你|想看看你|发张照片/u;
const GREETING = /^(?:早安|早上好|早呀|早[～~]|晚安|要睡了|我睡啦|睡啦)/u;

const TRIGGER_CHANCE: Record<SelfieTrigger, number> = { missing: 0.75, celebrate: 0.8, cheer: 0.5, life: 0.7, greeting: 0.35 };

/** 这句话属于哪种适合发自拍的时刻；正事、严肃话题、纠正都不算。 */
export function classifySelfieMoment(text: string): SelfieTrigger | undefined {
  const value = text.trim();
  if (!value || value.length > 200 || SERIOUS.test(value) || TASK.test(value)) return undefined;
  if (MISSING.test(value)) return "missing";
  if (CELEBRATE.test(value)) return "celebrate";
  if (LIFE.test(value)) return "life";
  if (CHEER.test(value)) return "cheer";
  if (GREETING.test(value)) return "greeting";
  return undefined;
}

/** 关系允许亲近表达时才主动发自拍。 */
export function relationshipAllowsSelfie(relationship: Pick<RelationshipState, "paused" | "affection" | "relationshipMode" | "selfieFrequency">): boolean {
  if (relationship.paused || !relationship.affection) return false;
  const mode = relationship.relationshipMode ?? "companion";
  return (mode === "partner" || mode === "companion") && normalizeSelfieFrequency(relationship.selfieFrequency) !== "off";
}

function pose(trigger: SelfieTrigger, localHour: number): string {
  switch (trigger) {
    case "missing": return "托着脸凑近镜头笑，像在说“我也想你”";
    case "celebrate": return "举着一朵小花或比个耶，笑得很开心，像在替对方庆祝";
    case "cheer": return "握拳给对方打气，或把一杯热饮递向镜头";
    case "life": return "此刻所在的地方和正在做的事，随手拍的生活照";
    case "greeting": return localHour < 12 ? "刚起床、头发有点乱的居家照，带着困困的笑" : "窝在被子里准备睡觉的样子，灯光暗暗的";
  }
}

const REASON: Record<SelfieTrigger, string> = {
  missing: "对方在想你、撒娇",
  celebrate: "对方有值得庆祝的事",
  cheer: "对方有点累，需要打打气",
  life: "对方想知道你在做什么",
  greeting: "对方在跟你道早安或晚安",
};

export function buildSelfieOfferHint(trigger: SelfieTrigger, localHour: number): string {
  return [
    "[这一轮可以发自拍]",
    `${REASON[trigger]}。这会儿你可以顺手给对方发一张自己的自拍：调用图片生成，再配一两句话，像随手拍给喜欢的人看。`,
    `拍的样子：${pose(trigger, localHour)}。外貌按上面的昔涟图片生成约束和参考图。`,
    "只是可以，不是必须：发图会显得突兀、对方在说正事或情绪很低落时，就正常回复，也不要提照片。",
    "决定发的话，文字里不要提“生成”“系统”，也不要描述图片里没有的东西。",
  ].join("\n");
}

interface SelfieLogEntry {
  at: number;
  origin: SelfieOrigin;
  status: "offered" | "sent";
  trigger?: SelfieTrigger;
  conversationId?: string;
}

export interface SelfieLog {
  /** 回复前调用：规则通过时记一次提议并返回触发原因。 */
  offerForReply(input: { conversationId: string; userText: string; frequency: SelfieFrequency; now: number; random?: () => number }): SelfieTrigger | undefined;
  /** 用户明确要自拍：之后生成的图片按自拍计数。 */
  noteRequested(conversationId: string, now: number): void;
  /** 有图片落盘时调用：把最近的提议/请求记为已发出。 */
  recordImageSaved(conversationId: string, now: number): void;
  canSendProactive(frequency: SelfieFrequency, now: number): boolean;
  recordProactiveSent(conversationId: string | undefined, now: number): void;
  entries(): readonly SelfieLogEntry[];
}

const MAX_ENTRIES = 300;

export function createSelfieLog(filePath?: string): SelfieLog {
  let loaded = false;
  let entries: SelfieLogEntry[] = [];
  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { entries?: unknown };
      entries = Array.isArray(raw.entries)
        ? raw.entries.filter((item): item is SelfieLogEntry => Boolean(item) && typeof item === "object"
          && typeof (item as SelfieLogEntry).at === "number" && ["offered", "sent"].includes((item as SelfieLogEntry).status))
        : [];
    } catch { entries = []; }
  };
  const save = () => {
    entries = entries.slice(-MAX_ENTRIES);
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2), "utf8");
      fs.renameSync(temporary, filePath);
    } catch (error) {
      console.warn("[XilianSelfie] 自拍记录写入失败", error);
    }
  };
  const sent = (now: number, windowMs: number, origin?: SelfieOrigin) => entries.filter(entry => entry.status === "sent"
    && entry.at > now - windowMs && entry.at <= now && (!origin || entry.origin === origin));
  const lastSentAt = () => entries.filter(entry => entry.status === "sent").reduce((latest, entry) => Math.max(latest, entry.at), 0);

  return {
    offerForReply({ conversationId, userText, frequency, now, random = Math.random }) {
      load();
      const preset = SELFIE_FREQUENCY_PRESETS[frequency];
      if (preset.replyPerDay <= 0) return undefined;
      const trigger = classifySelfieMoment(userText);
      if (!trigger) return undefined;
      if (now - lastSentAt() < preset.minGapMs) return undefined;
      if (sent(now, DAY).filter(entry => entry.origin !== "proactive").length >= preset.replyPerDay) return undefined;
      if (entries.some(entry => entry.status === "offered" && entry.at > now - OFFER_RETRY_MS && entry.at <= now)) return undefined;
      if (random() >= TRIGGER_CHANCE[trigger]) return undefined;
      entries.push({ at: now, origin: "reply", status: "offered", trigger, conversationId });
      save();
      return trigger;
    },
    noteRequested(conversationId, now) {
      load();
      entries.push({ at: now, origin: "requested", status: "offered", conversationId });
      save();
    },
    recordImageSaved(conversationId, now) {
      load();
      const pending = [...entries].reverse().find(entry => entry.status === "offered" && now - entry.at <= OFFER_MATCH_MS && now >= entry.at
        && (!entry.conversationId || entry.conversationId === conversationId));
      if (!pending) return;
      pending.status = "sent";
      pending.at = now;
      save();
    },
    canSendProactive(frequency, now) {
      load();
      const preset = SELFIE_FREQUENCY_PRESETS[frequency];
      if (preset.proactive.count <= 0) return false;
      if (now - lastSentAt() < preset.minGapMs) return false;
      return sent(now, preset.proactive.windowMs, "proactive").length < preset.proactive.count;
    },
    recordProactiveSent(conversationId, now) {
      load();
      entries.push({ at: now, origin: "proactive", status: "sent", ...(conversationId ? { conversationId } : {}) });
      save();
    },
    entries() {
      load();
      return entries;
    },
  };
}

let sharedLog: SelfieLog | undefined;
let sharedPath: string | undefined;
/** 回复链路和主动消息共用同一份记录，冷却才算得准。 */
export function getSharedSelfieLog(filePath: string): SelfieLog {
  if (!sharedLog || sharedPath !== filePath) {
    sharedLog = createSelfieLog(filePath);
    sharedPath = filePath;
  }
  return sharedLog;
}
