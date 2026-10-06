// limiter.ts — `espn_requests`, the cross-process token bucket (plan 01 §6: every request inserts a
// row inside a short BEGIN IMMEDIATE after checking every window; plan 06 §1.4 + changelog V7: two
// daily caps for the job fleet, counted over JOB-origin rows of the same kind) plus each request's
// outcome, from which any process derives the breaker and the 304 count. Fail closed: a row that
// cannot be written → StoreBusyError, and the caller does not send the request (WRITE_CLASS).
import { REQUEST_OUTCOMES } from "../../config/schema.js";
import type { IsoInstant } from "../../domain/league/types.js";
import {
  limiterDecision,
  type LimiterRepository,
  type LimiterRequest,
  type LimiterVerdict,
  type RequestCounts,
  type RequestOrigin,
} from "../types.js";
import { bool, boundedArray, intIn, isoMs, msToIso, num, oneOf, type RepoDeps } from "./common.js";

/** A day, for the daily caps' next-day start (dayStart + 24 h; the caller picks the zone). */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Most windows one check takes, and the largest window max (bounded statements). */
export const LIMITER_MAX_WINDOWS = 8;
export const LIMITER_MAX_PER_WINDOW = 10_000;
/** Largest `recentOutcomes` page. */
export const RECENT_OUTCOMES_MAX = 1000;

const ORIGINS: readonly RequestOrigin[] = ["server", "job"];

function checkRequest(req: LimiterRequest): {
  atMs: number;
  windows: { startMs: number; max: number }[];
  cap: { dayStartMs: number; max: number } | null;
} {
  const atMs = isoMs(req.at, "at");
  bool(req.keyless, "keyless");
  oneOf(req.origin, ORIGINS, "request origin");
  const windows = boundedArray(req.windows, LIMITER_MAX_WINDOWS, "windows").map((w) => {
    const startMs = isoMs(w.start, "window start");
    if (startMs > atMs) throw new RangeError("store: a window cannot start after the request");
    return { startMs, max: intIn(w.max, 1, LIMITER_MAX_PER_WINDOW, "window max") };
  });
  let cap: { dayStartMs: number; max: number } | null = null;
  if (req.dailyCap !== null) {
    if (req.origin !== "job") throw new RangeError("store: daily caps bind job requests only");
    const dayStartMs = isoMs(req.dailyCap.dayStart, "dayStart");
    if (dayStartMs > atMs) throw new RangeError("store: the day cannot start after the request");
    cap = { dayStartMs, max: intIn(req.dailyCap.max, 0, LIMITER_MAX_PER_WINDOW, "daily cap") };
  }
  return { atMs, windows, cap };
}

export function limiterRepository({ db, writes }: RepoDeps): LimiterRepository {
  return {
    tryRecord(req): LimiterVerdict {
      const { atMs, windows, cap } = checkRequest(req);
      return writes.requiredTx("espn_requests", () => {
        const inWindow = db.prepare("SELECT ts FROM espn_requests WHERE ts >= ? ORDER BY ts");
        const windowRows = windows.map((w) =>
          (inWindow.all(w.startMs) as unknown as { ts: number }[]).map((r) => num(r.ts)),
        );
        const used =
          cap === null
            ? 0
            : num(
                (
                  db
                    .prepare(
                      "SELECT COUNT(*) AS n FROM espn_requests WHERE origin = 'job' AND keyless = ? AND ts >= ?",
                    )
                    .get(req.keyless ? 1 : 0, cap.dayStartMs) as { n: number }
                ).n,
              );
        const verdict = limiterDecision({
          nowMs: atMs,
          windows,
          windowRows,
          dailyCap:
            cap === null ? null : { max: cap.max, used, nextDayStartMs: cap.dayStartMs + DAY_MS },
        });
        if (!verdict.ok) return verdict;
        const id = db
          .prepare(
            "INSERT INTO espn_requests (ts, keyless, origin, outcome) VALUES (?, ?, ?, 'pending')",
          )
          .run(atMs, req.keyless ? 1 : 0, req.origin).lastInsertRowid;
        return { ok: true, id: Number(id) };
      });
    },

    recordOutcome(id, outcome) {
      intIn(id, 1, Number.MAX_SAFE_INTEGER, "request id");
      oneOf(outcome, REQUEST_OUTCOMES, "request outcome");
      writes.required("espn_requests", () => {
        db.prepare("UPDATE espn_requests SET outcome = ? WHERE id = ?").run(outcome, id);
      });
    },

    countSince(since: IsoInstant) {
      const ms = isoMs(since, "since");
      return num(
        (
          db.prepare("SELECT COUNT(*) AS n FROM espn_requests WHERE ts >= ?").get(ms) as {
            n: number;
          }
        ).n,
      );
    },

    countToday(dayStart): RequestCounts {
      const ms = isoMs(dayStart, "dayStart");
      const rows = db
        .prepare(
          "SELECT origin, keyless, COUNT(*) AS n FROM espn_requests WHERE ts >= ? GROUP BY origin, keyless",
        )
        .all(ms) as unknown as { origin: string; keyless: number; n: number }[];
      const out = {
        server: { cookie: 0, keyless: 0 },
        job: { cookie: 0, keyless: 0 },
      };
      for (const r of rows) {
        const side = r.origin === "job" ? out.job : r.origin === "server" ? out.server : null;
        if (side === null) continue;
        if (num(r.keyless) === 1) side.keyless += num(r.n);
        else side.cookie += num(r.n);
      }
      return out;
    },

    recentOutcomes(limit) {
      const lim = intIn(limit, 1, RECENT_OUTCOMES_MAX, "limit");
      const rows = db
        .prepare("SELECT ts, outcome FROM espn_requests ORDER BY ts DESC, id DESC LIMIT ?")
        .all(lim) as unknown as { ts: number; outcome: string }[];
      return rows
        .filter((r) => (REQUEST_OUTCOMES as readonly string[]).includes(r.outcome))
        .map((r) => ({
          at: msToIso(num(r.ts)),
          outcome: r.outcome as (typeof REQUEST_OUTCOMES)[number],
        }));
    },

    count304Since(since) {
      const ms = isoMs(since, "since");
      return num(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM espn_requests WHERE outcome = 'not_modified' AND ts >= ?",
            )
            .get(ms) as { n: number }
        ).n,
      );
    },

    prune(before) {
      const ms = isoMs(before, "before");
      return writes.required("espn_requests", () =>
        Number(db.prepare("DELETE FROM espn_requests WHERE ts < ?").run(ms).changes),
      );
    },
  };
}
