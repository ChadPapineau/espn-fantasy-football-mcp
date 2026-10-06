// kdst.test.ts — plan 10 A12a replayed on the recorded fixture weeks: hard — at least 3 candidates
// per position with implied totals populated for every fixture week (nflverse lines joined to ESPN
// by the game id); soft (reported in docs/evals/1a-backtest.md) — the bracket model's rank
// correlation with realised points against "lowest opponent implied total" and "most points last week".
import { beforeAll, describe, expect, it } from "vitest";
import {
  docSection,
  kdstSection,
  replayKdst,
  writeDocSection,
  type KdstRow,
} from "./helpers/replay.js";

let rows: KdstRow[];

beforeAll(() => {
  rows = replayKdst();
  if (process.env.UPDATE_EVALS === "1") writeDocSection("kdst", kdstSection(rows));
}, 60_000);

describe("A12a K/D-ST replay (recorded fixture weeks)", () => {
  it("(hard) ≥ 3 candidates per position, implied totals populated, every league-week", () => {
    expect(rows.length).toBeGreaterThanOrEqual(18);
    for (const r of rows) {
      expect(r.n, `${r.league} ${String(r.week)} ${r.position}`).toBeGreaterThanOrEqual(3);
      expect(r.implied_populated, `${r.league} ${String(r.week)} ${r.position}`).toBe(true);
    }
  });

  it("(soft, reported) the numbers in docs/evals/1a-backtest.md are this replay's", () => {
    expect(docSection("kdst")).toBe(kdstSection(rows));
  });
});
