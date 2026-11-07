import {
  getXilianLocation,
  XILIAN_LOCATIONS,
  XILIAN_TIME_BLOCKS,
  type XilianLifeGoal,
  type XilianTimelineEvent,
  type XilianTimeBlock,
  type XilianWorldActivityKind,
  type XilianWorldArcId,
  type XilianWorldState,
} from "../../shared/xilian-world";

export interface XilianCompanionSignals {
  energy: number;
  curiosity: number;
  boredom: number;
}

export interface XilianScheduleInput {
  state: XilianWorldState;
  timeline: readonly XilianTimelineEvent[];
  now: number;
  timezone: string;
  companion?: XilianCompanionSignals;
}

export interface XilianScheduleResult {
  state: XilianWorldState;
  events: XilianTimelineEvent[];
  changed: boolean;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DEFAULT_SIGNALS: XilianCompanionSignals = { energy: 70, curiosity: 50, boredom: 20 };

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
  } catch {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
  }
}

export function getXilianDateKey(date: Date, timezone: string): string {
  const parts = getZonedDateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localMinute(parts: ZonedDateParts): number {
  return parts.hour * 60 + parts.minute;
}

/** Stable non-cryptographic hash for a day's deterministic schedule. */
export function xilianStableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

export function getXilianSeasonId(dayIndex: number): string {
  if (dayIndex <= 14) return "first-light";
  if (dayIndex <= 30) return "echo-tide";
  return "far-voyage";
}

function blockContains(block: XilianTimeBlock, minute: number): boolean {
  if (block.id === "quiet") return minute >= block.startMinute && minute < block.endMinute;
  return minute >= block.startMinute && minute < block.endMinute;
}

function shouldMaterialize(block: XilianTimeBlock, minute: number): boolean {
  // Quiet time is the first block of the local day. At 23:00 the night block
  // carries the state until midnight; the next quiet event belongs to tomorrow.
  if (block.id === "quiet") return minute < block.endMinute;
  return minute >= block.startMinute;
}

export function getCurrentXilianTimeBlock(minute: number): XilianTimeBlock | undefined {
  return XILIAN_TIME_BLOCKS.find((block) => blockContains(block, minute));
}

function chooseActivityKind(block: XilianTimeBlock, signals: XilianCompanionSignals, seed: string): XilianWorldActivityKind {
  const allowed = [...block.activityKinds];
  if (signals.energy < 30 && block.id !== "quiet" && block.id !== "noon") {
    const rest = allowed.includes("rest") ? "rest" : undefined;
    if (rest) return rest;
  }
  if (signals.boredom >= 65) {
    if (allowed.includes("game")) return "game";
    if (allowed.includes("explore")) return "explore";
    if (allowed.includes("social")) return "social";
  }
  const index = xilianStableHash(seed) % Math.max(1, allowed.length);
  return allowed[index] ?? "rest";
}

function chooseLocation(kind: XilianWorldActivityKind, seed: string): string {
  const candidates = XILIAN_LOCATIONS.filter((location) => location.activityKinds.includes(kind));
  if (!candidates.length) return "prologue-city";
  return candidates[xilianStableHash(seed) % candidates.length]!.id;
}

function goalForActivity(kind: XilianWorldActivityKind): string | undefined {
  if (kind === "work" || kind === "maintenance") return "light-maintenance";
  if (kind === "game") return "memory-game";
  if (kind === "study" || kind === "explore" || kind === "travel") return "echo-mapping";
  return undefined;
}

interface XilianLifeScene {
  title: string;
  detail: string;
  summary: string;
  outcome: string;
  diary: string;
  mood: string;
  participants?: string[];
  tags: string[];
}

const LIFE_SCENES: Readonly<Record<XilianWorldActivityKind, readonly XilianLifeScene[]>> = Object.freeze({
  work: [
    { title: "整理星砂样本", detail: "把昨天晒好的星砂分装进三只小瓶，逐一写上日期和重量。", summary: "三只样本瓶排在桌边，标签终于全部贴正了。", outcome: "样本归档完成，明早可以直接开始对照。", diary: "今天的工作很细，但不讨厌。三只小瓶排成一排的时候，我突然觉得桌面变得很可靠。", mood: "专注而踏实", tags: ["工作", "整理", "星砂"] },
    { title: "补好排班表", detail: "把星炉台的值守时间重新抄了一遍，还给缺角的木夹换了新绳。", summary: "新的排班表挂在门边，翻页时不会再被风吹落。", outcome: "明天的值守安排已经交给岚栖。", diary: "排班表比想象中难抄，最后一行总是歪掉。好在木夹换好以后，它终于能稳稳地待在门边。", mood: "平静而满足", participants: ["岚栖"], tags: ["工作", "修补", "星炉"] },
    { title: "找回账本的一页", detail: "把渡桥集带回来的账本按颜色重新归好，终于在旧地图夹层里找到缺的那一页。", summary: "账本恢复完整，墨水没有被潮气晕开。", outcome: "这一周的物资记录可以继续核对。", diary: "我找了半个下午的那一页，原来一直夹在旧地图里。找到它的时候没有大声庆祝，只是很轻地松了口气。", mood: "松了一口气", tags: ["工作", "账本", "渡桥集"] },
  ],
  study: [
    { title: "读完《潮汐与钟》", detail: "和岚栖一起读完第七页，书页中间夹着一片已经干透的银叶。", summary: "第七页读完了，银叶被放进了书签夹。", outcome: "两个人约好明天继续读下一页。", diary: "岚栖读得比我快，我只好按住书角追上她。银叶掉出来时，我们都笑了一下，后来把它夹回了书里。", mood: "安静而亲近", participants: ["岚栖"], tags: ["阅读", "档案", "银叶"] },
    { title: "读完旧居民册", detail: "逐页读完旧居民登记册，把已经搬走的住户和仍在城里的人分开标注。", summary: "登记册的最后一页有一枚褪色的圆章。", outcome: "档案柜的索引顺序被重新整理。", diary: "我读完那本很厚的登记册，手指都沾上了纸灰。最后一页的圆章很淡，但我还是把它擦干净了。", mood: "沉静而认真", tags: ["阅读", "居民", "档案"] },
    { title: "读一封没有寄出的信", detail: "把抽屉里那封没有寄出的信读到最后，再按原来的折痕放回信封。", summary: "信纸没有被重新改写，抽屉也恢复了原样。", outcome: "她决定暂时保留这封信，不替写信的人做决定。", diary: "今天读到一封没有寄出的信。读完以后我没有急着替它找结局，只把信纸按原来的折痕放回去。", mood: "温柔而克制", tags: ["阅读", "信件", "选择"] },
  ],
  game: [
    { title: "赢下第三局记忆棋盘", detail: "在回声场和迭洛玩了三局记忆棋盘，第三局从侧边的小路绕开了他的防守。", summary: "第三局赢得很险，迭洛把最后一枚棋子推回盒子里。", outcome: "她学会了先留一条退路再进攻。", diary: "迭洛说我今天终于学会了留后手。其实我只是记住了他前两局总会先看左上角。", mood: "开心而得意", participants: ["迭洛"], tags: ["游戏", "棋盘", "胜利"] },
    { title: "和澄音玩颜色配对", detail: "和澄音玩颜色配对，前两局都把相近的蓝色认错，第三局终于一次配对成功。", summary: "桌上的蓝色卡片被分成了三组，最浅的那张留在中间。", outcome: "她把最喜欢的蓝色卡片送给了澄音。", diary: "我还是分不清两种很像的蓝色。澄音没有笑我，最后还把最浅的那张留给了我。", mood: "轻快而开心", participants: ["澄音"], tags: ["游戏", "颜色", "陪伴"] },
    { title: "独自完成小谜题", detail: "一个人完成回声场的木格谜题，中途数了三遍窗格才找到正确的起点。", summary: "最后一块木片嵌进去时，整面棋盘亮了一下。", outcome: "她发现数窗格是自己紧张时最有效的办法。", diary: "今天一个人解谜，卡住的时候我数了三遍窗格。答案出现时没有声音，但我还是对着棋盘点了点头。", mood: "专注而满足", tags: ["游戏", "解谜", "习惯"] },
  ],
  rest: [
    { title: "泡一壶薄荷茶", detail: "在静海庭泡好薄荷茶，听完一面旧唱片，中途靠在椅背上睡了十分钟。", summary: "茶还温着，唱片刚好停在最后一小节。", outcome: "她的肩膀不再像上午那样紧。", diary: "下午睡着了十分钟，醒来时茶还温着。没有错过什么，反而觉得这一段时间被好好收下了。", mood: "放松而柔软", tags: ["休息", "茶", "唱片"] },
    { title: "烘干湿袖口", detail: "把被雨打湿的袖口放到炉边烘干，顺手给窗台上的植物换了水。", summary: "袖口干了，叶片也重新挺起来。", outcome: "她把雨伞收好，明天仍然会带上它。", diary: "雨把袖口弄湿了。我把它放在炉边，给窗台的植物换了水。两件小事都慢慢恢复了原样。", mood: "安静而踏实", tags: ["休息", "雨天", "植物"] },
    { title: "写下三件小事", detail: "在静海庭写下今天已经做完的三件小事，把笔扣好后坐在窗边看了一会儿天色。", summary: "便签上只有三行字，但每一行都是真实完成的事。", outcome: "她决定今晚不再给自己增加新的安排。", diary: "今天只写了三行日记：样本、茶、还有把湿袖口烘干。三行已经够了，晚上不再给自己安排新的事。", mood: "平稳而知足", tags: ["休息", "日记", "自我照顾"] },
  ],
  explore: [
    { title: "走到南侧台阶尽头", detail: "沿远观台南侧的台阶走到底，看见远处浮桥亮了两次，随后恢复成原来的亮度。", summary: "南侧台阶尽头的风比上面大，浮桥的灯已经恢复稳定。", outcome: "她把这次散步的路线画进了新观察册。", diary: "今天走到了远观台南侧的尽头。风很大，浮桥亮了两次又安静下来，我站了一会儿才回去。", mood: "清醒而开阔", tags: ["散步", "远观台", "风"] },
    { title: "挑到一枚旧铜扣", detail: "在渡桥集翻了三个摊位，最后挑到一枚刻着小船纹样的旧铜扣。", summary: "铜扣上有一道磨痕，但小船纹样仍然清楚。", outcome: "她把铜扣放进自己的小盒子，准备以后配到旧外套上。", diary: "我在渡桥集挑了很久，最后买下一枚旧铜扣。它有点磨损，但小船的纹样还在，我很喜欢。", mood: "好奇而愉快", tags: ["散步", "集市", "收藏"] },
    { title: "找到晒书的平石头", detail: "沿城墙外绕了一圈，找到一块下午会晒到太阳的平石头，大小刚好能放下两本书。", summary: "平石头旁边有一小簇白色野花，明天可以带书过去。", outcome: "她在地图上画了一个小圆点作为记号。", diary: "城墙外有一块很平的石头，下午的太阳会照到它。我已经想好明天带哪两本书过去了。", mood: "期待而轻快", tags: ["散步", "城墙", "阅读"] },
  ],
  social: [
    { title: "和岚栖分吃栗子饼", detail: "和岚栖分吃一块刚出炉的栗子饼，替她把借阅册送回序页城的架子上。", summary: "栗子饼只剩最后一小块，借阅册也回到了正确的位置。", outcome: "岚栖把明天要读的书放到了桌角。", diary: "岚栖分给我半块栗子饼，我替她把借阅册放回架子。我们没有谈很大的事情，但下午因此变得很好。", mood: "亲近而温暖", participants: ["岚栖"], tags: ["相处", "栗子饼", "序页城"] },
    { title: "帮阿沅挑修伞的线", detail: "在渡桥集帮阿沅从六种蓝线里挑出最耐水的一种，回程时收到一个热果子。", summary: "那卷蓝线在灯下呈现出很细的银光。", outcome: "阿沅今晚可以把伞骨重新缝好。", diary: "阿沅让我帮她挑修伞的线。我选了最耐水的那种，她送我一个热果子，捧在手里一路都没有凉。", mood: "热闹而满足", participants: ["阿沅"], tags: ["相处", "集市", "修伞"] },
    { title: "和澄音交换歌单", detail: "在静海庭和澄音交换歌单，她把一首很慢的歌标成了“下雨也能听”。", summary: "两张歌单重合了四首歌，最慢的那首被写上了新名字。", outcome: "她们约好下雨时一起听完那首歌。", diary: "澄音给我听了一首很慢的歌，我把它标成‘下雨也能听’。我们约好下一场雨一起把它听完。", mood: "柔和而有期待", participants: ["澄音"], tags: ["相处", "音乐", "约定"] },
  ],
  maintenance: [
    { title: "拧紧星炉西侧铜环", detail: "把星炉台西侧松掉的铜环拧紧，连续做了三次测试，灯光终于稳定下来。", summary: "第三次测试结束后，西侧灯光没有再闪烁。", outcome: "星炉台今晚可以照常工作。", diary: "西侧铜环比看起来难拧，手指都被磨红了。第三次测试以后灯光稳定下来，我终于愿意坐下喝水。", mood: "疲惫而有成就感", tags: ["维护", "星炉台", "完成"] },
    { title: "补齐回声场棋子", detail: "给回声场的棋盘补齐缺失的木片，把散落的棋子按颜色装回盒子。", summary: "棋盒现在能完整装下三套棋子，明天可以直接开始。", outcome: "迭洛答应下次不再把棋子带到台阶上。", diary: "我把回声场的棋子一枚枚捡回来，补好最后一块木片。迭洛答应下次不会再把它们带到台阶上。", mood: "专注而轻松", participants: ["迭洛"], tags: ["维护", "棋盘", "整理"] },
    { title: "修好静海庭门闩", detail: "修好静海庭门口总会卡住的门闩，开关时终于不再发出刺耳的响声。", summary: "门闩可以顺畅地落下，晚风也不会把门吹开。", outcome: "澄音说今晚的庭院安静了很多。", diary: "静海庭的门闩终于不响了。澄音推门进来时说，连风都像变轻了一点。", mood: "平静而温柔", participants: ["澄音"], tags: ["维护", "门闩", "静海庭"] },
  ],
  travel: [
    { title: "带回一卷耐水纸", detail: "从渡桥集带回一卷耐水纸，准备给远观台做新的观察册。", summary: "纸卷没有被雨水打湿，放在桌边正好够做一本册子。", outcome: "新的观察册明天可以开始装订。", diary: "今天带回一卷耐水纸。它比普通纸重一点，但不怕雨，正适合放在远观台。", mood: "期待而踏实", tags: ["往返", "纸张", "观察"] },
    { title: "把地图送到星炉台", detail: "把序页城借来的地图送到星炉台，沿桥走了一小段才回来。", summary: "地图平整地交到了值守桌上，边角没有折痕。", outcome: "明天可以按地图上的旧路线检查灯点。", diary: "我把地图送到星炉台，回来的时候没有走最快的路。桥上的风很好，地图也没有被吹皱。", mood: "从容而清醒", tags: ["往返", "地图", "星炉台"] },
    { title: "带回一枚白色石子", detail: "从远观台回到静海庭时捡到一枚白色石子，把它放进自己的小盒子里。", summary: "石子很小，表面有一道像月牙的灰纹。", outcome: "小盒子里又多了一件属于今天的东西。", diary: "回静海庭的路上捡到一枚白色石子。它有一道月牙一样的灰纹，我把它放进小盒子里了。", mood: "安静而珍惜", tags: ["往返", "收藏", "静海庭"] },
  ],
});

function chooseScene(kind: XilianWorldActivityKind, seed: string): XilianLifeScene {
  const scenes = LIFE_SCENES[kind];
  return scenes[xilianStableHash(seed) % scenes.length] ?? scenes[0]!;
}

function eventTimestamp(now: number, parts: ZonedDateParts, block: XilianTimeBlock): number {
  const current = localMinute(parts);
  const elapsed = Math.max(0, current - block.startMinute);
  return now - elapsed * 60_000;
}

function eventVisibility(kind: XilianWorldActivityKind, status: XilianTimelineEvent["status"]): XilianTimelineEvent["visibility"] {
  if (status === "active") return "private";
  if (kind === "rest") return "private";
  return "shareable";
}

function makeEvent(
  input: XilianScheduleInput,
  block: XilianTimeBlock,
  parts: ZonedDateParts,
  signals: XilianCompanionSignals,
  existing?: XilianTimelineEvent,
): XilianTimelineEvent {
  const dateKey = getXilianDateKey(new Date(input.now), input.timezone);
  const minute = localMinute(parts);
  const active = blockContains(block, minute);
  const status: XilianTimelineEvent["status"] = active ? "active" : "completed";
  const kind = chooseActivityKind(block, signals, `${dateKey}:${input.state.dayIndex}:${block.id}:${input.state.activeArcId}`);
  const locationId = chooseLocation(kind, `${dateKey}:${input.state.dayIndex}:${block.id}:${kind}`);
  const location = getXilianLocation(locationId) ?? XILIAN_LOCATIONS[0]!;
  const scene = chooseScene(kind, `${dateKey}:${input.state.dayIndex}:${block.id}:${locationId}:${kind}`);
  const goalId = goalForActivity(kind);
  const energyCost = kind === "rest" ? -4 : kind === "game" || kind === "social" ? 2 : 7;
  const candidate: XilianTimelineEvent = {
    id: `xilian:${dateKey}:${block.id}`,
    dateKey,
    slotId: block.id,
    occurredAt: eventTimestamp(input.now, parts, block),
    locationId: location.id,
    activityKind: kind,
    activityTitle: scene.title,
    summary: scene.summary,
    detail: scene.detail,
    outcome: scene.outcome,
    diaryText: scene.diary,
    ...(scene.participants ? { participants: scene.participants } : {}),
    memoryTags: scene.tags,
    mood: scene.mood,
    energyAfter: clamp(signals.energy - energyCost),
    ...(goalId ? { goalId } : {}),
    status,
    visibility: eventVisibility(kind, status),
    source: "simulated_world",
  };
  if (!existing) return candidate;
  // Terminal state wins if the clock is moved backwards after a restart.
  const terminalStatus = existing.status === "completed" || existing.status === "interrupted" ? existing.status : candidate.status;
  const legacyContent = !existing.diaryText || !existing.detail;
  if (legacyContent) {
    return {
      ...candidate,
      status: terminalStatus,
      visibility: existing.visibility === "shared" ? "shared" : eventVisibility(candidate.activityKind, terminalStatus),
      occurredAt: existing.occurredAt,
      previousEventId: existing.previousEventId,
      nextEventId: existing.nextEventId,
    };
  }
  return {
    ...candidate,
    ...existing,
    status: terminalStatus,
    visibility: existing.visibility === "shared" ? "shared" : eventVisibility(candidate.activityKind, terminalStatus),
    occurredAt: existing.occurredAt,
    previousEventId: existing.previousEventId,
    nextEventId: existing.nextEventId,
  };
}

function updateGoals(
  goals: readonly XilianLifeGoal[],
  events: readonly XilianTimelineEvent[],
  newlyCompleted: readonly XilianTimelineEvent[],
  now: number,
): XilianLifeGoal[] {
  const increment = new Map<string, number>();
  for (const event of newlyCompleted) if (event.goalId) increment.set(event.goalId, (increment.get(event.goalId) ?? 0) + 1);
  return goals.map((goal) => {
    const progress = Math.min(goal.target, goal.progress + (increment.get(goal.id) ?? 0));
    const stage = progress >= goal.target ? "completed" : goal.stage === "completed" ? "completed" : goal.stage;
    return { ...goal, progress, stage, updatedAt: increment.has(goal.id) ? now : goal.updatedAt };
  });
}

function activeArcForGoals(goals: readonly XilianLifeGoal[]): XilianWorldArcId {
  const lighting = goals.find((goal) => goal.id === "light-maintenance");
  const echo = goals.find((goal) => goal.id === "echo-mapping");
  if (lighting?.stage === "completed" && echo?.stage === "completed") return "voyage";
  if (lighting?.stage === "completed") return "echo";
  return "lighting";
}

function nextPlannedEvent(input: XilianScheduleInput, block: XilianTimeBlock, parts: ZonedDateParts, signals: XilianCompanionSignals, previousEventId?: string): XilianTimelineEvent {
  const dateKey = getXilianDateKey(new Date(input.now), input.timezone);
  const kind = chooseActivityKind(block, signals, `${dateKey}:${input.state.dayIndex}:${block.id}:${input.state.activeArcId}`);
  const locationId = chooseLocation(kind, `${dateKey}:${input.state.dayIndex}:${block.id}:${kind}`);
  const location = getXilianLocation(locationId) ?? XILIAN_LOCATIONS[0]!;
  const scene = chooseScene(kind, `${dateKey}:${input.state.dayIndex}:${block.id}:${locationId}:${kind}`);
  return {
    id: `xilian:${dateKey}:${block.id}`,
    dateKey,
    slotId: block.id,
    occurredAt: input.now + Math.max(0, block.startMinute - localMinute(parts)) * 60_000,
    locationId: location.id,
    activityKind: kind,
    activityTitle: scene.title,
    summary: scene.summary,
    detail: scene.detail,
    outcome: scene.outcome,
    diaryText: scene.diary,
    ...(scene.participants ? { participants: scene.participants } : {}),
    memoryTags: scene.tags,
    mood: scene.mood,
    energyAfter: clamp(signals.energy - (kind === "rest" ? -4 : 7)),
    ...(goalForActivity(kind) ? { goalId: goalForActivity(kind) } : {}),
    status: "planned",
    visibility: "private",
    source: "simulated_world",
    ...(previousEventId ? { previousEventId } : {}),
  };
}

function eventEqual(a: XilianTimelineEvent | undefined, b: XilianTimelineEvent): boolean {
  return Boolean(a && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * Pure日程归一化：只根据固定时钟、世界状态和短期信号生成事件。
 * 不调用模型，也不写文件；持久化和去重由 XilianWorldStore 负责。
 */
export function reconcileXilianWorld(input: XilianScheduleInput): XilianScheduleResult {
  const signals = input.companion ?? DEFAULT_SIGNALS;
  const parts = getZonedDateParts(new Date(input.now), input.timezone);
  const dateKey = getXilianDateKey(new Date(input.now), input.timezone);
  const minute = localMinute(parts);
  const dayAdvance = input.state.worldDate === dateKey ? 0 : daysBetween(input.state.worldDate, dateKey);
  const nextDayIndex = input.state.worldDate === dateKey ? input.state.dayIndex : input.state.dayIndex + Math.max(1, dayAdvance);
  const stateBase: XilianWorldState = {
    ...input.state,
    worldDate: dateKey,
    dayIndex: nextDayIndex,
    seasonId: getXilianSeasonId(nextDayIndex),
    currentActivity: undefined,
    nextPlannedEvent: undefined,
  };
  const existingById = new Map(input.timeline.map((event) => [event.id, event]));
  const changedEvents: XilianTimelineEvent[] = [];
  const newlyCompleted: XilianTimelineEvent[] = [];
  const materialized: XilianTimelineEvent[] = [];

  for (const block of XILIAN_TIME_BLOCKS) {
    if (!shouldMaterialize(block, minute)) continue;
    const existing = existingById.get(`xilian:${dateKey}:${block.id}`);
    const event = makeEvent({ ...input, state: stateBase }, block, parts, signals, existing);
    materialized.push(event);
    if (!eventEqual(existing, event)) changedEvents.push(event);
    if (event.status === "completed" && existing?.status !== "completed" && existing?.status !== "interrupted") newlyCompleted.push(event);
  }

  const currentBlock = getCurrentXilianTimeBlock(minute);
  const current = currentBlock ? materialized.find((event) => event.slotId === currentBlock.id) : undefined;
  const previous = materialized.at(-1);
  const nextBlock = currentBlock
    ? XILIAN_TIME_BLOCKS.find((block) => block.startMinute > currentBlock.startMinute && block.startMinute > minute)
    : XILIAN_TIME_BLOCKS.find((block) => block.startMinute > minute);
  const goals = updateGoals(input.state.goals, [...input.timeline, ...changedEvents], newlyCompleted, input.now);
  const state: XilianWorldState = {
    ...stateBase,
    currentLocationId: current?.locationId ?? previous?.locationId ?? input.state.currentLocationId,
    ...(current ? { currentActivity: current } : previous ? { currentActivity: previous } : {}),
    ...(nextBlock ? { nextPlannedEvent: nextPlannedEvent({ ...input, state: { ...stateBase, goals } }, nextBlock, parts, signals, current?.id ?? previous?.id) } : {}),
    goals,
    activeArcId: activeArcForGoals(goals),
    recentEventIds: [...new Set([...input.state.recentEventIds, ...materialized.map((event) => event.id)])].slice(-24),
    revision: input.state.revision + (dateKey !== input.state.worldDate || changedEvents.length > 0 || newlyCompleted.length > 0 ? 1 : 0),
  };
  const changed = dateKey !== input.state.worldDate
    || state.seasonId !== input.state.seasonId
    || state.dayIndex !== input.state.dayIndex
    || state.currentLocationId !== input.state.currentLocationId
    || state.activeArcId !== input.state.activeArcId
    || JSON.stringify(state.goals) !== JSON.stringify(input.state.goals)
    || JSON.stringify(state.currentActivity) !== JSON.stringify(input.state.currentActivity)
    || JSON.stringify(state.nextPlannedEvent) !== JSON.stringify(input.state.nextPlannedEvent)
    || changedEvents.length > 0;
  return { state, events: changedEvents, changed };
}
