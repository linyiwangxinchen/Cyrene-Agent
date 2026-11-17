// Seeded mechanism verification; no real model, channel, account or user data.
// Run: node scripts/verify/proactive-rhythm.mjs [--seeds=7,42,20261117]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const sourceFiles = ['initiative-opportunities.ts', 'proactive-policy.ts', 'proactive-service.ts'];
const sourceDigests = Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(repo, 'src/main/proactive', file))).digest('hex')]));
const bundle = await build({ stdin: { contents: sourceFiles.map(file => `export * from './src/main/proactive/${file}';`).join('\n'),
  resolveDir: repo, sourcefile: 'proactive-rhythm-entry.ts' }, bundle: true, write: false, platform: 'node',
  format: 'cjs', target: 'node24', packages: 'external', logLevel: 'silent' });
const loaded = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(loaded, loaded.exports, createRequire(import.meta.url));
const { InitiativeOpportunityStore, createDefaultProactiveState, canStartProactiveGeneration, createProactiveChatService } = loaded.exports;
const START = Date.parse('2026-11-17T00:00:00.000Z'); // Asia/Shanghai 08:00
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const seeds = (process.argv.find(arg => arg.startsWith('--seeds='))?.slice(8) ?? '7,42,20261117').split(',').map(Number);
assert.ok(seeds.length > 0 && seeds.length <= 12 && seeds.every(Number.isSafeInteger), 'Use up to twelve integer seeds');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrene-proactive-rhythm-'));
assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
assert.ok(path.basename(temporary).startsWith('cyrene-proactive-rhythm-'));
const reportPath = path.join(repo, '.build-temp', 'proactive-rhythm-verification.json');

function random(seed) {
  let state = seed >>> 0, calls = 0;
  const next = () => {
    calls++;
    state = state + 0x6d2b79f5 >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  next.calls = () => calls;
  return next;
}
function clock(now) {
  const date = new Date(now + 8 * HOUR);
  return { localDate: date.toISOString().slice(0, 10), localHour: date.getUTCHours(), localMinute: date.getUTCMinutes() };
}
function candidate(item) {
  return { sceneId: item.sceneId ?? item.id, score: item.score ?? 76, sceneCooldownMs: 0,
    ...(item.key ? { opportunityId: item.key } : {}), sourceEventId: item.sourceEventId,
    evidenceVersion: String(item.evidenceVersion), replyBurden: item.replyBurden, momentSummary: item.summary };
}
function sources(seed, days) {
  const rng = random(seed ^ 0x23c90c07), result = [];
  const motives = ['interesting', 'progress', 'connection', 'interesting', 'boredom'];
  for (let day = 0; day < days; day++) {
    let elapsed = 3 + Math.floor(rng() * 8), index = 0;
    while (elapsed < 14 * 60 - 15) {
      const motive = motives[index % motives.length], at = START + day * DAY + elapsed * MINUTE;
      const duration = motive === 'connection' || motive === 'boredom' ? (30 + Math.floor(rng() * 55)) * MINUTE : 6 * HOUR;
      result.push({ id: `day:${day}:fact:${index}`, source: motive === 'connection' ? 'shared_interest' : motive === 'boredom' ? 'inner_life' : 'amphoreus',
        sourceEventId: `day:${day}:event:${index}`, evidenceVersion: 1, conversationId: 'fixture-private', motive,
        summary: `隔离构造的${motive}片段${day}/${index}；只描述已知变化`, occurredAt: at, expiresAt: at + duration,
        strengthPerHour: motive === 'connection' ? 1.5 : motive === 'boredom' ? 2 : 4,
        decayPerHour: motive === 'boredom' ? 0 : motive === 'connection' ? 0.8 : 1,
        replyBurden: motive === 'boredom' ? 'question' : 'none', score: motive === 'boredom' ? 68 : 76 });
      elapsed += 18 + Math.floor(rng() * 27); index++;
    }
  }
  return result;
}
function harness(name, seed, density, { respond = true, fixtureDecisions = true } = {}) {
  const dir = path.join(temporary, name); fs.mkdirSync(dir);
  const statePath = path.join(dir, 'state.json'), opportunityPath = path.join(dir, 'opportunities.json');
  fs.writeFileSync(statePath, JSON.stringify(createDefaultProactiveState()));
  const chance = random(seed ^ 0x59d31a7b), model = random(seed ^ 0x6b1c094d);
  let store = new InitiativeOpportunityStore(opportunityPath, chance), now = START, activeCandidate, replyAt;
  const deliveries = [], decisions = [];
  const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const save = value => fs.writeFileSync(statePath, JSON.stringify(value));
  const snapshot = () => ({ now, ...clock(now), enabled: true, screenLocked: false, conversationBusy: false,
    generationBusy: false, idleSec: respond ? 0 : Number.POSITIVE_INFINITY, dailyLimit: 20 });
  const service = createProactiveChatService({ loadState: load, saveState: save, getSnapshot: snapshot,
    requiresDurableIntent: () => true, getDeliveryTarget: () => 'local',
    buildMessages: async value => { activeCandidate = value; return [{ role: 'user', content: value.momentSummary }]; },
    beforeModel: value => store.markAttempt(value.opportunityId, now, clock(now).localDate, 44),
    runModel: async () => {
      const value = store.find(activeCandidate.opportunityId), draw = fixtureDecisions ? model() : 1;
      const decision = draw < 0.09 ? 'hold' : draw < 0.18 ? 'drop' : 'send';
      decisions.push({ at: new Date(now).toISOString(), motive: value.motive, decision });
      return decision === 'send' ? { kind: 'send', text: value.summary }
        : decision === 'hold' ? { kind: 'hold', resumeOn: 'evidence_change' } : { kind: 'drop' };
    },
    getFallback: async () => null,
    validateCandidate: value => {
      const entry = store.find(value.opportunityId);
      return !entry || entry.expiresAt <= now || ['dropped', 'expired'].includes(entry.status) ? 'invalid_fixture_source' : undefined;
    },
    onOpportunityDecision: (value, decision, input) => assert.ok(store.resolve(value.opportunityId, decision, input)),
    commitMessage: async input => {
      const item = store.find(input.candidate.opportunityId);
      assert.ok(input.intentId && load().pendingCommitIntent?.intentId === input.intentId, 'Delivery needs an actual durable intent');
      deliveries.push({ at: new Date(now).toISOString(), localDate: clock(now).localDate, intentId: input.intentId,
        sourceEventId: item.sourceEventId, motive: item.motive, replyBurden: item.replyBurden });
      if (respond) replyAt = now + 2 * MINUTE;
      return { kind: 'committed' };
    },
  });
  return { service, deliveries, decisions, chance, load,
    get store() { return store; },
    setNow(value) { now = value; },
    restart() { store = new InitiativeOpportunityStore(opportunityPath, chance); },
    async tick(at, available, options = {}) {
      now = at;
      if (replyAt !== undefined && now >= replyAt) {
        service.invalidateForUserMessage(); service.normalConversationStarted(); service.normalConversationEnded(now);
        store.resume('user_message', now); replyAt = undefined;
      }
      if (options.suspended) { store.suspend(now); return; }
      const state = load(), snap = snapshot();
      const selected = store.select({ now, opportunities: available, density,
        dayKey: clock(now).localDate, dailyAttemptLimit: 44,
        eligible: item => canStartProactiveGeneration(snap, state, candidate(item)).allowed });
      if (selected) await service.evaluateCandidate(candidate(selected));
    },
  };
}
function summarize(name, seed, density, h, extra = {}) {
  const days = {}, motives = {}, intervalsMinutes = [], withinDayIntervals = [];
  let questions = 0;
  h.deliveries.forEach((entry, index) => {
    const day = days[entry.localDate] ??= { sends: 0, questions: 0 };
    day.sends++; motives[entry.motive] = (motives[entry.motive] ?? 0) + 1;
    if (entry.replyBurden === 'question') { questions++; day.questions++; }
    if (index) {
      const interval = (Date.parse(entry.at) - Date.parse(h.deliveries[index - 1].at)) / MINUTE;
      intervalsMinutes.push(interval);
      if (entry.localDate === h.deliveries[index - 1].localDate) withinDayIntervals.push(interval);
    }
  });
  for (const day of Object.values(days)) {
    assert.ok(day.sends <= 20, 'Daily cap'); assert.ok(day.questions <= 3, 'Daily question cap');
  }
  for (const entry of h.deliveries) {
    const end = Date.parse(entry.at);
    assert.ok(h.deliveries.filter(other => Date.parse(other.at) > end - HOUR && Date.parse(other.at) <= end).length <= 4, 'Rolling hourly cap');
  }
  assert.ok(intervalsMinutes.every(value => value >= 3), 'Anti-flood gap');
  return { scenario: name, seed, density, sends: h.deliveries.length, modelCalls: h.decisions.length,
    questions, questionRatio: h.deliveries.length ? questions / h.deliveries.length : 0,
    days, motives, intervalsMinutes, withinDayIntervals, chanceDraws: h.chance.calls(),
    decisions: h.decisions, deliveries: h.deliveries, ...extra };
}
async function dayScenario(seed, density, label, respond = true, days = 1) {
  const h = harness(`${label}-${density}-${seed}`, seed, density, { respond });
  const pool = sources(seed, days), end = START + (days - 1) * DAY + 14 * HOUR;
  for (let now = START; now < end; now += MINUTE) {
    await h.tick(now, pool.filter(item => item.occurredAt <= now && item.expiresAt > now));
  }
  if (!respond) assert.ok(h.deliveries.length <= 2, 'Three unanswered days cannot produce a third opening');
  return summarize(respond ? 'rich_engaged' : 'no_reply', seed, density, h, { sourceCount: pool.length, simulatedDays: days });
}
async function noEvents(seed) {
  const h = harness(`no-events-${seed}`, seed, 'active');
  h.service.normalConversationEnded(START);
  const checkpoints = [];
  for (const elapsed of [0, 3, 29, 30, 31, 60, 180]) {
    await h.tick(START + elapsed * MINUTE, []);
    checkpoints.push({ minute: elapsed, sends: h.deliveries.length, modelCalls: h.decisions.length });
  }
  assert.equal(h.deliveries.length, 0); assert.equal(h.decisions.length, 0); assert.equal(h.chance.calls(), 0);
  return summarize('no_events', seed, 'active', h, { checkpoints });
}
async function offline(seed) {
  const h = harness(`offline-${seed}`, seed, 'active', { fixtureDecisions: false });
  const item = { ...sources(seed, 1)[0], id: 'offline-proof', sourceEventId: 'offline-proof', occurredAt: START,
    expiresAt: START + 6 * HOUR, strengthPerHour: 0, decayPerHour: 0, replyBurden: 'none' };
  await h.tick(START, [item]);
  const original = h.store.find(item.id), threshold = original.threshold;
  item.strengthPerHour = Math.min(120, threshold * 4);
  await h.tick(START + MINUTE, [item]); await h.tick(START + 2 * MINUTE, [item]);
  const before = h.store.find(item.id).accumulated, draws = h.chance.calls();
  await h.tick(START + 3 * MINUTE, [], { suspended: true });
  h.restart();
  const resumeAt = START + 2 * HOUR;
  await h.tick(resumeAt, [item]);
  assert.equal(h.store.find(item.id).threshold, threshold, 'Restart must not reroll');
  assert.equal(h.store.find(item.id).accumulated, before, 'Offline time cannot add pressure');
  assert.equal(h.chance.calls(), draws); assert.equal(h.deliveries.length, 0, 'No catch-up send on resume');
  for (let minute = 1; minute <= 30; minute++) await h.tick(resumeAt + minute * MINUTE, [item]);
  assert.ok(h.deliveries.filter(entry => Date.parse(entry.at) < resumeAt + 3 * MINUTE).length === 0, 'No resume burst');
  return summarize('offline_resume', seed, 'active', h, { thresholdBefore: threshold,
    thresholdAfter: h.store.find(item.id).threshold, accumulatedBefore: before, accumulatedOnResume: before,
    offlineMinutes: 117, resumeAt: new Date(resumeAt).toISOString(), drawsBeforeRestart: draws });
}

try {
  const runs = [];
  let replayModelCalls = 0;
  for (const seed of seeds) {
    for (const density of ['quiet', 'natural', 'active']) runs.push(await dayScenario(seed, density, 'engaged'));
    const replay = await dayScenario(seed, 'active', 'replay');
    replayModelCalls += replay.modelCalls;
    assert.deepEqual(replay, runs.find(run => run.seed === seed && run.scenario === 'rich_engaged' && run.density === 'active'), 'Same seed must reproduce the full trace');
    runs.push(await dayScenario(seed, 'active', 'unanswered', false, 3), await noEvents(seed), await offline(seed));
  }
  const active = runs.filter(run => run.scenario === 'rich_engaged' && run.density === 'active');
  const intervals = active.flatMap(run => run.withinDayIntervals);
  const nearThirty = intervals.filter(value => value >= 29 && value <= 31).length;
  assert.ok(intervals.length > 0 && new Set(intervals).size >= 3, 'Rich fixtures should exercise varied timing');
  assert.ok(nearThirty / intervals.length < 0.5, 'Openings must not concentrate around a thirty-minute period');
  const modeTotals = Object.fromEntries(['quiet', 'natural', 'active'].map(density => [density,
    runs.filter(run => run.scenario === 'rich_engaged' && run.density === density).reduce((sum, run) => sum + run.sends, 0)]));
  const report = { version: 1, timezone: 'Asia/Shanghai', startsAt: new Date(START).toISOString(), seeds,
    environment: { node: process.version, mechanism: 'actual opportunity store, policy and durable service; seeded fixture sources/model; isolated local receipts' },
    limits: { dailySends: 20, rollingHourlySends: 4, dailyQuestions: 3, minimumGapMinutes: 3, dailyModelAttempts: 44 },
    checks: ['same-seed full trace replay', 'daily/hourly/question caps', 'no third unanswered opening across three days',
      'no events at 29/30/31 minutes => zero model calls', 'offline interval adds no pressure', 'restart retains threshold without a new draw',
      'resume creates no immediate catch-up burst', 'rich intervals do not concentrate at thirty minutes'],
    modeTotals, timing: { richIntervalCount: intervals.length, distinctIntervals: [...new Set(intervals)].sort((a, b) => a - b), nearThirtyFraction: nearThirty / intervals.length },
    sourceDigests, bundledMechanismSha256: createHash('sha256').update(bundle.outputFiles[0].text).digest('hex'),
    modelCallAccounting: { scenarios: runs.reduce((sum, run) => sum + run.modelCalls, 0), deterministicReplays: replayModelCalls,
      totalFixtureCalls: runs.reduce((sum, run) => sum + run.modelCalls, 0) + replayModelCalls, realApiRequests: 0 },
    traceSha256: createHash('sha256').update(JSON.stringify(runs)).digest('hex'), runs,
    limitations: ['Mechanism and constructed content only; no real model quality, real channel delivery or human reply behavior was verified.',
      'Fixture availability and seeds are not daily message targets. Quiet/natural/active share identical source pools; per-run totals can vary.'] };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.checks.length, seeds, modeTotals, nearThirtyFraction: report.timing.nearThirtyFraction,
    noReplySends: runs.filter(run => run.scenario === 'no_reply').map(run => run.sends),
    modelCallAccounting: report.modelCallAccounting, traceSha256: report.traceSha256, report: path.relative(repo, reportPath) }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
