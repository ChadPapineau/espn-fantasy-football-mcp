// waiver-extras-steps.test.ts — F1, round 4d: espn_analyze_waivers' P1 extras (the candidates' usage
// with its extras, Sleeper's trending adds, the claim history) ran as one synchronous call — on the
// Linux CI runner one turn of 357 SQLite statements and the candidates' scoring, 18 ms of the call's
// longest CPU run (the per-tool notice's split; its profiled pass named the dataset readers). They
// are resumable work now (market-p1.ts waiverP1ExtrasSteps, under inTurns), its usage read a few
// players a read and a cut point after each candidate's games. Counted, no clock: a meter that spends
// a slice a read gives up a turn at those cut points, a frozen meter takes none, and the answers are
// the same, byte for byte. fx-10h, fixture mode, the published datasets; no network.
//
// The turns are counted per run of the extras, not process-wide (the round-4d verifier's
// R4D-VS-1): the whole call's grantedTurns difference also held the reads' own conditional turns and
// any read a moving fixture clock re-made in one call and not the other, and fell from 88 locally to
// 29 on CI. A wrapper around waiverP1ExtrasSteps counts its yields and the turns granted while it
// runs — the generator is synchronous between yields, so those turns are inTurns' own.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { frozenMeter, spendingMeter, withSliceMeter } from "../domain/analytics/slice-meter.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

/** Each run of waiverP1ExtrasSteps: its yields (cut points) and the turns granted while it ran. */
const runs = vi.hoisted(() => [] as { yields: number; turns: number }[]);
vi.mock("../../src/mcp/tools/market-p1.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/mcp/tools/market-p1.js")>();
  const { grantedTurns } = await import("../../src/domain/analytics/cooperative.js");
  function* counted(
    ...a: Parameters<typeof m.waiverP1ExtrasSteps>
  ): ReturnType<typeof m.waiverP1ExtrasSteps> {
    const run = { yields: 0, turns: 0 };
    const t0 = grantedTurns();
    const g = m.waiverP1ExtrasSteps(...a);
    for (;;) {
      const r = g.next();
      if (r.done === true) {
        run.turns = grantedTurns() - t0;
        runs.push(run);
        return r.value;
      }
      run.yields += 1;
      yield;
    }
  }
  return { ...m, waiverP1ExtrasSteps: counted };
});

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
/** The extras' cut points over fx-10h's candidates (29 at 9f7d0aa, the per-tool notice's split). */
const EXTRAS_CUT_POINTS = 29;

describe("E5's P1 extras in turns of their own (F1, round 4d)", () => {
  it("a spent slice gives up the turn at the extras' cut points; a frozen meter none; the same answer", async () => {
    runs.length = 0;
    const stepped = await withSliceMeter(spendingMeter(), () =>
      call(client, "espn_analyze_waivers", ARGS),
    );
    const frozen = await withSliceMeter(frozenMeter, () =>
      call(client, "espn_analyze_waivers", ARGS),
    );
    expect(stepped.isError).toBe(false);
    expect(frozen.isError).toBe(false);
    // the same answer, byte for byte, but for the inputs' ages (the fixture clock moves per call)
    const same = (d: unknown): string =>
      JSON.stringify(d, (k, v: unknown) => (k === "age_s" ? undefined : v));
    expect(same(stepped.body.data) === same(frozen.body.data)).toBe(true);
    expect(stepped.body.warnings).toEqual(frozen.body.warnings);
    // counted per run: the extras ran once a call, with the same cut points — one a candidate after
    // its games, one between the usage read's slices, and the trending and history reads (a literal
    // over fx-10h's candidates) — and a spent slice gave up the turn at every one, a frozen meter at
    // none
    expect(runs).toHaveLength(2);
    const [s, f] = runs as [{ yields: number; turns: number }, { yields: number; turns: number }];
    expect(s.yields).toBe(f.yields);
    expect(s.yields).toBeGreaterThanOrEqual(EXTRAS_CUT_POINTS);
    expect(s.turns).toBe(s.yields);
    expect(f.turns).toBe(0);
  }, 120_000);
});
