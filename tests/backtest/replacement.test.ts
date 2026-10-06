// replacement.test.ts — plan 10 B7's hard regression (research 05 §4.1, §3.1–§3.2): recompute the
// 2025 and 2024 replacement baselines from the nflverse files (the committed excerpt in
// tests/backtest/data/stats_player_week, re-hashed on every read) through the shipped scoring
// translator and engine under the reference league's settings and the shipped E4 allocation
// (`allocate`, `allocationPlanOf` over fx-10h's own roster settings, N = 10), and assert research
// 05 §4.1's table within 0.3 points per game and its flex split (2025 RB 7 / WR 3, 2024 WR 6 / RB 4,
// TE 0) exactly; the season-totals variant and §3.2's QB totals as a cross-check; the full E4
// engine (`analyzeReplacement`) on the same season agrees with the kernel. One table cell is a
// recorded discrepancy (2024 TE rank 3: the table prints 3.2, the release file gives 3.6 — the
// next rank is 3.1; every baseline and the other 35 cells agree within 0.3), asserted at its
// measured value so a change in either direction is seen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  allocate,
  allocationPlanOf,
  analyzeReplacement,
  replacementDepth,
  type ReplacementPlayer,
} from "../../src/domain/analytics/replacement.js";
import { fixedClock } from "../../src/domain/clock.js";
import { buildRosterSlots } from "../../src/domain/league/slots.js";
import type { BareText, RosterSlots } from "../../src/domain/league/types.js";
import type { ScoringSettings } from "../../src/domain/scoring/index.js";
import { instantPacer } from "../domain/analytics/helpers.js";
import {
  MIN_GAMES,
  REPLACEMENT_DATA_DIR,
  RESEARCH_05_TABLE,
  entriesOf,
  playerSeasons,
  type PlayerSeason,
} from "./helpers/replacement-data.js";
import { BACKTEST_POSITIONS, ROOT, loadBacktestSeason } from "./helpers/waiver-excerpt.js";
import { referenceSettings, rowPoints } from "./helpers/waivers.js";

/** Research 05 §4.1's tolerance (plan 10 B7). */
const PPG_TOL = 0.3;
/** The one table cell the release file does not reproduce (see the header). */
const KNOWN_CELL = { season: 2024, position: "TE", rank: 3, table: 3.2, measured: 3.6 } as const;

/** fx-10h's own roster settings — the reference league (research 05 §0). */
function referenceRoster(): RosterSlots {
  const body = JSON.parse(
    readFileSync(join(ROOT, "fixtures/espn/fx-10h/league/mSettings.json"), "utf8"),
  ) as { settings: { rosterSettings: { lineupSlotCounts: Record<string, number> } } };
  return buildRosterSlots({
    slot_counts: body.settings.rosterSettings.lineupSlotCounts,
    position_limits: {},
    lineup_lock_type: "INDIVIDUAL_GAME",
    undroppable_list: false,
    move_limit: null,
  }).roster;
}

let settings: ScoringSettings;
let roster: RosterSlots;
const seasons = new Map<number, PlayerSeason[]>();

beforeAll(() => {
  settings = referenceSettings();
  roster = referenceRoster();
  for (const s of [2024, 2025]) {
    const ps = playerSeasons(s, settings);
    if (ps === null) throw new Error(`the ${String(s)} excerpt is not committed`);
    seasons.set(s, ps);
  }
});

const seasonOf = (s: number): PlayerSeason[] => seasons.get(s) ?? [];

describe("the excerpt and the scoring path", () => {
  it("both seasons are committed, hash-checked and cover research 05 §3.1's filter", () => {
    for (const s of [2024, 2025]) {
      const rows = loadBacktestSeason(s, REPLACEMENT_DATA_DIR);
      expect(rows, String(s)).not.toBeNull();
      for (const r of rows ?? []) {
        expect(r.season_type).toBe("REG");
        expect(Number(r.week)).toBeGreaterThanOrEqual(1);
        expect(Number(r.week)).toBeLessThanOrEqual(17);
        expect(BACKTEST_POSITIONS).toContain(r.position_group);
      }
    }
  });

  it("the shipped engine scores every row as nflverse's standard line + 1/pass TD + 0.5/reception, return TDs out, own-recovery TDs in", () => {
    // nflverse `fantasy_points`: 4-pt pass TD, no reception points, return TDs counted, own fumble-
    // recovery TDs not. The reference league adds the fifth pass-TD point and half-PPR; a player-
    // level `special_teams_tds` cannot be split into stats 101/102 without pbp, so the translator
    // books it under `ret_td_total`, which the league does not score (plan 08 §3.2's table); an own
    // fumble-recovery TD is ESPN 63 at 6. (Research 05 §3.1 scored return TDs: 32 of 11,339 rows.)
    let returnTdRows = 0;
    for (const s of [2024, 2025]) {
      for (const r of loadBacktestSeason(s, REPLACEMENT_DATA_DIR) ?? []) {
        const n = (k: string): number => {
          const v = r[k];
          return typeof v === "number" ? v : 0;
        };
        const expected =
          n("fantasy_points") +
          n("passing_tds") +
          0.5 * n("receptions") -
          6 * n("special_teams_tds") +
          6 * Math.min(n("fumble_recovery_tds"), n("fumble_recovery_own"));
        expect(Math.abs(rowPoints(r, settings) - expected)).toBeLessThan(0.011);
        if (n("special_teams_tds") > 0) returnTdRows += 1;
      }
    }
    expect(returnTdRows).toBe(32);
  });

  it("the reference league's plan: QB, 2 RB, 2 WR, TE, D/ST, K dedicated; one RB/WR/TE FLEX; QB read 2 past the last starter", () => {
    const plan = allocationPlanOf(roster);
    expect(plan.fixed).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, "D/ST": 1, K: 1 });
    expect(plan.flex).toEqual([{ slot: "FLEX", positions: ["RB", "WR", "TE"], count: 1 }]);
    expect(replacementDepth(plan, 10)).toMatchObject({ QB: 2, RB: 1, WR: 1, TE: 1, K: 1 });
  });
});

describe.each([2025, 2024] as const)("research 05 §4.1, %i (per game, ≥ 8 GP) — hard", (season) => {
  const table = RESEARCH_05_TABLE[season];
  const run = () => {
    const plan = allocationPlanOf(roster);
    return allocate(entriesOf(seasonOf(season), "per_game"), plan, 10);
  };

  it(`the flex split is exactly RB ${String(table.flex.RB)} / WR ${String(table.flex.WR)} / TE 0`, () => {
    const a = run();
    expect({ RB: a.flex_split.RB, WR: a.flex_split.WR, TE: a.flex_split.TE }).toEqual(table.flex);
    expect(a.trace).toHaveLength(10);
  });

  it("every baseline within 0.3 ppg (QB at QB12, the others at the best unslotted player)", () => {
    const a = run();
    expect(a.baseline_rank).toMatchObject({
      QB: 12,
      RB: 20 + table.flex.RB + 1,
      WR: 20 + table.flex.WR + 1,
      TE: 11,
    });
    for (const pos of BACKTEST_POSITIONS)
      expect(Math.abs((a.baseline[pos] ?? Number.NaN) - table.baseline[pos]), pos).toBeLessThan(
        PPG_TOL,
      );
    expect(Math.abs((a.last_starter.QB ?? Number.NaN) - table.qb_last_starter)).toBeLessThan(
      PPG_TOL,
    );
  });

  it("every top and every VOR cell within 0.3 ppg (the one recorded cell at its measured value)", () => {
    const a = run();
    for (const pos of BACKTEST_POSITIONS) {
      const ranked = a.ranked[pos] ?? [];
      expect(Math.abs((ranked[0]?.value ?? Number.NaN) - table.top[pos]), pos).toBeLessThan(
        PPG_TOL,
      );
      for (const [rank, cell] of table.vor[pos]) {
        const got = (ranked[rank - 1]?.value ?? Number.NaN) - (a.baseline[pos] ?? 0);
        const known =
          season === KNOWN_CELL.season && pos === KNOWN_CELL.position && rank === KNOWN_CELL.rank;
        if (known) {
          expect(cell).toBe(KNOWN_CELL.table);
          expect(Math.abs(got - KNOWN_CELL.measured)).toBeLessThan(0.05);
        } else expect(Math.abs(got - cell), `${pos} rank ${String(rank)}`).toBeLessThan(PPG_TOL);
      }
    }
  });

  it("the season-totals variant reproduces the §4.1 note and §3.2's QB totals (within 1 point a season)", () => {
    const plan = allocationPlanOf(roster);
    const a = allocate(entriesOf(seasonOf(season), "season_total"), plan, 10);
    expect({ RB: a.flex_split.RB, WR: a.flex_split.WR, TE: a.flex_split.TE }).toEqual(
      table.totals.flex,
    );
    for (const pos of ["RB", "WR", "TE"] as const)
      expect(
        Math.abs((a.baseline[pos] ?? Number.NaN) - table.totals.baseline[pos]),
        pos,
      ).toBeLessThan(1);
    const qb = a.ranked.QB ?? [];
    expect(Math.abs((qb[0]?.value ?? 0) - table.totals.qb.qb1)).toBeLessThan(1);
    expect(Math.abs((qb[9]?.value ?? 0) - table.totals.qb.qb10)).toBeLessThan(1);
    expect(Math.abs((a.baseline.QB ?? 0) - table.totals.qb.qb12)).toBeLessThan(1);
  });

  it("the ≥ 8 GP filter matters: without it a short season tops a position or moves a baseline", () => {
    const plan = allocationPlanOf(roster);
    const all = seasonOf(season).map((p) => ({
      key: p.id,
      position: p.position,
      value: p.points / p.games,
    }));
    const unfiltered = allocate(all, plan, 10);
    const filtered = run();
    const moved = BACKTEST_POSITIONS.some(
      (pos) =>
        Math.abs((unfiltered.baseline[pos] ?? 0) - (filtered.baseline[pos] ?? 0)) > 1e-9 ||
        (unfiltered.ranked[pos]?.[0]?.value ?? 0) !== (filtered.ranked[pos]?.[0]?.value ?? 0),
    );
    expect(moved).toBe(true);
    expect(seasonOf(season).some((p) => p.games < MIN_GAMES)).toBe(true);
  });
});

describe("the full E4 engine on 2025 agrees with the kernel (real nflverse values as the projections)", () => {
  it("starter_baseline_ros, the flex split, QB10 − replacement and the curve", async () => {
    const rows = loadBacktestSeason(2025, REPLACEMENT_DATA_DIR) ?? [];
    const keep = new Set(
      seasonOf(2025)
        .filter((p) => p.games >= MIN_GAMES)
        .map((p) => p.id),
    );
    const posOf = new Map(seasonOf(2025).map((p) => [p.id, p.position]));
    const weeks = Array.from({ length: 17 }, (_, i) => i + 1);
    const byPlayer = new Map<string, (number | null)[]>();
    for (const r of rows) {
      const id = String(r.player_id);
      if (!keep.has(id)) continue;
      const w = byPlayer.get(id) ?? weeks.map(() => null);
      w[Number(r.week) - 1] = rowPoints(r, settings);
      byPlayer.set(id, w);
    }
    const ids = [...byPlayer.keys()].sort();
    const players: ReplacementPlayer[] = ids.map((id, i) => ({
      player_id: i + 1,
      name: `P${String(i + 1)}` as BareText,
      position: posOf.get(id) ?? "QB",
      rostered: true,
      weeks: (byPlayer.get(id) ?? []).map((v) => (v === null ? null : { mean: v, bye: false })),
    }));
    const out = await analyzeReplacement({
      roster,
      league_size: 10,
      weeks,
      positions: ["QB", "RB", "WR", "TE"],
      players,
      detail: "full",
      clock: fixedClock("2026-10-06T12:00:00.000Z"),
      pacer: instantPacer,
      deadline_ms: null,
    });
    const t = RESEARCH_05_TABLE[2025];
    expect(out.partial).toBe(false);
    expect(out.data.format_notes.flex_split).toEqual({ rb: 7, wr: 3, te: 0 });
    for (const p of out.data.positions)
      expect(
        Math.abs(p.starter_baseline_ros - t.baseline[p.position as "QB"]),
        p.position,
      ).toBeLessThan(PPG_TOL);
    expect(
      Math.abs(
        (out.data.format_notes.qb_last_starter_vs_replacement_ppg ?? 0) -
          (t.qb_last_starter - t.baseline.QB),
      ),
    ).toBeLessThan(0.05);
    const rb = out.data.positions.find((p) => p.position === "RB");
    expect(rb?.curve[0]?.vor).toBeCloseTo(t.vor.RB[0]?.[1] ?? 0, 0);
    expect(rb?.flex_allocation_trace).toHaveLength(7);
    // no pool in the input: streamability is the allocation proxy, and QB stays streamable
    expect(out.streamability_basis.QB).toBe("allocation_proxy");
    expect(out.data.format_notes.streamable_positions).toContain("QB");
  });
});
