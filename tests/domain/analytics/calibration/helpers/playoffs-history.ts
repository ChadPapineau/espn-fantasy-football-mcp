// playoffs-history.ts — our P(playoffs) on the recorded finished seasons (plan 10 C3; research 05
// §8.4 #5 "Brier and reliability of P(playoffs) from weeks 4, 8 and 12"): for every league-season of
// the committed history (fixtures/espn/recorded/history/<season>/<slot>: mSettings, mTeam, mMatchup)
// and every checkpoint week, the standings and schedule as they stood after that week go through
// the shipped seeding simulator (`simulateSeason`, cold-start weekly models — the season-to-date mean
// shrunk toward the league mean with a pooled σ, the mean drawn from its posterior per path — under
// the league's own seeding rule, reading (a)) once per team (`known_means`: the same models with the
// mean taken as known — the simulator before the B2b fix, kept as the comparison); the outcome is the team's final `playoffSeed` within the playoff field. ESPN's
// `playoffPct` is absent from every finished season (only in-season mTeam carries
// `currentSimulationResults`), so every row's ESPN number is null. Team names are never read.
import { simulateSeason } from "../../../../../src/domain/analytics/seeding.js";
import type {
  PlayedGame,
  ScheduledGame,
  SeasonTeam,
} from "../../../../../src/domain/analytics/seeding.js";
import type { ComparatorRow } from "../../../../../src/domain/analytics/calibration/index.js";
import { fixedClock, seededRng } from "../../../../../src/domain/clock.js";
import { historyBody, servedSeasons } from "../../../../fixtures/helpers/history-fixtures.js";
import { instantPacer } from "../../helpers.js";

/** research 05 §8.4 #5's checkpoints. */
export const PLAYOFF_CHECKPOINTS = Object.freeze([4, 8, 12] as const);
/** Paths per simulation (the simulator's floor; ten runs per league-season checkpoint). */
const N_SIMS = 2000;

interface RawSide {
  readonly teamId: number;
  readonly totalPoints: number;
}
interface RawRow {
  readonly id: number;
  readonly matchupPeriodId: number;
  readonly winner?: string;
  readonly home: RawSide;
  readonly away?: RawSide | null;
}

/** One league-season's playoff inputs. */
export interface PlayoffSeason {
  readonly slot: string;
  readonly season: number;
  readonly regular_periods: number;
  readonly team_count: number;
  readonly rule: string;
  readonly reseed: boolean | null;
  readonly teams: readonly { team_id: number; division_id: number | null; seed: number }[];
  readonly rows: readonly RawRow[];
}

/** The history slots and seasons with a finished season recorded. */
export function playoffSeasons(): PlayoffSeason[] {
  const out: PlayoffSeason[] = [];
  for (const slot of ["league-a", "league-b", "league-c"])
    for (const [season] of servedSeasons(slot)) {
      const settings = historyBody(season, slot, "mSettings") as unknown as {
        settings: {
          scheduleSettings: {
            matchupPeriodCount: number;
            playoffTeamCount: number;
            playoffSeedingRule: string;
            playoffReseed?: boolean;
          };
        };
      };
      const team = historyBody(season, slot, "mTeam") as unknown as {
        teams: { id: number; divisionId?: number; playoffSeed: number }[];
      };
      const matchup = historyBody(season, slot, "mMatchup") as unknown as {
        schedule: RawRow[];
      };
      const ss = settings.settings.scheduleSettings;
      out.push({
        slot,
        season,
        regular_periods: ss.matchupPeriodCount,
        team_count: ss.playoffTeamCount,
        rule: ss.playoffSeedingRule,
        reseed: typeof ss.playoffReseed === "boolean" ? ss.playoffReseed : null,
        teams: team.teams.map((t) => ({
          team_id: t.id,
          division_id: typeof t.divisionId === "number" ? t.divisionId : null,
          seed: t.playoffSeed,
        })),
        rows: matchup.schedule,
      });
    }
  return out;
}

/**
 * The standings and schedule after `checkpoint`, our P(playoffs) per team, and the outcome. With
 * `known_means` every team runs on its cold-start model (μ, σ) as an explicit weekly model without
 * `mean_sd` — no mean uncertainty, the comparison for the fix.
 */
export async function playoffRows(
  ps: PlayoffSeason,
  checkpoint: number,
  opts: { readonly known_means?: boolean } = {},
): Promise<ComparatorRow[]> {
  const regular = ps.rows.filter(
    (r) => r.matchupPeriodId <= ps.regular_periods && r.away !== undefined && r.away !== null,
  );
  const playedRows = regular.filter((r) => r.matchupPeriodId <= checkpoint);
  const played: PlayedGame[] = playedRows.map((r) => ({
    period: r.matchupPeriodId,
    home: r.home.teamId,
    away: r.away?.teamId ?? -1,
    home_points: r.home.totalPoints,
    away_points: r.away?.totalPoints ?? 0,
  }));
  const remaining: ScheduledGame[] = regular
    .filter((r) => r.matchupPeriodId > checkpoint)
    .map((r) => ({
      period: r.matchupPeriodId,
      matchup_id: r.id,
      home: r.home.teamId,
      away: r.away?.teamId ?? -1,
    }));
  const teams: SeasonTeam[] = ps.teams.map((t) => {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pf = 0;
    let pa = 0;
    for (const g of played) {
      const home = g.home === t.team_id;
      if (!home && g.away !== t.team_id) continue;
      const mine = home ? g.home_points : g.away_points;
      const theirs = home ? g.away_points : g.home_points;
      pf += mine;
      pa += theirs;
      if (mine > theirs) wins += 1;
      else if (mine < theirs) losses += 1;
      else ties += 1;
    }
    return {
      team_id: t.team_id,
      division_id: t.division_id,
      wins,
      losses,
      ties,
      points_for: pf,
      points_against: pa,
    };
  });
  const playoff = {
    team_count: ps.team_count,
    seeding_rule: ps.rule,
    reseed: ps.reseed,
    rounds: [],
  };
  let simTeams: SeasonTeam[] = teams;
  if (opts.known_means === true) {
    // the cold models (μ and σ are the same whichever team is `me`)
    const cold = await simulateSeason({
      teams,
      played,
      remaining,
      me: teams[0]?.team_id ?? 0,
      playoff,
      seeding_mode: "espn_rule",
      seeding_config: { mode: "espn_rule", confirmed_at: null },
      n_sims: 1000,
      marginal: false,
      clock: fixedClock(Date.UTC(ps.season, 9, 1)),
      rng: seededRng(1),
      pacer: instantPacer,
      deadline_ms: null,
    });
    simTeams = teams.map((t) => ({ ...t, weekly: cold.models.get(t.team_id) ?? null }));
  }
  const rows: ComparatorRow[] = [];
  for (const t of ps.teams) {
    const out = await simulateSeason({
      teams: simTeams,
      played,
      remaining,
      me: t.team_id,
      playoff,
      seeding_mode: "espn_rule",
      seeding_config: { mode: "espn_rule", confirmed_at: null },
      n_sims: N_SIMS,
      marginal: false,
      clock: fixedClock(Date.UTC(ps.season, 9, 1)),
      rng: seededRng(ps.season * 100 + checkpoint * 7 + t.team_id),
      pacer: instantPacer,
      deadline_ms: null,
    });
    const reading = out.data.readings[0];
    if (reading === undefined) continue;
    rows.push({
      group: ps.slot,
      season: ps.season,
      period: checkpoint,
      team_id: t.team_id,
      ours: reading.p_playoffs,
      espn: null,
      outcome: t.seed >= 1 && t.seed <= ps.team_count,
    });
  }
  return rows;
}

/** How much a league-season's team strength persisted (the cold start's shrinkage assumes k = 4). */
export interface SeasonPersistence {
  readonly slot: string;
  readonly season: number;
  readonly teams: number;
  readonly games: number;
  /** Pooled weekly sd of a team's score around its season mean. */
  readonly sigma: number;
  /** Between-team sd of true weekly means (method of moments; 0 when the estimate is ≤ 0). */
  readonly tau: number;
  /** σ²/τ² — the shrinkage constant the season implies (null when τ² ≤ 0: no persistence). */
  readonly k: number | null;
  /** Correlation of the teams' first-half and second-half mean scores. */
  readonly half_corr: number;
}

/** The persistence of one finished league-season's regular-season scoring. */
export function seasonPersistence(ps: PlayoffSeason): SeasonPersistence {
  const scores = new Map<number, { period: number; points: number }[]>();
  for (const r of ps.rows) {
    if (r.matchupPeriodId > ps.regular_periods || r.away === undefined || r.away === null) continue;
    for (const side of [r.home, r.away]) {
      const list = scores.get(side.teamId) ?? [];
      list.push({ period: r.matchupPeriodId, points: side.totalPoints });
      scores.set(side.teamId, list);
    }
  }
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const means: number[] = [];
  const first: number[] = [];
  const second: number[] = [];
  let ss = 0;
  let cnt = 0;
  const half = ps.regular_periods / 2;
  for (const list of scores.values()) {
    const m = mean(list.map((x) => x.points));
    means.push(m);
    for (const x of list) {
      ss += (x.points - m) ** 2;
      cnt += 1;
    }
    first.push(mean(list.filter((x) => x.period <= half).map((x) => x.points)));
    second.push(mean(list.filter((x) => x.period > half).map((x) => x.points)));
  }
  const n = means.length;
  const s2 = ss / (cnt - n);
  const mm = mean(means);
  const vMeans = means.reduce((a, b) => a + (b - mm) ** 2, 0) / (n - 1);
  const tau2 = vMeans - s2 / ps.regular_periods;
  const mf = mean(first);
  const ms = mean(second);
  let cov = 0;
  let vf = 0;
  let vs = 0;
  for (let i = 0; i < n; i++) {
    const a = (first[i] ?? 0) - mf;
    const b = (second[i] ?? 0) - ms;
    cov += a * b;
    vf += a * a;
    vs += b * b;
  }
  return {
    slot: ps.slot,
    season: ps.season,
    teams: n,
    games: ps.regular_periods,
    sigma: Math.sqrt(s2),
    tau: Math.sqrt(Math.max(0, tau2)),
    k: tau2 > 0 ? s2 / tau2 : null,
    half_corr: cov / Math.sqrt(vf * vs),
  };
}
