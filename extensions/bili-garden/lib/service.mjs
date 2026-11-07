import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { GardenStore } from "./store.mjs";
import { PythonRuntime } from "./python.mjs";
import { BilibiliClient } from "./bilibili.mjs";
import { GardenRunner } from "./runner.mjs";
import { InteractionPolicy, worthwhile } from "./policy.mjs";
import { due, localClock, videoId, withinWindow } from "./config.mjs";
import { markdownReport, timePlaylist } from "./content.mjs";

export class GardenService {
  constructor(
    ctx,
    packageRoot,
    { client, runtime, store, now = () => Date.now(), schedule = true, onInterestingItem } = {},
  ) {
    this.ctx = ctx;
    this.packageRoot = packageRoot;
    this.now = now;
    this.onInterestingItem = onInterestingItem;
    this.closed = false;
    this.active = null;
    this.scanBusy = false;
    this.store = store ?? new GardenStore(ctx.storage.rootDir(), { now });
    this.root = this.store.root;
    this.runtime =
      runtime ??
      new PythonRuntime(this.root, packageRoot, {
        config: () => this.store.config(),
        credentials: () => this.client.credentials(),
        log: (m) => this.log(m),
      });
    this.client =
      client ??
      new BilibiliClient({ secrets: ctx.deps.secrets, runtime: this.runtime });
    this.policy = new InteractionPolicy({
      store: this.store,
      client: this.client,
      config: () => this.store.config(),
      account: () => this.account(),
      now,
    });
    this.runner = new GardenRunner({
      store: this.store,
      client: this.client,
      policy: this.policy,
      llm: ctx.deps.llm,
      config: () => this.store.config(),
      charter: async () => this.charter(),
      pluginId: ctx.id,
    });
    this.ensureCharter();
    if (schedule) {
      this.timer = setInterval(() => {
        this.tick().catch((e) => this.log(e.message, "error"));
      }, 30000);
      this.timer.unref?.();
    }
  }
  log(message, kind = "info") {
    if (!this.closed) this.store.log(message, kind);
  }
  ensureCharter() {
    const shipped = readFileSync(
        path.join(this.packageRoot, "charter.md"),
        "utf8",
      ),
      file = path.join(this.root, "charter.md");
    const sha = (t) => createHash("sha256").update(t).digest("hex"),
      previous = this.store.get("meta", "charter-hash");
    if (!existsSync(file) || sha(readFileSync(file, "utf8")) === previous) {
      writeFileSync(file, shipped);
      this.store.put("meta", "charter-hash", sha(shipped));
    } else if (sha(readFileSync(file, "utf8")) !== sha(shipped))
      writeFileSync(path.join(this.root, "charter.md.new"), shipped);
  }
  charter() {
    return readFileSync(path.join(this.root, "charter.md"), "utf8").slice(
      0,
      8000,
    );
  }
  async account(force = false) {
    if (!force && this.accountCache && this.now() - this.accountAt < 60000)
      return this.accountCache;
    const value = await this.client.account(this.ctx.signal);
    this.accountAt = this.now();
    return (this.accountCache = value);
  }
  async snapshot() {
    let account;
    try {
      account = await this.account();
    } catch {
      account = {
        loggedIn: false,
        error: "账号检查失败，请检查网络或重新登录",
      };
    }
    const day = localClock(
      new Date(this.now()),
      this.store.config().timezone,
    ).day;
    return {
      config: this.store.config(),
      account,
      environment: this.runtime.status(),
      run: this.active ? this.store.run(this.active.id) : null,
      runs: this.store.runs(25),
      videos: this.store.list("video", 150),
      reports: this.store.list("report", 40),
      memories: this.store.list("memory", 60),
      actions: this.store.actions(100),
      questions: this.store.list("question", 30),
      events: this.store.list("event", 35),
      cooldown: this.store.get("meta", "cooldown"),
      guard: this.guardStatus(account),
      stats: {
        day,
        picked: this.store.picked(day),
        asr: this.store.counter("asr", day),
        likes: this.store.countActions("like", day),
        favs: this.store.countActions("fav", day),
      },
      profiles: (await this.ctx.deps.llm.listProfiles?.()) ?? [],
      charter: this.charter(),
    };
  }
  guardStatus(account) {
    const cfg = this.store.config();
    const clock = localClock(new Date(this.now()), cfg.timezone);
    const paused = !cfg.guardOn ? "评论守护未开启"
      : !account.loggedIn ? "尚未登录 B 站"
      : this.active ? "当前任务结束后继续扫描"
      : withinWindow(clock.minute, cfg.quietStart, cfg.quietEnd) ? "静默时段内，后台扫描暂停"
      : !cfg.guardPerRound || this.store.countActions("reply", clock.day) >= cfg.guardPerDay ? "回复额度已用完或设为 0"
      : "按设置的间隔扫描 @ 和评论";
    return { message: paused, autoSend: cfg.autoSend, whitelistEmpty: !cfg.guardWhitelist.length,
      lastScan: account.uid ? this.store.get("guard-scan", account.uid) : null,
      retryable: account.uid ? this.store.retryableMentions(account.uid).filter(item => cfg.guardWhitelist.includes(String(item.uid))).length : 0 };
  }
  async start({
    source = "manual",
    kind = "discover",
    bvid,
    question,
    guardItems,
  } = {}) {
    if (this.closed) throw new Error("插件已停止");
    if (this.active || this.scanBusy || this.runtime.status().installing)
      throw new Error("已有任务、评论扫描或环境安装正在运行");
    if (!["discover", "question", "guard"].includes(kind))
      throw new Error("任务类型无效");
    if (bvid) bvid = videoId(bvid);
    if (kind === "question" && (!bvid || !String(question || "").trim()))
      throw new Error("请选择视频并填写问题");
    const account = await this.account();
    if (!account.loggedIn) throw new Error("请先在设置中登录 B 站");
    if (this.active || this.closed) throw new Error("已有任务运行或插件已停止");
    const cfg = this.store.config();
    if (
      cfg.modelProfileId &&
      this.ctx.deps.llm.listProfiles &&
      !(await this.ctx.deps.llm.listProfiles()).some(
        (p) => p.id === cfg.modelProfileId,
      )
    )
      throw new Error("选择的模型档案已删除，请重新选择");
    const day = localClock(new Date(this.now()), cfg.timezone).day;
    if (
      kind === "discover" &&
      (cfg.perRound === 0 || this.store.picked(day) >= cfg.perDay)
    )
      throw new Error("今天的阅读额度已用完或设置为 0");
    const run = this.store.startRun({ day, source, kind });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.ctx.signal]);
    const active = { id: run.id, controller, promise: null };
    this.active = active;
    this.log(
      `开始${kind === "guard" ? "守护评论" : kind === "question" ? "视频追问" : "发现视频"}`,
    );
    active.promise = (async () => {
      try {
        const result = await this.runner.run(
          run,
          { bvid, question, guardItems },
          signal,
        );
        if (!this.closed && result?.report && this.onInterestingItem) {
          const report = result.report;
          for (const item of report.items ?? []) {
            try {
              await this.onInterestingItem({
                eventId: `${run.id}:${item.bvid}`,
                occurredAt: this.now(),
                bvid: item.bvid,
                title: item.title,
                summary: item.summary,
                say: report.say,
                url: `https://www.bilibili.com/video/${item.bvid}`,
              });
            } catch (error) {
              this.log(`陪伴观察事件发布失败：${error.message}`, "error");
            }
          }
        }
        if (!this.closed)
          this.store.updateRun(run.id, {
            status: "success",
            ended: this.now(),
            phase: "已完成",
            usage: result.usage ?? null,
            rounds: result.rounds,
          });
      } catch (e) {
        if (!this.closed) {
          this.store.updateRun(run.id, {
            status: signal.aborted ? "cancelled" : "failed",
            ended: this.now(),
            phase: signal.aborted ? "已取消" : "未完成",
            error: String(e.message).slice(0, 500),
          });
          this.log(
            signal.aborted ? "任务已取消" : `任务未完成：${e.message}`,
            "error",
          );
        }
      } finally {
        if (this.active === active) this.active = null;
      }
    })();
    return { started: true, runId: run.id };
  }
  cancel() {
    this.active?.controller.abort();
    this.installController?.abort();
    this.runtime.stopWorker(new Error("用户取消了任务"));
    return { cancelled: true };
  }
  async tick() {
    if (this.closed || this.active || this.scanBusy || this.runtime.status().installing) return;
    const cfg = this.store.config();
    if (!cfg.autoRun && !cfg.guardOn) return;
    const account = await this.account();
    if (!account.loggedIn) return;
    const clock = localClock(new Date(this.now()), cfg.timezone);
    if (withinWindow(clock.minute, cfg.quietStart, cfg.quietEnd)) return;
    if (
      cfg.guardOn &&
      this.now() - this.store.get("meta", "last-guard", 0) >=
        cfg.guardMinutes * 60000
    ) {
      this.store.put("meta", "last-guard", this.now());
      const scan = await this.scanGuard();
      if (scan.items.length) {
        await this.start({
          source: "auto",
          kind: "guard",
          guardItems: scan.items,
        });
        return;
      }
    }
    if (
      due(cfg, {
        now: new Date(this.now()),
        runs: this.store.runs(100),
        picked: this.store.picked(clock.day),
        busy: Boolean(this.active),
        loggedIn: true,
      })
    )
      await this.start({ source: "auto" });
  }
  async scanGuard() {
    if (this.scanBusy || this.active) throw new Error("已有扫描或模型任务运行");
    const cfg = this.store.config();
    if (!cfg.guardOn) throw new Error("评论守护未启用");
    this.scanBusy = true;
    try {
      const account = await this.account();
      if (!account.loggedIn) throw new Error("请先登录");
      const day = localClock(new Date(this.now()), cfg.timezone).day;
      const room = Math.min(
        cfg.guardPerRound,
        Math.max(0, cfg.guardPerDay - this.store.countActions("reply", day)),
      );
      if (!room) return { items: [], message: "回复额度已用完或设为 0，本次未扫描" };
      const owner = cfg.guardOwnerUid || account.uid;
      const errors = [];
      let bvids = [];
      try {
        const videos = await this.client.call("bili_user_videos",
          { uid: Number(owner), pn: 1, ps: cfg.guardVideos, order: "pubdate" }, { signal: this.ctx.signal });
        bvids = (videos.videos ?? videos.list ?? []).map(v => v.bvid).filter(Boolean).slice(0, cfg.guardVideos);
      } catch {
        this.ctx.signal.throwIfAborted();
        errors.push("UP 视频列表读取失败；本轮仍扫描 @ 我的");
      }
      const cursor = this.store.get("cursor", account.uid, {
        id: 0,
        time: 0,
        ctimes: {},
      });
      let scan;
      try {
        scan = await this.client.call("bili_guard_scan", {
          bvids, since_at_id: cursor.id, since_at_time: cursor.time,
          since_ctimes: cursor.ctimes, at_resume: cursor.atResume ?? null, max_pages: 3,
        }, { signal: this.ctx.signal });
      } catch {
        this.ctx.signal.throwIfAborted();
        scan = { at: [], comments: [], errors: ["scan: failed"], at_cursor: cursor, at_resume: cursor.atResume ?? null };
      }
      if (scan.errors?.length) errors.push("部分通知或评论读取失败，将保留未完成进度重试");
      const atItems = scan.at ?? [];
      const allowedAt = atItems.filter(it => cfg.guardWhitelist.includes(String(it.uid)));
      const stats = { at: this.now(), receivedAt: scan.at_stats?.received ?? atItems.length,
        allowedAt: allowedAt.length, filteredAt: atItems.length - allowedAt.length,
        unsupported: scan.at_stats?.unsupported ?? 0, invalid: 0, queued: 0,
        errors, backlog: Boolean(scan.at_resume) };
      const incoming = [
        ...allowedAt
          .map((it) => ({ ...it, kind: "at", root: it.root_id || 0 })),
        ...(scan.comments ?? [])
          .filter(
            (it) =>
              (cfg.guardOwnAll ||
                cfg.guardWhitelist.includes(String(it.uid))) &&
              worthwhile(it.text),
          )
          .map((it) => ({ ...it, kind: "comment" })),
      ];
      this.store.transaction(() => {
        for (const it of incoming) {
          if (!/^BV[0-9A-Za-z]{10}$/.test(it.bvid || "") || !/^[1-9]\d*$/.test(String(it.rpid || ""))) {
            stats.invalid++;
            continue;
          }
          if (String(it.uid) === account.uid) continue;
          const id = `${account.uid}:${it.rpid}`;
          if (!this.store.get("guard", id)) {
            this.store.put("guard", id, {
              ...it, status: "pending", attempts: 0, accountUid: account.uid,
              ownerUid: owner, seenAt: this.now(),
            });
            stats.queued++;
          }
        }
        // Queue eligible items and cursor progress in one transaction.
        const ctimes = { ...cursor.ctimes };
        if (!scan.errors?.length) for (const c of scan.comments ?? [])
          ctimes[c.bvid] = Math.max(ctimes[c.bvid] || 0, Number(c.ctime) || 0);
        this.store.put("cursor", account.uid, {
          id: scan.at_cursor?.id ?? cursor.id,
          time: scan.at_cursor?.time ?? cursor.time,
          atResume: scan.at_resume ?? null,
          ctimes,
        });
        this.store.put("guard-scan", account.uid, stats);
      });
      if (errors.length) this.log(errors.join("；"), "error");
      this.log(`扫描 @ ${stats.receivedAt} 条，白名单通过 ${stats.allowedAt} 条，新入队 ${stats.queued} 条${stats.backlog ? "；还有历史通知待扫描" : ""}`);
      const pending = this.store.pendingGuard(account.uid, room);
      for (const it of pending)
        this.store.put("guard", it.id, { ...it, attempts: it.attempts + 1 });
      return { items: pending, message: `扫描完成：读取 @ ${stats.receivedAt} 条，白名单通过 ${stats.allowedAt} 条，本轮待处理 ${pending.length} 条${errors.length ? "；部分读取失败，详情见扫描状态" : ""}` };
    } finally {
      this.scanBusy = false;
    }
  }
  async dispatch(command, args = {}) {
    if (this.closed) throw new Error("插件已停止");
    switch (command) {
      case "snapshot":
        return this.snapshot();
      case "config": {
        if (
          args.modelProfileId &&
          this.ctx.deps.llm.listProfiles &&
          !(await this.ctx.deps.llm.listProfiles()).some(
            (p) => p.id === args.modelProfileId,
          )
        )
          throw new Error("模型档案不存在");
        const value = this.store.saveConfig(args);
        const run = this.active ? this.store.run(this.active.id) : null;
        if (
          run &&
          ((args.autoRun === false &&
            run.source === "auto" &&
            run.kind === "discover") ||
            (args.guardOn === false && run.kind === "guard"))
        )
          this.cancel();
        this.log("配置已保存");
        return value;
      }
      case "login-start":
        return this.client.loginStart(this.ctx.signal);
      case "login-poll": {
        const r = await this.client.loginPoll(args.key, this.ctx.signal);
        if (r.state === "ok") {
          this.accountCache = null;
          await this.account(true);
        }
        return r;
      }
      case "logout":
        this.cancel();
        await this.client.logout();
        this.accountCache = null;
        return { ok: true };
      case "install": {
        if (this.active || this.runtime.status().installing)
          throw new Error("请等待当前任务结束");
        this.installController = new AbortController();
        const signal = AbortSignal.any([
          this.installController.signal,
          this.ctx.signal,
        ]);
        this.installPromise = this.runtime
          .install({ asr: Boolean(args.asr), signal })
          .catch((e) => this.log(`环境安装未完成：${e.message}`, "error"));
        return { started: true };
      }
      case "run":
        return this.start({ bvid: args.bvid });
      case "question":
        return this.start({
          kind: "question",
          bvid: args.bvid,
          question: args.question,
        });
      case "cancel":
        return this.cancel();
      case "queue": {
        const bvid = videoId(args.bvid),
          old = this.store.get("video", bvid, { bvid, title: bvid });
        const state = args.status || "queued";
        if (!["queued", "watched", "removed"].includes(state))
          throw new Error("待看状态无效");
        return this.store.put("video", bvid, {
          ...old,
          queueStatus: state,
          queuedAt: this.now(),
        });
      }
      case "feedback": {
        const bvid = videoId(args.bvid),
          old = this.store.get("video", bvid);
        if (!old) throw new Error("视频不存在");
        if (!["like", "dislike", "neutral"].includes(args.value))
          throw new Error("反馈无效");
        this.store.put("video", bvid, { ...old, feedback: args.value });
        return { ok: true };
      }
      case "playlist":
        return timePlaylist(this.store.list("video", 1000), args.minutes);
      case "export": {
        const reports = this.store
          .list("report", 1000)
          .filter((r) =>
            args.week
              ? Date.parse(r.day) >= this.now() - 7 * 86400000
              : !args.day || r.day === args.day,
          )
          .reverse();
        return {
          filename: args.week
            ? "昔涟的一周发现.md"
            : `小花园-${args.day || "全部"}.md`,
          markdown: markdownReport(reports, {
            title: args.week ? "昔涟的一周发现" : "昔涟的 B 站小花园",
            day: args.day,
          }),
        };
      }
      case "evidence": {
        const e = this.store.get("evidence", videoId(args.bvid));
        if (!e) throw new Error("还没有读取字幕");
        return e;
      }
      case "memory-delete":
        this.store.remove("memory", String(args.id));
        return { ok: true };
      case "charter": {
        const value = String(args.text || "").trim();
        if (!value || value.length > 8000)
          throw new Error("任务章程需为 1–8000 字");
        writeFileSync(path.join(this.root, "charter.md"), value);
        return { ok: true };
      }
      case "send":
        return this.policy.execute(String(args.id), {
          signal: this.ctx.signal,
        });
      case "discard": {
        const a = this.store.action(String(args.id));
        if (!a || !["draft", "failed"].includes(a.status))
          throw new Error("只能放弃草稿或明确失败的互动");
        if (a.guard) {
          const id = `${a.accountUid}:${a.rpid}`;
          this.store.put("guard", id, {
            ...this.store.get("guard", id),
            status: "cancelled",
          });
        }
        return this.store.updateAction(a.id, "cancelled");
      }
      case "retry": {
        const a = this.store.action(String(args.id));
        if (!a || a.status !== "failed")
          throw new Error("只有明确失败的互动能重新送审");
        return this.store.updateAction(a.id, "draft");
      }
      case "undo":
        return this.policy.undo(String(args.id), this.ctx.signal);
      case "verify": {
        const a = this.store.action(String(args.id));
        if (!a || !["comment", "reply"].includes(a.kind))
          throw new Error("请选择评论记录");
        const r = await this.client.call(
          "bili_comments",
          { bvid: a.bvid, num: 100, order: "time" },
          { signal: this.ctx.signal },
        );
        const replies = (r.comments ?? []).flatMap((c) => [
            c,
            ...(c.replies ?? []),
          ]),
          found = replies.some(
            (c) => String(c.rpid) === String(a.receipt?.rpid),
          );
        return this.store.updateAction(a.id, a.status, {
          visibility: found
            ? "在当前账号下查到"
            : "在查询范围内未查到，不等于未发送",
          verifiedAt: this.now(),
        });
      }
      case "guard": {
        const r = await this.scanGuard();
        return r.items.length
          ? this.start({ kind: "guard", guardItems: r.items })
          : { started: false, message: r.message || "没有需要回复的新评论" };
      }
      case "guard-retry": {
        if (this.active || this.scanBusy) throw new Error("请等待本轮任务或扫描结束");
        const account = await this.account();
        if (!account.loggedIn) throw new Error("请先登录");
        const cfg = this.store.config();
        if (!cfg.guardOn) throw new Error("评论守护未启用");
        const retry = this.store.retryableMentions(account.uid).filter(item => cfg.guardWhitelist.includes(String(item.uid)));
        this.store.transaction(() => {
          for (const item of retry) this.store.put("guard", item.id, { ...item, attempts: 0 });
          this.store.put("meta", "last-guard", 0);
        });
        return { message: `已将 ${retry.length} 条白名单内未回复的 @ 放回队列，下一轮扫描时处理` };
      }
      default:
        throw new Error("未知小花园操作");
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.cancel();
    const pending = [
      this.runtime.close(),
      this.active?.promise,
      this.installPromise,
    ].filter(Boolean);
    const end = Promise.allSettled(pending).then(() => this.store.close());
    let timer;
    await Promise.race([
      end,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 3500);
      }),
    ]);
    clearTimeout(timer);
  }
}
