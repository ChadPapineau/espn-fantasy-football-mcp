// sqlite-limiter.ts — a test-only LimiterRepository over one SQLite file (plan 01 §6: the cross-
// process bucket is a row per request checked and inserted in ONE `BEGIN IMMEDIATE`), running the
// store's pure `limiterDecision`. The real repository is the store module's; this one exists so the
// limiter's cross-process property can be shown with two real processes (plan 05 §2, §4.1).
import { DatabaseSync } from "node:sqlite";
import type { RequestOutcome } from "../../../../src/config/schema.js";
import {
  limiterDecision,
  type LimiterRepository,
  type LimiterRequest,
  type LimiterVerdict,
  type RequestCounts,
} from "../../../../src/store/types.js";

/** Opens (and creates) the shared limiter table. */
export function openSqliteLimiter(file: string): LimiterRepository & { close(): void } {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS espn_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, keyless INTEGER NOT NULL, origin TEXT NOT NULL, outcome TEXT NOT NULL)",
  );
  // no upper bound: a row another process wrote while this one waited for the lock still counts
  const inWindow = db.prepare("SELECT ts FROM espn_requests WHERE ts > ?");
  const insert = db.prepare(
    "INSERT INTO espn_requests (ts, keyless, origin, outcome) VALUES (?, ?, ?, 'pending')",
  );
  const setOutcome = db.prepare("UPDATE espn_requests SET outcome = ? WHERE id = ?");
  const recent = db.prepare(
    "SELECT ts, outcome FROM espn_requests ORDER BY ts DESC, id DESC LIMIT ?",
  );
  return {
    tryRecord(req: LimiterRequest): LimiterVerdict {
      const now = Date.parse(req.at);
      db.exec("BEGIN IMMEDIATE");
      try {
        const windowRows = req.windows.map((w) =>
          inWindow.all(Date.parse(w.start)).map((r) => (r as { ts: number }).ts),
        );
        const d = limiterDecision({
          nowMs: now,
          windows: req.windows.map((w) => ({ startMs: Date.parse(w.start), max: w.max })),
          windowRows,
          dailyCap: null,
        });
        if (!d.ok) {
          db.exec("COMMIT");
          return d;
        }
        const r = insert.run(now, req.keyless ? 1 : 0, req.origin);
        db.exec("COMMIT");
        return { ok: true, id: Number(r.lastInsertRowid) };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordOutcome(id: number, outcome: RequestOutcome): void {
      setOutcome.run(outcome, id);
    },
    countSince: () => 0,
    countToday: (): RequestCounts => ({
      server: { cookie: 0, keyless: 0 },
      job: { cookie: 0, keyless: 0 },
    }),
    recentOutcomes(limit: number) {
      return recent.all(limit).map((r) => {
        const row = r as { ts: number; outcome: RequestOutcome };
        return { at: new Date(row.ts).toISOString(), outcome: row.outcome };
      });
    },
    count304Since: () => 0,
    prune: () => 0,
    close: () => {
      db.close();
    },
  };
}
