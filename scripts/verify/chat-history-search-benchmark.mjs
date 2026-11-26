import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-history-benchmark-"));
const conversationCount = 160;
const turnsPerConversation = 125;
const date = Date.UTC(2025, 4, 9, 10);
const session = n => `history-fixture-${n}`;

function makeCases() {
  const topics = ["松林", "红茶", "银铃", "海盐", "蒲公英", "琥珀", "白瓷", "枫叶", "苹果", "风筝", "盘山", "浮萍", "烤栗", "榕树", "墨鱼", "桂香", "木槿", "黄鹂", "薄荷", "海棠"];
  const sample = (n, category, query, text = query, title = undefined, at = date) => ({
    category, query, text, title, at, id: session((n * 47 + 159) % conversationCount),
  });
  return [
    ...topics.map((topic, n) => sample(n, "CJK short term", topic)),
    ...topics.map((topic, n) => sample(n + 20, "CJK exact phrase", `天桥下的${topic}礼物`, `天桥下的${topic}礼物只出现一次。`)),
    ...topics.map((_, n) => sample(n + 40, "Latin word boundary", `ultra${n}cat`, `Remember ultra${n}cat near the river.`)),
    ...topics.map((topic, n) => sample(n + 60, "title", `琉璃序列${topic}`, "这里是普通正文。", `琉璃序列${topic}`)),
    ...topics.map((topic, n) => sample(n + 80, "date window", `2025-05-09 离岛${topic}`, `离岛${topic}的会话。`)),
    ...topics.map((_, n) => ({ category: "absent", query: `qavent${n}cat不存在`, id: undefined })),
  ];
}

function seed(database, cases) {
  const byId = new Map(cases.filter(item => item.id).map(item => [item.id, item]));
  database.transaction(() => {
    for (let i = 0; i < conversationCount; i++) {
      const id = session(i);
      const fixture = byId.get(id);
      database.saveRecord({ schemaVersion: 2, id, mode: "chat", identityId: null, title: fixture?.title ?? `示例会话 ${i}`,
        createdAt: date - 86_400_000, updatedAt: date - i, messageCount: turnsPerConversation * 2 });
      database.db.prepare("UPDATE conversations SET transcript_imported=1 WHERE id=?").run(id);
      for (let j = 0; j < turnsPerConversation; j++) {
        const target = j === 7 ? fixture?.text : undefined;
        const decoy = j === 4 ? `prefixultra${i % 20}catmiddle prefixqavent${i % 20}cat不存在` : undefined;
        const text = target || decoy || `我们记下第 ${i} 份日程的第 ${j} 项，晚些再讨论。 General notes and follow-up.`;
        const at = target ? fixture.at : date + 86_400_000 + j;
        const turnId = `turn-${j}`;
        database.insert(id, { id: `user:v1:${turnId}:r1`, seq: j * 2 + 1, kind: "user", turnId, revision: 1, at, payload: { text } });
        database.insert(id, { id: `reply-${j}`, seq: j * 2 + 2, kind: "assistant", turnId: `answer-${j}`, at: at + 1,
          payload: { role: "assistant", content: "我记下了，我们到时候再确认。" } });
      }
    }
  });
}

function summarize(results) {
  const times = results.map(row => row.ms).sort((a, b) => a - b);
  const positive = results.filter(row => row.id);
  const negative = results.filter(row => !row.id);
  return {
    recallAt5: +(positive.filter(row => row.rank >= 0 && row.rank < 5).length / positive.length).toFixed(3),
    meanReciprocalRank: +(positive.reduce((sum, row) => sum + (row.rank >= 0 ? 1 / (row.rank + 1) : 0), 0) / positive.length).toFixed(3),
    falsePositiveRate: +(negative.filter(row => row.count > 0).length / negative.length).toFixed(3),
    p95Ms: +times[Math.ceil(times.length * 0.95) - 1].toFixed(1),
  };
}

let database;
try {
  const output = path.join(temp, "history.cjs");
  await build({ stdin: { contents: `export { ConversationDatabase } from './src/main/storage/conversation-database';
    export { searchConversationHistory } from './src/main/storage/conversation-history-repository';
    export { buildRecallQueryPlan } from './src/main/memory/recall-query-plan';`, resolveDir: root },
    platform: "node", format: "cjs", bundle: true, outfile: output });
  const { ConversationDatabase, searchConversationHistory, buildRecallQueryPlan } = (await import(pathToFileURL(output).href)).default;
  database = new ConversationDatabase(temp);
  const cases = makeCases();
  seed(database, cases);
  const policy = { blockedIds: [], withdrawal: { sourceKeys: [], factKeys: [] }, limit: 5, offset: 0 };
  const query = (value, options) => searchConversationHistory(database,
    { ...policy, ...options, plan: buildRecallQueryPlan({ query: value, timeZone: "Asia/Shanghai", now: date }) }, async () => {});
  const cold = [];
  for (let i = 0; i < 8; i++) {
    const start = performance.now();
    const result = await query("红茶");
    cold.push({ ms: +(performance.now() - start).toFixed(1), coverage: result.coverage });
    if (result.coverage === "complete") break;
  }
  assert.equal(cold.at(-1).coverage, "complete");

  async function measure(fixtures, fallback = false) {
    const results = [];
    for (const fixture of fixtures) {
      const start = performance.now();
      const result = await query(fixture.query);
      assert.equal(result.coverage, fallback ? "degraded" : "complete");
      results.push({ ...fixture, ms: performance.now() - start, count: result.hits.length,
        rank: result.hits.findIndex(hit => hit.conversationId === fixture.id) });
    }
    return results;
  }

  const indexed = await measure(cases);
  database.db.exec("DROP TABLE history_index_fts; CREATE TABLE history_index_fts(tokens TEXT)");
  const scanCases = cases.filter((_, index) => index % 2 === 0);
  const fallback = await measure(scanCases, true);
  const grouped = [...new Set(cases.map(item => item.category))].map(category => ({ category,
    hitAt5: indexed.filter(row => row.category === category && row.id && row.rank >= 0 && row.rank < 5).length,
    expected: indexed.filter(row => row.category === category && row.id).length }));
  const report = { conversationCount, turns: conversationCount * turnsPerConversation, queries: cases.length, cold,
    warmIndex: summarize(indexed), scanFirstPage: { queries: scanCases.length, ...summarize(fallback) }, grouped };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.warmIndex.recallAt5 >= 0.95, "Recall@5 below 0.95 on labelled queries");
  assert.equal(report.warmIndex.falsePositiveRate, 0);
} finally {
  database?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
