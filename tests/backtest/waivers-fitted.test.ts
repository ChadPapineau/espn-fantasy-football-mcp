// waivers-fitted.test.ts — plan 10 C5 (soft, with numbers): the waiver DP re-solved from a league's own
// surplus distribution (research 05 §1.6 eval 3, §8.4 #4) and replayed against "claim the top
// trending player" over the two committed nflverse seasons (tests/backtest/data/stats_player_week,
// 2024 and 2025 — the B7 excerpt, re-hashed on every read). The league is research 05 §1.6's
// replay league (10 teams, the reference scoring, availability by prior per-game rank) and the
// replay machinery is the A9a harness's (tests/backtest/helpers/waivers.ts, used as shipped). The
// rule's forecast `s` comes from one of two forecasters: the Phase 3 opportunity model
// (`v2-opportunity`'s week-ahead expected points over replacement — helpers/v2-forecast.ts, read
// as of the claim week from the committed C1 excerpt; C5's verdict) and the A9a harness's trailing-4
// points per game (the Phase 1a forecast, reported beside it). Its own feed, per forecaster: one run
// per claim week, the best available player's forecast surplus as a per-week rate (r = s / (W + 1)).
// Protocol: each season is replayed with the premium fitted on the OTHER season (held out — for 2025
// that is the previous season, the production protocol; for 2024 it is the later one, said). The
// drift evidence comes from the probe leagues' real histories (mTeam's per-period acquisition totals
// through the provider in fixture mode): it only bounds c. Hard here: every fit is league_fitted,
// the rule never claims below the premium it was given, v2 forecasts most candidate-weeks, the
// replay is deterministic, the drift bound is read through the provider. The numbers are written
// to docs/evals/phase3-waivers-seeding.md (UPDATE_EVALS=1; equality asserted otherwise).
// Stage C (changelog R6-3): the Π miss E5 states with the cold start (WAIVER_FIT.coldStartMiss) is
// held equal to this measurement.
import { beforeAll, describe, expect, it } from "vitest";
import {
  WAIVER_FIT,
  comparePremium,
  driftFromAcquisitions,
  fitDrift,
  fitLeaguePremium,
  surplusRate,
  type DriftFit,
  type LeaguePremiumFit,
  type SurplusObservation,
} from "../../src/domain/analytics/waiver-fit/index.js";
import { solvePremiumTable, type PremiumTable } from "../../src/domain/analytics/waiverDp.js";
import { seededRng } from "../../src/domain/clock.js";
import { normalizeLeagueRules } from "../../src/providers/espn/normalize.js";
import { mSettingsSchema } from "../../src/providers/espn/views/league.schema.js";
import { writeOrCompare } from "../domain/analytics/seeding-reproduce/doc.js";
import {
  historyBody,
  historyFixtureFetch,
  servedSeasons,
} from "../fixtures/helpers/history-fixtures.js";
import { makeWorld, type LeagueSlot } from "../providers/espn/helpers.js";
import { REPLACEMENT_DATA_DIR } from "./helpers/replacement-data.js";
import { loadBacktestSeason, type BacktestPosition } from "./helpers/waiver-excerpt.js";
import { v2Forecaster, type V2ForecastStats } from "./helpers/v2-forecast.js";
import {
  REPLAY,
  demand,
  forecastSurplus,
  poolsFor,
  referenceSettings,
  rowPoints,
  seasonFromPoints,
  simulateSeason,
  type PathResult,
  type Pool,
  type Season,
  type SurplusForecaster,
} from "./helpers/waivers.js";

const SEASONS = [2024, 2025] as const;
type ReplaySeason = (typeof SEASONS)[number];
const POLICY_NAMES = [
  "rule_fitted",
  "rule_cold",
  "trending",
  "trending_strike",
  "hindsight",
] as const;
type PolicyName = (typeof POLICY_NAMES)[number];
/** The rule's forecasters: C5's verdict is v2's (the Phase 3 model); trailing-4 is reported beside. */
const FORECASTS = ["v2", "trailing4"] as const;
type ForecastName = (typeof FORECASTS)[number];
const FORECAST_LABEL: Readonly<Record<ForecastName, string>> = {
  v2: "v2-opportunity",
  trailing4: "trailing-4",
};

/** One season from the committed B7 excerpt under the reference scoring. */
function loadReplaySeason(season: ReplaySeason): Season {
  const rows = loadBacktestSeason(season, REPLACEMENT_DATA_DIR);
  const replacement = REPLAY.replacement[season];
  if (rows === null || replacement === undefined)
    throw new Error(`no excerpt for ${String(season)}`);
  const settings = referenceSettings();
  return seasonFromPoints(
    season,
    rows.map((r) => ({
      id: String(r.player_id),
      pos: r.position_group as BacktestPosition,
      week: Number(r.week),
      points: rowPoints(r, settings),
    })),
    replacement,
  );
}

/** The league's own feed of one season: per claim week, the best available forecast as a rate. */
function feedOf(pools: ReadonlyMap<number, Pool>): SurplusObservation[] {
  return REPLAY.claimWeeks.map((t) => ({
    r: surplusRate(pools.get(t)?.byForecast[0]?.f ?? 0, REPLAY.finalWeek - t) ?? 0,
  }));
}

/**
 * A diagnostic policy (not in research 05): "claim the top trending player" filtered by the DP's
 * strike — he is claimed only when his forecast surplus clears Π(k, W). It isolates what the premium
 * adds to the trending pick, on the A9a harness's mechanics (one target per run, (1 − q)^(k−1) to
 * win, a win sends me to N, a run without a win moves me up by Binomial(k − 1, c)).
 */
function simulateTrendingStrike(
  startK: number,
  rng: ReturnType<typeof seededRng>,
  table: PremiumTable,
  pools: ReadonlyMap<number, Pool>,
): PathResult {
  let k = startK;
  let claims = 0;
  let successes = 0;
  let surplus = 0;
  const mine = new Set<string>();
  const gone = new Set<string>();
  const events: PathResult["events"][number][] = [];
  const positions: number[] = [];
  for (const t of REPLAY.claimWeeks) {
    positions.push(k);
    const W = REPLAY.finalWeek - t;
    const premium = table.premium(k, W);
    const top = pools.get(t)?.byLast.find((c) => c.last > 0 && !mine.has(c.id) && !gone.has(c.id));
    let won = false;
    if (top !== undefined && top.f > 0 && top.f >= premium) {
      claims++;
      const win = rng.next() < (1 - demand(top.f, W)) ** (k - 1);
      events.push({ week: t, k, W, id: top.id, f: top.f, premium, won: win });
      if (win) {
        successes++;
        surplus += top.h;
        mine.add(top.id);
        won = true;
      } else gone.add(top.id);
    }
    if (won) k = REPLAY.teams;
    else {
      let d = 0;
      for (let i = 0; i < k - 1; i++) if (rng.next() < 0.25) d++;
      k -= d;
    }
  }
  return { claims, successes, surplus, events, positions };
}

/** One policy's aggregate over every start position and path. */
interface Row {
  readonly forecast: ForecastName;
  readonly season: number;
  readonly policy: PolicyName;
  readonly claims: number;
  readonly successes: number;
  readonly per_claim: number;
  readonly per_season: number;
  readonly below_premium: number;
}

/** The replay of one season: every policy on common random numbers (the A9a harness's streams). */
function replay(
  forecast: ForecastName,
  season: number,
  pools: ReadonlyMap<number, Pool>,
  tables: { readonly cold: PremiumTable; readonly fitted: PremiumTable },
  paths: number = REPLAY.paths,
): Row[] {
  return POLICY_NAMES.map((name) => {
    const table = name === "rule_cold" ? tables.cold : tables.fitted;
    let claims = 0;
    let successes = 0;
    let surplus = 0;
    let runs = 0;
    let below = 0;
    for (let startK = 1; startK <= REPLAY.teams; startK++)
      for (let p = 0; p < paths; p++) {
        const rng = seededRng(REPLAY.seed).fork(`${String(season)}/${String(startK)}/${String(p)}`);
        const r =
          name === "trending_strike"
            ? simulateTrendingStrike(startK, rng, table, pools)
            : simulateSeason(
                name === "rule_fitted" || name === "rule_cold" ? "rule" : name,
                startK,
                rng,
                table,
                pools,
              );
        claims += r.claims;
        successes += r.successes;
        surplus += r.surplus;
        runs += 1;
        if (name !== "trending" && name !== "hindsight")
          below += r.events.filter((e) => e.f < e.premium).length;
      }
    return {
      forecast,
      season,
      policy: name,
      claims: claims / runs,
      successes: successes / runs,
      per_claim: successes === 0 ? 0 : surplus / successes,
      per_season: surplus / runs,
      below_premium: below,
    };
  });
}

/** The drift evidence of one probe league's recorded seasons (acquisitions: an upper bound on c). */
async function driftOf(slot: LeagueSlot, season: number): Promise<DriftFit> {
  const w = makeWorld({ fetch: historyFixtureFetch(slot) });
  const standings = (await w.provider.getStandings({ ...w.ref, season })).value.teams;
  const rules = normalizeLeagueRules(mSettingsSchema.parse(historyBody(season, slot, "mSettings")));
  const regular = rules.playoffs.regular_season_matchups ?? 0;
  const periods = Array.from({ length: regular }, (_, i) => i + 1);
  return fitDrift(driftFromAcquisitions(standings, periods), "acquisitions");
}

const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);

/** One forecaster's replay: its pools, the league's feed and fits from them, the policy rows. */
interface ForecastRun {
  readonly pools: ReadonlyMap<ReplaySeason, ReadonlyMap<number, Pool>>;
  readonly feeds: ReadonlyMap<ReplaySeason, SurplusObservation[]>;
  readonly fits: ReadonlyMap<ReplaySeason, LeaguePremiumFit>;
  readonly pooled: LeaguePremiumFit;
  readonly rows: readonly Row[];
}

interface World {
  readonly seasons: ReadonlyMap<ReplaySeason, Season>;
  readonly runs: Readonly<Record<ForecastName, ForecastRun>>;
  /** What the v2 forecaster did over both seasons' candidate-weeks. */
  readonly v2_stats: V2ForecastStats;
  readonly drift: readonly { slot: LeagueSlot; season: number; fit: DriftFit; priority: boolean }[];
}

/** Pools, feeds, held-out fits and the replay of every season under one forecaster. */
function runForecast(
  name: ForecastName,
  seasons: ReadonlyMap<ReplaySeason, Season>,
  forecast: SurplusForecaster,
): ForecastRun {
  const pools = new Map<ReplaySeason, ReadonlyMap<number, Pool>>();
  const feeds = new Map<ReplaySeason, SurplusObservation[]>();
  for (const s of SEASONS) {
    const season = seasons.get(s);
    if (season === undefined) throw new Error(`no season ${String(s)}`);
    const p = poolsFor(season, forecast);
    pools.set(s, p);
    feeds.set(s, feedOf(p));
  }
  const fits = new Map<ReplaySeason, LeaguePremiumFit>(
    SEASONS.map((s) => [s, fitLeaguePremium({ teams: REPLAY.teams, surplus: feeds.get(s) ?? [] })]),
  );
  const pooled = fitLeaguePremium({
    teams: REPLAY.teams,
    surplus: SEASONS.flatMap((s) => feeds.get(s) ?? []),
  });
  const cold = solvePremiumTable({ teams: REPLAY.teams });
  const rows: Row[] = [];
  for (const s of SEASONS) {
    const other = s === 2024 ? 2025 : 2024;
    const fitted = fits.get(other)?.base ?? cold;
    rows.push(...replay(name, s, pools.get(s) ?? new Map(), { cold, fitted }));
  }
  return { pools, feeds, fits, pooled, rows };
}

let world: World;
beforeAll(async () => {
  const seasons = new Map<ReplaySeason, Season>();
  for (const s of SEASONS) seasons.set(s, loadReplaySeason(s));
  const v2Stats: V2ForecastStats = { v2: 0, bye_next: 0, fallback: 0 };
  const runs: Record<ForecastName, ForecastRun> = {
    v2: runForecast("v2", seasons, v2Forecaster(v2Stats)),
    trailing4: runForecast("trailing4", seasons, forecastSurplus),
  };
  const drift: World["drift"][number][] = [];
  for (const slot of ["league-a", "league-b", "league-c"] as const)
    for (const [season] of servedSeasons(slot)) {
      const rules = normalizeLeagueRules(
        mSettingsSchema.parse(historyBody(season, slot, "mSettings")),
      );
      drift.push({
        slot,
        season,
        fit: await driftOf(slot, season),
        priority: rules.waiver.uses_budget === false,
      });
    }
  world = { seasons, runs, v2_stats: v2Stats, drift };
}, 300_000);

/** The premium section: the league's feed, the fitted tables against the cold start, the drift. */
function premiumSection(w: World): string {
  const cold = solvePremiumTable({ teams: REPLAY.teams });
  const v2 = w.runs.v2;
  const lines: string[] = [
    "The replay league's own feed — one run per claim week (weeks 2–14), the best available player's forecast surplus as a per-week rate — under each forecaster, and the distribution fitted from it (the cold-start table as a Dirichlet prior worth 8 runs):",
    "",
    "| forecast | feed | runs | observed mean r | fitted mean r | cold-start mean r | p at r = 0 / 1 / 2.5 / 4.5 / 7 / 10 / 14 / 20 | clamped above 20 |",
    "|---|---|---:|---:|---:|---:|---|---:|",
  ];
  const fits: [string, string, LeaguePremiumFit][] = FORECASTS.flatMap((fn) => {
    const run = w.runs[fn];
    return [
      ...SEASONS.map((s): [string, string, LeaguePremiumFit] => [
        FORECAST_LABEL[fn],
        String(s),
        run.fits.get(s) ?? run.pooled,
      ]),
      [FORECAST_LABEL[fn], "2024 + 2025", run.pooled] as [string, string, LeaguePremiumFit],
    ];
  });
  for (const [forecast, label, f] of fits) {
    const p = [0, 1, 2.5, 4.5, 7, 10, 14, 20].map(
      (r) => f.surplus.rates.find((x) => x.r === r)?.p ?? 0,
    );
    lines.push(
      `| ${forecast} | ${label} | ${String(f.surplus.n)} | ${f2(f.surplus.observed_mean_r ?? 0)} | ${f2(f.surplus.mean_r)} | ${f2(f.surplus.prior_mean_r)} | ${p.map(f2).join(" / ")} | ${String(f.surplus.clamped)} |`,
    );
  }
  lines.push(
    "",
    "Π(k, W) in ROS points, fitted on the pooled v2-opportunity feed (drift c = 0.25, demand the cold-start curve) against the cold-start table (research 05 §1.2), `fitted / cold`:",
    "",
    `| k \\ W | ${[1, 3, 5, 7, 9, 11, 13, 15].map(String).join(" | ")} |`,
    `|---:|${[1, 3, 5, 7, 9, 11, 13, 15].map(() => "---:").join("|")}|`,
  );
  const cells = comparePremium(v2.pooled, { ks: [1, 2, 3, 5, 7, 10] });
  for (const k of [1, 2, 3, 5, 7, 10])
    lines.push(
      `| ${String(k)} | ${cells
        .filter((c) => c.k === k)
        .map((c) => `${f1(c.fitted)} / ${f1(c.cold)}`)
        .join(" | ")} |`,
    );
  const v = (t: PremiumTable, k: number) => t.value(k, 16);
  const pc = comparePremium(v2.pooled, { ks: [1, 5, 10], Ws: [9] });
  const t4 = w.runs.trailing4;
  const pcT = comparePremium(t4.pooled, { ks: [1, 10], Ws: [9] });
  lines.push(
    "",
    `Value of the order at the season's start, V(k, 16): fitted ${f1(v(v2.pooled.base, 1))} / ${f1(v(v2.pooled.base, 10))} for k = 1 / 10 against the cold start's ${f1(v(cold, 1))} / ${f1(v(cold, 10))}. How far the cold-start table was off (research 05 §1.6 eval 3): Π(1, 9) ×${f2(pc[0]?.ratio ?? 0)}, Π(5, 9) ×${f2(pc[1]?.ratio ?? 0)}, Π(10, 9) ×${f2(pc[2]?.ratio ?? 0)}. Season by season: Π(2, 13) fitted on 2024 = ${f1(v2.fits.get(2024)?.base.premium(2, 13) ?? 0)}, on 2025 = ${f1(v2.fits.get(2025)?.base.premium(2, 13) ?? 0)}, cold ${f1(cold.premium(2, 13))}. On the trailing-4 feed instead: Π(1, 9) ×${f2(pcT[0]?.ratio ?? 0)}, Π(10, 9) ×${f2(pcT[1]?.ratio ?? 0)}; Π(2, 13) fitted on 2024 = ${f1(t4.fits.get(2024)?.base.premium(2, 13) ?? 0)}, on 2025 = ${f1(t4.fits.get(2025)?.base.premium(2, 13) ?? 0)}.`,
    "",
    "Drift evidence from the probe leagues' recorded seasons — the share of team-weeks with an acquisition (`matchupAcquisitionTotals`, regular season). It bounds c from above only (free-agent adds count there too), so c stays the cold-start 0.25 unless the bound is lower:",
    "",
    "| league / season | waivers | team-weeks | with an acquisition | bound on c | c used | basis |",
    "|---|---|---:|---:|---:|---:|---|",
  );
  for (const d of w.drift)
    lines.push(
      `| ${d.slot}/${String(d.season)} | ${d.priority ? "priority (rolling)" : "FAAB"} | ${String(d.fit.team_weeks)} | ${String(d.fit.team_weeks_active)} | ${f2(d.fit.upper_bound ?? 0)} | ${f2(d.fit.c)} | ${d.fit.basis} |`,
    );
  return lines.join("\n");
}

/** Fitted rule vs trending per successful claim, per season, for one forecaster. */
function verdictsOf(rows: readonly Row[]): { s: ReplaySeason; ratio: number | null }[] {
  return SEASONS.map((s) => {
    const rule = rows.find((r) => r.season === s && r.policy === "rule_fitted");
    const trend = rows.find((r) => r.season === s && r.policy === "trending");
    const ratio =
      rule !== undefined && trend !== undefined && trend.per_claim > 0
        ? rule.per_claim / trend.per_claim - 1
        : null;
    return { s, ratio };
  });
}

const verdictText = (vs: readonly { s: ReplaySeason; ratio: number | null }[]): string =>
  vs
    .map(
      (v) =>
        `${String(v.s)} ${v.ratio === null ? "—" : `${v.ratio >= 0 ? "+" : "−"}${f1(Math.abs(v.ratio) * 100)} %`}`,
    )
    .join("; ");

const isMet = (vs: readonly { ratio: number | null }[]): boolean =>
  vs.every((v) => v.ratio !== null && v.ratio >= 0.1);

/** The waivers section: the replay under both forecasters and C5's verdict (v2's). */
function waiversSection(w: World): string {
  const st = w.v2_stats;
  const lines = [
    `Every start position 1–10 × ${String(REPLAY.paths)} seeded paths per season, common random numbers across policies within a forecaster; \`rule_fitted\` uses the premium fitted on the other season's feed of the same forecaster (held out), \`rule_cold\` the cold-start table. The forecast is the rule's \`s\` (and the rivals' demand reads it); \`trending\` and \`hindsight\` choose without it. v2-opportunity forecast ${String(st.v2)} candidate-weeks (${String(st.bye_next)} from the next game after a bye); ${String(st.fallback)} candidate-weeks the C1 excerpt does not cover kept the trailing-4 forecast:`,
    "",
    "| forecast | season | policy | claims / season | successful / season | surplus per successful claim | surplus / season |",
    "|---|---:|---|---:|---:|---:|---:|",
  ];
  for (const fn of FORECASTS)
    for (const r of w.runs[fn].rows)
      lines.push(
        `| ${FORECAST_LABEL[fn]} | ${String(r.season)} | ${r.policy} | ${f1(r.claims)} | ${f1(r.successes)} | ${f1(r.per_claim)} | ${f1(r.per_season)} |`,
      );
  const v2 = verdictsOf(w.runs.v2.rows);
  const t4 = verdictsOf(w.runs.trailing4.rows);
  lines.push(
    "",
    `**C5, surplus per successful claim, fitted rule vs trending (≥ +10 % in both seasons), on the Phase 3 forecast (v2-opportunity):** ${verdictText(v2)} → **${isMet(v2) ? "met" : "not met"}** (soft). On the A9a harness's trailing-4 forecast: ${verdictText(t4)} → ${isMet(t4) ? "met" : "not met"}.`,
  );
  return lines.join("\n");
}

describe("C5 — the fitted DP on the replay league (hard parts)", () => {
  it("each forecaster's season feed holds 13 runs and fits a league_fitted premium; the pooled fit too", () => {
    for (const fn of FORECASTS) {
      const run = world.runs[fn];
      for (const s of SEASONS) {
        expect(run.feeds.get(s)).toHaveLength(13);
        const f = run.fits.get(s);
        expect(f?.basis).toBe("league_fitted");
        expect(f?.surplus.n).toBe(13);
        expect(f?.drift.basis).toBe("prior");
      }
      expect(run.pooled.surplus.n).toBe(26);
      expect(run.pooled.basis).toBe("league_fitted");
    }
  });

  it("v2-opportunity forecasts the large majority of candidate-weeks; the rest keep the trailing forecast, counted", () => {
    const st = world.v2_stats;
    expect(st.v2).toBeGreaterThan(5 * st.fallback);
    expect(st.bye_next).toBeLessThan(st.v2);
    // every candidate-week of both seasons is counted exactly once
    let candidates = 0;
    for (const s of SEASONS)
      for (const t of REPLAY.claimWeeks) {
        const pool = world.runs.v2.pools.get(s)?.get(t);
        candidates += pool?.byForecast.length ?? 0;
      }
    expect(st.v2 + st.fallback).toBe(candidates);
  });

  it("the rule never claims below the premium it was given (cold or fitted); every policy runs", () => {
    for (const fn of FORECASTS) {
      const rows = world.runs[fn].rows;
      for (const r of rows) {
        expect(r.below_premium, `${fn} ${String(r.season)} ${r.policy}`).toBe(0);
        // the diagnostic trending_strike may legitimately never fire on v2's forecast (the trending
        // pick's v2 surplus rarely clears the fitted premium: 0 claims in 2025); every other policy,
        // and every policy on the trailing-4 forecast, claims
        if (fn === "trailing4" || r.policy !== "trending_strike")
          expect(r.claims, `${fn} ${String(r.season)} ${r.policy}`).toBeGreaterThan(0);
        expect(r.per_claim).toBeGreaterThanOrEqual(0);
      }
      // the hindsight ceiling realises at least as much per claim as any forecast policy
      for (const s of SEASONS) {
        const h = rows.find((r) => r.season === s && r.policy === "hindsight");
        for (const r of rows.filter((x) => x.season === s && x.policy !== "hindsight"))
          expect(h?.per_claim ?? 0).toBeGreaterThanOrEqual(r.per_claim);
      }
    }
  });

  it("the replay is deterministic (a second run on a few paths equals the first; a fresh v2 forecaster gives the same pools)", () => {
    const s = 2025;
    const run = world.runs.v2;
    const pools: ReadonlyMap<number, Pool> = run.pools.get(s) ?? new Map<number, Pool>();
    const tables = {
      cold: solvePremiumTable({ teams: REPLAY.teams }),
      fitted: run.fits.get(2024)?.base ?? solvePremiumTable({ teams: REPLAY.teams }),
    };
    expect(replay("v2", s, pools, tables, 5)).toEqual(replay("v2", s, pools, tables, 5));
    const season = world.seasons.get(s);
    expect(season).toBeDefined();
    if (season === undefined) return;
    const again = poolsFor(season, v2Forecaster({ v2: 0, bye_next: 0, fallback: 0 }));
    expect(again.get(5)?.byForecast.map((c) => [c.id, c.f])).toEqual(
      pools.get(5)?.byForecast.map((c) => [c.id, c.f]),
    );
  });

  it("the drift bound is read from every recorded league-season through the provider; the priority league's bound sits above the cold-start c", () => {
    expect(world.drift).toHaveLength(9);
    for (const d of world.drift) {
      expect(d.fit.evidence).toBe("acquisitions");
      expect(d.fit.team_weeks).toBeGreaterThanOrEqual(140);
      expect(d.fit.upper_bound).not.toBeNull();
    }
    const c = world.drift.filter((d) => d.slot === "league-c");
    expect(c.every((d) => d.priority)).toBe(true);
    for (const d of c) {
      expect(d.fit.basis).toBe("prior_within_acquisition_bound");
      expect(d.fit.c).toBe(0.25);
    }
  });

  it("E5's stated cold-start miss for Π is this measurement (changelog R6-3: WAIVER_FIT.coldStartMiss)", () => {
    const pc = comparePremium(world.runs.v2.pooled, { ks: [1, 10], Ws: [9] });
    const ratios = pc.map((c) => Math.round((c.ratio ?? 0) * 100) / 100);
    expect(WAIVER_FIT.coldStartMiss.premiumRatio).toEqual({
      min: Math.min(...ratios),
      max: Math.max(...ratios),
    });
  });

  it("the numbers are the ones in docs/evals/phase3-waivers-seeding.md", () => {
    writeOrCompare("premium", premiumSection(world));
    writeOrCompare("waivers", waiversSection(world));
  });
});
