// p1-sizes.test.ts — plan 07 C8 for the group-A P1 engines: every analytics result is capped at
// 10 000 serialised chars BY CONSTRUCTION (the envelope's halving is the last resort, not the plan).
// Each engine runs at its default detail on fx-10h's own week-5 inputs read through the real provider
// (E1 over the rest of the season for all ten rosters): E4 over the whole league with my roster as
// the focus, E8 and E9 on my roster, E3 live on `sunday-live`. The numbers are the `data` objects
// the tools wrap; plan 07 §5.1's typical / worst columns are the comparison.
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMatchupWin, matchupPlayerOf } from "../../../src/domain/analytics/matchup.js";
import type { ProjectedPlayer } from "../../../src/domain/analytics/projection.js";
import {
  analyzeReplacement,
  streamCandidates,
  type ReplacementPlayer,
} from "../../../src/domain/analytics/replacement.js";
import { analyzeRoster } from "../../../src/domain/analytics/rosterAudit.js";
import { analyzeSchedule } from "../../../src/domain/analytics/scheduleStress.js";
import { ANALYTICS_RESULT_CHARS, seedingStatus } from "../../../src/domain/analytics/types.js";
import { seededRng } from "../../../src/domain/clock.js";
import { remainingWeeks } from "../../../src/domain/league/rules.js";
import { lockPlan } from "../../../src/domain/league/schedule.js";
import { instantPacer } from "./helpers.js";
import {
  FX_WEEK,
  MY_TEAM,
  fxLeague,
  lineupPlayers,
  myRoster,
  projectRosters,
  type FxLeague,
} from "./fx10h-world.js";

let fx: FxLeague;
let weeks: number[];
let proj: Map<number, ProjectedPlayer>;
let league: ReplacementPlayer[];

beforeAll(async () => {
  fx = await fxLeague("");
  weeks = remainingWeeks(fx.rules.playoffs, FX_WEEK);
  proj = await projectRosters(fx, fx.rosters, { from: FX_WEEK, horizon: "ros" });
  league = fx.rosters.flatMap((r) =>
    r.entries.map((e) => {
      const pp = proj.get(e.player.ref.id);
      return {
        player_id: e.player.ref.id,
        name: e.player.name,
        position: e.player.position,
        rostered: true,
        weeks: weeks.map((w) => {
          const x = pp?.weeks.find((y) => y.week === w);
          return x === undefined ? null : { mean: x.dist.mean, bye: x.bye };
        }),
        ros: pp?.projection.ros_total ?? null,
        week_dist: pp?.weeks[0]?.dist ?? null,
      };
    }),
  );
});

const size = (data: unknown): number => JSON.stringify(data).length;

describe("plan 07 C8: each engine's data ≤ 10 000 chars at its default detail on fx-10h", () => {
  it("E4 over the league (my roster the focus)", async () => {
    const out = await analyzeReplacement({
      roster: fx.slots,
      league_size: fx.league.size,
      weeks,
      players: league,
      focus_player_ids: myRoster(fx).entries.map((e) => e.player.ref.id),
      clock: fx.clock,
      pacer: instantPacer,
      deadline_ms: null,
    });
    expect(size(out.data)).toBeLessThanOrEqual(ANALYTICS_RESULT_CHARS);
    expect(out.data.positions).toHaveLength(6);
  });

  it("E8 and E9 on my roster over the rest of the season", async () => {
    const mine = myRoster(fx);
    const sched = await analyzeSchedule({
      roster: fx.slots,
      players: mine.entries.map((e) => ({
        player_id: e.player.ref.id,
        position: e.player.position,
        eligible_slot_ids: e.player.eligible_slot_ids,
        injury_status: e.player.injury_status,
        pro_team_id: e.player.pro_team_id,
        slot_id: e.slot_id,
        weeks: (proj.get(e.player.ref.id)?.weeks ?? []).map((x) => ({
          week: x.week,
          dist: x.dist,
          bye: x.bye,
        })),
      })),
      weeks,
      playoff: { weeks: fx.rules.playoffs.playoff_weeks, bye_seeds: fx.rules.playoffs.bye_seeds },
      seeding: seedingStatus("espn_rule", null),
      stream: streamCandidates(league, weeks, ["QB", "RB", "WR", "TE", "K", "D/ST"]),
      schedule: fx.schedule,
      clock: fx.clock,
      pacer: instantPacer,
      deadline_ms: null,
    });
    expect(size(sched.data)).toBeLessThanOrEqual(ANALYTICS_RESULT_CHARS);
    expect(sched.data.weeks).toHaveLength(weeks.length);
    const roster = await analyzeRoster({
      roster: fx.slots,
      players: mine.entries.map((e) => ({
        player_id: e.player.ref.id,
        position: e.player.position,
        eligible_slot_ids: e.player.eligible_slot_ids,
        slot_id: e.slot_id,
        injury_status: e.player.injury_status,
        pro_team_id: e.player.pro_team_id,
        droppable: e.player.droppable,
        percent_owned: e.player.ownership?.percent_owned ?? null,
        weeks: (proj.get(e.player.ref.id)?.weeks ?? []).map((x) => ({
          week: x.week,
          mean: x.dist.mean,
          bye: x.bye,
        })),
        ros: proj.get(e.player.ref.id)?.projection.ros_total ?? null,
      })),
      weeks,
      current_week: FX_WEEK,
      playoff_weeks: fx.rules.playoffs.playoff_weeks,
      trade_deadline_week: 13,
      rules: {
        acquisition_limit: fx.rules.waiver.acquisition_limit,
        acquisitions_used: null,
        next_run_at: fx.rules.waiver.next_execution,
      },
      clock: fx.clock,
      pacer: instantPacer,
      deadline_ms: null,
    });
    expect(size(roster.data)).toBeLessThanOrEqual(ANALYTICS_RESULT_CHARS);
  });

  it("E3 live on sunday-live", async () => {
    const live = await fxLeague("sunday-live");
    const box = live.box.find((b) => b.home.team_id === MY_TEAM || b.away?.team_id === MY_TEAM);
    const away = box?.away ?? null;
    if (box === undefined || away === null) throw new Error("no matchup");
    const oppId = box.home.team_id === MY_TEAM ? away.team_id : box.home.team_id;
    const rosters = live.rosters.filter(
      (r) => r.team.team_id === MY_TEAM || r.team.team_id === oppId,
    );
    const projected = await projectRosters(live, rosters, { from: FX_WEEK, horizon: "week" });
    const side = (teamId: number) => {
      const r = rosters.find((x) => x.team.team_id === teamId);
      const s = [box.home, away].find((x) => x.team_id === teamId);
      if (r === undefined || s === undefined) throw new Error("missing side");
      const plan = lockPlan(
        r.entries.map((e) => ({
          player_id: e.player.ref.id,
          pro_team_id: e.player.pro_team_id,
          lineup_locked: e.lineup_locked,
        })),
        live.schedule,
        FX_WEEK,
        live.slots.lineup_lock_type,
        live.clock.nowMs(),
      );
      return lineupPlayers(live, r, projected).map((p) =>
        matchupPlayerOf(
          p,
          plan.players.find((x) => x.player_id === p.player_id) ?? null,
          s.entries.find((x) => x.player.ref.id === p.player_id)?.actual?.applied_total ?? null,
        ),
      );
    };
    const out = await analyzeMatchupWin({
      mode: "live",
      roster: live.slots,
      me: side(MY_TEAM),
      opponent: side(oppId),
      method: "mc",
      n_sims: 2000,
      clock: live.clock,
      rng: seededRng(4),
      pacer: instantPacer,
      deadline_ms: null,
    });
    expect(size(out.data)).toBeLessThanOrEqual(ANALYTICS_RESULT_CHARS);
  });
});
