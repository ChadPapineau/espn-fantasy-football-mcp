// season-roster-barrel.test.ts — src/domain/analytics/seasonRoster.ts re-exports the group-A P1
// engines (E3 pre/live and the fitted season, E4, E8, E9) unchanged: the same function objects as
// their modules, and nothing that collides with the P0 surface (./index.ts) or ./phase2.ts.
import { describe, expect, it } from "vitest";
import * as barrel from "../../../src/domain/analytics/seasonRoster.js";
import * as p0 from "../../../src/domain/analytics/index.js";
import * as phase2 from "../../../src/domain/analytics/phase2.js";
import { analyzeMatchupWin } from "../../../src/domain/analytics/matchup.js";
import { analyzeReplacement } from "../../../src/domain/analytics/replacement.js";
import { analyzeRoster } from "../../../src/domain/analytics/rosterAudit.js";
import { analyzeSchedule } from "../../../src/domain/analytics/scheduleStress.js";
import { simulateFittedSeason } from "../../../src/domain/analytics/seasonFit.js";

describe("the season and roster barrel", () => {
  it("re-exports each engine's entry point unchanged", () => {
    expect(barrel.analyzeMatchupWin).toBe(analyzeMatchupWin);
    expect(barrel.simulateFittedSeason).toBe(simulateFittedSeason);
    expect(barrel.analyzeReplacement).toBe(analyzeReplacement);
    expect(barrel.analyzeSchedule).toBe(analyzeSchedule);
    expect(barrel.analyzeRoster).toBe(analyzeRoster);
    expect(barrel.HIDDEN_BENCH_RISKS).toHaveLength(3);
  });

  it("no runtime name collides with the P0 surface or the market barrel", () => {
    const mine = Object.keys(barrel);
    const others = new Set([...Object.keys(p0), ...Object.keys(phase2)]);
    expect(mine.filter((k) => others.has(k))).toEqual([]);
    expect(mine.length).toBeGreaterThanOrEqual(30);
  });
});
