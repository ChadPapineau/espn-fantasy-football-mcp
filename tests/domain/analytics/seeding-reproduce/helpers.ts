// helpers.ts — constructed finished seasons for the seeding-reproduction tests (plan 10 C4): games
// in, consistent standings out (so a test changes exactly the one thing it means to), seeds from
// any order, and an independent reference implementation of research 05 §2.1's chain written
// from the text — not from src/domain/analytics/seeding.ts — so the property tests check the
// shipped chain against a second reading of the rule.
import type {
  ReproduceMatchup,
  ReproduceTeam,
  SeasonReproductionInput,
} from "../../../../src/domain/analytics/seeding-reproduce/index.js";

/** One constructed regular-season game: home, away, home points, away points. */
export type G = readonly [home: number, away: number, hp: number, ap: number];

/** A matchup row from a game (a tie arrives as `winner: "TIE"`, as the provider normalises it). */
export function row(g: G, period: number): ReproduceMatchup {
  const [home, away, hp, ap] = g;
  return {
    matchup_period: period,
    winner: hp > ap ? "HOME" : hp < ap ? "AWAY" : "TIE",
    is_bye: false,
    home: { team_id: home, points: hp },
    away: { team_id: away, points: ap },
  };
}

/** Standings consistent with the games (W/L/T, PF, PA), seeds unset. */
export function standingsOf(
  teamIds: readonly number[],
  games: readonly G[],
  division: (id: number) => number | null = () => 0,
): ReproduceTeam[] {
  const r = new Map(teamIds.map((id) => [id, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  for (const [h, a, hp, ap] of games) {
    const rh = r.get(h);
    const ra = r.get(a);
    if (rh === undefined || ra === undefined) continue;
    rh.pf += hp;
    rh.pa += ap;
    ra.pf += ap;
    ra.pa += hp;
    if (hp > ap) {
      rh.w++;
      ra.l++;
    } else if (hp < ap) {
      ra.w++;
      rh.l++;
    } else {
      rh.t++;
      ra.t++;
    }
  }
  return teamIds.map((id) => {
    const x = r.get(id) ?? { w: 0, l: 0, t: 0, pf: 0, pa: 0 };
    return {
      team_id: id,
      division_id: division(id),
      playoff_seed: null,
      wins: x.w,
      losses: x.l,
      ties: x.t,
      points_for: x.pf,
      points_against: x.pa,
    };
  });
}

/** Sets seeds from an order (seed 1 first). */
export function seeded(teams: readonly ReproduceTeam[], order: readonly number[]): ReproduceTeam[] {
  return teams.map((t) => ({ ...t, playoff_seed: order.indexOf(t.team_id) + 1 }));
}

/** A season input: games one per period (period = index + 1 unless given), regular = last period. */
export function seasonOf(args: {
  readonly teams: readonly ReproduceTeam[];
  readonly games: readonly G[];
  readonly periods?: readonly number[];
  readonly regular?: number | null;
  readonly team_count?: number | null;
  readonly rule?: string;
  readonly extra?: readonly ReproduceMatchup[];
  readonly playoff_edited?: boolean | null;
  readonly season?: number;
}): SeasonReproductionInput {
  const periods = args.periods ?? args.games.map((_, i) => i + 1);
  const matchups = args.games.map((g, i) => row(g, periods[i] ?? i + 1));
  return {
    season: args.season ?? 2024,
    teams: args.teams,
    matchups: [...matchups, ...(args.extra ?? [])],
    playoff: {
      team_count: args.team_count === undefined ? 4 : args.team_count,
      seeding_rule: args.rule ?? "TOTAL_POINTS_SCORED",
      seeding_rule_by: 0,
      regular_season_matchups: args.regular === undefined ? Math.max(1, ...periods) : args.regular,
    },
    playoff_edited: args.playoff_edited ?? false,
  };
}

// --- the reference chain (research 05 §2.1, written independently) ------------------------------

type Rec = ReproduceTeam;

const pctOf = (t: Rec): number => {
  const g = t.wins + t.losses + t.ties;
  return g === 0 ? 0 : (t.wins + t.ties / 2) / g;
};

/** Head-to-head (or division) win share of `t` against the teams in `among`. */
function shareAgainst(t: Rec, among: ReadonlySet<number>, games: readonly G[]): number | null {
  let w = 0;
  let n = 0;
  for (const [h, a, hp, ap] of games) {
    const mine = h === t.team_id ? 0 : a === t.team_id ? 1 : -1;
    if (mine < 0) continue;
    const other = mine === 0 ? a : h;
    if (!among.has(other)) continue;
    n++;
    if (hp === ap) w += 0.5;
    else if (hp > ap === (mine === 0)) w += 1;
  }
  return n === 0 ? null : w / n;
}

/**
 * The reference reading (a) for TOTAL_POINTS_SCORED: division winners first (when > 1 division),
 * then win %, PF, head-to-head among the tied teams, division record, fewer PA, then the team-list
 * order (the coin). Reading (b): PF, then the team-list order.
 */
export function referenceOrder(
  teams: readonly Rec[],
  games: readonly G[],
  mode: "espn_rule" | "points_only",
): number[] {
  const pos = new Map(teams.map((t, i) => [t.team_id, i]));
  const levels: ((t: Rec, group: readonly Rec[]) => number)[] =
    mode === "points_only"
      ? [(t) => t.points_for]
      : [
          (t) => pctOf(t),
          (t) => t.points_for,
          (t, group) =>
            shareAgainst(
              t,
              new Set(group.map((x) => x.team_id).filter((x) => x !== t.team_id)),
              games,
            ) ?? 0.5,
          (t) => {
            const d = t.division_id;
            if (d === null) return 0;
            const mates = new Set(
              teams
                .filter((x) => x.division_id === d && x.team_id !== t.team_id)
                .map((x) => x.team_id),
            );
            return shareAgainst(t, mates, games) ?? 0;
          },
          (t) => -t.points_against,
        ];
  const sortGroup = (group: Rec[], level: number): Rec[] => {
    if (group.length <= 1) return group;
    const f = levels[level];
    if (f === undefined)
      return [...group].sort((x, y) => (pos.get(x.team_id) ?? 0) - (pos.get(y.team_id) ?? 0));
    const scored = group.map((t) => ({ t, v: f(t, group) }));
    scored.sort((x, y) => y.v - x.v || (pos.get(x.t.team_id) ?? 0) - (pos.get(y.t.team_id) ?? 0));
    const out: Rec[] = [];
    for (let i = 0; i < scored.length;) {
      let j = i;
      while (
        j + 1 < scored.length &&
        Math.abs((scored[j + 1]?.v ?? 0) - (scored[i]?.v ?? 0)) <= 1e-9
      )
        j++;
      const tied = scored.slice(i, j + 1).map((x) => x.t);
      out.push(...(tied.length > 1 ? sortGroup(tied, level + 1) : tied));
      i = j + 1;
    }
    return out;
  };
  const divs = new Set(teams.map((t) => t.division_id).filter((d) => d !== null));
  if (mode === "points_only" || divs.size <= 1)
    return sortGroup([...teams], 0).map((t) => t.team_id);
  const byDiv = new Map<number | null, Rec[]>();
  for (const t of teams) byDiv.set(t.division_id, [...(byDiv.get(t.division_id) ?? []), t]);
  const winners = [...byDiv.values()]
    .map((m) => sortGroup(m, 0)[0])
    .filter((x): x is Rec => x !== undefined);
  const w = new Set(winners.map((t) => t.team_id));
  return [
    ...sortGroup(winners, 0),
    ...sortGroup(
      teams.filter((t) => !w.has(t.team_id)),
      0,
    ),
  ].map((t) => t.team_id);
}

/** A double round-robin-ish schedule over `ids`: every pair once per round, `rounds` rounds. */
export function roundRobin(ids: readonly number[], rounds: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < rounds; r++)
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] ?? 0;
        const b = ids[j] ?? 0;
        out.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
  return out;
}
