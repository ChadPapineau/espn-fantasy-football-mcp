// crosswalk.ts — the persisted ESPN-player → gsis_id pairs (plan 01 §5.2 `crosswalk`: method,
// confidence, first/last seen; research 04 §C: survive team changes, never expire): delta-only
// required upserts ("changed" never compares last_seen), and a best-effort `touch` that refreshes
// last_seen only at LAST_SEEN_GRANULARITY_MS grain. Ported from sibling @cf3b015, adapted (ESPN ids
// are the key; D/ST units are never paired, so ids are positive).
import { GSIS_ID_RE } from "../../config/schema.js";
import {
  LAST_SEEN_GRANULARITY_MS,
  type CrosswalkPair,
  type CrosswalkRepository,
  type CrosswalkSource,
} from "../../domain/crosswalk/types.js";
import {
  boundedArray,
  finite,
  intIn,
  isoMs,
  matching,
  num,
  oneOf,
  type RepoDeps,
} from "./common.js";

const METHODS = ["id", "match", "override"] as const;
const SOURCES: readonly CrosswalkSource[] = [
  "nflverse:roster_weekly",
  "nflverse:players",
  "matcher",
  "overrides",
];
/** Most ids one `touch` call may name, and most pairs one `upsertDelta` takes (bounded work). */
export const TOUCH_MAX_IDS = 50_000;
export const UPSERT_MAX_PAIRS = 50_000;

function checkPair(p: CrosswalkPair): number {
  intIn(p.espn_id, 1, Number.MAX_SAFE_INTEGER, "espn_id");
  matching(p.gsis_id, GSIS_ID_RE, "gsis_id");
  oneOf(p.method, METHODS, "crosswalk method");
  oneOf(p.source, SOURCES, "crosswalk source");
  const c = finite(p.confidence, "confidence");
  if (c < 0 || c > 1) throw new RangeError("store: confidence must be in 0..1");
  isoMs(p.first_seen, "first_seen");
  return isoMs(p.last_seen, "last_seen");
}

interface Row {
  espn_id: number;
  gsis_id: string;
  method: string;
  source: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
}

const toPair = (r: Row): CrosswalkPair => ({
  espn_id: num(r.espn_id),
  gsis_id: r.gsis_id,
  method: r.method as CrosswalkPair["method"],
  source: r.source as CrosswalkSource,
  confidence: r.confidence,
  first_seen: r.first_seen,
  last_seen: r.last_seen,
});

const COLS = "espn_id, gsis_id, method, source, confidence, first_seen, last_seen";

export function crosswalkRepository({ db, writes }: RepoDeps): CrosswalkRepository {
  return {
    get(espnId) {
      if (!Number.isSafeInteger(espnId)) return null;
      const r = db.prepare(`SELECT ${COLS} FROM crosswalk WHERE espn_id = ?`).get(espnId) as
        Row | undefined;
      return r === undefined ? null : toPair(r);
    },
    byGsis(gsisId) {
      if (typeof gsisId !== "string" || !GSIS_ID_RE.test(gsisId)) return [];
      return (
        db
          .prepare(`SELECT ${COLS} FROM crosswalk WHERE gsis_id = ? ORDER BY espn_id`)
          .all(gsisId) as unknown as Row[]
      ).map(toPair);
    },
    upsertDelta(pairs) {
      const checked = boundedArray(pairs, UPSERT_MAX_PAIRS, "pairs").map((p) => ({
        p,
        ms: checkPair(p),
      }));
      if (checked.length === 0) return 0;
      return writes.requiredTx("crosswalk", () => {
        const sel = db.prepare(
          "SELECT gsis_id, method, source, confidence FROM crosswalk WHERE espn_id = ?",
        );
        const ins = db.prepare(
          `INSERT INTO crosswalk (${COLS}, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const upd = db.prepare(
          `UPDATE crosswalk SET gsis_id = ?, method = ?, source = ?, confidence = ?, last_seen = ?, last_seen_ms = ?
           WHERE espn_id = ?`,
        );
        let written = 0;
        for (const { p, ms } of checked) {
          const cur = sel.get(p.espn_id) as
            { gsis_id: string; method: string; source: string; confidence: number } | undefined;
          if (cur === undefined) {
            ins.run(
              p.espn_id,
              p.gsis_id,
              p.method,
              p.source,
              p.confidence,
              p.first_seen,
              p.last_seen,
              ms,
            );
            written += 1;
          } else if (
            cur.gsis_id !== p.gsis_id ||
            cur.method !== p.method ||
            cur.source !== p.source ||
            cur.confidence !== p.confidence
          ) {
            upd.run(p.gsis_id, p.method, p.source, p.confidence, p.last_seen, ms, p.espn_id);
            written += 1;
          }
        }
        return written;
      });
    },
    touch(espnIds, at) {
      const atMs = isoMs(at, "at");
      const ids = boundedArray(espnIds, TOUCH_MAX_IDS, "espnIds").filter(
        (n) => Number.isSafeInteger(n) && n > 0,
      );
      if (ids.length === 0) return { written: true };
      return writes.bestEffort(() => {
        db.prepare(
          `UPDATE crosswalk SET last_seen = :at, last_seen_ms = :at_ms
           WHERE espn_id IN (SELECT value FROM json_each(:ids)) AND last_seen_ms < :threshold`,
        ).run({
          at,
          at_ms: atMs,
          ids: JSON.stringify(ids),
          threshold: atMs - LAST_SEEN_GRANULARITY_MS,
        });
      });
    },
    count() {
      return num((db.prepare("SELECT COUNT(*) AS n FROM crosswalk").get() as { n: number }).n);
    },
  };
}
