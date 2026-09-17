/**
 * SQLite-backed state for the monitor. One file, no server to run.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Monitor {
  id: string;
  url: string;
  label: string;
  intervalSeconds: number;
  enabled: number;
  webhookUrl: string | null;
  createdAt: number;
  lastRunAt: number | null;
  consecutiveFailures: number;
}

export interface Run {
  id: number;
  monitorId: string;
  at: number;
  ok: number;
  error: string | null;
  verdict: string | null;
  errors: number;
  warnings: number;
  infos: number;
  breakCount: number;
  protocol: string | null;
  durationMs: number;
  codes: string;
}

export interface Alert {
  id: number;
  monitorId: string;
  at: number;
  severity: "error" | "warning" | "info";
  code: string;
  title: string;
  detail: string;
  acknowledged: number;
}

export interface OpenBreak {
  monitorId: string;
  breakKey: string;
  firstSeen: number;
  lastSeen: number;
  signalled: number | null;
  closed: number;
  alerted: number;
}

/**
 * Serverless platforms give a function only /tmp to write to, and that disk
 * does not survive the instance. The monitor therefore cannot run there — see
 * `schedulerStatus` — but the database still has to open so the rest of the
 * app serves normally.
 */
export const EPHEMERAL_STORAGE = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const DB_PATH = resolve(
  process.env.SPLICECHECK_DB ?? (EPHEMERAL_STORAGE ? "/tmp/splicecheck.db" : "./data/splicecheck.db"),
);

function init(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      label TEXT NOT NULL,
      intervalSeconds INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      webhookUrl TEXT,
      createdAt INTEGER NOT NULL,
      lastRunAt INTEGER,
      consecutiveFailures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitorId TEXT NOT NULL,
      at INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      verdict TEXT,
      errors INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,
      infos INTEGER NOT NULL DEFAULT 0,
      breakCount INTEGER NOT NULL DEFAULT 0,
      protocol TEXT,
      durationMs INTEGER NOT NULL DEFAULT 0,
      codes TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS runs_monitor_at ON runs(monitorId, at DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitorId TEXT NOT NULL,
      at INTEGER NOT NULL,
      severity TEXT NOT NULL,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS alerts_at ON alerts(at DESC);
    CREATE TABLE IF NOT EXISTS open_breaks (
      monitorId TEXT NOT NULL,
      breakKey TEXT NOT NULL,
      firstSeen INTEGER NOT NULL,
      lastSeen INTEGER NOT NULL,
      signalled REAL,
      closed INTEGER NOT NULL DEFAULT 0,
      alerted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (monitorId, breakKey)
    );
  `);
  return db;
}

// Survive Next.js hot reloads without reopening the file handle.
const g = globalThis as unknown as { __splicecheckDb?: Database.Database };
export const db: Database.Database = g.__splicecheckDb ?? (g.__splicecheckDb = init());

export const store = {
  listMonitors(): Monitor[] {
    return db.prepare("SELECT * FROM monitors ORDER BY createdAt DESC").all() as Monitor[];
  },
  getMonitor(id: string): Monitor | undefined {
    return db.prepare("SELECT * FROM monitors WHERE id = ?").get(id) as Monitor | undefined;
  },
  createMonitor(m: Omit<Monitor, "lastRunAt" | "consecutiveFailures">): Monitor {
    db.prepare(
      `INSERT INTO monitors (id, url, label, intervalSeconds, enabled, webhookUrl, createdAt)
       VALUES (@id, @url, @label, @intervalSeconds, @enabled, @webhookUrl, @createdAt)`,
    ).run(m);
    return this.getMonitor(m.id)!;
  },
  updateMonitor(id: string, patch: Partial<Pick<Monitor, "enabled" | "intervalSeconds" | "label" | "webhookUrl">>) {
    const cur = this.getMonitor(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    db.prepare(
      `UPDATE monitors SET label=@label, intervalSeconds=@intervalSeconds, enabled=@enabled, webhookUrl=@webhookUrl WHERE id=@id`,
    ).run(next);
    return this.getMonitor(id);
  },
  deleteMonitor(id: string) {
    db.prepare("DELETE FROM runs WHERE monitorId = ?").run(id);
    db.prepare("DELETE FROM alerts WHERE monitorId = ?").run(id);
    db.prepare("DELETE FROM open_breaks WHERE monitorId = ?").run(id);
    db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
  },
  markRun(id: string, at: number, failed: boolean) {
    db.prepare(
      `UPDATE monitors SET lastRunAt = ?, consecutiveFailures = CASE WHEN ? THEN consecutiveFailures + 1 ELSE 0 END WHERE id = ?`,
    ).run(at, failed ? 1 : 0, id);
  },
  addRun(r: Omit<Run, "id">): number {
    const info = db
      .prepare(
        `INSERT INTO runs (monitorId, at, ok, error, verdict, errors, warnings, infos, breakCount, protocol, durationMs, codes)
         VALUES (@monitorId, @at, @ok, @error, @verdict, @errors, @warnings, @infos, @breakCount, @protocol, @durationMs, @codes)`,
      )
      .run(r);
    return Number(info.lastInsertRowid);
  },
  lastRun(monitorId: string, before?: number): Run | undefined {
    return before === undefined
      ? (db.prepare("SELECT * FROM runs WHERE monitorId = ? ORDER BY at DESC LIMIT 1").get(monitorId) as Run | undefined)
      : (db
          .prepare("SELECT * FROM runs WHERE monitorId = ? AND at < ? ORDER BY at DESC LIMIT 1")
          .get(monitorId, before) as Run | undefined);
  },
  recentRuns(monitorId: string, limit = 100): Run[] {
    return db
      .prepare("SELECT * FROM runs WHERE monitorId = ? ORDER BY at DESC LIMIT ?")
      .all(monitorId, limit) as Run[];
  },
  pruneRuns(monitorId: string, keep = 2000) {
    db.prepare(
      `DELETE FROM runs WHERE monitorId = ? AND id NOT IN (
         SELECT id FROM runs WHERE monitorId = ? ORDER BY at DESC LIMIT ?)`,
    ).run(monitorId, monitorId, keep);
  },
  addAlert(a: Omit<Alert, "id" | "acknowledged">): Alert {
    const info = db
      .prepare(
        `INSERT INTO alerts (monitorId, at, severity, code, title, detail)
         VALUES (@monitorId, @at, @severity, @code, @title, @detail)`,
      )
      .run(a);
    return db.prepare("SELECT * FROM alerts WHERE id = ?").get(Number(info.lastInsertRowid)) as Alert;
  },
  listAlerts(limit = 200, monitorId?: string): Alert[] {
    return monitorId
      ? (db
          .prepare("SELECT * FROM alerts WHERE monitorId = ? ORDER BY at DESC LIMIT ?")
          .all(monitorId, limit) as Alert[])
      : (db.prepare("SELECT * FROM alerts ORDER BY at DESC LIMIT ?").all(limit) as Alert[]);
  },
  acknowledgeAlerts(ids: number[]) {
    if (!ids.length) return;
    const stmt = db.prepare("UPDATE alerts SET acknowledged = 1 WHERE id = ?");
    db.transaction((xs: number[]) => xs.forEach((i) => stmt.run(i)))(ids);
  },
  unacknowledgedCount(): number {
    const r = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0").get() as { n: number };
    return r.n;
  },
  openBreaks(monitorId: string): OpenBreak[] {
    return db
      .prepare("SELECT * FROM open_breaks WHERE monitorId = ? AND closed = 0")
      .all(monitorId) as OpenBreak[];
  },
  upsertBreak(b: OpenBreak) {
    db.prepare(
      `INSERT INTO open_breaks (monitorId, breakKey, firstSeen, lastSeen, signalled, closed, alerted)
       VALUES (@monitorId, @breakKey, @firstSeen, @lastSeen, @signalled, @closed, @alerted)
       ON CONFLICT(monitorId, breakKey) DO UPDATE SET
         lastSeen = excluded.lastSeen,
         signalled = COALESCE(excluded.signalled, open_breaks.signalled),
         closed = MAX(open_breaks.closed, excluded.closed)`,
    ).run(b);
  },
  markBreakAlerted(monitorId: string, breakKey: string) {
    db.prepare("UPDATE open_breaks SET alerted = 1 WHERE monitorId = ? AND breakKey = ?").run(monitorId, breakKey);
  },
  pruneBreaks(monitorId: string, olderThan: number) {
    db.prepare("DELETE FROM open_breaks WHERE monitorId = ? AND lastSeen < ?").run(monitorId, olderThan);
  },
};
