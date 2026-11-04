import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Single-core, transactional derived state. CTA remains the conversation authority. */
export class RelationshipRepository<T> {
  constructor(private legacyPath: string, private normalize: (value: unknown) => T) {}
  private open(): DatabaseSync {
    const dbPath = this.legacyPath.replace(/\.json$/i, "") + ".sqlite";
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
      const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 1) throw new Error("关系数据库来自较新版本，请先升级程序，未修改原始数据。");
      db.exec("CREATE TABLE IF NOT EXISTS companion_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1;");
      if (!db.prepare("SELECT id FROM companion_state WHERE id=1").get()) {
        // Parsing errors intentionally propagate; never overwrite damaged legacy data.
        const initial = fs.existsSync(this.legacyPath) ? JSON.parse(fs.readFileSync(this.legacyPath, "utf8")) : {};
        db.prepare("INSERT OR IGNORE INTO companion_state(id,body) VALUES(1,?)").run(JSON.stringify(this.normalize(initial)));
      }
      if (process.platform !== "win32") fs.chmodSync(dbPath, 0o600);
      return db;
    } catch (error) { db.close(); throw error; }
  }
  read(): T {
    const db = this.open();
    try { return this.normalize(JSON.parse((db.prepare("SELECT body FROM companion_state WHERE id=1").get() as { body: string }).body)); }
    finally { db.close(); }
  }
  write(data: T): void {
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE companion_state SET body=? WHERE id=1").run(JSON.stringify(data));
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    finally { db.close(); }
  }
  /** Remove the pre-migration source when a user deletes derived private data. */
  purgeLegacy(): void { if (fs.existsSync(this.legacyPath)) fs.unlinkSync(this.legacyPath); }
}
