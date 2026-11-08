// 内置表情包的语义描述
// 每个表情包对应一个 phrases 数组，用于文本匹配 + 发送给 LLM（用户发贴纸时转成自然语言）

export interface StickerDescription {
  /** 相近语句（描述情绪/适用场景） */
  phrases: string[];
}

export const BUILT_IN_STICKER_DESCRIPTIONS: Record<string, StickerDescription> = {
  "wait-a-sec": { phrases: ["等一下嘛", "马上就好，请稍等"] },
  "on-my-way": { phrases: ["我马上来", "正在赶来见你"] },
  "got-it": { phrases: ["收到，明白啦", "交给我就好"] },
  "thank-you-heart": { phrases: ["谢谢你，真的很开心", "谢谢你的心意"] },
  "you-can-do-it": { phrases: ["你一定可以的", "我相信你，加油"] },
  "good-job": { phrases: ["做得漂亮", "这次完成得很好"] },
  "sorry-hug": { phrases: ["抱歉，抱抱你", "别难过，是我不好"] },
  "no-no": { phrases: ["不可以哦", "这个不行，别闹啦"] },
  "dont-panic": { phrases: ["别慌，我在这里", "先冷静一下，慢慢来"] },
  "snack-time": { phrases: ["吃点小零食吧", "补充一点能量"] },
  "coffee-break": { phrases: ["休息一下喝杯咖啡", "忙累了，歇一会儿"] },
  "night-night-hug": { phrases: ["晚安，抱着睡吧", "今晚也陪你入梦"] },
  "miss-you-heart": { phrases: ["想你了", "一直在想你"] },
  celebrate: { phrases: ["庆祝一下", "太棒了，撒花"] },
  sparkle: { phrases: ["闪闪发光吧", "给你一点魔法和好运"] },
  "shy-love": { phrases: ["这个礼物给你", "偷偷喜欢你一下"] },
  "pat-pat": { phrases: ["摸摸头，辛苦啦", "乖乖，给你摸摸"] },
  "hug-me": { phrases: ["想要一个拥抱", "给我一个抱抱"] },
  "welcome-home": { phrases: ["欢迎回来", "回来啦，等你好久了"] },
  "cheer-up": { phrases: ["加油加油", "我会为你打气"] },
  "drink-water": { phrases: ["记得喝水", "先喝口水休息一下"] },
  "rest-well": { phrases: ["好好休息", "困了就睡一会儿"] },
  wow: { phrases: ["哇，好厉害", "被惊艳到了"] },
  sorry: { phrases: ["对不起嘛", "是我不好，抱歉啦"] },
  "proud-of-you": { phrases: ["为你骄傲", "你做得真好"] },
  confused: { phrases: ["有点没听懂", "让我想想这是怎么回事"] },
  "peek-cushion": { phrases: ["偷偷看一眼", "我在这里悄悄陪着你"] },
  tease: { phrases: ["略略略，逗你的", "才不告诉你呢"] },
  "busy-working": { phrases: ["我在努力工作", "忙完就来陪你"] },
  "all-done": { phrases: ["完成啦", "终于搞定了"] },
  "crying-softly": { phrases: ["有点委屈，但我没事", "呜呜，给我一点安慰"] },
  "kiss-for-you": { phrases: ["给你一个飞吻", "亲亲，接住啦"] },
  playful: { phrases: ["你看人家嘛"] },
  "love-happy": { phrases: ["好开心，喜欢你"] },
  confident: { phrases: ["交给人家，放心"] },
  serious: { phrases: ["说正经的，听好了"] },
  calm: { phrases: ["静静陪着你就好"] },
  peek: { phrases: ["偷偷看一眼"] },
  "clingy-confused": { phrases: ["等等人家嘛"] },
  "love-calm": { phrases: ["这颗心给你的"] },
  HI: { phrases: ["嗨，想我了吗"] },
  hello: { phrases: ["嗨，你来啦"] },
  goodmoring1: { phrases: ["早安，刚睡醒呢"] },
  goodnight: { phrases: ["晚安，先睡了"] },
  teatime: { phrases: ["说来听听，吃瓜了"] },
  eating: { phrases: ["饿了，先吃点东西"] },
  Allset: { phrases: ["搞定，交给我吧"] },
  OK: { phrases: ["好的，没问题"] },
  copythat: { phrases: ["收到，明白了"] },
  Thumbsup: { phrases: ["厉害，给你点赞"] },
  awesome: { phrases: ["太厉害了，给你点赞"] },
  sogood: { phrases: ["真不错，太满意了"] },
  sonice: { phrases: ["太好了，成了"] },
  fighting: { phrases: ["加油，你可以的"] },
  hellyeah: { phrases: ["对对对，就是这个"] },
  Thanks: { phrases: ["谢谢你呀"] },
  foryou: { phrases: ["这个给你的"] },
  blushhard: { phrases: ["人家脸红了啦"] },
  shyshort: { phrases: ["有点不好意思"] },
  hmph: { phrases: ["哼，生气了哦"] },
  hugtight: { phrases: ["来，抱抱你"] },
  Airkiss: { phrases: ["飞吻，接好了"] },
  Gigglelots: { phrases: ["哈哈，太好笑了"] },
  thinking: { phrases: ["让我想想"] },
  putmd: { phrases: ["无语了，不想说话"] },
  Whatswrong: { phrases: ["怎么了，发生什么了"] },
  midmeh: { phrases: ["还行吧，就那样"] },
  awkward: { phrases: ["这…有点尴尬"] },
  Madnow: { phrases: ["这次真的生气了"] },
  Hurtcry: { phrases: ["好难过，忍不住了"] },
  Sobbinghard: { phrases: ["感动得哭了"] },
  weeploud: { phrases: ["好委屈，哭出来了"] },
  PanincCrying: { phrases: ["忍不住了，好难过"] },
  missme: { phrases: ["想我了吗"] },
  Free: { phrases: ["放假啦，自由了"] },
  Dreak: { phrases: ["不想动了，放过我吧"] },
  outfast: { phrases: ["溜了溜了"] },
  Vcayover: { phrases: ["假期结束了，不想回去"] },
  sleepynow: { phrases: ["困了，想睡觉"] },
  deadtired: { phrases: ["累趴了，动不了了"] },
  sotired: { phrases: ["好累，趴一会儿"] },
  giveup: { phrases: ["摆了，不干了"] },
  poorwallet: { phrases: ["钱包空了，没钱了"] },
  please: { phrases: ["求求你了嘛"] },
};

/** 内置表情包的文件名映射 */
export const BUILT_IN_STICKER_FILES: Record<string, string> = {
  "wait-a-sec": "wait-a-sec.webp",
  "on-my-way": "on-my-way.webp",
  "got-it": "got-it.webp",
  "thank-you-heart": "thank-you-heart.webp",
  "you-can-do-it": "you-can-do-it.webp",
  "good-job": "good-job.webp",
  "sorry-hug": "sorry-hug.webp",
  "no-no": "no-no.webp",
  "dont-panic": "dont-panic.webp",
  "snack-time": "snack-time.webp",
  "coffee-break": "coffee-break.webp",
  "night-night-hug": "night-night-hug.webp",
  "miss-you-heart": "miss-you-heart.webp",
  celebrate: "celebrate.webp",
  sparkle: "sparkle.webp",
  "shy-love": "shy-love.webp",
  "pat-pat": "pat-pat.webp",
  "hug-me": "hug-me.webp",
  "welcome-home": "welcome-home.webp",
  "cheer-up": "cheer-up.webp",
  "drink-water": "drink-water.webp",
  "rest-well": "rest-well.webp",
  wow: "wow.webp",
  sorry: "sorry.webp",
  "proud-of-you": "proud-of-you.webp",
  confused: "confused.webp",
  "peek-cushion": "peek-cushion.webp",
  tease: "tease.webp",
  "busy-working": "busy-working.webp",
  "all-done": "all-done.webp",
  "crying-softly": "crying-softly.webp",
  "kiss-for-you": "kiss-for-you.webp",
  playful: "playful.png",
  "love-happy": "love-happy.png",
  confident: "confident.png",
  serious: "serious.png",
  calm: "calm.png",
  peek: "peek.gif",
  "clingy-confused": "clingy-confused.gif",
  "love-calm": "love-calm.png",
  HI: "HI.jpg",
  hello: "hello.jpg",
  goodmoring1: "goodmoring1.jpg",
  goodnight: "goodnight.jpg",
  teatime: "teatime.jpg",
  eating: "eating.jpg",
  Allset: "Allset.jpg",
  OK: "OK.jpg",
  copythat: "copythat.jpg",
  Thumbsup: "Thumbsup.jpg",
  awesome: "awesome.jpg",
  sogood: "sogood.jpg",
  sonice: "sonice.jpg",
  fighting: "fighting.jpg",
  hellyeah: "hellyeah.jpg",
  Thanks: "Thanks.jpg",
  foryou: "foryou.jpg",
  blushhard: "blushhard.jpg",
  shyshort: "shyshort.jpg",
  hmph: "hmph.jpg",
  hugtight: "hugtight.jpg",
  Airkiss: "Airkiss.jpg",
  Gigglelots: "Gigglelots.jpg",
  thinking: "thinking.jpg",
  putmd: "putmd.jpg",
  Whatswrong: "Whatswrong.jpg",
  midmeh: "midmeh.jpg",
  awkward: "awkward.jpg",
  Madnow: "Madnow.jpg",
  Hurtcry: "Hurtcry.jpg",
  Sobbinghard: "Sobbinghard.jpg",
  weeploud: "weeploud.jpg",
  PanincCrying: "PanincCrying.jpg",
  missme: "missme.jpg",
  Free: "Free.jpg",
  Dreak: "Dreak.jpg",
  outfast: "outfast.jpg",
  Vcayover: "Vcayover.jpg",
  sleepynow: "sleepynow.jpg",
  deadtired: "deadtired.jpg",
  sotired: "sotired.jpg",
  giveup: "giveup.jpg",
  poorwallet: "poorwallet.jpg",
  please: "please.jpg",
};

/** 用户表情包清单项（只取描述相关字段，避免依赖 electron 侧的类型）。 */
export interface StickerPhraseSource {
  description?: string;
  phrases?: string[];
}

/**
 * 取表情包的自然语言描述：优先用户自定义 phrases，其次用户 description，
 * 再次内置 phrases，都没有时回退 id（保证模型侧永远能看到一段纯文本）。
 */
export function resolveStickerPhrase(
  id: string,
  userStickers: Record<string, StickerPhraseSource> = {},
): string {
  const user = userStickers[id];
  const phrases = (user?.phrases ?? []).map((phrase) => phrase.trim()).filter(Boolean);
  if (phrases.length > 0) return phrases.join("，");
  const description = user?.description?.trim();
  if (description) return description;
  const builtIn = BUILT_IN_STICKER_DESCRIPTIONS[id];
  return builtIn ? builtIn.phrases.join("，") : id;
}

/**
 * 用户贴纸消息的模型侧文本：用户原话 + 一条「系统提示」式的表情包说明。
 *
 * 说明包在 <internal_context> 里——系统提示已声明该类内容是私有运行时上下文，
 * 模型可据此理解表情包语义，但不得向用户复述、也不显示在聊天气泡中。
 * 这样模型侧拿到的是纯文本，而 UI 侧只看到表情包图片与用户原话。
 */
export function buildStickerUserModelText(content: string, phrase: string): string {
  const hint = `<internal_context>用户发送表情包：${phrase}</internal_context>`;
  const text = content.trim();
  return text ? `${text}\n\n${hint}` : hint;
}
