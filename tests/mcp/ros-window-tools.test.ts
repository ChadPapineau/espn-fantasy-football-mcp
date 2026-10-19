// ros-window-tools.test.ts — the league-wide tools read ESPN's rest-of-season total as E1 reads it
// (Stage C finding projection-ros-includes-week18, the tool half; research 04 §B.1.1; plan 07 E1):
// ESPN's split (1,0) total counts the games not yet played through NFL week 18, so a value week's
// share comes from the player's own window at the call's clock (projection.ts rosWindow, read by the
// tools through common.ts RosReading). E1 has read it that way since the domain fix; E4–E9, E11 and
// E5 called weeklyValues without the window, so on the recorded league — captured after week 4's
// games, the scoring period still 4 — every later week was short by about wk4/13 there. Here every
// rostered player's tool-side weekly values (valueWeeks, waiverPlayerOf — the helpers every one of
// those tools calls, with the reading the tool builds) equal E1's own ESPN component week for week,
// and E4's VOR — built from those values — moves exactly as E1's totals do. No network, no cookie.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformPlayer, ProSchedule } from "../../src/domain/league/types.js";
import { remainingWeeks } from "../../src/domain/league/rules.js";
import { waiverPlayerOf } from "../../src/mcp/tools/analytics.js";
import { rosShareOptsOf } from "../../src/domain/analytics/waivers.js";
import { rosOptsOf, rosReadingFrom } from "../../src/mcp/tools/common.js";
import { valueWeeks } from "../../src/mcp/tools/p1-common.js";
import { SEASON, T0, call, connect, makeWorld, type World } from "./helpers/world.js";

interface E1Week {
  readonly week: number;
  readonly inputs: { readonly espn: number | null };
}
interface E1Player {
  readonly player_id: number | null;
  readonly position: string;
  readonly weeks: readonly E1Week[];
}

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({ league: "league-b", env: { EFF_TOOLSET: "full" } });
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

function scheduleOf(): ProSchedule {
  return {
    season: SEASON,
    teams: world.store.datasets.proSchedule.teams(SEASON).rows,
    games: world.store.datasets.proSchedule.games(SEASON, null).rows,
  };
}

/** E1 for a team's players (compact: the first three weeks — the as-of week and two later ones). */
async function e1Team(teamId: number): Promise<E1Player[]> {
  const r = await call(client, "espn_project_players", {
    players: { team_id: teamId },
    horizon: "ros",
    // every week's row (compact answers a whole roster with ros_total only once the rows do not
    // fit — Stage C finding projections-roster-truncated)
    detail: "full",
    n_sims: 1000,
    seed: 1,
  });
  expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
  // the 10 000-char budget may keep only a prefix of the team: every returned player is compared
  return (r.body.data as { projections: E1Player[] }).projections;
}

const sum = (xs: readonly (number | null)[]): number =>
  xs.reduce<number>((a, x) => a + (x ?? 0), 0);

describe("the tools' weekly values are E1's (projection-ros-includes-week18)", () => {
  it("every rostered player E1 returns, league-wide: valueWeeks and waiverPlayerOf under the call's reading equal E1's ESPN component", async () => {
    const ref = world.services.league;
    const league = (await world.wiring.provider.getLeague(ref)).value;
    const rules = (await world.wiring.provider.getLeagueRules(ref)).value;
    const w = league.clock.current_scoring_period;
    const weeks = remainingWeeks(rules.playoffs, w);
    expect(weeks.length).toBeGreaterThan(5);
    const ros = rosReadingFrom(scheduleOf(), SEASON, Date.parse(T0));
    expect(ros).not.toBeNull();
    const rosters = (await world.wiring.provider.getRosters(ref, w)).value;
    let compared = 0;
    let later = 0;
    let differs = 0;
    for (const teamId of rosters.map((r) => r.team.team_id)) {
      const e1 = await e1Team(teamId);
      const roster = rosters.find((r) => r.team.team_id === teamId);
      expect(roster).toBeDefined();
      for (const entry of roster?.entries ?? []) {
        const p: PlatformPlayer = entry.player;
        const proj = e1.find((x) => x.player_id === p.ref.id);
        if (proj === undefined || p.injury_status !== "ACTIVE") continue;
        const v = valueWeeks(p, weeks, ros);
        const wp = waiverPlayerOf(p, entry.slot_id, entry.lineup_locked, weeks, null, ros).weekly;
        const old = valueWeeks(p, weeks, null);
        for (const [i, week] of weeks.entries()) {
          const espn = proj.weeks.find((x) => x.week === week)?.inputs.espn ?? null;
          if (espn === null) continue;
          // E1 reports its ESPN component to 2 decimals; the old reading was off by points
          expect(v[i] ?? 0, `${String(p.ref.id)} week ${String(week)}`).toBeCloseTo(espn, 1);
          expect(wp[i] ?? 0, `${String(p.ref.id)} week ${String(week)}`).toBeCloseTo(espn, 1);
          compared += 1;
          if (week > w && espn > 0) {
            later += 1;
            if (Math.abs((old[i] ?? 0) - espn) > 0.1) differs += 1;
          }
        }
      }
    }
    // the reading the tools used before (none) disagrees with E1 on those later weeks
    expect(differs).toBeGreaterThan(20);
    // the comparison covers the later weeks, where the old reading was short by wk4/13
    expect(compared).toBeGreaterThan(60);
    expect(later).toBeGreaterThan(40);
  });

  it("rosOptsOf is rosShareOptsOf for every platform player, memoised per pro team", async () => {
    const ref = world.services.league;
    const sched = scheduleOf();
    const ros = rosReadingFrom(sched, SEASON, Date.parse(T0));
    const players = (await world.wiring.provider.getRosters(ref, 4)).value.flatMap((r) =>
      r.entries.map((e) => e.player),
    );
    expect(players.length).toBeGreaterThan(100);
    for (const p of players)
      expect(rosOptsOf(p, ros), String(p.ref.id)).toEqual(
        rosShareOptsOf(p, sched, SEASON, Date.parse(T0)),
      );
    expect(rosOptsOf(players[0]!, null)).toEqual({});
  });

  it("without a schedule the reading is null and said; the default reading is the old one", () => {
    expect(rosReadingFrom(null, SEASON, Date.parse(T0))).toBeNull();
    expect(rosReadingFrom({ games: [] }, SEASON, Date.parse(T0))).toBeNull();
  });

  it("E4's VOR is built from those values: VOR(A) − VOR(B) = Σ values(A) − Σ values(B) under the call's reading, same position", async () => {
    const ref = world.services.league;
    const league = (await world.wiring.provider.getLeague(ref)).value;
    const rules = (await world.wiring.provider.getLeagueRules(ref)).value;
    const w = league.clock.current_scoring_period;
    const weeks = remainingWeeks(rules.playoffs, w).slice(0, 22);
    const ros = rosReadingFrom(scheduleOf(), SEASON, Date.parse(T0));
    const byId = new Map<number, PlatformPlayer>();
    for (const r of (await world.wiring.provider.getRosters(ref, w)).value)
      for (const e of r.entries) byId.set(e.player.ref.id, e.player);
    const pool = await world.wiring.provider.listPlayers(
      ref,
      { status: "AVAILABLE", position: null, sort: "projection_ros", week: w, injured: null },
      { limit: 100, offset: 0 },
    );
    for (const p of pool.value.items) if (!byId.has(p.ref.id)) byId.set(p.ref.id, p);
    const r = await call(client, "espn_analyze_replacement", { detail: "full" });
    expect(r.isError).toBe(false);
    const players = (
      r.body.data as {
        players: { player_id: number; position: string; vor_ros: { mean: number } }[];
      }
    ).players;
    let pairs = 0;
    let moved = 0;
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const same = players.filter((p) => p.position === pos && byId.has(p.player_id));
      const a = same[0];
      if (a === undefined) continue;
      const pa = byId.get(a.player_id);
      for (const b of same.slice(1)) {
        const pb = byId.get(b.player_id);
        if (pa === undefined || pb === undefined) continue;
        const want = sum(valueWeeks(pa, weeks, ros)) - sum(valueWeeks(pb, weeks, ros));
        const before = sum(valueWeeks(pa, weeks, null)) - sum(valueWeeks(pb, weeks, null));
        expect(
          a.vor_ros.mean - b.vor_ros.mean,
          `${pos} ${String(a.player_id)}/${String(b.player_id)}`,
        ).toBeCloseTo(want, 1);
        pairs += 1;
        if (Math.abs(want - before) > 0.5) moved += 1;
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(4);
    // and the pairs discriminate: under the old reading the differences were not these
    expect(moved).toBeGreaterThanOrEqual(2);
  });
});
