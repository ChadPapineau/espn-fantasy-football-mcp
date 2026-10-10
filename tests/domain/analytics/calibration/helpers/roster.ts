// roster.ts — small hand-built rosters for the calibration unit tests (plan 10 C2): the reference
// slots (QB, 2 RB, 2 WR, TE, FLEX, D/ST, K, BE, IR), players with known Dists, and rows.
import type { LineupPlayer } from "../../../../../src/domain/analytics/lineup.js";
import type {
  StartSitRow,
  StartSitRule,
} from "../../../../../src/domain/analytics/calibration/index.js";
import type { Dist, DistBasis } from "../../../../../src/domain/scoring/types.js";
import { bare, dist, ELIGIBLE } from "../../helpers.js";

export const SLOT = {
  QB: 0,
  RB: 2,
  WR: 4,
  TE: 6,
  FLEX: 23,
  DST: 16,
  K: 17,
  BE: 20,
  IR: 21,
} as const;

/** A Dist of a given basis (sd = cv × mean). */
export function distOf(mean: number, basis: DistBasis = "position_cv", cv = 0.5): Dist {
  return { ...dist(mean, cv), basis };
}

/** One rostered player (pro team = his id unless given). */
export function player(
  id: number,
  position: string,
  mean: number,
  slot: number,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  return {
    player_id: id,
    gsis_id: null,
    name: bare(`Player ${String(id)}`),
    position,
    eligible_slot_ids: ELIGIBLE[position] ?? [20],
    injury_status: null,
    pro_team_id: id,
    slot_id: slot,
    locked: false,
    lock_at: null,
    points: distOf(mean, "position_cv", position === "QB" ? 0.4 : 0.6),
    p_active: null,
    espn_projection: mean,
    percent_started: null,
    role_games: 4,
    ...over,
  };
}

/** A legal roster whose bench holds two upgrades (an RB and a WR), ids offset by `base`. */
export function roster(base = 0, basis: DistBasis = "position_cv"): LineupPlayer[] {
  const rows: [string, number, number][] = [
    ["QB", 20, SLOT.QB],
    ["RB", 14, SLOT.RB],
    ["RB", 9, SLOT.RB],
    ["WR", 13, SLOT.WR],
    ["WR", 8, SLOT.WR],
    ["TE", 9, SLOT.TE],
    ["WR", 7, SLOT.FLEX],
    ["D/ST", 7, SLOT.DST],
    ["K", 8, SLOT.K],
    ["RB", 12, SLOT.BE],
    ["WR", 11, SLOT.BE],
    ["TE", 5, SLOT.BE],
  ];
  return rows.map(([pos, mean, slot], i) => {
    const id = base + i + 1;
    const p = player(id, pos, mean, slot);
    return { ...p, points: { ...p.points, basis } };
  });
}

const RULES: readonly StartSitRule[] = [
  "hindsight",
  "auto",
  "mean",
  "pwin",
  "espn_projection",
  "last_week",
  "manager",
];

/** A StartSitRow with every rule realised from `realised` (missing → null) and its own lineup key. */
export function row(
  season: number,
  week: number,
  realised: Partial<Record<StartSitRule, number>>,
  over: Partial<StartSitRow> = {},
): StartSitRow {
  const r = {} as Record<StartSitRule, number | null>;
  const k = {} as Record<StartSitRule, string | null>;
  for (const rule of RULES) {
    r[rule] = realised[rule] ?? null;
    k[rule] = realised[rule] === undefined ? null : rule;
  }
  return {
    season,
    week,
    team_id: 1,
    objective_auto: "mean",
    basis: "position_cv",
    player_sim_share: 0,
    realised: r,
    lineup_key: k,
    h2h: null,
    ...over,
  };
}
