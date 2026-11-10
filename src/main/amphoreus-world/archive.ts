import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AmphoreusState, WorldHistoryEntry, WorldHistoryPage, WorldHistoryQuery } from "../../shared/amphoreus-world";
import { AMPHOREUS_LOCATIONS, AMPHOREUS_RESIDENTS } from "../../shared/amphoreus-canon";
import { historyEntries } from "./engine";
import { terminalEvent } from "./life";

function open(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL, location TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_time ON history(at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS history_residents(entry TEXT NOT NULL REFERENCES history(id),resident TEXT NOT NULL,PRIMARY KEY(entry,resident));
    CREATE INDEX IF NOT EXISTS history_person ON history_residents(resident,entry);`);
  return db;
}
export function archiveWorld(file: string, state: AmphoreusState): void {
  const db = open(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT OR IGNORE INTO history(id,at,kind,location,payload) VALUES(?,?,?,?,?)");
    const member = db.prepare("INSERT OR IGNORE INTO history_residents(entry,resident) VALUES(?,?)");
    for (const entry of historyEntries(state)) {
      insert.run(entry.id, entry.at, entry.kind, entry.locationId ?? null, JSON.stringify(entry));
      for (const id of entry.residentIds) member.run(entry.id, id);
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
  // Trim only after archive commit; active matters and fact references remain in the snapshot.
  const recent = new Set(state.days.slice(-60).map((day) => day.date));
  state.days = state.days.filter((day) => recent.has(day.date) || day.events.some((event) => !terminalEvent(event)));
  for (const resident of state.residents) resident.memories = resident.memories.slice(-48);
  state.gaps = state.gaps.slice(-60);
  const retained = new Set(state.days.flatMap((day) => day.events.map((event) => event.id)));
  for (const resident of state.residents) resident.heardEventIds = resident.heardEventIds.filter((id) => retained.has(id));
  state.appliedEventIds = state.appliedEventIds.filter((id) => retained.has(id));
}
export function queryHistory(file: string, input: WorldHistoryQuery = {}): WorldHistoryPage {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid history query");
  if (input.residentId && !AMPHOREUS_RESIDENTS.some((r) => r.id === input.residentId)) throw new Error("Invalid resident");
  if (input.locationId && !AMPHOREUS_LOCATIONS.some((p) => p.id === input.locationId)) throw new Error("Invalid location");
  if (input.before !== undefined && !Number.isFinite(input.before) || input.since !== undefined && !Number.isFinite(input.since) || input.beforeId !== undefined && (typeof input.beforeId !== "string" || input.beforeId.length > 300)) throw new Error("Invalid history cursor");
  const limit = Math.max(1, Math.min(80, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 30));
  if (!fs.existsSync(file)) return { entries: [] };
  const db = open(file), where: string[] = [], params: Array<string | number> = [];
  try {
    if (input.before !== undefined) { where.push("(h.at < ? OR (h.at = ? AND h.id < ?))"); params.push(input.before, input.before, input.beforeId ?? ""); }
    if (input.since !== undefined) { where.push("h.at > ?"); params.push(input.since); }
    if (input.locationId) { where.push("h.location = ?"); params.push(input.locationId); }
    if (input.residentId) { where.push("EXISTS(SELECT 1 FROM history_residents r WHERE r.entry=h.id AND r.resident=?)"); params.push(input.residentId); }
    else where.push("h.kind <> 'memory'");
    const rows = db.prepare(`SELECT h.payload FROM history h ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY h.at DESC,h.id DESC LIMIT ?`).all(...params, limit + 1);
    const entries = rows.slice(0, limit).map((row) => JSON.parse(String(row.payload)) as WorldHistoryEntry);
    const last = entries.at(-1);
    return { entries, ...(rows.length > limit && last ? { next: { before: last.at, beforeId: last.id } } : {}) };
  } finally { db.close(); }
}
