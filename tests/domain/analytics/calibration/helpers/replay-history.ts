// replay-history.ts — the held-out start/sit replay (plan 10 C2, C3; research 05 §8.4 #7): every
// complete team-week of `league-b`'s recorded 2024 and 2025 seasons through the shipped engines, on
// each toolset's distributions — `position_cv` (what EFF_TOOLSET=core serves: E1 `v1-ensemble`, the
// positional CV around ESPN's weekly projection, weight_espn = 1.0) and `full` (what EFF_TOOLSET=full
// serves since Phase 3: E1 with the Phase 2 player_sim basis — an RB/WR/TE with ≥ 3 trailing games —
// overlaid, for every QB/RB/WR/TE v2 can model, by `v2-opportunity`'s served first-week Dist, the
// merge src/mcp/tools/analytics.ts performs; v2-history.ts assembles v2's request the way the store
// does). E2 decides through calibration/replay.ts. v1's trailing lines are the player's own earlier
// weeks of the held-out seasons as ESPN recorded them (the actual raw stats in the same box scores,
// through the plan 08 translator) — only weeks he was rostered in this league, never the week itself
// or later (no look-ahead); v2 reads the nflverse games before the week. Nothing is fitted on these
// seasons: every parameter is a shipped constant (v2's were fitted on 2023), so both seasons are held
// out. Deterministic (seeded per season and week).
import {
  projectPlayers,
  type TrailingLine,
} from "../../../../../src/domain/analytics/projection.js";
import type { LineupPlayer } from "../../../../../src/domain/analytics/lineup.js";
import {
  replayStartSit,
  type ObjectiveSwitchRecord,
  type StartSitRow,
} from "../../../../../src/domain/analytics/calibration/index.js";
import { fixedClock, seededRng } from "../../../../../src/domain/clock.js";
import type { BareText } from "../../../../../src/domain/league/types.js";
import type { Dist } from "../../../../../src/domain/scoring/types.js";
import { instantPacer } from "../../helpers.js";
import { heldOutSeasons, historySeason, type HistoryEntry, type HistorySeason } from "./history.js";
import { v2WeekOverlay } from "./v2-history.js";

/** The distribution basis a replay runs on: `core`'s position_cv, or what `full` serves. */
export type ReplayBasis = "position_cv" | "full";

/** E1's per-call target bound (LIMITS.maxTargets) and trailing-line bound (LIMITS.maxTrailing). */
const TARGETS_PER_CALL = 64;
const TRAILING_KEPT = 40;
/** E1's sample count for the replay (its own minimum; the shape, not the mean, depends on it). */
const N_SIMS = 1000;
/**
 * v2's samples per player in the replay. E2's own call asks for v2's default (2 000) and shares it
 * down by the line budget; the replay uses 500 to stay inside the unit project's time — the mean is
 * pinned to ESPN's either way, only the quantiles' Monte-Carlo noise depends on it.
 */
export const V2_REPLAY_SIMS = 500;

/** One season's replay and the bookkeeping the eval report states. */
export interface SeasonReplay {
  readonly season: number;
  readonly rows: readonly StartSitRow[];
  /** Team-weeks skipped because a roster entry was withheld (manifest `incomplete`). */
  readonly skipped_incomplete: number;
  /** Team-weeks whose matchup is not decided by the week's points (both complete). */
  readonly not_h2h: number;
  /** Player-weeks without an ESPN projection (E1 then reads his trailing line). */
  readonly no_projection: number;
  /** Rostered player-weeks whose E1 Dist is player_sim (v2's or the Phase 2 basis). */
  readonly player_sim_weeks: number;
  /** …of which v2-opportunity served (the rest: Phase 2's volume × efficiency basis). */
  readonly v2_weeks: number;
  /** …of the v2-served weeks, the quarterbacks' (Phase 2's basis never served a QB). */
  readonly v2_qb_weeks: number;
  /** …of the player_sim weeks, the mean differs from ESPN's projection by more than 0.01. */
  readonly player_sim_off_espn: number;
}

/** A replay of every held-out season on one basis. */
export interface HistoryReplay {
  readonly basis: ReplayBasis;
  readonly seasons: readonly SeasonReplay[];
  readonly rows: readonly StartSitRow[];
}

const nameOf = (id: number): BareText => `Player ${String(id)}` as BareText;

function lineupPlayer(e: HistoryEntry, points: Dist): LineupPlayer {
  return {
    player_id: e.player_id,
    gsis_id: null,
    name: nameOf(e.player_id),
    position: e.position,
    eligible_slot_ids: e.eligible_slot_ids,
    injury_status: null,
    pro_team_id: e.pro_team_id,
    slot_id: e.slot_id,
    locked: false,
    lock_at: null,
    points,
    p_active: null,
    espn_projection: e.projected,
    percent_started: null,
    role_games: 0,
  };
}

/** E1 v1 Dists for every rostered player of one week, and the players whose week is a bye. */
async function weekDists(
  s: HistorySeason,
  week: number,
  entries: readonly HistoryEntry[],
  trailing: ReadonlyMap<number, readonly TrailingLine[]>,
  basis: ReplayBasis,
): Promise<{ dists: Map<number, Dist>; byes: Set<number> }> {
  const out = new Map<number, Dist>();
  const byes = new Set<number>();
  const targets = entries.map((e) => ({
    player_id: e.player_id,
    gsis_id: null,
    name: nameOf(e.player_id),
    position: e.position,
    position_id: e.position_id,
    pro_team_id: e.pro_team_id,
    injury_status: null,
    espn_week: e.projected,
    espn_ros: null,
    trailing: (trailing.get(e.player_id) ?? []).slice(-TRAILING_KEPT),
  }));
  for (let i = 0; i < targets.length; i += TARGETS_PER_CALL) {
    const res = await projectPlayers({
      targets: targets.slice(i, i + TARGETS_PER_CALL),
      season: s.season,
      horizon: "week",
      week,
      final_week: week,
      settings: s.settings,
      schedule: s.schedule,
      clock: fixedClock(Date.UTC(s.season, 8, 1)),
      rng: seededRng(s.season * 1000 + week * 10 + i / TARGETS_PER_CALL),
      pacer: instantPacer,
      deadline_ms: null,
      n_sims: N_SIMS,
      player_sim: basis === "full",
    });
    for (const p of res.players) {
      const w = p.weeks[0];
      if (p.target.player_id === null || w === undefined) continue;
      out.set(p.target.player_id, w.dist);
      if (w.bye) byes.add(p.target.player_id);
    }
  }
  return { dists: out, byes };
}

/** What the toolset serves for one week: v1, and under `full` v2's overlay where it models. */
async function servedDists(
  s: HistorySeason,
  week: number,
  entries: readonly HistoryEntry[],
  trailing: ReadonlyMap<number, readonly TrailingLine[]>,
  basis: ReplayBasis,
): Promise<{ dists: Map<number, Dist>; v2: Set<number> }> {
  const v1 = await weekDists(s, week, entries, trailing, basis);
  const v2 = new Set<number>();
  if (basis !== "full") return { dists: v1.dists, v2 };
  const overlay = await v2WeekOverlay(s, week, entries, v1.byes, V2_REPLAY_SIMS);
  for (const [id, d] of overlay.dists) {
    v1.dists.set(id, d);
    v2.add(id);
  }
  return { dists: v1.dists, v2 };
}

/**
 * Replays one held-out season on a basis. `trailing` carries each player's recorded lines across
 * seasons (E1 also reads the prior season's); it is extended with this season's weeks as they pass.
 */
export async function replaySeason(
  s: HistorySeason,
  basis: ReplayBasis,
  objectiveSwitch?: ObjectiveSwitchRecord,
  trailing = new Map<number, TrailingLine[]>(),
): Promise<SeasonReplay> {
  const rows: StartSitRow[] = [];
  let skipped = 0;
  let notH2h = 0;
  let noProjection = 0;
  let simWeeks = 0;
  let v2Weeks = 0;
  let v2Qb = 0;
  let simOff = 0;
  let prev: Map<number, number> | null = null;
  for (const wk of s.weeks) {
    const all = new Map<number, HistoryEntry>();
    for (const t of wk.teams) for (const e of t.entries) all.set(e.player_id, e);
    noProjection += [...all.values()].filter((e) => e.projected === null).length;
    const { dists, v2 } = await servedDists(s, wk.week, [...all.values()], trailing, basis);
    for (const e of all.values()) {
      const d = dists.get(e.player_id);
      if (d?.basis !== "player_sim") continue;
      simWeeks += 1;
      if (v2.has(e.player_id)) {
        v2Weeks += 1;
        if (e.position === "QB") v2Qb += 1;
      }
      if (Math.abs(d.mean - (e.projected ?? 0)) > 0.01) simOff += 1;
    }
    const realised = new Map([...all.values()].map((e) => [e.player_id, e.actual ?? 0] as const));
    const espn = new Map([...all.values()].map((e) => [e.player_id, e.projected ?? 0] as const));
    const asPlayers = (entries: readonly HistoryEntry[]): LineupPlayer[] =>
      entries.map((e) => {
        const d = dists.get(e.player_id);
        if (d === undefined) throw new Error(`no E1 Dist for player ${String(e.player_id)}`);
        return lineupPlayer(e, d);
      });
    for (const t of wk.teams) {
      if (!t.complete) {
        skipped += 1;
        continue;
      }
      const opp = wk.teams.find((x) => x.team_id === t.opponent_id) ?? null;
      const h2h = opp !== null && opp.complete && t.starters_sum_total && opp.starters_sum_total;
      if (!h2h) notH2h += 1;
      rows.push(
        replayStartSit({
          season: s.season,
          week: wk.week,
          team_id: t.team_id,
          roster: s.roster,
          players: asPlayers(t.entries),
          opponent: opp === null ? null : asPlayers(opp.entries),
          realised,
          espn_projection: espn,
          last_week: prev,
          h2h,
          seeding_config: { mode: "espn_rule", confirmed_at: null },
          clock: fixedClock(Date.UTC(s.season, 8, 1)),
          ...(objectiveSwitch === undefined ? {} : { objective_switch: objectiveSwitch }),
        }),
      );
    }
    for (const e of all.values())
      if (e.actual_line !== null && e.actual !== null)
        trailing.set(e.player_id, [
          ...(trailing.get(e.player_id) ?? []),
          { season: s.season, week: wk.week, line: e.actual_line },
        ]);
    prev = realised;
  }
  return {
    season: s.season,
    rows,
    skipped_incomplete: skipped,
    not_h2h: notH2h,
    no_projection: noProjection,
    player_sim_weeks: simWeeks,
    v2_weeks: v2Weeks,
    v2_qb_weeks: v2Qb,
    player_sim_off_espn: simOff,
  };
}

/** Replays every held-out season on a basis (seasons loaded once per call). */
export async function replayHistory(
  basis: ReplayBasis,
  objectiveSwitch?: ObjectiveSwitchRecord,
): Promise<HistoryReplay> {
  const seasons: SeasonReplay[] = [];
  const trailing = new Map<number, TrailingLine[]>();
  for (const season of heldOutSeasons())
    seasons.push(await replaySeason(historySeason(season), basis, objectiveSwitch, trailing));
  return { basis, seasons, rows: seasons.flatMap((x) => x.rows) };
}
