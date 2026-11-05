// player-week-chunks.test.ts — F1, round 4d: E1's season of nflverse stat lines is read a few players
// at a time (common.ts playerWeekLinesSteps), with a cut point between reads, and the answer is the
// one read's, row for row and stamp for stamp. Counted, no clock: the reads and their sizes, the
// yields between them; byte-identical against a stand-in reader over any id list (duplicates,
// unsorted) and against the real dataset reader on fx-10h's published nflverse excerpt.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DatasetResult,
  DatasetStamp,
  PlayerWeekLine,
  PlayerWeekReader,
} from "../../src/domain/analytics/types.js";
import type { McpServices } from "../../src/mcp/services.js";
import {
  PLAYER_WEEK_CHUNK,
  playerWeekLines,
  playerWeekLinesSteps,
} from "../../src/mcp/tools/common.js";
import { ESPN_FIXTURES, makeWorld, type World } from "./helpers/world.js";

const STAMP = { source: "nflverse:stats_player_week" } as unknown as DatasetStamp;

/** A reader over a fixed table, ordered as the statement orders (player id, week); counted. */
function standIn(ids: readonly string[], loaded = true) {
  const table = ids
    .flatMap((g) => [1, 2, 3].map((week) => ({ gsis_id: g, week, season: 2025 })))
    .sort((a, b) => (a.gsis_id < b.gsis_id ? -1 : a.gsis_id > b.gsis_id ? 1 : a.week - b.week));
  const calls: string[][] = [];
  const reader: Pick<PlayerWeekReader, "lines"> = {
    lines(gsis, _season, weeks): DatasetResult<PlayerWeekLine> {
      calls.push([...gsis]);
      if (!loaded) return NOT_LOADED;
      const want = new Set(gsis);
      return {
        rows: table.filter(
          (r) => want.has(r.gsis_id) && weeks.includes(r.week),
        ) as unknown as PlayerWeekLine[],
        stamp: STAMP,
      };
    },
  };
  const ctx = { services: { datasets: { playerWeeks: reader } } as unknown as McpServices };
  return { ctx, calls };
}
const NOT_LOADED: DatasetResult<PlayerWeekLine> = Object.freeze({ rows: [], stamp: null });

/** Drains the steps, counting the yields. */
function drain<T>(g: Generator<void, T, undefined>): { value: T; yields: number } {
  let yields = 0;
  for (;;) {
    const r = g.next();
    if (r.done === true) return { value: r.value, yields };
    yields += 1;
  }
}

const gsisArb = fc
  .array(fc.integer({ min: 0, max: 60 }), { maxLength: 40 })
  .map((xs) => xs.map((x) => `00-00${String(30000 + x)}`));

describe("playerWeekLinesSteps: the one read's answer, a few players a read (F1, round 4d)", () => {
  it("row for row and stamp for stamp, whatever the ids' order and repeats; counted reads and yields", () => {
    fc.assert(
      fc.property(gsisArb, fc.subarray([1, 2, 3], { minLength: 1 }), (gsis, weeks) => {
        const one = standIn(gsis);
        const whole = one.ctx.services.datasets.playerWeeks.lines(gsis, 2025, weeks);
        const chunked = standIn(gsis);
        const { value, yields } = drain(
          playerWeekLinesSteps(chunked.ctx, gsis, 2025, weeks, { usage: false }),
        );
        expect(value.rows).toEqual(whole.rows);
        expect(value.stamp).toBe(whole.stamp);
        const unique = new Set(gsis).size;
        const reads = unique <= PLAYER_WEEK_CHUNK ? 1 : Math.ceil(unique / PLAYER_WEEK_CHUNK);
        expect(chunked.calls).toHaveLength(reads);
        expect(yields).toBe(reads - 1);
        for (const c of chunked.calls)
          expect(c.length).toBeLessThanOrEqual(Math.max(PLAYER_WEEK_CHUNK, gsis.length));
        if (unique > PLAYER_WEEK_CHUNK) {
          for (const c of chunked.calls) expect(c.length).toBeLessThanOrEqual(PLAYER_WEEK_CHUNK);
          expect(chunked.calls.flat()).toEqual([...new Set(gsis)].sort());
        }
      }),
    );
  });

  it("a source that is not loaded answers as the one read does, after one read", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `00-00${String(31000 + i)}`);
    const s = standIn(ids, false);
    const { value, yields } = drain(playerWeekLinesSteps(s.ctx, ids, 2025, [1, 2]));
    expect(value).toBe(NOT_LOADED);
    expect(s.calls).toHaveLength(1);
    expect(yields).toBe(0);
  });

  it("the async form gives the same answer", async () => {
    const ids = Array.from({ length: 23 }, (_, i) => `00-00${String(32000 + ((i * 7) % 23))}`);
    const a = standIn(ids);
    const b = standIn(ids);
    expect(await playerWeekLines(a.ctx, ids, 2025, [1, 3])).toEqual(
      b.ctx.services.datasets.playerWeeks.lines(ids, 2025, [1, 3]),
    );
  });
});

describe("against the real dataset reader on fx-10h's nflverse excerpt", () => {
  let world: World;
  beforeAll(async () => {
    const FX = path.join(ESPN_FIXTURES, "fx-10h");
    const m = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as { clock: string };
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
      teamId: 2,
      clock: m.clock,
      publishEspn: true,
      publishNflverse: true,
    });
  }, 120_000);
  afterAll(() => {
    world.cleanup();
  });

  it("every player the excerpt holds, both seasons, with and without the usage extras: byte-identical", () => {
    const reader = world.services.datasets.playerWeeks;
    const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
    let most = 0;
    for (const season of [2024, 2025, 2026]) {
      // the excerpt's players: everyone its weekly rosters name (reversed: never pre-sorted)
      const gsis = [
        ...new Set(world.services.rosterWeekly.latest(season).rows.map((p) => p.gsis_id)),
      ].reverse();
      const have = new Set(
        reader.lines(gsis, season, weeks, { usage: false }).rows.map((r) => r.gsis_id),
      );
      most = Math.max(most, have.size);
      for (const usage of [false, true]) {
        const whole = reader.lines(gsis, season, weeks, { usage });
        const chunked = drain(playerWeekLinesSteps(world, gsis, season, weeks, { usage }));
        expect(JSON.stringify(chunked.value)).toBe(JSON.stringify(whole));
      }
    }
    // the excerpt holds more players than two reads' worth: the chunked path ran
    expect(most).toBeGreaterThan(PLAYER_WEEK_CHUNK * 2);
  });
});
