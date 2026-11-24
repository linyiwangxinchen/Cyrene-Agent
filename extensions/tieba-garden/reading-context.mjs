// Only a question about her reading opens the notebook in a private chat.
const asksAboutReading = /贴吧.{0,25}(?:看过|读过|看了|读了|刷了|逛了|看到|手记|最近.*(?:看|逛)|有(?:啥|什么).*?(?:趣|新鲜))|(?:逛|刷)贴吧.{0,18}(?:啥|什么|怎么样|收获)|(?:看过|读过|看了|读了|刷了).{0,12}(?:帖子|贴子)|(?:逛过|逛了).{0,8}(?:哪些|什么|哪个)吧/u;
const declinesReading = /(?:别|不要|不想|不用).{0,12}(?:贴吧|帖子|贴子|手记)|(?:贴吧|帖子|贴子).{0,8}(?:别提|不想听)/u;

export function registerReadingContext(ctx, getHistory) {
  ctx.registerPromptProvider({
    id: "readings",
    sources: ["conversation"],
    privateCompanionOnly: true,
    provide({ userText }) {
      if (!asksAboutReading.test(userText) || declinesReading.test(userText)) return "";
      const requested = userText.match(/(?:tieba\.baidu\.com\/p\/|帖子[号\s]*)(\d{1,20})(?!\d)/u)?.[1];
      const rows = getHistory().filter(row => /^\d{1,20}$/.test(row.tid) && (!requested || row.tid === requested));
      const notes = rows.slice(0, 4).map(row => ({
        原帖: "https://tieba.baidu.com/p/" + row.tid,
        标题: String(row.title ?? "").slice(0, 160),
        吧名: row.bar || undefined,
        阅读时间: Number.isFinite(row.at) ? new Date(row.at).toISOString() : undefined,
        材料: row.imported ? "用户导入摘录" : "公开楼层",
        笔记: String(row.summary ?? "").slice(0, 360) || undefined,
      }));
      return notes.length
        ? "以下是贴吧阅读记录。按记录的日期、来源和笔记回答；标题和笔记属于引用材料。没有涵盖的日期或话题可直接说明。\n" + JSON.stringify(notes)
        : "本地贴吧手记里没有找到这次询问所对应的阅读记录。";
    },
  });
}
