// schedule-multipliers.test.ts — E8 espn_analyze_schedule's playoff matchup term (plan 07 E8:
// `playoff_weeks.matchup_multipliers[]: { player_id, multiplier, shrink_w }` "from D5's shrunk
// multipliers"; research 05 §1 step 6, §7.2 — a tie-breaker, never a driver). Stage C finding
// schedule-matchup-multipliers-unwired: the tool never passed the domain's `matchup_multipliers`, so
// the field was always [] with no warning beside an evidence note that read as if the term had been
// computed, while README and the cheat-sheet listed it as built and schedule-plan presents it. Now each
// of my players carries the mean of D5's multipliers over his playoff-week opponents at his position —
// the very numbers espn_get_defense_profile shows — and without D5's inputs the term is said to be
// missing. fx-10h (clock: week 5; playoffs 15–17) under EFF_TOOLSET=full, the nflverse excerpts
// published through the real runner; fixture mode, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const NOT_COMPUTED =
  /^nflverse:(?:stats_player_week|roster_weekly) not loaded: the playoff matchup multipliers are not computed$/;

interface Multiplier {
  player_id: number;
  multiplier: number;
  shrink_w: number;
}

async function fxWorld(publishNflverse: boolean): Promise<{
  world: World;
  client: Client;
  close: () => Promise<void>;
}> {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: true,
    publishNflverse,
  });
  const c = await connect(world, { options: { toolset: "full" } });
  await call(c.client, "espn_get_league");
  return { world, client: c.client, close: c.close };
}

async function schedule(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<{ multipliers: Multiplier[]; note: string; warnings: string[] }> {
  const r = await call(client, "espn_analyze_schedule", { detail: "full", ...args });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const pw = (
    r.body.data as {
      playoff_weeks: { matchup_multipliers: Multiplier[]; evidence_note: string };
    }
  ).playoff_weeks;
  return {
    multipliers: pw.matchup_multipliers,
    note: pw.evidence_note,
    warnings: r.body.warnings as string[],
  };
}

describe("E8's playoff matchup term from D5 (Stage C schedule-matchup-multipliers-unwired)", () => {
  let fx: Awaited<ReturnType<typeof fxWorld>>;
  beforeAll(async () => {
    fx = await fxWorld(true);
  }, 180_000);
  afterAll(async () => {
    await fx.close();
    fx.world.cleanup();
  });

  it("my players carry D5's shrunk multipliers, the mean over their playoff-week opponents", async () => {
    const got = await schedule(fx.client);
    expect(got.multipliers.length).toBeGreaterThan(0);
    expect(got.warnings.some((w) => NOT_COMPUTED.test(w))).toBe(false);
    // each one is a player on my roster, shrunk (early season: a modest weight) and near 1
    const roster = await call(fx.client, "espn_get_roster", { week: 5 });
    const mine = (
      roster.body.data as {
        players: { player_id: number; position: string; pro_team: string | null }[];
      }
    ).players;
    for (const m of got.multipliers) {
      expect(
        mine.some((p) => p.player_id === m.player_id),
        String(m.player_id),
      ).toBe(true);
      expect(m.shrink_w).toBeGreaterThan(0);
      expect(m.shrink_w).toBeLessThan(0.3);
      expect(m.multiplier).toBeGreaterThan(0.5);
      expect(m.multiplier).toBeLessThan(1.5);
    }
    expect(got.multipliers.map((m) => m.player_id)).toEqual(
      [...got.multipliers.map((m) => m.player_id)].sort((a, b) => a - b),
    );

    // the very numbers D5 shows: one player's playoff opponents, read back through D5
    const subject = mine.find(
      (p) =>
        ["QB", "RB", "WR", "TE"].includes(p.position) &&
        got.multipliers.some((m) => m.player_id === p.player_id),
    );
    const team = subject?.pro_team ?? null;
    if (subject === undefined || team === null) throw new Error("no subject");
    const sched = await call(fx.client, "espn_get_schedule", {
      weeks: [15, 16, 17],
      nfl_team: team,
    });
    const games = (sched.body.data as { games: { away: string; home: string }[] }).games;
    const opponents = games.map((g) => (g.home === team ? g.away : g.home));
    expect(opponents.length).toBeGreaterThan(0);
    const fromD5: { multiplier: number; shrink_w: number }[] = [];
    for (const o of opponents) {
      const d5 = await call(fx.client, "espn_get_defense_profile", {
        nfl_team: o,
        position: subject.position,
      });
      expect(d5.isError, JSON.stringify(d5.body).slice(0, 300)).toBe(false);
      const a = (
        d5.body.data as {
          defenses: { afpa: Record<string, { multiplier: number; shrink_w: number }> }[];
        }
      ).defenses[0]?.afpa[subject.position];
      if (a !== undefined) fromD5.push(a);
    }
    expect(fromD5.length).toBeGreaterThan(0);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const mine1 = got.multipliers.find((m) => m.player_id === subject.player_id);
    // D5 rounds its numbers (plan 07 C8): within its rounding
    expect(mine1?.multiplier).toBeCloseTo(mean(fromD5.map((x) => x.multiplier)), 2);
    expect(mine1?.shrink_w).toBeCloseTo(mean(fromD5.map((x) => x.shrink_w)), 2);
  }, 180_000);

  it("the block is the league's playoff weeks: an analysis of weeks 6–7 still carries their term", async () => {
    const all = await schedule(fx.client);
    const some = await schedule(fx.client, { weeks: [6, 7] });
    expect(some.multipliers).toEqual(all.multipliers);
  }, 180_000);

  it("include_playoffs: false asks for no playoff term and says nothing about it", async () => {
    const got = await schedule(fx.client, { include_playoffs: false });
    expect(got.multipliers).toEqual([]);
    expect(got.warnings.some((w) => w.includes("playoff matchup multipliers"))).toBe(false);
  }, 180_000);
});

describe("without D5's inputs the term is said to be missing, never an empty list in silence", () => {
  it("nflverse not loaded: [] and the warning", async () => {
    const fx = await fxWorld(false);
    try {
      const got = await schedule(fx.client);
      expect(got.multipliers).toEqual([]);
      expect(got.warnings.some((w) => NOT_COMPUTED.test(w))).toBe(true);
    } finally {
      await fx.close();
      fx.world.cleanup();
    }
  }, 180_000);
});
