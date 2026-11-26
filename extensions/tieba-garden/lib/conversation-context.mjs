const seriousTurn = /急救|救命|受伤|去世|生病|难受|崩溃|很着急|认真(?:点|说|回答)|(?:只想|先听我)(?:说|倾诉)/u;
const declinesStyle = /(?:别|不要|不用)(?:再|老|一直|总是?|硬)?(?:用|学|玩梗|模仿|这么说|这样说|开玩笑)|(?:说话|回复|回答).{0,6}(?:简短|直接点|简单点|少问)|正常(?:一点|点)?(?:说话|聊天|回答)/u;
const declinesForum = /(?:别|不要|不想|不用).{0,12}(?:贴吧|帖子|贴子|手记)|(?:贴吧|帖子|贴子|手记).{0,8}(?:别提|不想听)/u;

export function declinesTiebaContext(userText) {
  return declinesForum.test(userText);
}

export function allowsCasualTiebaContext(userText) {
  return Boolean(userText?.trim()) && !seriousTurn.test(userText) && !declinesStyle.test(userText) && !declinesTiebaContext(userText);
}

export function tiebaSourceThread(source) {
  return typeof source === "string"
    ? /^https:\/\/tieba\.baidu\.com\/p\/(\d{1,20})(?:[?#]|$)/u.exec(source)?.[1]
    : undefined;
}
