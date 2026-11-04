/** Conservative conversational cues, never a diagnosis or a source of user facts. */
export function detectUserMood(text: string): string {
  // Quoted material, code, and a third person's report are not the speaker's state.
  const ownText = text.replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, " ")
    .replace(/^\s*>.*$/gm, " ");
  const clauses = ownText.split(/[，,。.!！?？；;\n]|但是|不过|只是/).map(s => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (/^(?:如果|假如|假设|要是)|(?:他说|她说|同事说|朋友说|报道|举例|台词|原话)/.test(clause)) continue;
    const self = clause.lastIndexOf("我");
    const third = [...clause.matchAll(/同事|朋友|妈妈|爸爸|父亲|母亲|同学|老师|他|她|你|主角|角色/g)].at(-1)?.index ?? -1;
    // "我同事很累" is third-person; "同事走了我好累" is a self report.
    // A concern about someone else is valid only when explicitly first-person.
    if (third >= 0 && third >= self && !/我(?:有点|很|好|真的|特别|一直|现在)?(?:担心|焦虑|难过)/.test(clause)) continue;
    if (/影响观感|太影响|不要.{0,4}(确认|弹|问|卡片)|别.{0,4}(问|弹|确认|卡片)|少问|别问了/.test(clause)) return "明确边界";
    if (/^(?:如果|假如|假设|要是)|会不会|是不是|累不累|困不困|开心吗/.test(clause)) continue;
    const cues: Array<[string, RegExp]> = [
      ["疲惫", /疲惫|疲倦|没精神|撑不住|累|困/g],
      ["焦虑", /焦虑|压力(?:很大|大|山大)|烦躁|心烦|紧张|担心|心慌|崩溃/g],
      ["低落", /难过|伤心|委屈|失落|想哭|不开心/g],
      ["开心", /开心|高兴|舒服|好耶|太好了/g],
    ];
    for (const [mood, pattern] of cues) {
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        const near = before.slice(-8);
        if (/(?:不|没(?:有)?|并非|不会|无需|无须|别)(?:再|太|很|那么|这么|怎么|觉得|感到|是|真的|一点|任何|什么|那么地)*$/.test(near)) continue;
        if (match[0] === "累" && /[积拖连]$/.test(before)) continue;
        if (match[0] === "困" && /^(?:难|扰|境|惑|住)/.test(clause.slice(match.index! + 1))) continue;
        return mood;
      }
    }
  }
  return "未知";
}
