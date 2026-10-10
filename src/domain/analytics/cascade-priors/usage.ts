// usage.ts — team-game opportunities per player from nflverse play-by-play (plan 10 §3.3 "the
// redistribution prior table from pbp history"; sib research 05 §6.2): every regular-season play the
// store keeps (`PBP_KEPT_PLAY_TYPES`) counted with the store's own definitions, so a share here is the
// share E7 reads at call time — a target is `pass_attempt = 1 ∧ sack = 0 ∧ two_point_attempt = 0`
// with a receiver (`PBP_TARGET_SQL`), a carry `rush_attempt = 1 ∧ two_point_attempt = 0` with a
// rusher (`PBP_CARRY_SQL`), red zone `yardline_100 ≤ 20` (`redZoneFlag`). The domain may not import
// the store (eslint layer boundaries), so the definitions are restated and a test holds them equal
// to the store's. Positions come from the caller (nflverse `stats_player_week.position_group`);
// depth-chart ranks from the week's chart. Pure. New here.
import type { SkillPosition, UsagePosition, UsageRow } from "./types.js";

/** The pbp play types the store keeps (src/store/datasets/derive.ts `PBP_KEPT_PLAY_TYPES`). */
export const KEPT_PLAY_TYPES: readonly string[] = Object.freeze([
  "pass",
  "run",
  "field_goal",
  "extra_point",
  "kickoff",
  "punt",
  "qb_kneel",
  "qb_spike",
]);
/** The red zone (src/store/datasets/derive.ts `RED_ZONE_YARDLINE`). */
export const RED_ZONE_YARDLINE = 20;

/** The pbp columns a play is read from (raw nflverse names; numbers may arrive as bigint). */
export interface PbpPlay {
  readonly season: unknown;
  readonly week: unknown;
  readonly season_type: unknown;
  readonly posteam: unknown;
  readonly play_type: unknown;
  readonly pass_attempt: unknown;
  readonly rush_attempt: unknown;
  readonly sack: unknown;
  readonly two_point_attempt: unknown;
  readonly receiver_player_id: unknown;
  readonly rusher_player_id: unknown;
  readonly yardline_100: unknown;
}

/** One depth-chart listing for a team's week (rank 1 = first at the position). */
export interface DepthListing {
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly player: string;
  readonly position: SkillPosition;
  readonly rank: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "bigint" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const flag = (v: unknown, want: 0 | 1): boolean => num(v) === want;

/** Whether a pbp play counts as a target (the store's `PBP_TARGET_SQL` with a receiver). */
export function isTarget(p: PbpPlay): boolean {
  return (
    flag(p.pass_attempt, 1) &&
    flag(p.sack, 0) &&
    flag(p.two_point_attempt, 0) &&
    text(p.receiver_player_id) !== null
  );
}

/** Whether a pbp play counts as a carry (the store's `PBP_CARRY_SQL` with a rusher). */
export function isCarry(p: PbpPlay): boolean {
  return (
    flag(p.rush_attempt, 1) && flag(p.two_point_attempt, 0) && text(p.rusher_player_id) !== null
  );
}

/** Whether the snap is in the red zone (`yardline_100` a whole yard 1–99 and ≤ 20). */
export function isRedZone(p: PbpPlay): boolean {
  const y = num(p.yardline_100);
  return y !== null && Number.isInteger(y) && y >= 1 && y <= 99 && y <= RED_ZONE_YARDLINE;
}

const SKILL = new Set<string>(["QB", "RB", "WR", "TE"]);
/** A position group as the table reads it (`QB`/`RB`/`WR`/`TE`, else `OTHER`). */
export function usagePosition(v: unknown): UsagePosition {
  return typeof v === "string" && SKILL.has(v) ? (v as SkillPosition) : "OTHER";
}

interface Acc {
  season: number;
  week: number;
  team: string;
  player: string;
  position: UsagePosition;
  depth: number | null;
  targets: number;
  carries: number;
  rz_targets: number;
  rz_carries: number;
}

/**
 * Per (season, week, team, player): targets, carries and their red-zone subsets over the regular
 * season's kept plays, plus a zero row for every depth-chart listing of a team-week that played.
 * Rows are sorted (season, team, week, player). `positions` maps a player to his position group.
 */
export function usageFromPlays(
  plays: Iterable<PbpPlay>,
  positions: ReadonlyMap<string, UsagePosition>,
  depth: readonly DepthListing[] = [],
): UsageRow[] {
  const acc = new Map<string, Acc>();
  const played = new Set<string>();
  const key = (s: number, t: string, w: number, p: string) => `${String(s)}|${t}|${String(w)}|${p}`;
  const row = (s: number, t: string, w: number, p: string): Acc => {
    const k = key(s, t, w, p);
    let a = acc.get(k);
    if (a === undefined) {
      a = {
        season: s,
        week: w,
        team: t,
        player: p,
        position: positions.get(p) ?? "OTHER",
        depth: null,
        targets: 0,
        carries: 0,
        rz_targets: 0,
        rz_carries: 0,
      };
      acc.set(k, a);
    }
    return a;
  };
  for (const p of plays) {
    if (p.season_type !== "REG") continue;
    if (typeof p.play_type !== "string" || !KEPT_PLAY_TYPES.includes(p.play_type)) continue;
    const s = num(p.season);
    const w = num(p.week);
    const t = text(p.posteam);
    if (s === null || w === null || t === null || !Number.isInteger(w) || w < 1) continue;
    const rz = isRedZone(p);
    if (isTarget(p)) {
      const a = row(s, t, w, text(p.receiver_player_id) ?? "");
      a.targets += 1;
      if (rz) a.rz_targets += 1;
      played.add(`${String(s)}|${t}|${String(w)}`);
    }
    if (isCarry(p)) {
      const a = row(s, t, w, text(p.rusher_player_id) ?? "");
      a.carries += 1;
      if (rz) a.rz_carries += 1;
      played.add(`${String(s)}|${t}|${String(w)}`);
    }
  }
  for (const d of depth) {
    if (!played.has(`${String(d.season)}|${d.team}|${String(d.week)}`)) continue;
    if (!Number.isInteger(d.rank) || d.rank < 1) continue;
    const a = row(d.season, d.team, d.week, d.player);
    if (a.position === "OTHER") a.position = d.position;
    if (a.position === d.position) a.depth = a.depth === null ? d.rank : Math.min(a.depth, d.rank);
  }
  return [...acc.values()].sort(
    (a, b) =>
      a.season - b.season ||
      (a.team < b.team ? -1 : a.team > b.team ? 1 : 0) ||
      a.week - b.week ||
      (a.player < b.player ? -1 : a.player > b.player ? 1 : 0),
  );
}
