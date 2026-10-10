// playoffs-history.ts — our P(playoffs) on the recorded finished seasons (plan 10 C3; research 05
// §8.4 #5 "Brier and reliability of P(playoffs) from weeks 4, 8 and 12"): for every league-season of
// the committed history (fixtures/espn/recorded/history/<season>/<slot>: mSettings, mTeam, mMatchup)
// and every checkpoint week, the standings and schedule as they stood after that week go through
// the shipped seeding simulator (`simulateSeason`, cold-start weekly models — the season-to-date mean
// shrunk toward the league mean with a pooled σ — under the league's own seeding rule, reading (a))
// once per team; the outcome is the team's final `playoffSeed` within the playoff field. ESPN's
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

/** The standings and schedule after `checkpoint`, our P(playoffs) per team, and the outcome. */
export async function playoffRows(ps: PlayoffSeason, checkpoint: number): Promise<ComparatorRow[]> {
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
  const rows: ComparatorRow[] = [];
  for (const t of ps.teams) {
    const out = await simulateSeason({
      teams,
      played,
      remaining,
      me: t.team_id,
      playoff: { team_count: ps.team_count, seeding_rule: ps.rule, reseed: ps.reseed, rounds: [] },
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
