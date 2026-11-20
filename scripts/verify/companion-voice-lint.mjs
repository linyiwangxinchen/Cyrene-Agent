#!/usr/bin/env node
// 统计一段会话里昔涟回复的“模板化 / AI 腔”指标，用于改动人设、主动消息前后对比。
// 离线运行，不调用模型：
//   node scripts/verify/companion-voice-lint.mjs <chats:get 导出的 JSON> [--since 2026-11-13] [--until 2026-11-21] [--json]
// 输入可以是 CHATS_GET 的返回值，也可以是 { messages: [...] }。

import fs from "node:fs";

export const AI_PHRASES = [
  "接住", "落点", "看见你", "被看见", "轻轻陪", "陪你安静", "安安静静", "放得柔软", "柔软一点", "留一点空白", "留一点安静",
  "安静的光", "圆满了一小块", "把线牵稳", "眼下能", "一小步", "硬拽", "推进", "闭环", "落地", "复盘", "边界", "可复查",
  "核对", "核实", "待查", "缺证据", "记录方法", "没想明白", "拐跑", "慢慢来", "不急着", "收好", "这段时间", "温柔的光",
];

const MARKDOWN = /\*\*[^*]+\*\*|^#{1,6}\s|^\s*[-*]\s+\S|^\s*\d+\.\s+\S|^>\s/mu;
const SYSTEM_LEAK = /Asia\/Shanghai|\/root\/|\/home\/|[A-Za-z]:\\|UTC[+-]?\d|按\s*\*{0,2}\d{4}\s*年|系统提示|上下文|工具调用/u;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("");
  return "";
}

function opener(text) {
  return text.replace(/^[\s"“]+/u, "").slice(0, 4);
}

function dayKey(at) {
  return new Date(at).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function lintConversation(messages, { since = 0, until = Infinity, nickname } = {}) {
  const inRange = messages.filter((m) => typeof m.at === "number" && m.at >= since && m.at < until);
  const replies = [];
  let lastUser = "";
  for (const m of inRange) {
    const text = textOf(m.content).trim();
    if (m.role === "user") { lastUser = text; continue; }
    if (m.role !== "model" && m.role !== "assistant") continue;
    if (!text) continue;
    replies.push({ text, at: m.at, proactive: String(m.id ?? "").startsWith("proactive-"), lastUser });
  }
  const n = replies.length || 1;
  const count = (predicate) => replies.filter(predicate).length;
  const phraseHits = {};
  for (const r of replies) for (const p of AI_PHRASES) if (r.text.includes(p)) phraseHits[p] = (phraseHits[p] ?? 0) + 1;
  const openers = {};
  for (const r of replies) openers[opener(r.text)] = (openers[opener(r.text)] ?? 0) + 1;
  const exact = {};
  for (const r of replies) exact[r.text] = (exact[r.text] ?? 0) + 1;
  const proactivePerDay = {};
  for (const r of replies.filter((r) => r.proactive)) proactivePerDay[dayKey(r.at)] = (proactivePerDay[dayKey(r.at)] ?? 0) + 1;
  const nick = nickname ?? "";
  const ratio = (x) => Math.round((x / n) * 100);
  return {
    replies: replies.length,
    proactive: count((r) => r.proactive),
    notePct: ratio(count((r) => r.text.includes("♪"))),
    noteEveryReplyEndPct: ratio(count((r) => /♪[\s～~]*$/u.test(r.text))),
    renjiaPct: ratio(count((r) => r.text.includes("人家"))),
    nicknamePct: nick ? ratio(count((r) => r.text.includes(nick))) : undefined,
    echoOpenerPct: ratio(count((r) => {
      const head = r.lastUser.replace(/[\s～~!！。,.，]+$/u, "").slice(0, 4);
      return !r.proactive && head.length >= 1 && r.text.startsWith(head);
    })),
    markdownReplies: count((r) => MARKDOWN.test(r.text)),
    systemLeakReplies: count((r) => SYSTEM_LEAK.test(r.text)),
    aiPhraseReplies: count((r) => AI_PHRASES.some((p) => r.text.includes(p))),
    aiPhraseHits: Object.fromEntries(Object.entries(phraseHits).sort((a, b) => b[1] - a[1])),
    topOpeners: Object.entries(openers).sort((a, b) => b[1] - a[1]).slice(0, 8),
    duplicatedReplies: Object.entries(exact).filter(([, c]) => c > 1).map(([t, c]) => [t.slice(0, 40), c]),
    proactivePerDay,
  };
}

function parseArgs(argv) {
  const options = { file: "", since: 0, until: Infinity, json: false, nickname: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") options.since = Date.parse(`${argv[++i]}T00:00:00+08:00`);
    else if (arg === "--until") options.until = Date.parse(`${argv[++i]}T00:00:00+08:00`);
    else if (arg === "--nickname") options.nickname = argv[++i];
    else if (arg === "--json") options.json = true;
    else options.file = arg;
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("companion-voice-lint.mjs")) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    console.error("用法：node scripts/verify/companion-voice-lint.mjs <会话JSON> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--nickname 称呼] [--json]");
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(options.file, "utf8"));
  const conversation = raw.value ?? raw;
  const report = lintConversation(conversation.messages ?? [], options);
  console.log(options.json ? JSON.stringify(report, null, 2) : Object.entries(report).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n"));
}
