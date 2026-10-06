// fx10h-world.ts — the derived Skills league fixtures/espn/fx-10h (and its variants) read IN PROCESS
// through the real ESPN provider in fixture mode (the derived-league fetch, in-memory limiter/cache/
// drift ports, the real scoring translator, the variant's own frozen clock) for the P1 analytics
// engines' fixture tests (plan 10 B7, B9). No network, no cookie: fixture mode refuses both. Also
// the E1 projections of a week the tools would compute (ESPN's mean, the position-CV shape — no
// nflverse trailing lines here), and the builders from domain objects to each engine's inputs.
import path from "node:path";
import { projectPlayers, type ProjectedPlayer } from "../../../src/domain/analytics/projection.js";
import { lineupPlayerOf, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { fixedClock, seededRng, type FixedClock } from "../../../src/domain/clock.js";
import { lockPlan } from "../../../src/domain/league/schedule.js";
import type {
  BoxScoreMatchup,
  League,
  LeagueRules,
  LiveMatchup,
  Matchup,
  ProSchedule,
  Roster,
  RosterSlots,
  Standings,
} from "../../../src/domain/league/types.js";
import { translateScoringInput, type ScoringSettings } from "../../../src/domain/scoring/index.js";
import {
  createDerivedLeagueFetch,
  derivedLeagueClock,
} from "../../../src/providers/espn/fixture-league.js";
import { makeWorld } from "../../providers/espn/helpers.js";
import { instantPacer } from "./helpers.js";

export const FX10H = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "espn",
  "fx-10h",
);
/** The user's team in fx-10h (README: Team 02). */
export const MY_TEAM = 2;
/** The fixture's current week (README: Tuesday of week 5). */
export const FX_WEEK = 5;

/** Everything one variant serves for week 5. */
export interface FxLeague {
  readonly clock: FixedClock;
  readonly league: League;
  readonly settings: ScoringSettings;
  readonly slots: RosterSlots;
  readonly rules: LeagueRules;
  readonly rosters: readonly Roster[];
  readonly matchups: readonly Matchup[];
  readonly standings: Standings;
  readonly schedule: ProSchedule;
  readonly box: readonly BoxScoreMatchup[];
  readonly live: readonly LiveMatchup[];
}

const cache = new Map<string, Promise<FxLeague>>();

/** One variant ("" = the base league), read once per test process. */
export function fxLeague(variant = ""): Promise<FxLeague> {
  let p = cache.get(variant);
  if (p === undefined) {
    p = load(variant);
    cache.set(variant, p);
  }
  return p;
}

async function load(variant: string): Promise<FxLeague> {
  const dir = path.join(FX10H, variant);
  const at = derivedLeagueClock(dir);
  if (at === null) throw new Error(`no derived league at ${dir}`);
  const clock = fixedClock(at);
  const w = makeWorld({
    fetch: createDerivedLeagueFetch({ dir }),
    clock,
    teamId: MY_TEAM,
    over: { scoring: translateScoringInput },
  });
  const ref = w.ref;
  const p = w.provider;
  const league = (await p.getLeague(ref)).value;
  const settings = (await p.getScoringSettings(ref)).value;
  const slots = (await p.getRosterSlots(ref)).value;
  const rules = (await p.getLeagueRules(ref)).value;
  const rosters = (await p.getRosters(ref, FX_WEEK)).value;
  const matchups = (await p.getMatchups(ref)).value;
  const standings = (await p.getStandings(ref)).value;
  const schedule = (await p.getProSchedule(ref.season)).value;
  const box = (await p.getBoxScores(ref, FX_WEEK)).value;
  const live = (await p.getLiveMatchups(ref, FX_WEEK)).value;
  return {
    clock,
    league,
    settings,
    slots,
    rules,
    rosters,
    matchups,
    standings,
    schedule,
    box,
    live,
  };
}

/** E1 for every player of `rosters` over `weeks` (ESPN's mean; seeded; no CPU deadline). */
export async function projectRosters(
  fx: FxLeague,
  rosters: readonly Roster[],
  weeks: { readonly from: number; readonly horizon: "week" | "ros" },
): Promise<Map<number, ProjectedPlayer>> {
  const out = new Map<number, ProjectedPlayer>();
  const entries = rosters.flatMap((r) => r.entries);
  for (let i = 0; i < entries.length; i += 60) {
    const chunk = entries.slice(i, i + 60);
    const res = await projectPlayers({
      targets: chunk.map((e) => ({
        player_id: e.player.ref.id,
        gsis_id: null,
        name: e.player.name,
        position: e.player.position,
        position_id: e.player.position_id,
        pro_team_id: e.player.pro_team_id,
        injury_status: e.player.injury_status,
        espn_week: e.player.projection_week_espn,
        espn_ros: e.player.projection_ros_espn,
        trailing: [],
      })),
      season: fx.league.ref.season,
      horizon: weeks.horizon,
      week: weeks.from,
      final_week: 17,
      settings: fx.settings,
      schedule: fx.schedule,
      clock: fx.clock,
      rng: seededRng(11),
      pacer: instantPacer,
      n_sims: 1000,
      deadline_ms: null,
    });
    for (const pp of res.players)
      if (pp.target.player_id !== null) out.set(pp.target.player_id, pp);
  }
  return out;
}

/** LineupPlayers of one roster for `week` from E1 and the lock plan at the variant's clock. */
export function lineupPlayers(
  fx: FxLeague,
  roster: Roster,
  projected: ReadonlyMap<number, ProjectedPlayer>,
  week = FX_WEEK,
): LineupPlayer[] {
  const plan = lockPlan(
    roster.entries.map((e) => ({
      player_id: e.player.ref.id,
      pro_team_id: e.player.pro_team_id,
      lineup_locked: e.lineup_locked,
    })),
    fx.schedule,
    week,
    fx.slots.lineup_lock_type,
    fx.clock.nowMs(),
  );
  return roster.entries.map((e) => {
    const pw = projected.get(e.player.ref.id)?.weeks.find((x) => x.week === week);
    const lock = plan.players.find((x) => x.player_id === e.player.ref.id) ?? null;
    const dist = pw?.dist ?? {
      mean: 0,
      p10: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p_zero: 1,
      basis: "position_cv" as const,
    };
    return lineupPlayerOf(e, { dist, p_active: pw?.p_active ?? null }, lock);
  });
}

/** My roster in a variant. */
export function myRoster(fx: FxLeague): Roster {
  const r = fx.rosters.find((x) => x.team.team_id === MY_TEAM);
  if (r === undefined) throw new Error("fx-10h: my roster is missing");
  return r;
}
