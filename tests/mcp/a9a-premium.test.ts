// a9a-premium.test.ts — plan 10 A9a (ii), hard (changelog R5-1): `espn_analyze_waivers(mode:
// priority)` on the derived league fx-10h, through the real composition root in fixture mode,
// returns `premium` within 0.5 of the DP table's Π(k, W) at the tool's own reported (k, W), and that
// W is the research definition computed here, independently, from the league clock: research 05
// §1.2's W is "the usable weeks remaining AFTER this week's claim (including playoff weeks I might
// reach, weighted by P(alive))" — on fx-10h's clock (claim week 5, final scoring period 17) W = 12,
// and research 05 §1.6 example A reads that same state (a week-5 run over weeks 5–17) as Π(2, 12) ≈
// 27.0, between the table's 24.5 (W 11) and 29.5 (W 13). A9a (i) — the DP reproducing the table cell
// for cell, Π(2, 13) = 29.5 — is tests/domain/analytics/waiver-dp.test.ts; A9a (iii) — the band, the
// marginal verdicts and the variants — is tests/e2e/acceptance.test.ts over real stdio.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { priorityPremium } from "../../src/domain/analytics/waiverDp.js";
import { call, connect, ESPN_FIXTURES, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
type J = Record<string, unknown>;
const readFx = (rel: string): J => JSON.parse(readFileSync(path.join(FX, rel), "utf8")) as J;
const MANIFEST = readFx("manifest.json") as { clock: string; my_team_id: number };

/** Research 05 §1.2's cold-start table, row k = 2, at W = 1, 3, …, 15 (ROS points). */
const TABLE_K2: Readonly<Record<number, number>> = {
  1: 1.2,
  3: 4.9,
  5: 9.5,
  7: 14.4,
  9: 19.5,
  11: 24.5,
  13: 29.5,
  15: 34.5,
};
/** The table read at any W in 1..15 (linear between its odd columns, as the research reads it). */
function tableK2(W: number): number {
  const lo = W % 2 === 1 ? W : W - 1;
  const a = TABLE_K2[lo];
  const b = TABLE_K2[lo + 2];
  if (a === undefined) throw new Error(`W ${String(W)} outside the table`);
  return lo === W || b === undefined ? a : (a + b) / 2;
}

/**
 * W per research 05 §1.2, from fx-10h's own league clock (mSettings): the league's weeks — the
 * regular season (`matchupPeriodCount`) plus the playoff rounds (⌈log2 playoffTeamCount⌉ rounds of
 * `playoffMatchupPeriodLength`) — strictly after the claim week (`status.currentMatchupPeriod`), each
 * playoff week weighted by P(alive), which the P0 tool weighs 1 (said in an assumption, below).
 */
function researchW(): { claimWeek: number; finalWeek: number; W: number; teams: number } {
  const s = readFx("league/mSettings.json") as {
    status: { currentMatchupPeriod: number; finalScoringPeriod: number };
    settings: {
      size: number;
      scheduleSettings: {
        matchupPeriodCount: number;
        matchupPeriodLength: number;
        playoffTeamCount: number;
        playoffMatchupPeriodLength: number;
      };
    };
  };
  const ss = s.settings.scheduleSettings;
  expect(ss.matchupPeriodLength).toBe(1); // one scoring period per matchup: weeks = periods
  const rounds = Math.ceil(Math.log2(ss.playoffTeamCount));
  const finalWeek = ss.matchupPeriodCount + rounds * ss.playoffMatchupPeriodLength;
  expect(finalWeek).toBe(s.status.finalScoringPeriod);
  const claimWeek = s.status.currentMatchupPeriod;
  return { claimWeek, finalWeek, W: finalWeek - claimWeek, teams: s.settings.size };
}

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX },
    teamId: MANIFEST.my_team_id,
    clock: MANIFEST.clock,
    publishEspn: false,
  });
  expect(world.options.fixtureMode).toBe(true);
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

async function ok(name: string, args: J = {}): Promise<J> {
  const r = await call(client, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
  return r.body;
}

describe("A9a (ii): the tool's premium at its own (k, W), W per research 05 §1.2 (hard)", () => {
  it("fx-10h's clock: claim week 5, final week 17, W = 12 weeks after the claim week", () => {
    expect(researchW()).toEqual({ claimWeek: 5, finalWeek: 17, W: 12, teams: 10 });
  });

  it("espn_analyze_waivers(mode: priority) reports k = 2, W = 12 and Π(k, W) within 0.5 of the table", async () => {
    // the Skills' call order (the facts first, so the analytics answer inside their request budget)
    await ok("espn_get_standings");
    await ok("espn_get_roster", { week: 5 });
    await ok("espn_list_players", { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 });
    const b = await ok("espn_analyze_waivers", { mode: "priority", detail: "full" });
    expect(b.partial).toBe(false);
    const d = b.data as {
      mode_used: string;
      k: number;
      W: number;
      premium: number;
      premium_basis: string;
      rec: { assumptions: { text: string }[] };
    };
    const { W, teams } = researchW();
    const mTeam = readFx("league/mTeam.json") as { teams: { id: number; waiverRank: number }[] };
    const myRank = mTeam.teams.find((t) => t.id === MANIFEST.my_team_id)?.waiverRank;
    expect(d.mode_used).toBe("priority");
    expect(d.premium_basis).toBe("cold_start_table");
    expect(d.k).toBe(myRank);
    expect(d.k).toBe(2);
    // W is the research definition from the league clock — not the claim week counted in
    expect(d.W).toBe(W);
    // the premium is the DP table's value at the tool's own (k, W) …
    expect(Math.abs(d.premium - priorityPremium(d.k, d.W, teams))).toBeLessThanOrEqual(0.5);
    // … which is the research's own table read at that cell (example A: Π(2, 12) ≈ 27.0)
    expect(tableK2(d.W)).toBe(27);
    expect(Math.abs(d.premium - tableK2(d.W))).toBeLessThanOrEqual(0.5);
    // and not the cell one week later, which counting the claim week in would give (29.5)
    expect(Math.abs(d.premium - tableK2(d.W + 1))).toBeGreaterThan(0.5);
    // the playoff weeks inside W carry weight 1 at P0, and the result says so
    expect(d.rec.assumptions.map((a) => a.text)).toContain(
      "playoff weeks are weighted 1: P(alive) from the seeding simulator was not given",
    );
  });
});
