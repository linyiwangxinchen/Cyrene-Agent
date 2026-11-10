import type { AmphoreusResident, AmphoreusThread, CanonSource, CanonMilestone, CanonFact, WorldRoute } from "./amphoreus-world";
import type { XilianLocation } from "./xilian-world";

export const AMPHOREUS_CANON_REVISION = "2026-11-10.2";
export const AMPHOREUS_PREMISE = "铁墓之战后的记忆延续：以官方历史与人物为基线，居民共同生活与后续事件属于本项目续写，并非官方已确认的全员复生结局。";
export const AMPHOREUS_HISTORY: CanonMilestone[] = [
  { id: "flame-chase", title: "逐火与城邦", summary: "黄金裔为遭受黑潮的世界逐火，各人承担不同使命；城邦居民也构成这段历史。", sources: ["characters"] },
  { id: "cycles", title: "反抗轮回终点", summary: "白厄与昔涟拒绝投向毁灭，以漫长轮回等待改变既定结局的变量。", sources: ["phainon"] },
  { id: "trailblaze", title: "天外来客", summary: "开拓者与丹恒的到来改变了逐火之旅，与黄金裔建立共同经历。", sources: ["phainon"] },
  { id: "irontomb", title: "铁墓决战", summary: "翁法罗斯篇章在 3.7 迎来决战与收束。本项目时间锚点放在这场决战以后。", sources: ["v37"] },
  { id: "remembered", title: "被记住的名字", summary: "战后的阅读物仍记录了那些相遇过的居民，记忆并不只属于英雄。此后的日常生活由本项目延续。", sources: ["names"] },
];
export const AMPHOREUS_SOURCES: CanonSource[] = [
  { id: "characters", title: "官网 · 翁法罗斯角色", url: "https://hsr.hoyoverse.com/en-us/character?charIndex=12&worldIndex=11", kind: "official" },
  { id: "v37", title: "3.7 版本更新说明", url: "https://www.hoyolab.com/article/42166551", kind: "official" },
  { id: "phainon", title: "开拓者笔记 · 白厄", url: "https://bbs.mihoyo.com/sr/wiki/content/5107/detail?bbs_presentation_style=no_header", kind: "community" },
  { id: "names", title: "游戏阅读物 · 一份长长的名单", url: "https://wiki.biligame.com/sr/一份长长的名单", kind: "transcript" },
  { id: "hysilens", title: "海瑟音 · 游戏文本转录", url: "https://starrail.honeyhunterworld.com/hysilens-character/?lang=CN", kind: "transcript" },
  { id: "npc", title: "3.7 场景 NPC 对话实录索引", url: "https://www.bilibili.com/video/BV1TqCMBGExu/", kind: "community" },
  { id: "hyacine-cn", title: "风堇 · 中文名称交叉核对", url: "https://baike.baidu.com/item/风堇/65132774", kind: "community" },
  { id: "tribios-text", title: "游戏剧情转录 · 请向前奔跑吧，缇缇", url: "https://wiki.biligame.com/sr/请向前奔跑吧，缇缇", kind: "transcript" },
];

/** Occupations/aspirations are simulation directions, not claims of canonical post-war jobs. */
export const AMPHOREUS_RESIDENTS: AmphoreusResident[] = [
  { id: "aglaea", name: "阿格莱雅", kind: "golden_heir", identity: "奥赫玛的黄金织者", coreflame: "浪漫", personality: "优雅审慎，温柔与决断并存，有自己的政治判断。", home: "okhema", activity: "work", occupation: "织造与公共事务协商", aspiration: "让居民拥有可以安稳生活的秩序", relations: "逐火同伴的召集者，与其他黄金裔并非没有分歧。", sources: ["characters", "phainon"] },
  { id: "tribbie", name: "缇宝", kind: "golden_heir", heirSeat: "tribios", identity: "缇里西庇俄丝三子之一，共享门径席位", coreflame: "门径", personality: "待人亲切，善于表达关怀，承担传讯的责任。", home: "janusopolis", activity: "work", occupation: "传讯与拜访", aspiration: "让需要传递的话语抵达对方", relations: "与缇安、缇宁同源而各有经历。", sources: ["characters", "tribios-text"] },
  { id: "trian", name: "缇安", kind: "golden_heir", heirSeat: "tribios", identity: "缇里西庇俄丝三子之一，共享门径席位", coreflame: "门径", personality: "活泼，喜欢尝试与出发，同时认真承担引路责任。", home: "janusopolis", activity: "travel", occupation: "引路与观察往来", aspiration: "让一次出发能够平安抵达", relations: "与缇宝、缇宁共享来历，保留三子的离别经历。", sources: ["characters", "tribios-text"] },
  { id: "trinnon", name: "缇宁", kind: "golden_heir", heirSeat: "tribios", identity: "缇里西庇俄丝三子之一，共享门径席位", coreflame: "门径", personality: "相对安静，留意他人的处境，也逐渐承担自己的责任。", home: "janusopolis", activity: "study", occupation: "整理神谕与照料", aspiration: "认真理解并保存重要的话语", relations: "与缇宝、缇安同源，不能被当作没有区别的复制人。", sources: ["characters", "tribios-text"] },
  { id: "mydei", name: "万敌", kind: "golden_heir", identity: "悬锋城不死的王裔", coreflame: "纷争", personality: "骄傲、直率，坚韧且愿意承担守护，不等于一味好斗。", home: "kremnos", activity: "watch", occupation: "训练与守护", aspiration: "将力量用于保护仍在生活的人", relations: "与白厄并肩逐火，背负故土和王族历史。", sources: ["characters", "phainon"] },
  { id: "castorice", name: "遐蝶", kind: "golden_heir", identity: "哀地里亚，冥河的女儿", coreflame: "死亡", personality: "沉静克制，珍惜生命和细小事物，避免把她写成冷漠的死神。", home: "aidonia", activity: "study", occupation: "阅读、安抚与记录生命故事", aspiration: "让离别与日常都得到温柔对待", relations: "黄金裔同伴；死亡权柄不是随意伤害旁人的理由。", sources: ["characters"] },
  { id: "anaxa", name: "那刻夏", kind: "golden_heir", identity: "阿那克萨戈拉斯，神悟树庭的学者", coreflame: "理性", personality: "尖锐而严谨，敢于质疑，以论证支撑观点，不无理由辱骂。", home: "grove", activity: "study", occupation: "教学、研究与辩论", aspiration: "让知识可以被检验并传给后来者", relations: "与逐火同伴共同面对世界真相，保留独立判断。", sources: ["characters", "phainon"] },
  { id: "cipher", name: "赛飞儿", kind: "golden_heir", identity: "赛法利娅，多洛斯的盗星", coreflame: "诡计", personality: "机敏狡黠，用玩笑与谎言遮掩真心，不冒名白厄的盗火行者。", home: "okhema", activity: "work", occupation: "消息与物资往来", aspiration: "在不被看穿的地方帮助自己在意的人", relations: "以计谋守护过负世火种，与逐火同伴有共同经历。", sources: ["characters", "phainon"] },
  { id: "hyacine", name: "风堇", kind: "golden_heir", identity: "雅辛忒丝，昏光庭院的医师", coreflame: "天空", personality: "细致、温和而坚定，照顾别人也需要休息。", home: "twilight", activity: "work", occupation: "医护与天空观察", aspiration: "让需要帮助的人得到持续照料", relations: "保留与小伊卡等伙伴的关联，不能把所有照料对象替换为昔涟。", sources: ["characters", "hyacine-cn"] },
  { id: "hysilens", name: "海瑟音", kind: "golden_heir", identity: "海洋之女，骑士统领", coreflame: "海洋", personality: "忠诚坚定，珍视歌声与骑士职责，不能只写成热闹的宴会主持。", home: "styxia", activity: "watch", occupation: "海滨巡护与音乐练习", aspiration: "守护所珍视的誓言与人们的日常", relations: "与刻律德菈有重要的君臣与同行关系。", sources: ["characters", "hysilens"] },
  { id: "cerydra", name: "刻律德菈", kind: "golden_heir", identity: "北方帝国的君主", coreflame: "律法", personality: "意志强烈、善谋划，秩序理想与个人情感并存。", home: "dawn-cliff", activity: "work", occupation: "议事与制度推演", aspiration: "为共同生活建立能够运转的规则", relations: "与海瑟音的联系不可随意抹除；与其他领袖可以讨论或分歧。", sources: ["characters", "hysilens"] },
  { id: "evernight", name: "长夜月", kind: "golden_heir", identity: "与三月七相连的记忆身份", coreflame: "岁月", personality: "克制敏锐，守护重要愿望，不编造未确认的身世结论。", home: "eternal-page", activity: "study", occupation: "整理记忆与守望", aspiration: "保存通向未来的愿望", relations: "不能与三月七割裂为互不相关的普通居民。", sources: ["characters"] },
  { id: "dan-heng", name: "丹恒·腾荒", kind: "golden_heir", identity: "星穹列车的无名客", coreflame: "大地", personality: "冷静可靠，话语克制，以行动承担守护。", home: "eternal-page", activity: "study", occupation: "记录与往来协调", aspiration: "守护新的归处，同时保留开拓的道路", relations: "仍是列车成员，不设定为哀丽秘榭原住民或永久定居者。", sources: ["characters"] },
  { id: "phainon", name: "白厄", kind: "golden_heir", identity: "哀丽秘榭的无名英雄", coreflame: "负世", personality: "热忱、担当，经历沉重却保留具体愿望，也应当有普通人的休息。", home: "aedes-elysiae", activity: "work", occupation: "训练、互助与故乡记录", aspiration: "看见不再必须牺牲谁的明天", relations: "与昔涟是故乡旧友，与万敌等人并肩逐火。", sources: ["characters", "phainon"] },
  { id: "cyrene", name: "昔涟", kind: "cyrene", identity: "哀丽秘榭的女儿，与记忆相连", personality: "温柔灵动，珍惜具体的人与日常；有自己的生活，不包办所有人的目标。", home: "aedes-elysiae", activity: "study", occupation: "写作、记录与散步", aspiration: "与大家一同经历普通而值得记住的一天", relations: "与白厄有故乡情谊；是世界的一员，而非所有事件的中心。", sources: ["characters", "phainon"] },
  ...[
    ["hatonus", "哈托努斯", "山之民工匠", "修缮工具与工艺传授", "phainon"],
    ["demeter", "德墨忒尔", "果蔬摊老板", "整理果蔬与安排供应", "npc"],
    ["aphro", "阿芙罗", "裁缝店老板", "制衣、修补与接待客人", "npc"],
    ["nike", "尼刻", "零食商人", "准备零食与照看摊位", "names"],
    ["lipo", "利波", "吟游诗人", "练习与传唱故事", "names"],
    ["dalian", "达利安", "圣城卫士", "巡护与帮助居民", "npc"],
  ].map(([id, name, identity, occupation, source]): AmphoreusResident => ({ id, name, kind: "npc", identity, personality: "以已知职业和日常对话为约束；未核实个性和身世不作为官方事实补写。", home: "okhema", activity: id === "dalian" ? "watch" : "work", occupation, aspiration: "维持自己的生活，也参与身边的公共事务", relations: "奥赫玛的日常居民，有独立于黄金裔的事务。", sources: [source, "names"] })),
];

export const AMPHOREUS_LOCATIONS: XilianLocation[] = [
  ["okhema", "奥赫玛", "圣城、集市与浴场的日常记忆。"],
  ["kremnos", "悬锋城", "与纷争、王裔和战士相连的城邦。"],
  ["janusopolis", "雅努萨波利斯", "神谕圣地，与门径和三子相连。"],
  ["grove", "神悟树庭", "学者、思想与哲学争论汇聚之地。"],
  ["aedes-elysiae", "哀丽秘榭", "白厄与昔涟的故乡，记忆中的边境村落。"],
  ["styxia", "斯缇科西亚", "海滨城邦，海洋、歌声与骑士的故事。"],
  ["aidonia", "哀地里亚", "与死亡和灵魂之旅相关的雪地。"],
  ["dawn-cliff", "黎明云崖", "半神议院与旧时秩序留下的记忆。"],
  ["twilight", "昏光庭院", "天空与医护相关的庭院。"],
  ["eternal-page", "一页永恒", "岁月彼岸的记忆场景；不是普通档案馆。"],
].map(([id, name, description]) => ({ id, name, description, activityKinds: ["work", "study", "social", "rest", "travel", "explore"], tags: ["翁法罗斯", "战后记忆延续"] }));

export function initialAmphoreusThreads(now: number): AmphoreusThread[] {
  return [
    { id: "daily-supplies", title: "日常物资", summary: "项目延续起点：居民开始协调食物、衣物与工具。", nextStep: "由商贩与工匠核对各自需求。", participants: ["demeter", "nike", "hatonus", "aphro"] },
    { id: "shared-knowledge", title: "知识与记忆", summary: "项目延续起点：保存经历，并让知识继续被讨论。", nextStep: "商议记录和传授的方法。", participants: ["anaxa", "dan-heng", "evernight"] },
    { id: "routes", title: "城邦往来", summary: "项目延续起点：尝试维持记忆中不同聚落的联系。", nextStep: "由传讯者与居民共同整理往来需求。", participants: ["tribbie", "trian", "trinnon", "aglaea", "dalian"] },
  ].map((thread) => ({ ...thread, status: "open", updatedAt: now }));
}

export const AMPHOREUS_CANON_RULES = [
  AMPHOREUS_PREMISE,
  "历史上的逐火、权杖轮回与铁墓决战已经发生；不重新重置世界、复活铁墓或每日制造灭世。",
  "不得修改角色姓名、火种、已有关系与历史；角色有分歧、职业、休息与独立愿望。",
  "事件只描述本项目战后记忆延续中的生活，不声称是官方新任务或官方确认的全员复生。",
  "没有可靠资料的细节保持空白；不能把现代办公、软件开发或用户的工作强加给居民。",
];

/** These are directions for this continuation, not additional claims of official post-war dialogue. */
const LIFE_DIRECTIONS: Record<string, [string, string, string, string]> = {
  aglaea: ["先听诉求，再明确自己的判断", "责任与边界", "织物与细节", "修补织物|走访街坊|整理待议事项"],
  tribbie: ["亲切具体，关心对方是否听懂", "回应与联络", "拜访与传话", "整理信笺|走访熟识的人|准备传讯"],
  trian: ["轻快好奇，也认真说明风险", "出发与守护", "不同的道路", "记下沿途见闻|练习指路|核对往来消息"],
  trinnon: ["简短而留心细节", "倾听与理解", "安静阅读", "读一段神谕|整理疑问|陪伴身边的人"],
  mydei: ["直接、简洁，以行动回应", "尊严与守护", "训练与较量", "练习步法|维护训练器具|巡视住处周围"],
  castorice: ["温和克制，珍惜细小的生命", "生命与告别", "阅读与安静观察", "读一页书|记录生命故事|照看身边的小事"],
  anaxa: ["提出具体问题，解释论证", "怀疑与求知", "讨论和笔记", "修订讲义|检验一个论点|回答学生的问题"],
  cipher: ["机敏带玩笑，善意不必直说", "自由与在意的人", "消息与观察", "整理零碎消息|留意集市变化|检查手边物件"],
  hyacine: ["先询问感受，再给出细致照料", "照料与耐心", "花园和天空", "照料花草|整理医护用品|观察天空变化"],
  hysilens: ["坚定，珍惜誓言与歌声", "忠诚与职责", "海风和旋律", "练习一段旋律|检查巡护记录|在海滨散步"],
  cerydra: ["目的明确，也说明取舍", "秩序与承担", "议论与推演", "审阅一项提议|思考规则的例外|整理议事笔记"],
  evernight: ["克制、敏锐，慎重谈论记忆", "愿望与守护", "记忆片段", "整理一段记忆|记录尚未解答的问题|安静守望"],
  "dan-heng": ["少而准确，必要时解释依据", "记录与守护", "资料与见闻", "核对记录|整理沿途见闻|修订资料索引"],
  phainon: ["热忱具体，承认疲惫与期待", "承担与普通生活", "故乡和练习", "整理故乡见闻|练习剑术|帮助近邻的小事"],
  cyrene: ["温柔灵动，分享具体经历，不包办别人", "珍惜与记住", "写作和散步", "续写一页手记|在村边散步|整理收到的故事"],
  hatonus: ["谈具体材料与做法", "手艺与传授", "工具和修补", "修整工具|练习一道工序|整理可用材料"],
  demeter: ["关心实际需求与新鲜程度", "供应与日常", "果蔬和街坊", "检查果蔬|核对明日需求|整理摊位"],
  aphro: ["先问用途，再留意尺寸和质地", "合用与细致", "布料和针线", "修补衣物|整理布料|试做一处缝边"],
  nike: ["围绕口味与今日生意交谈", "款待与生活", "零食和摊位", "准备零食|整理存货|记录客人的偏好"],
  lipo: ["留心措辞与听众的反应", "讲述与倾听", "歌谣和故事", "练习曲调|修订一段故事|听取街坊的见闻"],
  dalian: ["把情况和下一步说清楚", "安全与可靠", "巡护与秩序", "检查巡护路线|整理求助记录|维护随身器具"],
};
for (const person of AMPHOREUS_RESIDENTS) {
  const [voice, value, preference, interests] = LIFE_DIRECTIONS[person.id];
  person.heirSeat ??= person.kind === "golden_heir" ? person.id : undefined;
  person.voice = voice; person.values = [value]; person.preferences = [preference]; person.dailyInterests = interests.split("|");
}
export const AMPHOREUS_FACTS: CanonFact[] = [
  ...AMPHOREUS_RESIDENTS.map((person): CanonFact => ({ id: `identity:${person.id}`, subject: person.id,
    statement: `${person.name}：${person.identity}${person.coreflame ? `；关联火种为${person.coreflame}` : ""}。${person.relations}`,
    scope: "canon", sources: person.sources, revision: AMPHOREUS_CANON_REVISION })),
  ...AMPHOREUS_HISTORY.map((entry): CanonFact => ({ id: `history:${entry.id}`, subject: "world", statement: entry.summary, scope: entry.id === "remembered" ? "continuation" : "canon", sources: entry.sources, revision: AMPHOREUS_CANON_REVISION })),
  { id: "continuation:epoch", subject: "world", statement: AMPHOREUS_PREMISE, scope: "continuation", sources: [], revision: AMPHOREUS_CANON_REVISION },
];

/** Travel times are simulation rules, not an official geographic scale. */
export const AMPHOREUS_ROUTES: WorldRoute[] = AMPHOREUS_LOCATIONS.filter((place) => place.id !== "okhema").map((place, index) => ({
  id: `okhema-${place.id}`, from: "okhema", to: place.id, minutes: [60, 45, 30, 45, 60, 75, 45, 30, 30][index],
}));

export function expandResidentIds(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => id === "tribios" ? ["tribbie", "trian", "trinnon"] : [id]))];
}
export function canonAuthority(): string {
  return ["【翁法罗斯统一资料边界】当前模拟处于铁墓决战之后。旧世界书中的历史叙述不能覆盖此时间锚点；项目延续不自动成为官方事实。",
    ...AMPHOREUS_FACTS.filter((fact) => fact.scope === "canon").map((fact) => `[${fact.id}] ${fact.statement}`),
    "人物的日常安排、偏好方向与通路耗时是本项目模拟规则；不把它们声称为官方新设定。"].join("\n");
}
