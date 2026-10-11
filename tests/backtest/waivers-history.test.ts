// waivers-history.test.ts — changelog R6-3 proven on the recorded probe-league history, fixture
// mode, keyless: a league's previous-season transactions are its own feed (plan 07 E5), so E5's
// premium is `league_fitted` from the first call of a season whose previous season ESPN served, with
// the seasons and n said; the cold start stays only where no history exists, and E5 then says so
// with its measured miss.
//
// The probe leagues' finished seasons carry no mTransactions2 keylessly, so each previous season is
// read through the REAL provider in fixture mode over the history manifest (settings, standings,
// every week's box score) and its week-over-week roster changes are written as the transactions ESPN would have
// served (tests/domain/analytics/waiver-fit/helpers/history-moves.ts). The product's own builder
// and fit then run on them unchanged (`seasonFeedFromTransactions`, `fitPremiumFromHistory`), on the
// product's in-call reading (value-free: a past player's value is not in the store) and, as a
// diagnostic, with each drop's ESPN projection over replacement.
//
// Protocol (causal; nothing fitted on the season it is scored on): E5 in season S reads the feeds of
// S − 1 and S − 2. league-b 2024 is served from 2023 — whose rosters were not recorded, so no feed:
// the cold start; league-b 2025 is served from 2024 — league_fitted, scored on 2025's own drops
// (held out). The product constants (the 30-candidate floor, the valued rate and the 3-claims rule
// for a slope, the 8-day fate window, two seasons) were fixed from the plan and R6-3 before any
// season was scored and are not tuned here. The roster-derived feed sees only drops that another
// team re-claimed — not the claims of players nobody had rostered (league-b's per-run
// waiverProcessStatus counts, meaning [U], run far above it) — so its claim-run drift would understate c: the Π shown takes c from ESPN's
// own acquisition counters instead (the prior within their bound, as the C5 section reads league-b);
// a live league's mTransactions2 carries every claim. Numbers: docs/evals/phase3-waivers-seeding.md
// (`history` section; UPDATE_EVALS=1 rewrites it, equality asserted otherwise). Ids only, no names.
import { beforeAll, describe, expect, it } from "vitest";
import { WAIVER_DP } from "../../src/domain/analytics/constants.js";
import {
  COLD_START_REVISIT,
  WAIVER_FIT,
  calibrateClearsToFa,
  clearProbabilityCurve,
  coldStartNote,
  fitPremiumFromHistory,
  seasonFeedFromTransactions,
  type ClearsCalibration,
  type HistoryOutcome,
  type LeaguePremiumFit,
  type SeasonWaiverFeed,
} from "../../src/domain/analytics/waiver-fit/index.js";
import { solvePremiumTable } from "../../src/domain/analytics/waiverDp.js";
import { analyzeWaivers } from "../../src/domain/analytics/waivers.js";
import { waiverRequest } from "../domain/analytics/p1-helpers.js";
import { writeOrCompare } from "../domain/analytics/seeding-reproduce/doc.js";
import {
  movesFromRosters,
  readPreviousSeason,
  valueAtFromRosters,
  type PreviousSeason,
} from "../domain/analytics/waiver-fit/helpers/history-moves.js";
import type { LeagueSlot } from "../providers/espn/helpers.js";

const SLOTS: readonly LeagueSlot[] = ["league-a", "league-b", "league-c"];
const SEASONS = [2023, 2024, 2025] as const;

interface SeasonRead {
  readonly read: PreviousSeason;
  readonly moves: number;
  /** The product's in-call reading (value-free). */
  readonly feed: SeasonWaiverFeed;
  /** Diagnostic: each drop's ESPN projection over replacement. */
  readonly valued: SeasonWaiverFeed;
}

const reads = new Map<string, SeasonRead>();
const key = (slot: string, season: number): string => `${slot}/${String(season)}`;

/** The feeds E5 in `season` reads: the newest two previous seasons (product: transactions_seen). */
function feedsFor(slot: string, season: number, which: "feed" | "valued"): SeasonWaiverFeed[] {
  return [season - 1, season - 2]
    .map((s) => reads.get(key(slot, s)))
    .filter((r): r is SeasonRead => r !== undefined)
    .map((r) => r[which]);
}

/** The league's size in `season` (the newest recorded season at or before it). */
function sizeOf(slot: string, season: number): number {
  for (let s = Math.min(season, 2025); s >= 2023; s--) {
    const n = reads.get(key(slot, s))?.read.teams.length;
    if (n !== undefined && n > 0) return n;
  }
  return 10;
}

/** E5's premium for `season`: the history fit, drift from ESPN's counters (see the header). */
function servedFit(slot: string, season: number, which: "feed" | "valued"): LeaguePremiumFit {
  const feeds = feedsFor(slot, season, which).map((f) => ({ ...f, drift: [] }));
  return fitPremiumFromHistory({
    teams: sizeOf(slot, season),
    feeds,
    runs: [],
    // the first call of the season: no run logged, no period played (the counters bound nothing yet)
    current: { season, transactions: [], standings: [], periods_played: [] },
  });
}

/** E5's P(clears_to_FA) for each held-out drop under a curve (r = his value; E5 knows it in-season). */
function calibrate(outcomes: readonly HistoryOutcome[], q0: number, q1: number): ClearsCalibration {
  return calibrateClearsToFa(
    outcomes.map((o) => ({ p: clearProbabilityCurve(o.r, o.rivals, q0, q1), cleared: o.cleared })),
  );
}

beforeAll(async () => {
  for (const slot of SLOTS)
    for (const season of SEASONS) {
      const read = await readPreviousSeason(slot, season);
      const txns = movesFromRosters(read);
      const opts = {
        season,
        transactions: txns,
        teams: read.teams,
        regular_season_weeks: read.regular,
      };
      reads.set(key(slot, season), {
        read,
        moves: txns.length,
        feed: seasonFeedFromTransactions(opts),
        valued: seasonFeedFromTransactions({ ...opts, value_at: valueAtFromRosters(read) }),
      });
    }
}, 180_000);

const pct = (x: number | null): string => (x === null ? "—" : (x * 100).toFixed(1));
const signed = (x: number | null): string =>
  x === null ? "—" : `${x >= 0 ? "+" : "−"}${(Math.abs(x) * 100).toFixed(1)}`;
const f1 = (x: number): string => x.toFixed(1);
const yesNo = (b: boolean | null): string => (b === null ? "—" : b ? "yes" : "**no**");

function historySection(): string {
  const lines = [
    "Each previous season as the product reads it (provider, fixture mode, keyless): box-score weeks recorded, the roster changes written as transactions, drops, waiver candidates kept (a drop in the regular season with a later cycle), how many cleared, and the valued ones (diagnostic: r ≥ 2.5 over replacement) with how many were claimed:",
    "",
    "| league / season | box-score weeks | moves | drops | candidates | cleared | re-claim runs | valued (claimed) |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const slot of SLOTS)
    for (const season of SEASONS) {
      const r = reads.get(key(slot, season));
      if (r === undefined) continue;
      const v = r.valued.outcomes.filter((o) => o.value_known && o.r >= 2.5);
      lines.push(
        `| ${slot}/${String(season)} | ${String(r.read.weeks?.size ?? 0)} | ${String(r.moves)} | ${String(r.feed.drops)} | ${String(r.feed.outcomes.length)} | ${String(r.feed.outcomes.filter((o) => o.cleared).length)} | ${String(r.feed.claim_runs)} | ${String(v.length)} (${String(v.filter((o) => !o.cleared).length)}) |`,
      );
    }
  lines.push(
    "",
    "What E5 serves on the first call of each season (the newest two previous seasons; no run logged yet):",
    "",
    "| league / season served | teams | from | basis | demand curve | n | slope | drift c | Π(2, 12) | Π(1, 9) | Π(10, 9) |",
    "|---|---:|---|---|---|---:|---|---:|---:|---:|---:|",
  );
  const cold = solvePremiumTable({ teams: 10 });
  const served: [string, number][] = [];
  for (const slot of SLOTS) for (const s of [2024, 2025, 2026]) served.push([slot, s]);
  for (const [slot, s] of served) {
    const fit = servedFit(slot, s, "feed");
    const from = feedsFor(slot, s, "feed").filter((f) => f.outcomes.length > 0);
    const c = fit.demand_curve ?? null;
    lines.push(
      `| ${slot}/${String(s)} | ${String(fit.teams)} | ${from.length === 0 ? "no feed" : from.map((f) => String(f.season)).join(", ")} | ${fit.basis} | ${c === null ? `cold start (q0 ${String(WAIVER_DP.q0)})` : `q0 ${c.q0.toFixed(4)}`} | ${c === null ? "—" : String(c.n)} | ${c === null ? `${String(WAIVER_DP.q1)} (cold)` : `${String(c.q1)} (${c.basis === "curve" ? "fitted" : "cold start"})`} | ${String(fit.drift.c)} | ${f1(fit.base.premium(2, 12))} | ${f1(fit.base.premium(1, 9))} | ${f1(fit.base.premium(10, 9))} |`,
    );
  }
  lines.push(
    `| (cold-start table) | 10 | — | cold_start_table | q0 ${String(WAIVER_DP.q0)} | — | ${String(WAIVER_DP.q1)} | ${String(WAIVER_DP.drift)} | ${f1(cold.premium(2, 12))} | ${f1(cold.premium(1, 9))} | ${f1(cold.premium(10, 9))} |`,
    "",
    "Held out — league-b 2025 scored on its own drops (E5's P(clears_to_FA) = (1 − q(r))⁹, r = the drop's ESPN week projection over replacement) under the curve E5 serves in 2025, fitted on 2024 only:",
    "",
    "| curve | q0 | q1 | drops | observed clear rate | mean predicted | in the large | worst judged decile | judged deciles | within ±10 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  const held = reads.get(key("league-b", 2025))?.valued.outcomes ?? [];
  const rows: [string, number, number][] = [
    ["cold start (research 05 §1.3)", WAIVER_DP.q0, WAIVER_DP.q1],
  ];
  const vf = servedFit("league-b", 2025, "feed").demand_curve;
  const va = servedFit("league-b", 2025, "valued").demand_curve;
  if (vf) rows.push(["fitted on 2024, value-free (what E5 serves)", vf.q0, vf.q1]);
  if (va) rows.push(["fitted on 2024 with values (diagnostic)", va.q0, va.q1]);
  for (const [name, q0, q1] of rows) {
    const c = calibrate(held, q0, q1);
    lines.push(
      `| ${name} | ${q0.toFixed(4)} | ${q1.toFixed(4)} | ${String(c.n)} | ${pct(c.base_rate)} | ${pct(c.mean_p)} | ${signed(c.in_the_large)} | ${pct(c.max_abs_deviation)} | ${String(c.bins.filter((b) => b.judged).length)} | ${yesNo(c.within_tolerance)} |`,
    );
  }
  const c25 = calibrate(held, WAIVER_DP.q0, WAIVER_DP.q1);
  const h25 = vf ? calibrate(held, vf.q0, vf.q1) : null;
  lines.push(
    "",
    `**R6-3 on the recorded history:** league-b 2025 is served \`league_fitted\` from its first call (the feed of 2024: ${String(vf?.n ?? 0)} waiver candidates), league-b 2024 and every league-a / league-c season serve the cold start (no previous-season feed recorded) and say so with the measured miss. Held out on 2025, the history intercept moves P(clears_to_FA) in the large from ${signed(c25.in_the_large)} to ${signed(h25?.in_the_large ?? null)} points; its worst judged decile stays ${pct(h25?.max_abs_deviation ?? null)} points off because the slope stays the cold start's (R6-3: the feed shows no claims at value) — E5 says so beside the fitted intercept, with that ${signed(h25?.in_the_large ?? null)}-point miss.`,
  );
  return lines.join("\n");
}

describe("R6-3 — the league's previous seasons as its own feed (recorded probe history)", () => {
  it("only league-b 2024 and 2025 have recorded rosters; their moves yield ≥ 30 waiver candidates each", () => {
    for (const slot of SLOTS)
      for (const season of SEASONS) {
        const r = reads.get(key(slot, season));
        const recorded = slot === "league-b" && season !== 2023;
        expect(r?.read.weeks !== null, key(slot, season)).toBe(recorded);
        if (!recorded) {
          expect(r?.moves).toBe(0);
          continue;
        }
        expect(r?.feed.outcomes.length ?? 0).toBeGreaterThanOrEqual(30);
        expect(r?.read.teams).toHaveLength(10);
        expect(r?.feed.outcomes.every((o) => o.rivals === 9 && !o.value_known && o.r === 0)).toBe(
          true,
        );
        expect(r?.valued.outcomes.length).toBe(r?.feed.outcomes.length);
        // the fate rule reads the same moves either way
        expect(r?.valued.outcomes.map((o) => o.cleared)).toEqual(
          r?.feed.outcomes.map((o) => o.cleared),
        );
      }
  });

  it("league-b 2025 is league_fitted from the first call, its seasons and n in E5's own output", async () => {
    const fit = servedFit("league-b", 2025, "feed");
    expect(fit.basis).toBe("league_fitted");
    expect(fit.history?.seasons).toEqual([2024]);
    const n = reads.get(key("league-b", 2024))?.feed.outcomes.length ?? 0;
    expect(fit.demand_curve?.n).toBe(n);
    // R6-3: no claims at value in this feed — the slope stays the cold start's
    expect(fit.demand_curve?.basis).toBe("intercept");
    expect(fit.demand_curve?.q1).toBe(WAIVER_DP.q1);
    const { data } = await analyzeWaivers({ ...waiverRequest(), premium_fit: fit });
    expect(data.premium_basis).toBe("league_fitted");
    const text = data.rec.assumptions.map((a) => a.text).join(" | ");
    expect(text).toContain("seasons 2024");
    expect(text).toContain(`${String(n)} drops`);
    // what is still the cold start — the slope — is said, with its measured miss
    expect(
      data.rec.assumptions
        .filter((a) => a.revisit_trigger === COLD_START_REVISIT)
        .map((a) => a.text),
    ).toEqual([coldStartNote(false, false, true)]);
    for (const c of data.candidates)
      if (c.p_clears_to_fa !== null) expect(c.p_clears_to_fa.basis).toBe("league_fitted");
  });

  it("no previous-season feed (league-b 2024, league-a, league-c): the cold start, said with its miss", async () => {
    for (const [slot, s] of [
      ["league-b", 2024],
      ["league-a", 2025],
      ["league-c", 2026],
    ] as const) {
      const fit = servedFit(slot, s, "feed");
      expect(fit.basis, `${slot}/${String(s)}`).toBe("cold_start_table");
      expect(fit.reasons[0]).toContain("no previous-season transactions");
      const { data } = await analyzeWaivers({ ...waiverRequest(), premium_fit: fit });
      expect(data.premium_basis).toBe("cold_start_table");
      expect(
        data.rec.assumptions
          .filter((a) => a.revisit_trigger === COLD_START_REVISIT)
          .map((a) => a.text),
      ).toEqual([coldStartNote(true, true)]);
    }
  });

  it("held out on 2025, the curve fitted on 2024 is closer in the large than the cold start", () => {
    const held = reads.get(key("league-b", 2025))?.valued.outcomes ?? [];
    expect(held.length).toBeGreaterThanOrEqual(30);
    const cold = calibrate(held, WAIVER_DP.q0, WAIVER_DP.q1);
    const vf = servedFit("league-b", 2025, "feed").demand_curve;
    if (!vf) throw new Error("no curve");
    const fitted = calibrate(held, vf.q0, vf.q1);
    expect(Math.abs(fitted.in_the_large ?? 1)).toBeLessThan(Math.abs(cold.in_the_large ?? 0));
    expect(fitted.brier ?? 1).toBeLessThan(cold.brier ?? 0);
  });

  it("E5's stated miss for the cold slope is this measurement (WAIVER_FIT.coldStartMiss.slopeClearsPoints)", () => {
    const held = reads.get(key("league-b", 2025))?.valued.outcomes ?? [];
    const vf = servedFit("league-b", 2025, "feed").demand_curve;
    if (!vf) throw new Error("no curve");
    const miss = Math.round((calibrate(held, vf.q0, vf.q1).in_the_large ?? 0) * 1000) / 10;
    expect(WAIVER_FIT.coldStartMiss.slopeClearsPoints).toBe(miss);
  });

  it("2026 would read both recorded seasons (the newest two), still with the cold slope", () => {
    const fit = servedFit("league-b", 2026, "feed");
    expect(fit.history?.seasons).toEqual([2025, 2024]);
    expect(fit.demand_curve?.basis).toBe("intercept");
  });

  it("the numbers are the ones in docs/evals/phase3-waivers-seeding.md", () => {
    writeOrCompare("history", historySection());
  });
});
