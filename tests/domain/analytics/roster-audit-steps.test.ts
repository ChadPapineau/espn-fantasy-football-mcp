// roster-audit-steps.test.ts — E9's bench rows run a bench player's WEEK a step (src/domain/
// analytics/rosterAudit.ts benchSteps; plan 03 §1.2's ≤ 20 ms batch; plan 10 A16a; round 3b's M5:
// a warm espn_analyze_roster's longest turn 17–20 ms on the owner's Mac, the batch that met a heavy
// bench player after a cheap one). Counted, never timed: the unit is one lineup solve
// (fastLineupValue), a pacer whose clock moves a whole batch at every read ends each batch after one
// step, so the solves between two of its yields are one step's. A week is two solves plus two per
// active player he could cover; a player's whole horizon held a dozen weeks of them. The rows are
// the same however the batches fall.
import { describe, expect, it, vi } from "vitest";
import type * as Lineup from "../../../src/domain/analytics/lineup.js";
import {
  analyzeRoster,
  type AuditPlayer,
  type RosterAuditRequest,
} from "../../../src/domain/analytics/rosterAudit.js";
import type { Pacer } from "../../../src/domain/analytics/cooperative.js";
import type { StreamOption } from "../../../src/domain/analytics/scheduleStress.js";
import type { InjuryStatus } from "../../../src/domain/league/types.js";
import { clockAndRng, ELIGIBLE, instantPacer, referenceSlots } from "./helpers.js";

const solves = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../../src/domain/analytics/lineup.js", async (importOriginal) => {
  const m = await importOriginal<typeof Lineup>();
  return {
    ...m,
    fastLineupValue: (...a: Parameters<typeof m.fastLineupValue>) => {
      solves.n += 1;
      return m.fastLineupValue(...a);
    },
  };
});

const WEEKS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

function ap(
  id: number,
  pos: string,
  mean: number,
  slot: number,
  over: { bye?: number | null; status?: InjuryStatus | null; out?: readonly number[] } = {},
): AuditPlayer {
  const { bye = null, status = null, out = [] } = over;
  return {
    player_id: id,
    position: pos,
    eligible_slot_ids: ELIGIBLE[pos] ?? [],
    slot_id: slot,
    injury_status: status,
    pro_team_id: id,
    droppable: true,
    percent_owned: 10,
    weeks: WEEKS.map((w) => ({
      week: w,
      mean: w === bye || out.includes(w) ? 0 : mean,
      bye: w === bye,
    })),
  };
}

/** 9 starters and 5 bench, the first bench player out most weeks (cheap), the rest healthy. */
function roster(): AuditPlayer[] {
  return [
    ap(1, "QB", 20, 0, { bye: 9 }),
    ap(2, "RB", 15, 2, { bye: 8 }),
    ap(3, "RB", 13, 2, { bye: 10 }),
    ap(4, "WR", 14, 4, { bye: 8 }),
    ap(5, "WR", 12, 4, { bye: 11 }),
    ap(6, "TE", 9, 6, { bye: 12 }),
    ap(7, "WR", 10, 23, { bye: 13 }),
    ap(8, "D/ST", 7, 16, { bye: 14 }),
    ap(9, "K", 8, 17, { bye: 7 }),
    ap(10, "RB", 9, 20, { bye: 9, out: [6, 7, 8, 10, 11, 12, 13, 14, 15, 16] }),
    ap(11, "WR", 8.5, 20, { bye: 10 }),
    ap(12, "RB", 4, 20, { bye: 11 }),
    ap(13, "WR", 3, 20, { bye: 12 }),
    ap(14, "TE", 2, 20, { bye: 6 }),
  ];
}

const stream: StreamOption[] = WEEKS.flatMap((w) => [
  { position: "RB", week: w, player_id: 901, points: 7 },
  { position: "WR", week: w, player_id: 902, points: 7.5 },
]);

function rq(pacer: Pacer, over: Partial<RosterAuditRequest> = {}): RosterAuditRequest {
  const { clock } = clockAndRng("2026-10-13T12:00:00.000Z");
  return {
    roster: referenceSlots(),
    players: roster(),
    weeks: WEEKS,
    current_week: 6,
    playoff_weeks: [15, 16, 17],
    trade_deadline_week: 13,
    season: {
      p_playoffs: 0.7,
      eliminated: false,
      p_alive_by_week: WEEKS.map((w) => ({ week: w, p: w >= 15 ? 0.5 : 1 })),
    },
    streamability: { QB: 0.95, TE: 0.92, K: 1, "D/ST": 1, RB: 0.6, WR: 0.7 },
    stream,
    rules: { acquisition_limit: null, acquisitions_used: 3, next_run_at: null },
    clock,
    pacer,
    deadline_ms: null,
    ...over,
  };
}

/** A pacer whose clock moves a whole batch per read (one step a batch), counting solves per yield. */
function stepPacer(): Pacer & { readonly segments: number[] } {
  let t = 0;
  let at = solves.n;
  const segments: number[] = [];
  return {
    segments,
    nowMs: () => (t += 20),
    yieldToLoop: () => {
      segments.push(solves.n - at);
      at = solves.n;
      return Promise.resolve();
    },
  };
}

describe("E9's bench rows: one bench player's week a step", () => {
  it("no step solves more than one week's lineups; the call solves a dozen weeks' for each of five", async () => {
    const pacer = stepPacer();
    const out = await analyzeRoster(rq(pacer));
    // the run's steps lie between its first yield (before the first batch) and its last (after the
    // last batch): the segment before it and the one after it are the audit's other work
    const steps = pacer.segments.slice(1);
    expect(steps.length).toBeGreaterThan(20);
    // a week: the lineup with and without him, and with and without him for every other player of
    // the roster (no IR here: all 14 play) who could be out that week
    const others = roster().length - 1;
    const weekMax = 2 + 2 * others;
    expect(Math.max(...steps), `solves per step: ${steps.join(" ")}`).toBeLessThanOrEqual(weekMax);
    // not vacuous: the bench rows hold many weeks' worth
    expect(steps.reduce((a, b) => a + b, 0)).toBeGreaterThan(5 * weekMax);
    expect(out.data.bench_plan.length).toBe(5);
    expect(out.partial).toBe(false);
  });

  it("the rows are the same in one batch as in a step a batch, and the deadline keeps whole rows only", async () => {
    const one = await analyzeRoster(rq(instantPacer));
    const stepped = await analyzeRoster(rq(stepPacer()));
    expect(JSON.stringify(stepped.data)).toBe(JSON.stringify(one.data));
    expect(stepped.warnings).toEqual(one.warnings);
    // a deadline met mid-player keeps the rows done, says how many, and never a half-summed one
    let t = 0;
    const tight = await analyzeRoster(
      rq(
        { nowMs: () => (t += 20), cpuMs: () => t, yieldToLoop: () => Promise.resolve() },
        { deadline_ms: 200 },
      ),
    );
    expect(tight.partial).toBe(true);
    const kept = tight.data.bench_plan.length;
    expect(kept).toBeLessThan(5);
    expect(tight.warnings).toContain(
      `partial: ${String(kept)} of 5 bench players before the CPU deadline`,
    );
    for (const row of tight.data.bench_plan) {
      const full = one.data.bench_plan.find((r) => r.player_id === row.player_id);
      expect(row).toEqual(full);
    }
  });
});
