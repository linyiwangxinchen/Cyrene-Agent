import { randomUUID } from "node:crypto";
import { createAuthenticatedReader, floorsFromHtml, publicPage, repliesFromHtml, threadId, threadTitle, threadsFromHtml, TiebaPageError, TIEBA } from "./public-pages.mjs";
import { writeReadingNote } from "./notes.mjs";
import { createReadSession } from "./session.mjs";
import { chooseVisitBars } from "./visit-interests.mjs";

const HOUR = 3_600_000;
const READING_LIMIT = 36;
const VISIT_LIMIT = 50;
const DEFAULT_CONFIG = { bars: [], bar: "", learn: false, auto: false, replies: false, intervalHours: 4, postsPerVisit: 1 };

function clamp(value, min, max, fallback) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

function barName(value) {
  return typeof value === "string" ? value.trim().slice(0, 50) : "";
}

function configFrom(raw) {
  const bars = [...new Set((Array.isArray(raw?.bars) ? raw.bars.slice(0, 32) : [raw?.bar]).map(barName).filter(Boolean))].slice(0, 8);
  return {
    ...DEFAULT_CONFIG, bars, bar: bars[0] ?? "",
    learn: raw?.learn === true, auto: raw?.auto === true, replies: raw?.replies === true,
    intervalHours: clamp(raw?.intervalHours, 1, 24, DEFAULT_CONFIG.intervalHours),
    postsPerVisit: clamp(raw?.postsPerVisit, 1, 5, DEFAULT_CONFIG.postsPerVisit),
  };
}

function formatError(error) {
  return error instanceof Error ? error.message.slice(0, 220) : "贴吧操作失败";
}

function readingUrl(tid, page) {
  return TIEBA + "/p/" + tid + (page > 1 ? "?pn=" + page : "");
}

function barPage(bar, authenticated) {
  const query = "kw=" + encodeURIComponent(bar);
  return authenticated ? "/mo/q/m?" + query + "&pn=0" : "/f?" + query;
}

function legacyReading(reading) {
  if (!reading || !/^\d{1,20}$/.test(reading.tid ?? "") || !Array.isArray(reading.floors)) return undefined;
  return {
    title: "帖子 " + reading.tid, url: readingUrl(reading.tid), bar: "",
    analysisStatus: "skipped", summary: "", evidence: [], sampleIds: [], ...reading,
  };
}

function recoveryVisits(visits, now) {
  return visits.map(visit => visit.status === "running"
    ? { ...visit, status: "cancelled", finishedAt: now, errors: [...visit.errors, "上一次逛吧在插件停止时中断"] }
    : visit);
}

export function createForum(ctx, { page, now = Date.now } = {}) {
  const config = () => configFrom(ctx.storage.get("config"));
  const session = createReadSession(ctx.deps.secrets);
  const authenticated = createAuthenticatedReader();
  const readPage = page ?? ((path, signal, cookie) => publicPage(path, signal, cookie, authenticated.read));
  const loaded = ctx.storage.get("forum");
  const oldReading = legacyReading(ctx.storage.get("reading"));
  let data = {
    readings: oldReading ? [oldReading] : [],
    samples: ctx.storage.get("expressions") ?? [],
    visits: [],
    seen: oldReading ? [oldReading.tid] : [],
    forgotten: [],
    visitsStarted: 0,
    lastVisit: ctx.storage.get("lastVisit"),
    status: ctx.storage.get("status") ?? "",
    ...loaded,
  };
  data = {
    ...data,
    readings: data.readings.map(row => row.analysisStatus === "pending"
      ? { ...row, analysisStatus: "failed", analysisError: "上一次手记分析中断，可用保留的楼层重试" }
      : row),
    visits: recoveryVisits(data.visits, now()),
  };
  const save = patch => {
    const next = { ...data, ...patch };
    ctx.storage.set("forum", next);
    data = next;
  };
  function saveReading(row, samples = data.samples) {
    const readings = [row, ...data.readings.filter(old => old.tid !== row.tid)].sort((a, b) => b.at - a.at).slice(0, READING_LIMIT);
    const seen = [row.tid, ...data.seen.filter(id => id !== row.tid)].slice(0, 500);
    save({ readings, samples, seen });
  }
  let active;
  let manualDiscovery = false;
  let status = data.status;
  async function start(job, background, compact) {
    if (active || manualDiscovery) throw new Error("昔涟正在逛吧，请等本轮结束");
    ctx.signal.throwIfAborted();
    const work = Promise.resolve().then(job).catch(error => {
      status = formatError(error);
      if (!ctx.signal.aborted) save({ status });
      throw error;
    }).finally(() => { active = undefined; });
    active = work;
    if (background) void work.catch(() => {});
    else await work;
    return state(compact);
  }

  async function discover(bar) {
    if (!bar) throw new Error("请先填写常逛的吧");
    const cookie = await session.requestCookie();
    const html = await readPage(barPage(bar, Boolean(cookie)), ctx.signal, cookie);
    const items = threadsFromHtml(html, bar);
    if (!items.length) throw new TiebaPageError("这个吧的页面未返回可读帖子，可打开原帖或导入楼层摘录。");
    const read = new Set(data.seen);
    return items.map(item => ({ ...item, read: read.has(item.id) }));
  }

  async function analyze(reading) {
    const allowLearning = config().learn;
    const llm = ctx.deps.llm;
    if (!llm) {
      const stored = { ...reading, analysisStatus: "unavailable", analysisError: "宿主没有配置可用的模型服务" };
      saveReading(stored);
      return stored;
    }
    status = "正在写手记 · " + reading.title;
    if (reading.analysisStatus !== "pending") saveReading({ ...reading, analysisStatus: "pending", analysisError: "" });
    try {
      const result = await writeReadingNote(llm, reading, allowLearning, ctx.signal, now());
      const samples = new Map(data.samples.map(row => [row.id, row]));
      const accepted = config().learn ? result.samples.filter(sample => !data.forgotten.includes(sample.id)) : [];
      const current = data.readings.find(row => row.tid === reading.tid) ?? reading;
      for (const sample of accepted) {
        // Keep the original learning timestamp on re-analysis so daily recaps do not repeat it.
        if (!samples.has(sample.id)) samples.set(sample.id, sample);
      }
      const stored = {
        ...reading, summary: result.summary || reading.summary, evidence: result.evidence.length ? result.evidence : reading.evidence,
        analysisStatus: "complete", analysisError: "",
        sampleIds: [...new Set([...current.sampleIds, ...accepted.map(sample => sample.id)])],
      };
      saveReading(stored, [...samples.values()].slice(-500));
      return stored;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const current = data.readings.find(row => row.tid === reading.tid) ?? reading;
      const stored = { ...current, analysisStatus: "failed", analysisError: formatError(error) };
      saveReading(stored);
      return stored;
    }
  }

  async function fetchReading(args, onRead) {
    const tid = threadId(args.url);
    const number = new URL(String(args.url), TIEBA).searchParams.get("pn");
    const pageNumber = clamp(Number(number), 1, 1000, 1);
    const imported = typeof args.excerpt === "string" ? args.excerpt.trim().slice(0, 10_000) : "";
    const old = data.readings.find(row => row.tid === tid);
    const bar = barName(args.bar) || old?.bar || "";
    let title = typeof args.title === "string" ? args.title.trim().slice(0, 160) : "";
    status = "正在读帖 · " + (title || tid);
    const cookie = imported ? undefined : await session.requestCookie();
    let floors;
    if (imported) {
      floors = [{ post: "", body: imported, page: pageNumber }];
    } else {
      const path = cookie
        ? "/mo/q/m?kz=" + tid + "&pn=" + pageNumber
        : "/p/" + tid + (pageNumber > 1 ? "?pn=" + pageNumber : "");
      const html = await readPage(path, ctx.signal, cookie);
      title = threadTitle(html) || title;
      floors = floorsFromHtml(html, Boolean(cookie)).map(floor => ({ ...floor, page: pageNumber }));
    }
    if (!floors.length) throw new Error("没有读到帖子楼层。可在浏览器查看原帖后导入摘录。");

    let replyStatus = "";
    let limited = false;
    const refreshedReplies = new Set();
    if (!imported && config().replies) {
      const parents = floors.filter(floor => floor.post).slice(0, 2);
      if (!parents.length) replyStatus = "楼中楼 · 当前页面未提供可定位的楼层 ID";
      for (const floor of parents) {
        try {
          const html = await readPage("/p/comment?tid=" + tid + "&pid=" + floor.post + "&pn=1", ctx.signal, cookie);
          floors.push(...repliesFromHtml(html, floor.post).map(reply => ({ ...reply, page: pageNumber })));
          refreshedReplies.add(floor.post);
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          replyStatus = "楼中楼 · " + formatError(error);
          limited = error instanceof TiebaPageError && error.pauseVisit;
          break;
        }
      }
    }
    ctx.signal.throwIfAborted();
    // Bound stored text and send the same excerpts to the model and the detail panel.
    if (old && !imported && !old.imported) {
      const currentPosts = new Set(floors.map(floor => floor.post));
      floors.push(...old.floors.filter(floor => (floor.page ?? 1) !== pageNumber ||
        (floor.reply && currentPosts.has(floor.post) && !refreshedReplies.has(floor.post))));
    }
    let remaining = 12_000;
    floors = floors.flatMap(floor => {
      if (remaining <= 0) return [];
      const body = floor.body.slice(0, remaining);
      remaining -= body.length;
      return [{ ...floor, body }];
    });
    const reading = {
      tid, url: readingUrl(tid, pageNumber), title: title || old?.title || "帖子 " + tid,
      bar, at: now(), floors, imported: Boolean(imported), replyStatus, limited,
      summary: "", evidence: [], sampleIds: old?.sampleIds ?? [], analysisStatus: "pending", analysisError: "",
    };
    saveReading(reading);
    onRead?.(reading.tid);
    return analyze(reading);
  }

  function selectedBar(value) {
    const bar = barName(value);
    if (bar && !config().bars.includes(bar)) throw new Error("请从已保存的常逛吧中选一个");
    return bar;
  }

  async function visit(trigger, target) {
    const cfg = config();
    const savedBars = target ? [target] : cfg.bars;
    const priorVisits = data.visits;
    const previousCount = data.visitsStarted;
    const index = !target && savedBars.length ? previousCount % savedBars.length : 0;
    const visitsStarted = target ? previousCount : previousCount + 1;
    const rotations = [...savedBars.slice(index), ...savedBars.slice(0, index)];
    const record = { id: randomUUID(), at: now(), trigger, bars: [], status: "running", read: [], errors: [], discovered: 0, skipped: 0 };
    const update = patch => {
      const row = { ...record, ...patch };
      save({ visits: [row, ...data.visits.filter(old => old.id !== row.id)].slice(0, VISIT_LIMIT), visitsStarted, lastVisit: record.at, status });
    };
    const seen = new Set(data.seen);
    const knownCandidates = new Set();
    let stop = false;
    status = target ? "正在逛吧" : "正在挑想逛的吧";
    update();
    try {
      const choices = target ? [] : await chooseVisitBars(ctx.deps.llm, {
        favorites: savedBars, readings: data.readings, visits: priorVisits, signal: ctx.signal,
      });
      if (trigger === "auto" && !config().auto) return;
      const picked = choices[0];
      let bars = rotations;
      let minimumListings = 1;
      if (picked) {
        record.chosenBar = picked.bar;
        record.choiceReason = picked.reason;
        if (rotations.length) {
          const [favorite, ...remaining] = rotations;
          // Each favorite leads one cycle and follows the personal pick on the other.
          const preferChoice = index % 2 !== Math.floor(previousCount / rotations.length) % 2;
          const firstBars = preferChoice ? [picked.bar, favorite] : [favorite, picked.bar];
          bars = [...firstBars, ...remaining];
          minimumListings = firstBars.length;
        } else {
          bars = choices.map(choice => choice.bar);
        }
      }
      const candidates = [];
      for (const bar of bars) {
        if (trigger === "auto" && !config().auto) { stop = true; break; }
        record.bars.push(bar);
        status = "正在看帖子列表 · " + bar + (/吧$/.test(bar) ? "" : "吧");
        update();
        try {
          const items = (await discover(bar)).filter(item => !knownCandidates.has(item.id));
          items.forEach(item => knownCandidates.add(item.id));
          record.discovered += items.length;
          record.skipped += items.filter(item => seen.has(item.id)).length;
          candidates.push(items.filter(item => !seen.has(item.id)));
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          record.errors.push(bar + "吧 · " + formatError(error));
          if (error instanceof TiebaPageError && error.pauseVisit) { stop = true; break; }
        }
        if (record.bars.length >= minimumListings && candidates.reduce((count, rows) => count + rows.length, 0) >= cfg.postsPerVisit) break;
      }
      let attempted = 0;
      while (!stop && candidates.some(items => items.length) && record.read.length < cfg.postsPerVisit && attempted < cfg.postsPerVisit + 2) {
        for (const items of candidates) {
          if (record.read.length >= cfg.postsPerVisit || attempted >= cfg.postsPerVisit + 2) break;
          if (trigger === "auto" && !config().auto) { stop = true; break; }
          const item = items.shift();
          if (!item) continue;
          attempted++;
          try {
            const reading = await fetchReading(item, tid => {
              record.read.push(tid);
              update();
            });
            if (reading.replyStatus) record.errors.push(item.title + " · " + reading.replyStatus);
            if (reading.analysisError) record.errors.push(item.title + " · " + reading.analysisError);
            if (reading.limited) { stop = true; update(); break; }
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            record.errors.push(item.title + " · " + formatError(error));
            if (error instanceof TiebaPageError && error.pauseVisit) { stop = true; break; }
          }
          update();
        }
      }
    } finally {
      const complete = ctx.signal.aborted || (trigger === "auto" && !config().auto) ? "cancelled"
        : record.read.length ? record.errors.length ? "partial" : "complete"
        : record.errors.length ? "failed" : "empty";
      status = (record.read.length ? "读了 " + record.read.length + " 篇帖子"
        : complete === "empty" ? "这一轮没有新的可读帖子" : "这一轮未完成")
        + (record.errors.length ? " · " + record.errors[0] : "");
      if (!ctx.signal.aborted) update({ finishedAt: now(), status: complete });
    }
  }

  function nextVisitAt(cfg = config()) {
    if (cfg.auto && data.lastVisit !== undefined) return data.lastVisit + cfg.intervalHours * HOUR;
    return undefined;
  }

  async function state(compact) {
    const auth = await session.state();
    const cfg = config();
    const history = compact ? data.readings.map(({ floors, ...row }) => ({ ...row, floorCount: floors.length })) : data.readings;
    return {
      config: cfg, auth, reading: history[0], history, visits: data.visits,
      samples: data.samples, busy: Boolean(active) || manualDiscovery, status, nextVisitAt: nextVisitAt(cfg),
    };
  }

  async function checkSession(bar) {
    const cookie = await session.requestCookie();
    if (!cookie) throw new Error("请先保存可读取的贴吧 Cookie");
    const target = bar || config().bar || "贴吧";
    let status, message;
    try {
      authenticated.clear();
      const html = await readPage(barPage(target, true), ctx.signal, cookie);
      const readable = threadsFromHtml(html, target).length > 0;
      status = readable ? "accessible" : "unreadable";
      message = readable
        ? "贴吧已确认登录，帖子列表可读。"
        : "贴吧返回了页面，但未读取到帖子列表。";
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      status = error instanceof TiebaPageError && error.pauseVisit ? "blocked" : "error";
      message = status === "blocked"
        ? "检查无法判断 Cookie 是否仍有效。" + formatError(error)
        : error instanceof TiebaPageError ? formatError(error) : "暂时无法读取贴吧，请稍后再检查。";
    }
    session.recordCheck({ status, message, at: now(), bar: target });
  }

  return {
    readings: () => data.readings,
    learnedExpressions: () => config().learn ? data.samples : [],
    backgroundTick() {
      const cfg = config();
      if (!active && !manualDiscovery && !ctx.signal.aborted && cfg.auto &&
        (nextVisitAt(cfg) ?? 0) <= now()) void start(() => visit("auto"), true).catch(() => {});
    },
    async invoke(cmd, value) {
      const args = value && typeof value === "object" ? value : {};
      if (cmd === "state") return state(args.compact === true);
      if (cmd === "auth-save" || cmd === "auth-clear" || cmd === "auth-check") {
        if (active || manualDiscovery) throw new Error("请等本轮逛吧结束后再管理登录会话");
        manualDiscovery = true;
        try {
          if (cmd === "auth-check") await checkSession(barName(args.bar));
          else {
            if (cmd === "auth-save") await session.save(args.cookie);
            else await session.clear();
            authenticated.clear();
          }
        } finally {
          manualDiscovery = false;
        }
        return state(args.compact === true);
      }
      if (cmd === "save") {
        const old = config();
        const next = { ...old, ...args };
        if (Object.hasOwn(args, "bar") && !Object.hasOwn(args, "bars")) next.bars = [args.bar];
        ctx.storage.set("config", configFrom(next));
      } else if (cmd === "discover") {
        if (active || manualDiscovery) throw new Error("昔涟正在逛吧，请等本轮结束");
        manualDiscovery = true;
        try { return await discover(selectedBar(args.bar) || config().bar); }
        finally { manualDiscovery = false; }
      } else if (cmd === "visit") {
        const target = selectedBar(args.bar);
        return start(() => visit("manual", target), args.background !== false, args.compact === true);
      } else if (cmd === "read") {
        threadId(args.url);
        return start(async () => {
          const reading = await fetchReading(args);
          const issue = reading.replyStatus || reading.analysisError;
          status = issue ? "楼层已保存 · " + issue : "已读 · " + reading.title;
          save({ status });
        }, args.background === true, args.compact === true);
      } else if (cmd === "detail" || cmd === "analyze") {
        const reading = data.readings.find(row => row.tid === args.tid);
        if (!reading) throw new Error("这条阅读记录已不在读帖历史中");
        if (cmd === "detail") return reading;
        return start(async () => {
          const result = await analyze(reading);
          status = result.analysisError ? "楼层已保存 · " + result.analysisError : "手记已整理 · " + reading.title;
          save({ status });
        }, args.background === true, args.compact === true);
      } else if (cmd === "forget") {
        const samples = data.samples.filter(row => row.id !== args.id);
        const readings = data.readings.map(row => ({ ...row, sampleIds: row.sampleIds.filter(id => id !== args.id) }));
        const forgotten = typeof args.id === "string" && /^[a-f0-9]{64}$/.test(args.id)
          ? [...new Set([...data.forgotten, args.id])].slice(-1000)
          : data.forgotten;
        save({ samples, readings, forgotten });
      } else {
        throw new Error("未知操作");
      }
      return state(args.compact === true);
    },
  };
}
