import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULTS, normalizeConfig } from "./config.mjs";

export class GardenStore {
  constructor(root, { now = () => Date.now() } = {}) {
    mkdirSync(root, { recursive: true });
    this.root = root;
    this.now = now;
    this.db = new DatabaseSync(path.join(root, "garden.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) {
      this.db.close();
      throw new Error("数据来自更新版本，请升级插件后再打开");
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,day TEXT NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,idem TEXT NOT NULL UNIQUE,day TEXT NOT NULL,run_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS actions_day ON actions(day,kind,status);
      CREATE INDEX IF NOT EXISTS runs_day ON runs(day,source,status);
      PRAGMA user_version=1;`);
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',ended=? WHERE status='running'",
      )
      .run(now());
    this.db
      .prepare(
        "UPDATE actions SET status='uncertain',updated=? WHERE status='sending'",
      )
      .run(now());
    this.db
      .prepare(
        "UPDATE actions SET data=json_set(data,'$.undoStatus','uncertain') WHERE json_extract(data,'$.undoStatus')='sending'",
      )
      .run();
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(kind, id, fallback = null) {
    const r = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, String(id));
    return r ? JSON.parse(r.data) : fallback;
  }
  put(kind, id, data) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated=excluded.updated",
      )
      .run(kind, String(id), JSON.stringify(data), this.now());
    return data;
  }
  remove(kind, id) {
    return this.db
      .prepare("DELETE FROM records WHERE kind=? AND id=?")
      .run(kind, String(id));
  }
  list(kind, limit = 200) {
    return this.db
      .prepare(
        "SELECT id,data,updated FROM records WHERE kind=? ORDER BY updated DESC LIMIT ?",
      )
      .all(kind, Math.max(1, Math.min(10000, limit)))
      .map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
  }
  config() {
    return normalizeConfig(this.get("meta", "config", {}));
  }
  saveConfig(patch) {
    return this.put("meta", "config", normalizeConfig(patch, this.config()));
  }
  log(message, kind = "info") {
    const id = randomUUID();
    this.put("event", id, {
      at: this.now(),
      kind,
      message: String(message).slice(0, 1000),
    });
    this.db
      .prepare(
        "DELETE FROM records WHERE kind='event' AND id NOT IN (SELECT id FROM records WHERE kind='event' ORDER BY updated DESC LIMIT 500)",
      )
      .run();
  }
  startRun({ day, source, kind }) {
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM runs WHERE status='running'").get())
        throw new Error("已有任务正在运行");
      const id = randomUUID(),
        started = this.now();
      this.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,NULL,?)")
        .run(
          id,
          day,
          source,
          kind,
          "running",
          started,
          JSON.stringify({ phase: "准备", progress: [] }),
        );
      return this.run(id);
    });
  }
  run(id) {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    return r ? { ...JSON.parse(r.data), ...r, data: undefined } : null;
  }
  updateRun(id, patch) {
    const row = this.run(id);
    if (!row) throw new Error("运行记录不存在");
    const data = { ...row, ...patch };
    delete data.data;
    this.db
      .prepare("UPDATE runs SET status=?,ended=?,data=? WHERE id=?")
      .run(data.status, data.ended ?? null, JSON.stringify(data), id);
    return data;
  }
  runs(limit = 100) {
    return this.db
      .prepare("SELECT id FROM runs ORDER BY started DESC LIMIT ?")
      .all(limit)
      .map((r) => this.run(r.id));
  }
  picked(day) {
    return this.list("report", 1000)
      .filter((r) => r.day === day)
      .reduce((n, r) => n + (r.items?.length ?? 0), 0);
  }
  pendingGuard(accountUid, limit) {
    return this.db
      .prepare(
        `SELECT g.id,g.data FROM records g WHERE g.kind='guard'
      AND json_extract(g.data,'$.accountUid')=? AND json_extract(g.data,'$.status')='pending'
      AND json_extract(g.data,'$.attempts')<3 AND NOT EXISTS(
        SELECT 1 FROM actions a WHERE a.idem=?||':reply:'||json_extract(g.data,'$.bvid')||':'||json_extract(g.data,'$.rpid')
        AND a.status IN ('draft','sending','uncertain','sent','cancelled'))
      ORDER BY g.updated ASC LIMIT ?`,
      )
      .all(accountUid, accountUid, limit)
      .map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
  }
  retryableMentions(accountUid) {
    return this.db.prepare(`SELECT g.id,g.data FROM records g WHERE g.kind='guard'
      AND json_extract(g.data,'$.accountUid')=? AND json_extract(g.data,'$.kind')='at'
      AND json_extract(g.data,'$.status')='pending' AND json_extract(g.data,'$.attempts')>=3
      AND NOT EXISTS(SELECT 1 FROM actions a
        WHERE a.idem=?||':reply:'||json_extract(g.data,'$.bvid')||':'||json_extract(g.data,'$.rpid')
        AND a.status IN ('draft','sending','uncertain','sent','cancelled'))`)
      .all(accountUid, accountUid).map(row => ({ id: row.id, ...JSON.parse(row.data) }));
  }
  draft({ idem, day, runId = null, kind, ...data }) {
    const old = this.db
      .prepare("SELECT id FROM actions WHERE idem=?")
      .get(idem);
    if (old) return this.action(old.id);
    const id = randomUUID(),
      at = this.now();
    this.db
      .prepare("INSERT INTO actions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, idem, day, runId, kind, "draft", at, at, JSON.stringify(data));
    return this.action(id);
  }
  action(id) {
    const r = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id);
    return r ? { ...JSON.parse(r.data), ...r, data: undefined } : null;
  }
  actions(limit = 200) {
    return this.db
      .prepare("SELECT id FROM actions ORDER BY created DESC LIMIT ?")
      .all(limit)
      .map((r) => this.action(r.id));
  }
  updateAction(id, status, patch = {}) {
    const old = this.action(id);
    if (!old) throw new Error("互动记录不存在");
    this.db
      .prepare("UPDATE actions SET status=?,updated=?,data=? WHERE id=?")
      .run(
        status,
        this.now(),
        JSON.stringify({ ...old, ...patch, status, data: undefined }),
        id,
      );
    return this.action(id);
  }
  countActions(kind, day, runId) {
    const comments = ["comment", "reply"].includes(kind);
    let sql = `SELECT count(*) AS n FROM actions WHERE ${comments ? "kind IN ('comment','reply')" : "kind=?"} AND day=? AND status IN ('sending','sent','uncertain')`;
    const args = comments ? [day] : [kind, day];
    if (runId) {
      sql += " AND run_id=?";
      args.push(runId);
    }
    return Number(this.db.prepare(sql).get(...args).n);
  }
  reserveAction(id, { daily, round, runId, day }) {
    return this.transaction(() => {
      const a = this.action(id);
      if (!a || a.status !== "draft")
        throw new Error("该互动已处理；状态不明的动作不能自动重发");
      if (daily <= 0 || this.countActions(a.kind, day) >= daily)
        throw new Error("今天的互动额度已用完或为 0");
      if (
        round !== undefined &&
        (round <= 0 || this.countActions(a.kind, day, runId) >= round)
      )
        throw new Error("本轮互动额度已用完或为 0");
      this.db
        .prepare("UPDATE actions SET day=?,run_id=? WHERE id=?")
        .run(day, runId ?? null, id);
      return this.updateAction(id, "sending");
    });
  }
  counter(name, day, increment = 0) {
    const id = `${name}:${day}`,
      n = this.get("counter", id, { n: 0 }).n + increment;
    if (increment) this.put("counter", id, { n });
    return n;
  }
}
