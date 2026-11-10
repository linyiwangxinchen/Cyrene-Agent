import {
  getXilianLocation,
  XILIAN_WORLD_ARCS,
  type XilianLifeSnapshot,
  type XilianTimelineEvent,
  type XilianWorldState,
} from "../../shared/xilian-world";
import { getXilianDateKey, getZonedDateParts, xilianStableHash } from "./schedule";
import { formatAmphoreusContext } from "../amphoreus-world/engine";

export interface XilianLifeContextInput {
  state: XilianWorldState;
  timeline: readonly XilianTimelineEvent[];
  now: number;
  timezone: string;
  energy?: number;
  world?: import("../../shared/amphoreus-world").AmphoreusView;
}

export function isXilianSelfieRequest(text: string): boolean {
  return /自拍|昔涟.{0,20}(照片|图片)|拍一张.{0,20}(昔涟|照片|图片)/u.test(text);
}

function localTime(now: number, timezone: string): string {
  const parts = getZonedDateParts(new Date(now), timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function eventLocation(event: XilianTimelineEvent | undefined): string {
  return event ? getXilianLocation(event.locationId)?.name ?? "一个还在整理中的地点" : "序页城";
}

function chooseOutfit(input: XilianLifeContextInput, event: XilianTimelineEvent | undefined): string {
  if (event?.slotId === "amphoreus" && event.activityTitle.includes("睡眠")) return "适合安静休息的柔软睡衣";
  const seed = xilianStableHash(`${getXilianDateKey(new Date(input.now), input.timezone)}:${event?.slotId ?? "idle"}`) % 3;
  if (event?.activityKind === "maintenance" || event?.activityKind === "work") return "便于行动的浅色工作外套";
  if (event?.activityKind === "game") return "袖口稍微卷起的轻便日常装";
  if (seed === 1) return "带一点柔和蓝色的小外套";
  if (seed === 2) return "适合在风里走动的轻薄长裙";
  return "熟悉的粉色系日常服饰";
}

function selfieReason(event: XilianTimelineEvent | undefined): string {
  if (event?.slotId === "amphoreus") return event.activityTitle.includes("睡眠") ? "她正在休息；这是当前休息场景的画面，不声称她刚醒来拍摄" : "记录眼下的生活片刻，不把尚未发生的计划说成已经完成";
  if (!event) return "她想把今天安静的一小段时间留存下来";
  switch (event.activityKind) {
    case "maintenance": return "灯光终于稳定下来，她想记录这次小小的完成感";
    case "work": return "桌上的记录页刚好整理完，光线也落在了她身边";
    case "study": return "她翻到了一段特别的旧记录，想把当时的表情留给用户看";
    case "game": return "她刚结束一局游戏，胜负不重要，但这一刻很想分享";
    case "rest": return "她今天有一点疲惫，想分享一张不需要解释太多的照片";
    case "explore": return "远处出现了细小变化，她想带着那片景色来找用户";
    case "social": return "刚听到一件有趣的小事，她想先拍下来再慢慢讲";
    case "travel": return "她带回了一件小物，想让自拍成为这段旅程的书签";
  }
}

function currentEvent(input: XilianLifeContextInput): XilianTimelineEvent | undefined {
  return input.state.currentActivity
    ?? input.timeline.find((event) => event.status === "active")
    ?? [...input.timeline].filter((event) => event.status === "completed").sort((a, b) => b.occurredAt - a.occurredAt)[0];
}

function recentCompleted(input: XilianLifeContextInput, current: XilianTimelineEvent | undefined): XilianTimelineEvent | undefined {
  return [...input.timeline]
    .filter((event) => event.status === "completed" && event.id !== current?.id)
    .sort((a, b) => b.occurredAt - a.occurredAt)[0];
}

export function buildXilianLifeSnapshot(input: XilianLifeContextInput): XilianLifeSnapshot {
  const current = currentEvent(input);
  const recent = recentCompleted(input, current);
  const next = input.state.nextPlannedEvent;
  const location = eventLocation(current);
  const arc = XILIAN_WORLD_ARCS[input.state.activeArcId];
  return {
    worldDate: getXilianDateKey(new Date(input.now), input.timezone),
    localTime: localTime(input.now, input.timezone),
    season: input.state.seasonId.startsWith("翁法罗斯") ? input.state.seasonId : arc?.title ?? input.state.seasonId,
    ...(input.world ? { worldContext: formatAmphoreusContext(input.world) } : {}),
    location,
    currentActivity: current?.activityTitle ?? "还在决定今天先从哪一页开始",
    recentEvent: recent?.outcome ?? recent?.summary ?? "今天还没有完成可以回看的生活事件",
    nextPlan: next?.activityTitle ?? "晚上留一点安静时间整理心情",
    mood: current?.mood ?? "平稳，带着一点期待",
    energy: Math.max(0, Math.min(100, Math.floor((input.world ? input.world.residentStates.find((r) => r.id === "cyrene")?.energy : input.energy) ?? current?.energyAfter ?? 70))),
    outfit: chooseOutfit(input, current),
    selfieReason: selfieReason(current),
    visualAnchors: [
      "昔涟本人，粉色系长发与稳定的角色面部特征",
      "单人物、自然表情、清晰脸部和柔和光线",
      "保留现有昔涟视觉形象，不改变人物身份",
    ],
    avoid: [
      "不要出现第二个人物、文字水印、相机 UI 或未授权品牌",
      "不要把虚构世界地点画成现实城市，也不要添加与当前活动冲突的道具",
    ],
    sourceEventId: current?.id ?? "xilian:none",
  };
}

export function formatXilianLifeContext(snapshot: XilianLifeSnapshot): string {
  return [
    snapshot.worldContext ?? "",
    "【昔涟虚拟生活快照】",
    "以下内容属于昔涟所在的虚构世界，只能作为连续性事实，不代表用户现实地点或真实行程。",
    `世界日期：${snapshot.worldDate} ${snapshot.localTime}`,
    `阶段：${snapshot.season}`,
    `地点：${snapshot.location}`,
    `正在做：${snapshot.currentActivity}`,
    `最近完成：${snapshot.recentEvent}`,
    `下一计划：${snapshot.nextPlan}`,
    `心情：${snapshot.mood}`,
    `精力参考：${snapshot.energy}/100（不要直接向用户报告数值）`,
  ].join("\n");
}

export function buildXilianSelfiePrompt(snapshot: XilianLifeSnapshot): string {
  return [
    "生成昔涟在自己的虚构世界里拍摄的一张生活自拍。",
    `时间：${snapshot.worldDate} ${snapshot.localTime}；阶段：${snapshot.season}。`,
    `地点：${snapshot.location}；正在做：${snapshot.currentActivity}。`,
    `她的状态：${snapshot.mood}；服装：${snapshot.outfit}。`,
    `拍摄原因：${snapshot.selfieReason}。`,
    `视觉锚点：${snapshot.visualAnchors.join("；")}。`,
    `避免：${snapshot.avoid.join("；")}。`,
    "画面应自然、单人物、竖构图，像她刚刚拿起设备记录生活的一刻；不要生成文字或相机界面。",
  ].join("\n");
}

export function buildXilianPromptFingerprint(snapshot: XilianLifeSnapshot): string {
  return xilianStableHash(JSON.stringify({
    sourceEventId: snapshot.sourceEventId,
    worldDate: snapshot.worldDate,
    localTime: snapshot.localTime,
    location: snapshot.location,
    currentActivity: snapshot.currentActivity,
    outfit: snapshot.outfit,
  })).toString(16);
}
