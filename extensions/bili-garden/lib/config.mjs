export const DEFAULTS = Object.freeze({
  interests: "",
  exclusions: "",
  keywords: [],
  modelProfileId: "",
  timezone: "Asia/Shanghai",
  autoRun: false,
  runsPerDay: 6,
  gapMinutes: 60,
  perRound: 3,
  perDay: 18,
  valleyOnly: false,
  reserveNoon: true,
  quietStart: "23:00",
  quietEnd: "08:00",
  minMinutes: 0,
  maxMinutes: 60,
  subtitleProbeMax: 6,
  transcribe: false,
  transcribePerDay: 3,
  asrModel: "small",
  pythonPath: "",
  commentMode: "off",
  autoSend: false,
  commentsPerRound: 1,
  commentsPerDay: 5,
  mentionUid: "",
  dmOn: false,
  dmUid: "",
  dmPerDay: 3,
  likeOn: false,
  likesPerRound: 1,
  likesPerDay: 3,
  favOn: false,
  favsPerDay: 2,
  likeRule: "standard",
  likeRuleExtra: "",
  guardOn: false,
  guardOwnerUid: "",
  guardWhitelist: [],
  guardOwnAll: true,
  guardMinutes: 10,
  guardVideos: 1,
  guardPerRound: 3,
  guardPerDay: 10,
  maxRounds: 24,
  maxRunMinutes: 12,
});
const ranges = {
  runsPerDay: [0, 24],
  gapMinutes: [15, 1440],
  perRound: [0, 10],
  perDay: [0, 60],
  minMinutes: [0, 600],
  maxMinutes: [0, 600],
  subtitleProbeMax: [1, 15],
  transcribePerDay: [0, 20],
  commentsPerRound: [0, 5],
  commentsPerDay: [0, 20],
  dmPerDay: [0, 10],
  likesPerRound: [0, 5],
  likesPerDay: [0, 10],
  favsPerDay: [0, 8],
  guardMinutes: [3, 240],
  guardVideos: [1, 10],
  guardPerRound: [0, 5],
  guardPerDay: [0, 50],
  maxRounds: [4, 60],
  maxRunMinutes: [2, 30],
};
const lists = { keywords: 20, guardWhitelist: 50 };
export function normalizeConfig(patch = {}, previous = DEFAULTS) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("配置必须是对象");
  const next = { ...DEFAULTS, ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new Error(`未知配置项：${key}`);
    if (ranges[key]) {
      const n = Number(value),
        [min, max] = ranges[key];
      if (!Number.isInteger(n) || n < min || n > max)
        throw new Error(`${key} 必须在 ${min}–${max} 之间`);
      next[key] = n;
    } else if (lists[key]) {
      const parts = Array.isArray(value)
        ? value
        : String(value).split(/[\n,，]/);
      next[key] = [
        ...new Set(parts.map((s) => String(s).trim()).filter(Boolean)),
      ].slice(0, lists[key]);
      if (next[key].some((s) => s.length > 80))
        throw new Error(`${key} 单项过长`);
    } else if (typeof DEFAULTS[key] === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} 必须为开关值`);
      next[key] = value;
    } else {
      if (
        typeof value !== "string" ||
        value.length >
          (key === "interests" || key === "exclusions" ? 3000 : 1024)
      )
        throw new Error(`${key} 文本过长或格式不正确`);
      next[key] = value.trim();
    }
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: next.timezone }).format();
  } catch {
    throw new Error("时区无效，请使用 Asia/Shanghai 等 IANA 时区");
  }
  for (const key of ["quietStart", "quietEnd"])
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next[key]))
      throw new Error("静默时段请使用 HH:MM");
  for (const key of ["dmUid", "mentionUid", "guardOwnerUid"])
    if (next[key] && !/^[1-9]\d{0,15}$/.test(next[key]))
      throw new Error(`${key} 必须是数字 UID`);
  if (next.guardWhitelist.some((s) => !/^[1-9]\d{0,15}$/.test(s)))
    throw new Error("守护白名单必须是数字 UID");
  if (!["off", "normal", "invited"].includes(next.commentMode))
    throw new Error("评论模式无效");
  if (!["strict", "standard", "loose"].includes(next.likeRule))
    throw new Error("赞藏判据无效");
  if (!["tiny", "base", "small", "medium"].includes(next.asrModel))
    throw new Error("转写模型无效");
  if (next.maxMinutes && next.minMinutes > next.maxMinutes)
    throw new Error("最小时长不能大于最大时长");
  if (next.dmOn && !next.dmUid) throw new Error("打开私信前请填写唯一接收 UID");
  return next;
}
export function localClock(date, timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(date)
      .map((v) => [v.type, v.value]),
  );
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
    weekend: ["Sat", "Sun"].includes(p.weekday),
  };
}
export function withinWindow(minute, start, end) {
  const parse = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const a = parse(start),
    b = parse(end);
  return a === b
    ? false
    : a < b
      ? minute >= a && minute < b
      : minute >= a || minute < b;
}
export function due(
  config,
  {
    now = new Date(),
    runs = [],
    picked = 0,
    busy = false,
    loggedIn = false,
  } = {},
) {
  const clock = localClock(now, config.timezone);
  if (!config.autoRun || busy || !loggedIn) return false;
  const automatic = runs.filter(
    (r) => r.source === "auto" && (!r.kind || r.kind === "discover"),
  );
  const today = automatic.filter(
    (r) => r.day === clock.day && ["running", "success"].includes(r.status),
  );
  if (
    today.length >= config.runsPerDay ||
    picked >= config.perDay ||
    config.perRound === 0
  )
    return false;
  if (withinWindow(clock.minute, config.quietStart, config.quietEnd))
    return false;
  const latest = automatic.reduce((n, r) => Math.max(n, r.started), 0);
  if (now.getTime() - latest < config.gapMinutes * 60000) return false;
  if (
    config.valleyOnly &&
    !clock.weekend &&
    !withinWindow(clock.minute, "12:00", "14:00") &&
    !withinWindow(clock.minute, "18:00", "09:00")
  )
    return false;
  if (
    config.valleyOnly &&
    config.reserveNoon &&
    clock.minute < 720 &&
    today.length >= config.runsPerDay - 1
  )
    return false;
  return true;
}
export function videoId(value) {
  const raw = String(value ?? "").trim();
  if (/^BV[a-zA-Z0-9]{10}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(
        u.hostname,
      )
    )
      throw new Error();
    const m = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(u.pathname);
    if (m) return m[1];
  } catch {
    /* 仅接受规范 BV 或站内视频链接。 */
  }
  throw new Error("请输入 BV 号或 https://www.bilibili.com/video/BV… 链接");
}
