// waiver-extras-steps.test.ts — F1, round 4d: espn_analyze_waivers' P1 extras (the candidates' usage
// with its extras, Sleeper's trending adds, the claim history) ran as one synchronous call — on the
// Linux CI runner one turn of 357 SQLite statements and the candidates' scoring, 18 ms of the call's
// longest CPU run (the per-tool notice's split; its profiled pass named the dataset readers). They
// are resumable work now (market-p1.ts waiverP1ExtrasSteps, under inTurns), its usage read a few
// players a read and a cut point after each candidate's games. Counted, no clock: a meter that spends
// a slice a read gives up a turn at those cut points, a frozen meter takes none, and the answers are
// the same, byte for byte. fx-10h, fixture mode, the published datasets; no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantedTurns } from "../../src/domain/analytics/cooperative.js";
import { frozenMeter, spendingMeter, withSliceMeter } from "../domain/analytics/slice-meter.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
let world: World;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: true,
    publishNflverse: true,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full", cpuDeadlineMs: null } }));
  // warm: the reads cached, so both measured calls make the same reads
  expect(
    (await call(client, "espn_analyze_waivers", { mode: "auto", phase: "auto" })).isError,
  ).toBe(false);
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

const ARGS = { mode: "auto", phase: "auto" } as const;

describe("E5's P1 extras in turns of their own (F1, round 4d)", () => {
  it("a spent slice gives up the turn at the extras' cut points; a frozen meter none; the same answer", async () => {
    const a = grantedTurns();
    const stepped = await withSliceMeter(spendingMeter(), () =>
      call(client, "espn_analyze_waivers", ARGS),
    );
    const steppedTurns = grantedTurns() - a;
    const b = grantedTurns();
    const frozen = await withSliceMeter(frozenMeter, () =>
      call(client, "espn_analyze_waivers", ARGS),
    );
    const frozenTurns = grantedTurns() - b;
    expect(stepped.isError).toBe(false);
    expect(frozen.isError).toBe(false);
    // the same answer, byte for byte, but for the inputs' ages (the fixture clock moves per call)
    const same = (d: unknown): string =>
      JSON.stringify(d, (k, v: unknown) => (k === "age_s" ? undefined : v));
    expect(same(stepped.body.data) === same(frozen.body.data)).toBe(true);
    expect(stepped.body.warnings).toEqual(frozen.body.warnings);
    // counted (a literal over fx-10h's candidates): the turns a spent slice takes and a frozen meter
    // does not were 35 at cab2a31, 59 with the reads' own conditional turns (9f277c1) and 88 with the
    // extras' cut points — one a candidate after its games, and between the usage read's slices
    expect(steppedTurns - frozenTurns).toBeGreaterThanOrEqual(80);
  }, 120_000);
});
