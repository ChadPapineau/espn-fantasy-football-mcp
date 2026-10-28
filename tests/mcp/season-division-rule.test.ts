// season-division-rule.test.ts — E3 `season` says what its division-winners-first step is worth
// (plan 07 E3; Stage C live finding F8): ESPN documents division winners first (research 05 §2.1), and
// the simulator applies it under espn_rule whenever a league has more than one division, but no league
// field is known to confirm that a league applies it (`playoffSeedingRuleBy` is [U]; the owner's
// two-division league states "record first, then Total Points For"). The tool now ranks the same paths
// by record alone too, returns `division_rule`, and states both answers in `rec.assumptions[]` (which
// the Skills print with its revisit trigger). Through the real composition root in fixture mode: the
// recorded four-division league-c, and league-a (one division) as the control.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envelopeViolations, identifierLeaks } from "./helpers/walk.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

type J = Record<string, unknown>;
interface Season {
  division_aware: boolean;
  division_rule: {
    divisions: number;
    p_playoffs_record_only: number;
    p_bye_record_only: number;
  } | null;
  readings: { seeding_mode: string; p_playoffs: number; p_bye: number; tiebreak_chain: string[] }[];
  rec: { assumptions: { text: string; revisit_trigger: string }[] };
}

const sessions: { world: World; client: Client; close: () => Promise<void> }[] = [];

async function open(league: "league-a" | "league-c"): Promise<Client> {
  const world = await makeWorld({ league, env: { EFF_TOOLSET: "full" } });
  const c = await connect(world, { options: { toolset: "full" } });
  sessions.push({ world, ...c });
  return c.client;
}

async function season(client: Client, args: J = {}): Promise<Season> {
  const r = await call(client, "espn_analyze_matchup", {
    mode: "season",
    n_sims: 2000,
    seed: 1,
    ...args,
  });
  if (r.isError) throw new Error(`E3 season failed: ${JSON.stringify(r.body).slice(0, 400)}`);
  expect(envelopeViolations(r.body as never)).toEqual([]);
  expect(identifierLeaks(JSON.stringify(r.body))).toEqual([]);
  return (r.body as { data: Season }).data;
}

const DIVISION_ASSUMPTION =
  /^espn_rule seeds the \d+ division winners first \(ESPN's documented rule; no league setting is known to confirm it\): P\(playoffs\) [0-9.]+, P\(bye\) [0-9.]+; seeded by record alone [0-9.]+ and [0-9.]+$/;

let fourDivisions: Client;
let oneDivision: Client;
beforeAll(async () => {
  fourDivisions = await open("league-c");
  oneDivision = await open("league-a");
}, 180_000);
afterAll(async () => {
  for (const s of sessions) {
    await s.close();
    s.world.cleanup();
  }
});

describe("E3 season and the division-winners-first step (Stage C live finding F8)", () => {
  it("a four-division league: division_rule ranks the same paths by record alone, and the assumption states both", async () => {
    const d = await season(fourDivisions);
    expect(d.division_aware).toBe(true);
    expect(d.readings[0]?.seeding_mode).toBe("espn_rule");
    expect(d.readings[0]?.tiebreak_chain[0]).toBe("division_winners_first");
    expect(d.division_rule).not.toBeNull();
    const rule = d.division_rule;
    if (rule === null) throw new Error("no division_rule");
    expect(rule.divisions).toBe(4);
    for (const p of [rule.p_playoffs_record_only, rule.p_bye_record_only]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    const said = d.rec.assumptions.filter((a) => a.text.includes("division winners first"));
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toMatch(DIVISION_ASSUMPTION);
    // the assumption carries the reading's own numbers and the record-only ones
    expect(said[0]?.text).toContain(`P(playoffs) ${String(d.readings[0]?.p_playoffs)},`);
    expect(said[0]?.text).toContain(
      `by record alone ${String(rule.p_playoffs_record_only)} and ${String(rule.p_bye_record_only)}`,
    );
    expect(said[0]?.revisit_trigger).toContain("division winners are seeded first");
  });

  it("both readings: still one division_rule, for the espn_rule reading", async () => {
    const d = await season(fourDivisions, { seeding_mode: "both" });
    expect(d.readings.map((r) => r.seeding_mode)).toEqual(["espn_rule", "points_only"]);
    expect(d.division_rule?.divisions).toBe(4);
    expect(d.rec.assumptions.filter((a) => a.text.includes("division winners first"))).toHaveLength(
      1,
    );
  });

  it("points_only alone, or a league with one division: null and no assumption", async () => {
    for (const d of [
      await season(fourDivisions, { seeding_mode: "points_only" }),
      await season(oneDivision),
    ]) {
      expect(d.division_rule).toBeNull();
      expect(d.rec.assumptions.some((a) => a.text.includes("division winners first"))).toBe(false);
    }
    expect((await season(oneDivision)).division_aware).toBe(false);
  });
});
