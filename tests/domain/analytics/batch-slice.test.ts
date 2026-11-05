// batch-slice.test.ts — the round-4c verifier's R4C-VS-1 (plan 03 §1.2: no batch over 20 ms of CPU;
// plan 10 A16a). The process job's per-call `cpu_max_ms` is the length of a run on the CPU between two
// heartbeat ticks; on the Linux runner the P1 analytics read 18.7–24.1 ms with 12-ms batches. The
// local turn profile put the longest runs of cold espn_analyze_matchup `pre` and espn_analyze_trade
// calls in default cooperative batches (the matchup simulation, E1's sampler, trade's package
// evaluation), and that of a cold espn_analyze_replacement call in one synchronous loop valuing the
// league's players (leaguePlayers). The default batch is now a slice's share (SLICE_CPU_MS) and the
// loop takes one player a step. Counted on a pacer whose clock moves 1 ms a read and on the slice
// meters, never timed; the answers are the ones an unbatched run gives.
import { describe, expect, it } from "vitest";
import { COOPERATIVE } from "../../../src/domain/analytics/constants.js";
import {
  grantedTurns,
  runCooperative,
  SLICE_CPU_MS,
} from "../../../src/domain/analytics/cooperative.js";
import type { PlatformPlayer, Roster } from "../../../src/domain/league/types.js";
import { leaguePlayers } from "../../../src/mcp/tools/analytics-p1.js";
import { frozenMeter, spendingMeter, withSliceMeter } from "./slice-meter.js";

describe("R4C-VS-1: the default batch is a slice's share", () => {
  it("COOPERATIVE.batchMs is SLICE_CPU_MS, under plan 03 §1.2's 20 ms", () => {
    expect(COOPERATIVE.batchMs).toBe(SLICE_CPU_MS);
    expect(COOPERATIVE.batchMs).toBeLessThan(20);
  });

  it("a run with no batchMs of its own yields within a slice's share of the pacer's time; every step runs once, in order", async () => {
    let t = 0;
    const yieldsAt: number[] = [];
    const pacer = {
      nowMs: () => (t += 1),
      yieldToLoop: () => {
        yieldsAt.push(t);
        return Promise.resolve();
      },
    };
    const ran: number[] = [];
    // a step the pacer reads once per chunk (checkEvery): one unit per read makes every chunk 1 ms
    const r = await runCooperative(
      400 * COOPERATIVE.checkEvery,
      (i) => {
        if (i % COOPERATIVE.checkEvery === 0) ran.push(i);
      },
      { pacer, deadlineMs: null },
    );
    expect(r.completed).toBe(400 * COOPERATIVE.checkEvery);
    expect(ran).toEqual(Array.from({ length: 400 }, (_, k) => k * COOPERATIVE.checkEvery));
    const spans = yieldsAt.slice(1).map((x, i) => x - (yieldsAt[i] ?? 0));
    expect(spans.length).toBeGreaterThan(10);
    // a batch's own reads: its start, one per chunk; one more chunk may start before the last read
    expect(Math.max(...spans)).toBeLessThanOrEqual(SLICE_CPU_MS + 2);
  });
});

describe("R4C-VS-1: espn_analyze_replacement's league players are valued one a step", () => {
  const player = (id: number, status = "FREEAGENT"): PlatformPlayer =>
    ({
      ref: { platform: "espn", id },
      name: `Player ${String(id)}`,
      position: "WR",
      status,
      bye_week: 9,
    }) as unknown as PlatformPlayer;
  const rosters = [1, 2, 3].map(
    (t) =>
      ({
        entries: Array.from({ length: 10 }, (_, k) => ({ player: player(100 * t + k, "ONTEAM") })),
      }) as unknown as Roster,
  );
  // a duplicate of a rostered player and an ONTEAM pool row are dropped, as before
  const pool = [
    ...Array.from({ length: 20 }, (_, k) => player(900 + k)),
    player(101),
    player(7, "ONTEAM"),
  ];

  it("every player is a step of its own on a meter that spends a slice a read; the frozen meter's answer is the same", async () => {
    const before = grantedTurns();
    const stepped = await withSliceMeter(spendingMeter(), () =>
      leaguePlayers(rosters, pool, [], null, 5),
    );
    const passes = grantedTurns() - before;
    const at = grantedTurns();
    const frozen = await withSliceMeter(frozenMeter, () =>
      leaguePlayers(rosters, pool, [], null, 5),
    );
    // the frozen meter never spends a slice: at most the first check after a meter swap yields
    expect(grantedTurns() - at).toBeLessThanOrEqual(1);
    // 30 rostered + 20 from the pool: a turn of its own each
    expect(stepped).toHaveLength(50);
    expect(passes).toBe(50);
    expect(JSON.stringify(stepped)).toBe(JSON.stringify(frozen));
    expect(stepped.slice(0, 30).every((p) => p.rostered)).toBe(true);
    expect(stepped.slice(30).every((p) => !p.rostered)).toBe(true);
  });
});
