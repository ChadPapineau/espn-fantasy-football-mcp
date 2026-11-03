// project-slices.test.ts — v2's scoring phase scores a slice of samples per cooperative step
// (project.ts phase 3, V2_SIMS.scoreSlice; plan 01 §1.1, plan 03 §1.2: the loop never blocks for
// more than one ≤ 20 ms batch; Stage C: one whole sample set scored in one step held the loop
// 30–48 ms of CPU under parallel calls, 82 ms on a loaded machine — stall-parallel's own-CPU
// evidence). Counted, never timed: no scoring call scores more than one slice, the lines scored are
// exactly the sample sets the answers serve (no extra work), and the answer is byte-identical
// whatever the slice — one slice per set is the shape before the change. No clock, no wall time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock, seededRng } from "../../../../src/domain/clock.js";
import type * as Constants from "../../../../src/domain/analytics/projections-v2/constants.js";
import type * as Project from "../../../../src/domain/analytics/projections-v2/project.js";
import type { V2Request } from "../../../../src/domain/analytics/projections-v2/types.js";
import type * as Engine from "../../../../src/domain/scoring/engine.js";
import type { StatLine } from "../../../../src/domain/scoring/types.js";
import { instantPacer } from "../helpers.js";
import { qbGame, rbGame, settings, target, teamSeason, wrGame } from "./helpers/synthetic.js";

const ENGINE = "../../../../src/domain/scoring/engine.js";
const CONSTANTS = "../../../../src/domain/analytics/projections-v2/constants.js";
const PROJECT = "../../../../src/domain/analytics/projections-v2/project.js";

const weeks = [1, 2, 3, 4, 5, 6, 7, 8];
const wr = target(
  "WR",
  weeks.map((w) => wrGame(w)),
  { espn_mean: 14, player_id: 1 },
);
const rb = target(
  "RB",
  weeks.map((w) => rbGame(w)),
  { espn_mean: 12, player_id: 2 },
);
const qb = target(
  "QB",
  weeks.map((w) => qbGame(w)),
  { espn_mean: 19, player_id: 3 },
);
/** Own and anchored sets scored (ESPN means it can carry), one own set only, none, and an own set. */
const TARGETS = [
  wr,
  rb,
  qb,
  { ...wr, player_id: 4, espn_mean: null },
  { ...wr, player_id: 5, availability: { designation: "Out", practice: null } },
  { ...wr, player_id: 6, espn_mean: 0 },
];
/** Sample sets scored at each target's k samples: three own + anchored pairs, two own sets. */
const SETS = 3 * 2 + 2;

const req = (over: Partial<V2Request> = {}): V2Request => ({
  targets: TARGETS,
  season: 2025,
  week: 9,
  settings: settings(),
  team_games: teamSeason(8),
  markets: { AAA: { implied: 23, spread: 2, total: 44 } },
  opponents: { AAA: "BBB" },
  matchup: null,
  clock: fixedClock("2025-11-01T12:00:00Z"),
  rng: seededRng(5),
  pacer: instantPacer,
  deadline_ms: null,
  n_sims: 2000,
  ...over,
});

/** projectV2 loaded with the engine's scoring calls counted (lines per call) and a slice width. */
async function counted(slice?: number): Promise<{ project: typeof Project; calls: number[] }> {
  vi.resetModules();
  const calls: number[] = [];
  vi.doMock(ENGINE, async (importOriginal) => {
    const m = await importOriginal<typeof Engine>();
    return {
      ...m,
      scoreSamples: (...a: Parameters<typeof m.scoreSamples>) => {
        calls.push(a[0].length);
        return m.scoreSamples(...a);
      },
      sampleScorer: (...a: Parameters<typeof m.sampleScorer>) => {
        const scorer = m.sampleScorer(...a);
        return {
          add: (lines: readonly StatLine[]) => {
            calls.push(lines.length);
            scorer.add(lines);
          },
          dist: () => scorer.dist(),
        };
      },
    };
  });
  if (slice !== undefined)
    vi.doMock(CONSTANTS, async (importOriginal) => {
      const m = await importOriginal<typeof Constants>();
      return { ...m, V2_SIMS: Object.freeze({ ...m.V2_SIMS, scoreSlice: slice }) };
    });
  return { project: (await import(PROJECT)) as typeof Project, calls };
}

afterEach(() => {
  vi.doUnmock(ENGINE);
  vi.doUnmock(CONSTANTS);
  vi.resetModules();
});

describe("v2's scoring phase: a slice of samples per step (counted)", () => {
  it("no scoring call scores more than one slice; the lines scored are exactly the sets served", async () => {
    const { project, calls } = await counted();
    const { V2_SIMS } = (await import(CONSTANTS)) as typeof Constants;
    const out = await project.projectV2(req());
    const k = out.data.completed_samples;
    expect(k).toBe(2000);
    expect(out.partial).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(Math.max(...calls)).toBeLessThanOrEqual(V2_SIMS.scoreSlice);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(SETS * k);
    // every target is answered: the ruled-out one at 0, the zero-mean one not anchored
    expect(out.data.projections).toHaveLength(TARGETS.length);
  });

  it("the answer is byte-identical whatever the slice: one slice per set (the shape before), 128, 7", async () => {
    const answers: string[] = [];
    for (const slice of [100_000, 128, 7]) {
      const { project, calls } = await counted(slice);
      answers.push(JSON.stringify(await project.projectV2(req())));
      expect(Math.max(...calls)).toBeLessThanOrEqual(Math.min(slice, 2000));
    }
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);
  });

  it("a deadline inside a target's slices leaves it unreached (E1 keeps v1), never half-scored", async () => {
    // a clock that advances 1 ms a read: sampling takes half the budget (k samples, one read each),
    // and 4-sample slices give the scoring phase twice that many reads, so it is cut inside it
    const { project, calls } = await counted(4);
    let t = 0;
    const pacer = { nowMs: () => (t += 1), yieldToLoop: () => Promise.resolve() };
    const out = await project.projectV2(req({ pacer, deadline_ms: 400 }));
    const late = out.details.filter((d) => d.skipped === project.V2_DEADLINE_SKIP);
    expect(out.partial).toBe(true);
    expect(late.length).toBeGreaterThan(0);
    expect(out.data.projections.length).toBeGreaterThan(0);
    // each target is answered once: assembled whole, or left to v1
    expect(out.data.projections.length + late.length).toBe(TARGETS.length);
    expect(out.details).toHaveLength(TARGETS.length);
    // the scoring stopped inside a set: fewer lines scored than the reached targets' sets need
    const k = out.data.completed_samples;
    expect(calls.reduce((a, b) => a + b, 0) % k).not.toBe(0);
  });
});
