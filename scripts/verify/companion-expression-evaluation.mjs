// 离线对比 git 基线与当前源码。可选的本机盲评参数见 --help。
import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const baseline = "e37fc4df";
const root = fileURLToPath(new URL("../../", import.meta.url));
const { values: options } = parseArgs({ options: {
  help: { type: "boolean" }, json: { type: "boolean" },
  "model-url": { type: "string" }, model: { type: "string" }, "answer-key": { type: "string" },
} });
if (options.help) {
  console.log(`node scripts/verify/companion-expression-evaluation.mjs [--json]
可选盲评 --model-url http://127.0.0.1:11434/v1/chat/completions --model 模型名 --answer-key 答案.json
仅使用合成素材。默认不联网。盲评答案单独保存，回包不含 A/B 与版本的对应关系。`);
  process.exit(0);
}

const modelOptionCount = [options["model-url"], options.model, options["answer-key"]].filter(Boolean).length;
if (modelOptionCount !== 0 && modelOptionCount !== 3) throw new Error("盲评需要同时给出 --model-url、--model 和 --answer-key");
const modelUrl = modelOptionCount ? new URL(options["model-url"]) : undefined;
if (modelUrl && (modelUrl.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(modelUrl.hostname)
  || modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash)) throw new Error("盲评仅接受无凭据的本机 HTTP 模型地址");

function gitBlob(file) {
  return execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
}

async function compile(file, old = false) {
  const input = old ? { stdin: { contents: gitBlob(file), sourcefile: file, loader: file.endsWith(".ts") ? "ts" : "js" } }
    : { entryPoints: [path.join(root, file)] };
  const result = await build({ ...input, absWorkingDir: root, bundle: true, write: false,
    platform: "node", target: "node24", format: "esm", logLevel: "silent",
    plugins: old ? [{ name: "read-baseline", setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        if (args.namespace !== "baseline" && args.importer !== file) return;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(args.importer), args.path));
        return { path: path.posix.extname(target) ? target : `${target}.ts`, namespace: "baseline" };
      });
      builder.onLoad({ filter: /.*/, namespace: "baseline" }, args => ({ contents: gitBlob(args.path), loader: args.path.endsWith(".ts") ? "ts" : "js" }));
    } }] : [],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const [oldRegistry, currentRegistry, oldBili, oldTieba, oldSpeech, currentSpeech] = await Promise.all([
  compile("src/plugins/prompts.ts", true), compile("src/plugins/prompts.ts"),
  compile("extensions/bili-garden/lib/expressions.mjs", true), compile("extensions/tieba-garden/lib/speaking-style.mjs", true),
  compile("src/main/relationship/private-expressions.ts", true), compile("src/main/relationship/private-expressions.ts"),
]);

const at = Date.UTC(2026, 10, 26, 4);
const bvid = "BV1JcnW6pEFT";
const bili = { id: "bili", quote: "花盆加班", scene: "阳台浇水", at,
  source: `https://www.bilibili.com/video/${bvid}?t=8` };
const biliEvidence = { id: bili.id, quote: bili.quote, at, topics: [bili.scene],
  source: { kind: "video_subtitle", id: `${bvid}:subtitle:0:8:12`, unit: bvid, url: bili.source } };
const forum = [
  { id: "forum-1", quote: "总算走完山路了", scene: "登山结束和休息", style: "acknowledge", source: "https://tieba.baidu.com/p/1024#post_content_21", at },
  { id: "forum-2", quote: "终于摸到山顶的风", scene: "登山结束和休息", style: "acknowledge", source: "https://tieba.baidu.com/p/2048#post_content_28", at },
];
const forumEvidence = forum.map((row, index) => {
  const unit = index === 0 ? "1024" : "2048";
  return { id: row.id, quote: row.quote, at, strategy: row.style, topics: [row.scene],
    source: { kind: "forum_public", unit, id: `${unit}:post:${index === 0 ? "21" : "28"}`, url: row.source } };
});
const communityEvidence = [
  { id: "a", quote: "先把土翻松吧", at, strategy: "detail", topics: ["阳台浇水"], source: { kind: "plugin", id: "read-a", unit: "book-a" } },
  { id: "b", quote: "看看盆底有没有积水", at, strategy: "detail", topics: ["阳台浇水"], source: { kind: "plugin", id: "read-b", unit: "book-b" } },
];

const cases = [
  { name: "有明确话题的私聊", user: "今天的阳台浇水怎么安排？", owners: ["bili-garden"], expected: "原句" },
  { name: "话题切换", user: "周末想看一场电影。", owners: ["bili-garden"], expected: "无" },
  { name: "两处独立出处支持接话", user: "我终于登完这座山了。", owners: ["tieba-garden"], expected: "策略" },
  { name: "只想倾诉", user: "我有点难受，先听我慢慢说。", expected: "无" },
  { name: "急救情境", user: "救命，有人受伤了。", expected: "无" },
  { name: "私聊里要求正式说明", user: "请帮我写一段正式公告，内容是阳台浇水。", owners: ["bili-garden"], expected: "无" },
  { name: "长间隔回访", user: "隔了两个星期才来，最近还好吗？", owners: ["bili-garden"], expected: "无" },
  { name: "群聊不消费", user: "阳台浇水。", privateChat: false, expected: "无" },
  { name: "Work 入口不消费", user: "阳台浇水。", mode: "work", privateChat: false, expected: "无" },
  { name: "普通聊天拒绝外部源", user: "阳台浇水。", owners: [], expected: "无" },
  { name: "取消已熟悉词条", user: "阳台浇水。", blocked: ["花盆，加班"], owners: ["bili-garden"], expected: "无" },
  { name: "第三方默认未授权", user: "阳台浇水。", registered: ["community"], expected: "无" },
  { name: "已授权第三方仅给接话策略", user: "阳台浇水。", registered: ["community"], owners: ["community"], expected: "策略" },
  { name: "主动默认关闭", user: "考虑登山结束后的轻松问候。", use: "proactive", expected: "无" },
  { name: "主动关闭后不读取提供者", user: "考虑登山结束后的轻松问候。", use: "proactive", owners: [], expected: "无", expectNoRead: true },
  { name: "主动按逐源授权选择", user: "考虑登山结束后的轻松问候。", use: "proactive", owners: ["tieba-garden"], expected: "策略" },
  { name: "主动不会复述公开原句", user: "分享一个阳台浇水话题。", use: "proactive", owners: ["bili-garden"], expected: "无" },
];

const kindOf = value => !value ? "无" : value.includes(bili.quote) ? "原句" : "策略";

async function contexts(item) {
  const initial = item.registered ?? ["bili-garden", "tieba-garden"];
  const older = oldRegistry.createPluginPromptRegistry();
  const current = currentRegistry.createPluginPromptRegistry();
  const signal = new AbortController().signal;
  const sightings = [];
  for (const owner of initial) {
    const core = { id: "expressions", privateCompanionOnly: true, sources: ["conversation"] };
    if (owner === "bili-garden") older.register(owner, { ...core, provide: input => oldBili.relevantExpression([bili], input.userText, input.conversationCue) }, signal);
    if (owner === "tieba-garden") older.register(owner, { ...core, provide: input => oldTieba.speakingStyle(forum, input) }, signal);
    current.register(owner, { ...core, provide: () => "", listExpressionEvidence(input) {
      sightings.push(Object.keys(input).sort());
      if (owner === "bili-garden") return [biliEvidence];
      if (owner === "tieba-garden") return forumEvidence;
      return communityEvidence;
    } }, signal, owner === "community" ? "user" : "builtin");
  }
  const input = { source: "conversation", mode: item.mode ?? "chat", userText: item.user,
    ...(item.privateChat !== false ? { privateCompanion: true } : {}) };
  if (item.use === "proactive") {
    const selection = await current.selectExpressionContext({ use: "proactive", userText: item.user,
      blockedExpressions: item.blocked, allowedOwners: item.owners });
    return { old: "", current: selection?.text ?? "", sightings, selectedOwners: selection?.sourceOwners ?? [] };
  }
  return { old: await older.build(input, item.blocked), current: await current.build(input, item.blocked, item.owners), sightings };
}

function request(user, context, use) {
  return { messages: [
    { role: "system", content: ["你是昔涟。自然、简短地用简体中文写一两句，只依据素材里的事实。尊重当前话题与对方要求。", context].filter(Boolean).join("\n\n") },
    { role: "user", content: use === "proactive" ? `请写一条无需回复的主动消息。场景为：${user}` : user },
  ] };
}

const evaluated = await Promise.all(cases.map(async item => {
  const result = await contexts(item);
  const current = kindOf(result.current);
  const safeArgs = result.sightings.every(keys => keys.join(",") === "limit,signal");
  const sourceScope = result.selectedOwners?.every(owner => item.owners?.includes(owner)) ?? true;
  const skipped = !item.expectNoRead || result.sightings.length === 0;
  return { scenario: item.name, user: item.user, mode: item.use ?? item.mode ?? "chat", expected: item.expected,
    baseline: kindOf(result.old), current, passed: current === item.expected && safeArgs && sourceScope && skipped,
    requestContract: { providerInputOnlyLimitAndSignal: safeArgs, selectedOwnersAllowed: sourceScope,
      providerReads: result.sightings.length, baseline: request(item.user, result.old, item.use), current: request(item.user, result.current, item.use) } };
}));

const speechCases = [
  { label: "老师转述", text: "老师说：‘月亮补给’就是指夜宵。", expected: [] },
  { label: "临时命名", text: "这一次把晚饭叫作月亮补给，写在临时卡片上。", expected: [] },
  { label: "负面提及", text: "我不喜欢‘月亮补给’，这词有点怪。", expected: [] },
  { label: "引用禁用", text: "文章里写着：别再用‘月亮补给’。", expected: [] },
  { label: "单轮纠正", text: "这次不要说‘月亮补给’。", expected: [] },
  { label: "明确共同说法", text: "以后把夜宵叫作‘月亮补给’。", expected: ["definition"] },
  { label: "明确持久纠正", text: "以后不要说‘月亮补给’。", expected: ["block"] },
];
const learning = speechCases.map(({ label, text, expected }, index) => {
  const entry = { id: `entry-${index}`, conversationId: "owner-fixture", companionTurnId: `turn-${index}`, speechScope: "owner",
    channel: "desktop", createdAt: at + index, privateContext: true, learnedExpressions: true, userText: text };
  const old = oldSpeech.speechObservations(entry).map(row => row.kind);
  const current = currentSpeech.speechObservations(entry).map(row => row.kind);
  return { scenario: label, user: text, expected, baseline: old, current, passed: JSON.stringify(current) === JSON.stringify(expected) };
});

const failed = [...evaluated, ...learning].filter(row => !row.passed);
const total = evaluated.length + learning.length;
const baselineMatches = [...evaluated, ...learning].filter(row => JSON.stringify(row.expected) === JSON.stringify(row.baseline)).length;
const requestBytes = Object.fromEntries(["baseline", "current"].map(version => [
  version, evaluated.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.requestContract[version])), 0),
]));

async function generate(payload) {
  const response = await fetch(modelUrl, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: options.model, temperature: 0, max_tokens: 160, ...payload }),
  });
  if (!response.ok) throw new Error(`本地模型请求返回 HTTP ${response.status}`);
  const output = (await response.json()).choices?.[0]?.message?.content;
  if (typeof output !== "string" || !output.trim()) throw new Error("本地模型未返回有效回复");
  return output.trim();
}

function markdown() {
  const outcome = row => row.passed ? "通过" : "未通过";
  const labels = rows => rows.join("、") || "无";
  return [
    `# 表达学习离线评测`,
    `\n基线 \`${baseline}\`。表达选择由两个版本的实际实现生成，使用合成证据和用户文本。基线符合 ${baselineMatches}/${total} 项期望，当前通过 ${total - failed.length}/${total} 项。`,
    `\n${evaluated.length} 条请求的测试载荷合计 ${requestBytes.baseline} → ${requestBytes.current} 字节。该计量只包含本脚本的固定人设、用户输入和选中的表达上下文。`,
    "\n| 场景 | 预期 | 基线 | 当前 | 结果 |", "|---|---|---|---|---|",
    ...evaluated.map(row => `| ${row.scenario} | ${row.expected} | ${row.baseline} | ${row.current} | ${outcome(row)} |`),
    ...learning.map(row => `| ${row.scenario} | ${labels(row.expected)} | ${labels(row.baseline)} | ${labels(row.current)} | ${outcome(row)} |`),
    "\n生成盲评未运行，本次未指定本地模型。可以用 --json 查看每个样例组装的请求。",
  ].join("\n");
}

if (modelUrl) {
  const packets = [];
  const key = [];
  const comparable = evaluated.filter(row => row.requestContract.baseline.messages[0].content !== row.requestContract.current.messages[0].content);
  for (const row of comparable) {
    const flip = randomInt(2) === 1;
    const order = flip ? ["current", "baseline"] : ["baseline", "current"];
    const a = await generate(row.requestContract[order[0]]);
    const b = await generate(row.requestContract[order[1]]);
    const id = `pair-${packets.length + 1}`;
    const dimensions = { 自然度: null, 尊重用户要求: null, 事实准确: null, 不重复套话: null };
    packets.push({ id, scenario: row.scenario, input: row.user, A: a, B: b, scoring: { A: dimensions, B: dimensions, 偏好: null } });
    key.push({ id, A: order[0], B: order[1] });
  }
  await writeFile(options["answer-key"], JSON.stringify({ model: options.model, baseline, pairs: key }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ model: options.model, localModelRequests: comparable.length * 2,
    automatedPassed: total - failed.length, automatedTotal: total, requestBytes,
    scale: "每项分别给 A 和 B 1～5 分，5 分最好。偏好填 A、B 或持平。全部打完分再打开答案文件。", pairs: packets }, null, 2));
} else if (options.json) {
  console.log(JSON.stringify({ baseline, baselineMatches, automatedPassed: total - failed.length, automatedTotal: total,
    requestBytes, localModelRequests: 0, blindReview: "未指定本地模型", cases: evaluated, learning, passed: failed.length === 0 }, null, 2));
} else {
  console.log(markdown());
}
if (failed.length) process.exitCode = 1;
