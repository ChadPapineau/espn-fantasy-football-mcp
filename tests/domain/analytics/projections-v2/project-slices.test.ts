// project-slices.test.ts — v2's scoring phase scores a slice of samples per cooperative step
// (project.ts phase 3, V2_SIMS.scoreSlice; plan 01 §1.1, plan 03 §1.2: the loop never blocks for
// more than one ≤ 20 ms batch; Stage C: one whole sample set scored in one step held the loop
// 30–48 ms of CPU under parallel calls, 82 ms on a loaded machine — stall-parallel's own-CPU
// evidence). Counted, never timed: every line is scored inside a cooperative step, no step scores
// more than STEP_LINES — a fixed ceiling, never read from the constant it holds, so a whole-set
// slice fails here without a clock — no scoring call scores more than one slice, the lines scored
// are exactly the sample sets the answers serve (no extra work), and the answer is byte-identical
// whatever the slice — one slice per set is the shape before the change. No clock, no wall time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock, seededRng } from "../../../../src/domain/clock.js";
import type * as Cooperative from "../../../../src/domain/analytics/cooperative.js";
import type * as Constants from "../../../../src/domain/analytics/projections-v2/constants.js";
import type * as Project from "../../../../src/domain/analytics/projections-v2/project.js";
import type { V2Request } from "../../../../src/domain/analytics/projections-v2/types.js";
import type * as Engine from "../../../../src/domain/scoring/engine.js";
import type { StatLine } from "../../../../src/domain/scoring/types.js";
import { instantPacer } from "../helpers.js";
import { qbGame, rbGame, settings, target, teamSeason, wrGame } from "./helpers/synthetic.js";

const ENGINE = "../../../../src/domain/scoring/engine.js";
const CONSTANTS = "../../../../src/domain/analytics/projections-v2/constants.js";
const COOPERATIVE = "../../../../src/domain/analytics/cooperative.js";
const PROJECT = "../../../../src/domain/analytics/projections-v2/project.js";

/**
 * The most lines one cooperative step may score: a literal, never V2_SIMS.scoreSlice (the value it
 * holds). At the slowest per-line cost measured (one 2 000-sample set held the loop 82 ms of CPU on
 * a slowed machine, Stage C: 41 µs a line), 256 lines are 10.5 ms, inside one 12 ms batch
 * (COOPERATIVE.batchMs); the runner passes a batch's budget only on a chunk longer than every chunk
 * before it (kernels.test.ts, A16a), so a turn of these steps stays far inside the 50 ms bound. A
 * whole set in one step (2 000 lines, the shape before the fix) is 82 ms on that machine by itself.
 */
const STEP_LINES = 256;

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

/** What one counted projectV2 module scored. */
interface Counted {
  readonly project: typeof Project;
  /** Lines per scoring call (scoreSamples, or one slice added to a sampleScorer). */
  readonly calls: number[];
  /** Lines scored inside each cooperative step the call ran, in order (every runCooperative). */
  readonly steps: number[];
  /** Lines scored outside every cooperative step (synchronous with the call's own turn). */
  readonly outside: () => number;
}

/**
 * projectV2 loaded with the engine's scoring calls counted (lines per call), each line attributed
 * to the cooperative step that scored it (the runner's steps wrapped, nothing else changed), and a
 * slice width.
 */
async function counted(slice?: number): Promise<Counted> {
  vi.resetModules();
  const calls: number[] = [];
  const steps: number[] = [];
  /** Lines scored in the step that is running; null between steps. */
  let open: number | null = null;
  let outside = 0;
  const scored = (n: number): void => {
    calls.push(n);
    if (open === null) outside += n;
    else open += n;
  };
  vi.doMock(ENGINE, async (importOriginal) => {
    const m = await importOriginal<typeof Engine>();
    return {
      ...m,
      scoreSamples: (...a: Parameters<typeof m.scoreSamples>) => {
        scored(a[0].length);
        return m.scoreSamples(...a);
      },
      sampleScorer: (...a: Parameters<typeof m.sampleScorer>) => {
        const scorer = m.sampleScorer(...a);
        return {
          add: (lines: readonly StatLine[]) => {
            scored(lines.length);
            scorer.add(lines);
          },
          dist: () => scorer.dist(),
        };
      },
    };
  });
  vi.doMock(COOPERATIVE, async (importOriginal) => {
    const m = await importOriginal<typeof Cooperative>();
    return {
      ...m,
      runCooperative: (
        units: number,
        step: (i: number) => void,
        opts: Cooperative.CooperativeOptions,
      ) =>
        m.runCooperative(
          units,
          (i) => {
            open = 0;
            try {
              step(i);
            } finally {
              steps.push(open);
              open = null;
            }
          },
          opts,
        ),
    };
  });
  if (slice !== undefined)
    vi.doMock(CONSTANTS, async (importOriginal) => {
      const m = await importOriginal<typeof Constants>();
      return { ...m, V2_SIMS: Object.freeze({ ...m.V2_SIMS, scoreSlice: slice }) };
    });
  return {
    project: (await import(PROJECT)) as typeof Project,
    calls,
    steps,
    outside: () => outside,
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

afterEach(() => {
  vi.doUnmock(ENGINE);
  vi.doUnmock(CONSTANTS);
  vi.doUnmock(COOPERATIVE);
  vi.resetModules();
});

describe("v2's scoring phase: a slice of samples per step (counted)", () => {
  it("every line is scored inside a cooperative step, and no step scores more than STEP_LINES (a fixed ceiling)", async () => {
    const { project, calls, steps, outside } = await counted();
    const { V2_SIMS } = (await import(CONSTANTS)) as typeof Constants;
    const out = await project.projectV2(req());
    const k = out.data.completed_samples;
    expect(k).toBe(2000);
    expect(out.partial).toBe(false);
    // the ceiling holds against the work counted, whatever the constant says
    expect(outside()).toBe(0);
    expect(steps.length).toBeGreaterThan(0);
    expect(Math.max(...steps)).toBeLessThanOrEqual(STEP_LINES);
    expect(V2_SIMS.scoreSlice).toBeLessThanOrEqual(STEP_LINES);
    // one slice per scoring call, and exactly the sets the answers serve
    expect(Math.max(...calls)).toBeLessThanOrEqual(V2_SIMS.scoreSlice);
    expect(sum(calls)).toBe(SETS * k);
    expect(sum(steps)).toBe(SETS * k);
    // every target is answered: the ruled-out one at 0, the zero-mean one not anchored
    expect(out.data.projections).toHaveLength(TARGETS.length);
  });

  it("the shape before the fix (one slice per set) scores a whole set in one step: past STEP_LINES", async () => {
    // the counting's positive control: the ceiling above is not vacuous — a whole-set slice puts
    // 2 000 lines in one step, and each set in exactly one step
    const { project, steps, outside } = await counted(100_000);
    const out = await project.projectV2(req());
    const k = out.data.completed_samples;
    expect(outside()).toBe(0);
    expect(Math.max(...steps)).toBe(k);
    expect(Math.max(...steps)).toBeGreaterThan(STEP_LINES);
    expect(steps.filter((n) => n === k)).toHaveLength(SETS);
  });

  it("the answer is byte-identical whatever the slice: one slice per set (the shape before), 128, 7", async () => {
    const answers: string[] = [];
    for (const slice of [100_000, 128, 7]) {
      const { project, calls, steps } = await counted(slice);
      answers.push(JSON.stringify(await project.projectV2(req())));
      expect(Math.max(...calls)).toBeLessThanOrEqual(Math.min(slice, 2000));
      expect(Math.max(...steps)).toBeLessThanOrEqual(Math.min(slice, 2000));
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
    expect(sum(calls) % k).not.toBe(0);
  });
});
