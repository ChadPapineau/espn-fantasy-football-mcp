// phase3.ts — the Phase 3 records (plan 10 §3.3; migration 002, every table never pruned):
// `parameter_proposal` — the retrospective's proposal sets, the only input `eff tune` applies from
// (C9; required writes, validated against the registry on the way in, re-validated by the CLI on the
// way out — the store is never trusted); `waiver_run` — one row per waiver processing run E5 priced,
// the league's own surplus feed waiver-fit re-solves the premium from (C5; best-effort, the newest
// call before the run wins); `scored_claim` — the news claims E10 weighed, value-free, scored by the
// retrospective once final, read back into the calibration table (C8; best-effort). League ids are
// local-only and never leave the store through these ports' callers. New here.
import { createHash } from "node:crypto";
import { ESPN_LEAGUE_ID_RE } from "../../config/schema.js";
import type { WaiverRunRecord, WaiverRunRepository } from "../../domain/analytics/types.js";
import {
  CALIBRATION,
  readScoredClaim,
  type ScoredClaim,
} from "../../domain/evidence/calibration.js";
import { validateProposalSet } from "../../domain/reclog/tune.js";
import type {
  LoggedClaim,
  ParameterProposalRepository,
  ParameterProposalSet,
  PendingClaim,
  ScoredClaimRepository,
} from "../../domain/reclog/types.js";
import {
  boundedArray,
  finite,
  intIn,
  isoMs,
  matching,
  num,
  parseJson,
  SEASON_MAX,
  SEASON_MIN,
  toJson,
  WEEK_MAX,
  WEEK_MIN,
  type RepoDeps,
} from "./common.js";

/** Largest stored proposal set (a set holds at most a handful of proposals and evaluations). */
export const PROPOSAL_JSON_MAX = 256 * 1024;
/** Most surplus values one waiver run keeps (E5's candidate pool is smaller). */
export const WAIVER_RUN_SURPLUS_MAX = 200;
/** Most scored claims one read returns: the calibration table reads at most this many. */
export const SCORED_CLAIMS_MAX = CALIBRATION.maxClaims;

const leagueOf = (v: unknown): string => matching(v, ESPN_LEAGUE_ID_RE, "league_id");

// --- parameter_proposal ------------------------------------------------------------------------------

export function parameterProposalRepository({ db, writes }: RepoDeps): ParameterProposalRepository {
  return {
    put(leagueId, set) {
      const league = leagueOf(leagueId);
      // the registry's own validator: a set the CLI would refuse is never stored
      const valid = validateProposalSet(set);
      if (valid === null) throw new RangeError("store: invalid parameter proposal set");
      const createdMs = isoMs(valid.created_at, "created_at");
      const json = toJson(valid, "proposal set", PROPOSAL_JSON_MAX);
      writes.required("parameter_proposal", () => {
        db.prepare(
          `INSERT OR IGNORE INTO parameter_proposal
           (league_id, season, week, hash, created_at, created_ms, set_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(league, valid.season, valid.week, valid.hash, valid.created_at, createdMs, json);
      });
    },
    latest(leagueId, season) {
      const league = leagueOf(leagueId);
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      const r = db
        .prepare(
          `SELECT set_json FROM parameter_proposal WHERE league_id = ? AND season = ?
           ORDER BY created_ms DESC, hash LIMIT 1`,
        )
        .get(league, season) as { set_json: string } | undefined;
      // returned as stored: `eff tune` re-validates every set it reads (the store is never trusted)
      return r === undefined ? null : parseJson<ParameterProposalSet>(r.set_json);
    },
  };
}

// --- waiver_run --------------------------------------------------------------------------------------

interface WaiverRunRow {
  season: number;
  run_at: string;
  w: number;
  surplus_json: string;
}

export function waiverRunRepository({ db, writes }: RepoDeps): WaiverRunRepository {
  return {
    put(leagueId, run, updatedAt) {
      const league = leagueOf(leagueId);
      intIn(run.season, SEASON_MIN, SEASON_MAX, "season");
      const runMs = isoMs(run.run_at, "run_at");
      isoMs(updatedAt, "updated_at");
      const W = finite(run.W, "W");
      if (W < 0 || W > WEEK_MAX) throw new RangeError("store: W out of range");
      const surplus = boundedArray(run.surplus, WAIVER_RUN_SURPLUS_MAX, "surplus").map((x) =>
        finite(x, "surplus"),
      );
      const json = JSON.stringify(surplus);
      return writes.bestEffort(() => {
        db.prepare(
          `INSERT INTO waiver_run (league_id, season, run_at, run_ms, w, surplus_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (league_id, season, run_ms) DO UPDATE SET
             w = excluded.w, surplus_json = excluded.surplus_json, updated_at = excluded.updated_at`,
        ).run(league, run.season, run.run_at, runMs, W, json, updatedAt);
      });
    },
    list(leagueId, season): readonly WaiverRunRecord[] {
      const league = leagueOf(leagueId);
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      const rows = db
        .prepare(
          `SELECT season, run_at, w, surplus_json FROM waiver_run
           WHERE league_id = ? AND season = ? ORDER BY run_ms`,
        )
        .all(league, season) as unknown as WaiverRunRow[];
      const out: WaiverRunRecord[] = [];
      for (const r of rows) {
        const s = parseJson<unknown>(r.surplus_json);
        if (!Array.isArray(s) || !s.every((x) => typeof x === "number" && Number.isFinite(x)))
          continue; // a corrupt row is skipped, never guessed
        out.push({ season: num(r.season), run_at: r.run_at, W: r.w, surplus: s as number[] });
      }
      return out;
    },
  };
}

// --- scored_claim ------------------------------------------------------------------------------------

/** The store key of a claim: one per league, player-week, source, type and signal. */
export function claimKeyOf(leagueId: string, c: LoggedClaim): string {
  return createHash("sha256")
    .update(
      [leagueId, c.season, c.week, c.player_id, c.claim.source, c.claim.type, c.claim.signal].join(
        "|",
      ),
    )
    .digest("hex");
}

interface ClaimRow {
  claim_key: string;
  season: number;
  week: number;
  player_id: number;
  claim_json: string;
  outcome_json: string | null;
}

/**
 * A logged claim's value-free body, checked with the calibration table's own reader (which refuses a
 * record with no outcome at all, so the body is read with a placeholder outcome that is then dropped).
 */
function checkedClaim(c: LoggedClaim["claim"]): LoggedClaim["claim"] {
  const read = readScoredClaim({ ...c, active: false, borne_out: null });
  if (read === null) throw new RangeError("store: invalid claim");
  return {
    source: read.source,
    type: read.type,
    signal: read.signal,
    prior_status: read.prior_status,
    prior_p: read.prior_p,
  };
}

export function scoredClaimRepository({ db, writes }: RepoDeps): ScoredClaimRepository {
  return {
    log(leagueId, c, loggedAt) {
      const league = leagueOf(leagueId);
      intIn(c.season, SEASON_MIN, SEASON_MAX, "season");
      intIn(c.week, WEEK_MIN, WEEK_MAX, "week");
      intIn(c.player_id, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "player_id");
      if (c.player_id === 0) throw new RangeError("store: player_id 0 is not a player");
      const loggedMs = isoMs(loggedAt, "logged_at");
      const claim = checkedClaim(c.claim);
      const key = claimKeyOf(league, { ...c, claim });
      return writes.bestEffort(() => {
        db.prepare(
          `INSERT OR IGNORE INTO scored_claim
           (claim_key, league_id, season, week, player_id, logged_at, logged_ms, claim_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          key,
          league,
          c.season,
          c.week,
          c.player_id,
          loggedAt,
          loggedMs,
          JSON.stringify(claim),
        );
      });
    },
    pending(leagueId, season, week): readonly PendingClaim[] {
      const league = leagueOf(leagueId);
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      intIn(week, WEEK_MIN, WEEK_MAX, "week");
      const rows = db
        .prepare(
          `SELECT claim_key, season, week, player_id, claim_json, outcome_json FROM scored_claim
           WHERE league_id = ? AND season = ? AND week = ? AND scored_at IS NULL
           ORDER BY logged_ms, claim_key`,
        )
        .all(league, season, week) as unknown as ClaimRow[];
      const out: PendingClaim[] = [];
      for (const r of rows) {
        let claim: LoggedClaim["claim"];
        try {
          claim = checkedClaim(parseJson(r.claim_json));
        } catch {
          continue; // a corrupt row is skipped
        }
        out.push({
          key: r.claim_key,
          season: num(r.season),
          week: num(r.week),
          player_id: num(r.player_id),
          claim,
        });
      }
      return out;
    },
    score(key, outcome, scoredAt) {
      matching(key, /^[0-9a-f]{64}$/, "claim key");
      isoMs(scoredAt, "scored_at");
      for (const v of [outcome.active, outcome.borne_out])
        if (v !== null && typeof v !== "boolean") throw new RangeError("store: invalid outcome");
      const json = JSON.stringify({ active: outcome.active, borne_out: outcome.borne_out });
      return writes.bestEffort(() => {
        db.prepare(
          `UPDATE scored_claim SET scored_at = ?, outcome_json = ?
           WHERE claim_key = ? AND scored_at IS NULL`,
        ).run(scoredAt, json, key);
      });
    },
    scored(leagueId, limit): readonly ScoredClaim[] {
      const league = leagueOf(leagueId);
      intIn(limit, 0, SCORED_CLAIMS_MAX, "limit");
      const rows = db
        .prepare(
          `SELECT claim_key, season, week, player_id, claim_json, outcome_json FROM scored_claim
           WHERE league_id = ? AND scored_at IS NOT NULL ORDER BY logged_ms DESC, claim_key LIMIT ?`,
        )
        .all(league, limit) as unknown as ClaimRow[];
      const out: ScoredClaim[] = [];
      for (const r of rows) {
        let raw: unknown;
        try {
          raw = {
            ...parseJson<Record<string, unknown>>(r.claim_json),
            ...parseJson<Record<string, unknown>>(r.outcome_json ?? "{}"),
          };
        } catch {
          continue;
        }
        // read back with the table's own defensive reader (a forged row is data, never trusted)
        const c = readScoredClaim(raw);
        if (c !== null) out.push(c);
      }
      return out;
    },
  };
}
