// retro-p3.ts — E13's Phase 3 inputs (plan 07 E13; plan 10 §3.3 C8, C9): the attribution rows of the
// re-fit window — every box-score entry of the last ATTRIBUTION_WINDOW_WEEKS weeks that carries a
// projection STORED BEFORE ITS GAME'S KICKOFF (projection.getAsOf, the newer of v2-opportunity and
// v1-ensemble — no post-lock run leaks the outcome), joined to ESPN's actual line (src/domain/reclog/attribution.ts
// attributionRowFromEspn), its stored trace filled with the realised shares and rates
// (src/domain/reclog/realised.ts; team volume from nflverse stats_team_week); the applied tuned
// overrides as the retrospective's `tuned`; and the scoring of E10's logged news claims once their
// game is final (claimOutcome: played from the box score, else the snap counts; a role claim from
// the snap shares around it, one week later). Reads only; the writes (proposal set, claim outcomes)
// are the caller's, best-effort. Third-party values are numbers here — no text is read. New here.
import { espnNumbersOf, preWeekSnapshot } from "../../domain/analytics/calibration/espn.js";
import { positionCv } from "../../domain/analytics/index.js";
import { gammaDist, normalCdf, sigmaOf } from "../../domain/analytics/math.js";
import { MODEL_VERSION_V2 } from "../../domain/analytics/projections-v2/index.js";
import type { Dist, StoredProjection } from "../../domain/analytics/types.js";
import { seasonOfInstant } from "../../domain/analytics/waiver-fit/history.js";
import { claimOutcome, type ScoredClaimType } from "../../domain/evidence/index.js";
import { teamOfProTeamId } from "../../domain/crosswalk/teams.js";
import { kickoffMsOf } from "../../domain/league/schedule.js";
import type {
  BoxScoreMatchup,
  ProSchedule,
  ScoreboardSnapshot,
  Week,
} from "../../domain/league/types.js";
import {
  attributionRowFromEspn,
  playedFromEspn,
  type AttributionRow,
} from "../../domain/reclog/attribution.js";
import { readTrace, traceWithRealised } from "../../domain/reclog/realised.js";
import type {
  ComparatorProbability,
  PlayerForecast,
  WeekProbability,
} from "../../domain/reclog/retrospective.js";
import type { ScoringSettings } from "../../domain/scoring/types.js";
import type { TunedParameters } from "../../domain/reclog/tune.js";
import type { NflTeam } from "../../config/schema.js";
import type { InputStamp } from "../envelope.js";
import { beforeSideEffect, type ToolContext } from "../define.js";
import { leagueRef, optionalDataset, turn } from "./common.js";
import { SERVED_DIST_KEY } from "./projection-v2.js";

/** Weeks of box scores the attribution reads (the re-fit window ends at the scored week). */
export const ATTRIBUTION_WINDOW_WEEKS = 8;

/** Box-score entries joined per turn of the event loop (plan 03 §1.2; plan 10 A16a). */
export const ATTRIBUTION_PER_TURN = 25;

/** The applied overrides as the retrospective's TunedParameters (history is the CLI's, not read). */
export function tunedDocOf(ctx: ToolContext): TunedParameters | null {
  const t = ctx.options.tuned;
  if (t === undefined || t === null) return null;
  return { schema: 1, updated_at: t.updated_at, values: t.values, history: [] };
}

/** Kickoff (epoch ms) of each pro team's game in a week. */
function kickoffsOf(schedule: ProSchedule | null, week: Week): Map<number, number> {
  const out = new Map<number, number>();
  for (const g of schedule?.games ?? []) {
    if (g.week !== week) continue;
    const k = kickoffMsOf(g);
    if (k === null) continue;
    out.set(g.home_pro_team_id, k);
    out.set(g.away_pro_team_id, k);
  }
  return out;
}

/**
 * The attribution rows of the window (see the header). `boxes(week)` returns that week's box scores
 * (the caller's reads, cached or budgeted) or null when they are unavailable.
 */
export async function attributionRows(
  ctx: ToolContext,
  season: number,
  week: Week,
  boxes: (w: Week) => Promise<readonly BoxScoreMatchup[] | null>,
  schedule: ProSchedule | null,
  inputs: InputStamp[],
  warnings: string[],
): Promise<AttributionRow[]> {
  const rows: AttributionRow[] = [];
  let missing = 0;
  for (let x = Math.max(1, week - ATTRIBUTION_WINDOW_WEEKS + 1); x <= week; x++) {
    await turn();
    const bx = await boxes(x);
    if (bx === null) {
      missing += 1;
      continue;
    }
    const kick = kickoffsOf(schedule, x);
    const entries = bx.flatMap((m) => [m.home, m.away]).flatMap((s) => s?.entries ?? []);
    // the realised team volume of every team in the week (target and carry shares)
    const teams = [
      ...new Set(
        entries
          .map((e) => teamOfProTeamId(e.player.pro_team_id))
          .filter((t): t is NflTeam => t !== null),
      ),
    ];
    const volume = new Map<NflTeam, { dropbacks: number | null; rushes: number | null }>();
    const reader = ctx.services.datasets.teamWeek;
    if (reader !== undefined && teams.length > 0) {
      const r = reader.lines(teams, season, [x]);
      const st = optionalDataset(r, ctx, true);
      if (st !== null) inputs.push(st);
      for (const t of r.rows)
        volume.set(t.nfl_team, {
          dropbacks: t.attempts === null || t.sacks === null ? null : t.attempts + t.sacks,
          rushes: t.carries,
        });
    }
    const seen = new Set<number>();
    for (const [n, e] of entries.entries()) {
      // two indexed reads and one translation per entry: a turn every ATTRIBUTION_PER_TURN
      if (n > 0 && n % ATTRIBUTION_PER_TURN === 0) await turn();
      const id = e.player.ref.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const lock = kick.get(e.player.pro_team_id);
      if (lock === undefined) continue; // no known kickoff: a pre-lock read cannot be guaranteed
      // the newest projection made before the game's kickoff, whichever model served it
      const before = new Date(lock).toISOString();
      const v2 = ctx.services.projections.getAsOf(id, season, x, MODEL_VERSION_V2, before);
      const v1 = ctx.services.projections.getAsOf(id, season, x, "v1-ensemble", before);
      const stored =
        v2 === null
          ? v1
          : v1 === null
            ? v2
            : Date.parse(v1.made_at) > Date.parse(v2.made_at)
              ? v1
              : v2;
      if (stored === null) continue;
      const reported = stored.reported_mean ?? null;
      if (reported === null) continue;
      const trace0 = readTrace(stored.trace ?? null);
      const row0 = attributionRowFromEspn({
        week: x,
        player_id: id,
        gsis_id: stored.gsis_id,
        position: e.player.position,
        position_id: e.player.position_id,
        model_version: stored.model_version,
        expectation: stored.expectation,
        reported_mean: reported,
        p_active: stored.p_active ?? null,
        actual_raw: e.actual?.raw ?? null,
        applied_total: e.actual?.applied_total ?? null,
        espn_mean: e.projected?.applied_total ?? null,
        trace: null,
      });
      if (row0 === null) continue;
      const team = teamOfProTeamId(e.player.pro_team_id);
      rows.push({
        ...row0,
        trace:
          trace0 === null
            ? null
            : traceWithRealised(
                trace0,
                e.player.position,
                row0.active,
                row0.realised,
                team === null ? null : (volume.get(team) ?? null),
              ),
      });
    }
  }
  if (missing > 0)
    warnings.push(
      `attribution: ${String(missing)} week(s) of box scores unavailable in the re-fit window`,
    );
  return rows;
}

// --- the forecasts E13 scores (Stage C finding reclog-retro-forecasts-never-scored) -----------------

/** The newest projection of a player-week stored before `lockMs`, whichever model served it. */
export function storedBefore(
  ctx: ToolContext,
  playerId: number,
  season: number,
  week: Week,
  lockMs: number,
): StoredProjection | null {
  const before = new Date(lockMs).toISOString();
  const v2 = ctx.services.projections.getAsOf(playerId, season, week, MODEL_VERSION_V2, before);
  const v1 = ctx.services.projections.getAsOf(playerId, season, week, "v1-ensemble", before);
  if (v2 === null) return v1;
  if (v1 === null) return v2;
  return Date.parse(v1.made_at) > Date.parse(v2.made_at) ? v1 : v2;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** The first-week Dist a stored projection served (SERVED_DIST_KEY), or null (an older row). */
export function servedDistOf(stored: Pick<StoredProjection, "trace">): Dist | null {
  const raw: unknown = stored.trace?.[SERVED_DIST_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const { mean, p10, p25, p50, p75, p90, p_zero, basis } = d;
  if (![mean, p10, p25, p50, p75, p90, p_zero].every(isNum) || typeof basis !== "string")
    return null;
  return d as unknown as Dist;
}

/** What E13 scores beyond the logged calls: the projections and probabilities it served. */
export interface RetroForecasts {
  readonly player_forecasts: PlayerForecast[];
  readonly p_active: WeekProbability[];
  readonly p_win: ComparatorProbability[];
  /** A pre-week scoreboard snapshot supplied ESPN's win probability. */
  readonly snapshot_used: boolean;
}

/**
 * The season-to-date forecasts E13 scores over the re-fit window (plan 07 E13: projection CRPS/MAE
 * against ESPN's position-CV Dist, coverage, the Brier table with ESPN's comparator): every final
 * box-score entry with a projection STORED BEFORE ITS GAME'S KICKOFF carrying the Dist the tool served
 * (servedDistOf) is a player forecast, its P(active) a p_active forecast against whether he played;
 * a week whose two lineups as played were each projected in full gives OUR pre-week P(win)
 * (independent normal sums of the served Dists — a starter E1 stored no row for at ESPN's mean with the
 * position-CV spread, the Dist E1 serves him), beside ESPN's from the pre-week scoreboard snapshot
 * of THIS season (preWeekSnapshot: the latest before the week's first kickoff — a previous season's
 * week N never answers). Before, E13 passed none of these and every metric read "n too small (0 of
 * 30)" forever; the stored snapshots were never read (Stage C finding
 * reclog-retro-forecasts-never-scored). Rows stored before the served Dist was kept are not scored
 * (said).
 */
export async function retroForecasts(
  ctx: ToolContext,
  season: number,
  week: Week,
  team: number,
  boxes: (w: Week) => Promise<readonly BoxScoreMatchup[] | null>,
  schedule: ProSchedule | null,
  settings: ScoringSettings,
  warnings: string[],
): Promise<RetroForecasts> {
  const player_forecasts: PlayerForecast[] = [];
  const p_active: WeekProbability[] = [];
  const p_win: ComparatorProbability[] = [];
  let snapshotUsed = false;
  let unserved = 0;
  let incompleteWeeks = 0;
  for (let x = Math.max(1, week - ATTRIBUTION_WINDOW_WEEKS + 1); x <= week; x++) {
    await turn();
    const bx = await boxes(x);
    if (bx === null) continue;
    const kick = kickoffsOf(schedule, x);
    const seen = new Set<number>();
    let n = 0;
    for (const m of bx) {
      const sides = [m.home, m.away].filter((s): s is NonNullable<typeof s> => s !== null);
      const lineup = new Map<number, { mu: number; v: number; complete: boolean }>();
      for (const side of sides) {
        let mu = 0;
        let v = 0;
        let complete = true;
        for (const e of side.entries) {
          if (n > 0 && n % ATTRIBUTION_PER_TURN === 0) await turn();
          n += 1;
          const starts = e.slot_class === "starter" || e.slot_class === "flex";
          const lock = kick.get(e.player.pro_team_id);
          const stored =
            lock === undefined ? null : storedBefore(ctx, e.player.ref.id, season, x, lock);
          const served = stored === null ? null : servedDistOf(stored);
          if (stored !== null && served === null) unserved += 1;
          if (starts) {
            // a starter whose team has no game this week (a bye) scores 0 for certain; one without a
            // stored projection is what E1 serves a player without a trailing line — ESPN's mean
            // with the position-CV spread (E1 stores no row for him: nothing to attribute)
            const bye = lock === undefined && kick.size > 0;
            const espnMean = e.projected?.applied_total ?? null;
            const d =
              served ??
              (espnMean === null
                ? null
                : gammaDist(
                    espnMean,
                    positionCv(e.player.position, e.player.position_id, settings),
                    "position_cv",
                  ));
            if (d !== null) {
              mu += d.mean;
              v += sigmaOf(d) ** 2;
            } else if (!bye) complete = false;
          }
          const id = e.player.ref.id;
          const outcome = e.actual?.applied_total ?? null;
          if (seen.has(id) || stored === null || outcome === null) continue;
          seen.add(id);
          if (served !== null) {
            const espnMean = e.projected?.applied_total ?? null;
            player_forecasts.push({
              week: x,
              player_id: id,
              position: e.player.position,
              ours: served,
              ours_samples: null,
              espn:
                espnMean === null
                  ? null
                  : gammaDist(
                      espnMean,
                      positionCv(e.player.position, e.player.position_id, settings),
                      "position_cv",
                    ),
              outcome,
            });
          }
          if (stored.p_active !== undefined && stored.p_active !== null)
            p_active.push({
              week: x,
              p: stored.p_active,
              outcome: playedFromEspn(e.actual?.raw ?? null),
            });
        }
        lineup.set(side.team_id, { mu, v, complete });
      }
      // our pre-week P(win) of my matchup, from the lineups as played (both projected in full)
      const mine = sides.find((s) => s.team_id === team);
      const other = sides.find((s) => s.team_id !== team);
      if (mine === undefined || other === undefined) continue;
      const a = lineup.get(mine.team_id);
      const b = lineup.get(other.team_id);
      const pm = mine.total_points;
      const po = other.total_points;
      if (a === undefined || b === undefined || pm === null || po === null || pm === po) continue;
      if (!a.complete || !b.complete) {
        incompleteWeeks += 1;
        continue;
      }
      const sd = Math.sqrt(a.v + b.v);
      const ours = sd > 0 ? normalCdf((a.mu - b.mu) / sd) : a.mu > b.mu ? 1 : a.mu < b.mu ? 0 : 0.5;
      let weekSnaps: readonly ScoreboardSnapshot[] = [];
      try {
        // this season's snapshots of week x only (forWeek has no season: a rollover keeps others)
        weekSnaps = ctx.services.scoreboardSnapshots
          .forWeek(x)
          .filter((s) => seasonOfInstant(s.taken_at) === season);
      } catch {
        weekSnaps = [];
      }
      const kicks = [...kick.values()];
      const snap = preWeekSnapshot(weekSnaps, x, kicks.length === 0 ? null : Math.min(...kicks));
      const espn = espnNumbersOf(snap).win_probability.get(team) ?? null;
      if (espn !== null) snapshotUsed = true;
      p_win.push({ week: x, ours: Math.min(1, Math.max(0, ours)), espn, outcome: pm > po });
    }
  }
  if (unserved > 0)
    warnings.push(
      `${String(unserved)} pre-lock projection(s) were stored before the served distribution was kept: not in the projection metrics`,
    );
  if (incompleteWeeks > 0)
    warnings.push(
      `${String(incompleteWeeks)} week(s) without a pre-lock projection for every starter of both lineups: no P(win) forecast for them`,
    );
  return { player_forecasts, p_active, p_win, snapshot_used: snapshotUsed };
}

/** The claim types scored at their own week (availability, health) and one week later (role). */
const NOW_TYPES: readonly ScoredClaimType[] = ["availability", "health"];
const LATER_TYPES: readonly ScoredClaimType[] = ["role", "coaching_intent"];

/**
 * Scores E10's logged claims (plan 10 C8): the week's availability and health claims (played: the
 * box score's games-played stat, else the player's snap count that week) and the previous week's role
 * claims (the snap share over that week and this one against up to four games before). A claim whose
 * outcome cannot be known yet stays pending. Returns how many were scored.
 */
export async function scoreClaims(
  ctx: ToolContext,
  season: number,
  week: Week,
  boxes: readonly BoxScoreMatchup[],
  gsisOf: (id: number) => string | null,
): Promise<number> {
  const repo = ctx.services.scoredClaims;
  if (repo === undefined) return 0;
  beforeSideEffect(ctx);
  const league = leagueRef(ctx).league_id;
  const box = new Map<number, Readonly<Record<string, number>> | null>();
  for (const m of boxes)
    for (const s of [m.home, m.away])
      for (const e of s?.entries ?? []) box.set(e.player.ref.id, e.actual?.raw ?? null);
  let now;
  let later;
  try {
    now = repo.pending(league, season, week).filter((c) => NOW_TYPES.includes(c.claim.type));
    later =
      week > 1
        ? repo.pending(league, season, week - 1).filter((c) => LATER_TYPES.includes(c.claim.type))
        : [];
  } catch {
    return 0;
  }
  if (now.length === 0 && later.length === 0) return 0;
  // snap shares (nflverse snap counts through the usage extras) for the players we need them for
  const ids = [...new Set([...now, ...later].map((c) => c.player_id))];
  const gsis = new Map<number, string>();
  for (const id of ids) {
    const g = gsisOf(id);
    if (g !== null) gsis.set(id, g);
  }
  const snaps = new Map<string, Map<number, number>>();
  if (gsis.size > 0) {
    await turn();
    const weeks = Array.from({ length: Math.min(week, 6) }, (_, i) => week - i).filter(
      (x) => x >= 1,
    );
    const r = ctx.services.datasets.playerWeeks.lines([...gsis.values()], season, weeks, {
      usage: true,
    });
    for (const l of r.rows) {
      const p = l.usage?.snap_pct;
      if (typeof p !== "number" || !Number.isFinite(p)) continue;
      const m = snaps.get(l.gsis_id) ?? new Map<number, number>();
      m.set(l.week, p);
      snaps.set(l.gsis_id, m);
    }
  }
  const at = ctx.services.clock.nowIso();
  let scored = 0;
  const record = (key: string, o: { active: boolean | null; borne_out: boolean | null }): void => {
    try {
      if (repo.score(key, o, at).written) scored += 1;
    } catch {
      // skipped: never fatal to the retrospective
    }
  };
  for (const c of now) {
    let played: boolean | null = null;
    if (box.has(c.player_id)) played = playedFromEspn(box.get(c.player_id) ?? null);
    else {
      const g = gsis.get(c.player_id);
      const s = g === undefined ? undefined : snaps.get(g)?.get(week);
      if (s !== undefined) played = s > 0;
    }
    if (played === null) continue; // unknown yet: stays pending
    record(c.key, claimOutcome(c.claim.type, c.claim.signal, { played }));
  }
  for (const c of later) {
    const g = gsis.get(c.player_id);
    const m = g === undefined ? undefined : snaps.get(g);
    if (m === undefined) continue;
    const after = [m.get(week - 1), m.get(week)].filter((x): x is number => x !== undefined);
    const before: number[] = [];
    for (let x = week - 2; x >= 1 && before.length < 4; x--) {
      const v = m.get(x);
      if (v !== undefined) before.push(v);
    }
    if (after.length === 0 || before.length === 0) continue;
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    record(
      c.key,
      claimOutcome(c.claim.type, c.claim.signal, {
        played: null,
        snap_before: mean(before),
        snap_after: mean(after),
      }),
    );
  }
  return scored;
}
