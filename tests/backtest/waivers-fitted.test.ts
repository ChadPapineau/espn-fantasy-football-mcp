// waivers-fitted.test.ts — plan 10 C5 (soft, with numbers): the waiver DP re-solved from a league's own
// surplus distribution (research 05 §1.6 eval 3, §8.4 #4) and replayed against "claim the top
// trending player" over the two committed nflverse seasons (tests/backtest/data/stats_player_week,
// 2024 and 2025 — the B7 excerpt, re-hashed on every read). The league is research 05 §1.6's
// replay league (10 teams, the reference scoring, availability by prior per-game rank) and the
// replay machinery is the A9a harness's (tests/backtest/helpers/waivers.ts, used as shipped). Its
// own feed: one run per claim week, the best available player's forecast surplus as a per-week
// rate (r = s / (W + 1)). Protocol: each season is replayed with the premium fitted on the OTHER
// season (held out — for 2025 that is the previous season, the production protocol; for 2024 it
// is the later one, said). The drift evidence comes from the probe leagues' real histories
// (mTeam's per-period acquisition totals through the provider in fixture mode): it only bounds c.
// Hard here: the fit is league_fitted, the rule never claims below the premium it was given, the
// replay is deterministic, the drift bound is read through the provider. The numbers are written
// to docs/evals/phase3-waivers-seeding.md (UPDATE_EVALS=1; equality asserted otherwise).
import { beforeAll, describe, expect, it } from "vitest";
import {
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
import {
  REPLAY,
  demand,
  poolsFor,
  referenceSettings,
  rowPoints,
  seasonFromPoints,
  simulateSeason,
  type PathResult,
  type Pool,
  type Season,
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

interface World {
  readonly seasons: ReadonlyMap<ReplaySeason, Season>;
  readonly pools: ReadonlyMap<ReplaySeason, ReadonlyMap<number, Pool>>;
  readonly feeds: ReadonlyMap<ReplaySeason, SurplusObservation[]>;
  readonly fits: ReadonlyMap<ReplaySeason, LeaguePremiumFit>;
  readonly pooled: LeaguePremiumFit;
  readonly rows: readonly Row[];
  readonly drift: readonly { slot: LeagueSlot; season: number; fit: DriftFit; priority: boolean }[];
}

let world: World;
beforeAll(async () => {
  const seasons = new Map<ReplaySeason, Season>();
  const pools = new Map<ReplaySeason, ReadonlyMap<number, Pool>>();
  const feeds = new Map<ReplaySeason, SurplusObservation[]>();
  for (const s of SEASONS) {
    const season = loadReplaySeason(s);
    seasons.set(s, season);
    const p = poolsFor(season);
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
    rows.push(...replay(s, pools.get(s) ?? new Map(), { cold, fitted }));
  }
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
  world = { seasons, pools, feeds, fits, pooled, rows, drift };
}, 120_000);

/** The premium section: the league's feed, the fitted tables against the cold start, the drift. */
function premiumSection(w: World): string {
  const cold = solvePremiumTable({ teams: REPLAY.teams });
  const lines: string[] = [
    "The replay league's own feed — one run per claim week (weeks 2–14), the best available player's forecast surplus as a per-week rate — and the distribution fitted from it (the cold-start table as a Dirichlet prior worth 8 runs):",
    "",
    "| feed | runs | observed mean r | fitted mean r | cold-start mean r | p at r = 0 / 1 / 2.5 / 4.5 / 7 / 10 / 14 / 20 | clamped above 20 |",
    "|---|---:|---:|---:|---:|---|---:|",
  ];
  const fits: [string, LeaguePremiumFit][] = [
    ...SEASONS.map((s): [string, LeaguePremiumFit] => [String(s), w.fits.get(s) ?? w.pooled]),
    ["2024 + 2025", w.pooled],
  ];
  for (const [label, f] of fits) {
    const p = [0, 1, 2.5, 4.5, 7, 10, 14, 20].map(
      (r) => f.surplus.rates.find((x) => x.r === r)?.p ?? 0,
    );
    lines.push(
      `| ${label} | ${String(f.surplus.n)} | ${f2(f.surplus.observed_mean_r ?? 0)} | ${f2(f.surplus.mean_r)} | ${f2(f.surplus.prior_mean_r)} | ${p.map(f2).join(" / ")} | ${String(f.surplus.clamped)} |`,
    );
  }
  lines.push(
    "",
    "Π(k, W) in ROS points, fitted on the pooled feed (drift c = 0.25, demand the cold-start curve) against the cold-start table (research 05 §1.2), `fitted / cold`:",
    "",
    `| k \\ W | ${[1, 3, 5, 7, 9, 11, 13, 15].map(String).join(" | ")} |`,
    `|---:|${[1, 3, 5, 7, 9, 11, 13, 15].map(() => "---:").join("|")}|`,
  );
  const cells = comparePremium(w.pooled, { ks: [1, 2, 3, 5, 7, 10] });
  for (const k of [1, 2, 3, 5, 7, 10])
    lines.push(
      `| ${String(k)} | ${cells
        .filter((c) => c.k === k)
        .map((c) => `${f1(c.fitted)} / ${f1(c.cold)}`)
        .join(" | ")} |`,
    );
  const v = (t: PremiumTable, k: number) => t.value(k, 16);
  const pc = comparePremium(w.pooled, { ks: [1, 5, 10], Ws: [9] });
  lines.push(
    "",
    `Value of the order at the season's start, V(k, 16): fitted ${f1(v(w.pooled.base, 1))} / ${f1(v(w.pooled.base, 10))} for k = 1 / 10 against the cold start's ${f1(v(cold, 1))} / ${f1(v(cold, 10))}. How far the cold-start table was off (research 05 §1.6 eval 3): Π(1, 9) ×${f2(pc[0]?.ratio ?? 0)}, Π(5, 9) ×${f2(pc[1]?.ratio ?? 0)}, Π(10, 9) ×${f2(pc[2]?.ratio ?? 0)}. Season by season: Π(2, 13) fitted on 2024 = ${f1(w.fits.get(2024)?.base.premium(2, 13) ?? 0)}, on 2025 = ${f1(w.fits.get(2025)?.base.premium(2, 13) ?? 0)}, cold ${f1(cold.premium(2, 13))}.`,
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

/** The waivers section: the replay and C5's verdict. */
function waiversSection(w: World): string {
  const lines = [
    `Every start position 1–10 × ${String(REPLAY.paths)} seeded paths per season, common random numbers across policies; \`rule_fitted\` uses the premium fitted on the other season's feed (held out), \`rule_cold\` the cold-start table:`,
    "",
    "| season | policy | claims / season | successful / season | surplus per successful claim | surplus / season |",
    "|---:|---|---:|---:|---:|---:|",
  ];
  for (const r of w.rows)
    lines.push(
      `| ${String(r.season)} | ${r.policy} | ${f1(r.claims)} | ${f1(r.successes)} | ${f1(r.per_claim)} | ${f1(r.per_season)} |`,
    );
  const verdicts = SEASONS.map((s) => {
    const rule = w.rows.find((r) => r.season === s && r.policy === "rule_fitted");
    const trend = w.rows.find((r) => r.season === s && r.policy === "trending");
    const ratio =
      rule !== undefined && trend !== undefined && trend.per_claim > 0
        ? rule.per_claim / trend.per_claim - 1
        : null;
    return { s, ratio };
  });
  const met = verdicts.every((v) => v.ratio !== null && v.ratio >= 0.1);
  lines.push(
    "",
    `**C5, surplus per successful claim, fitted rule vs trending (≥ +10 % in both seasons):** ${verdicts
      .map(
        (v) =>
          `${String(v.s)} ${v.ratio === null ? "—" : `${v.ratio >= 0 ? "+" : ""}${f1(v.ratio * 100)} %`}`,
      )
      .join("; ")} → **${met ? "met" : "not met"}** (soft).`,
  );
  return lines.join("\n");
}

describe("C5 — the fitted DP on the replay league (hard parts)", () => {
  it("each season's feed holds 13 runs and fits a league_fitted premium; the pooled fit too", () => {
    for (const s of SEASONS) {
      expect(world.feeds.get(s)).toHaveLength(13);
      const f = world.fits.get(s);
      expect(f?.basis).toBe("league_fitted");
      expect(f?.surplus.n).toBe(13);
      expect(f?.drift.basis).toBe("prior");
    }
    expect(world.pooled.surplus.n).toBe(26);
    expect(world.pooled.basis).toBe("league_fitted");
  });

  it("the rule never claims below the premium it was given (cold or fitted); every policy runs", () => {
    for (const r of world.rows) {
      expect(r.below_premium, `${String(r.season)} ${r.policy}`).toBe(0);
      expect(r.claims).toBeGreaterThan(0);
      expect(r.per_claim).toBeGreaterThanOrEqual(0);
    }
    // the hindsight ceiling realises at least as much per claim as any forecast policy
    for (const s of SEASONS) {
      const h = world.rows.find((r) => r.season === s && r.policy === "hindsight");
      for (const r of world.rows.filter((x) => x.season === s && x.policy !== "hindsight"))
        expect(h?.per_claim ?? 0).toBeGreaterThanOrEqual(r.per_claim);
    }
  });

  it("the replay is deterministic (a second run on a few paths equals the first)", () => {
    const s = 2025;
    const pools = world.pools.get(s) ?? new Map();
    const tables = {
      cold: solvePremiumTable({ teams: REPLAY.teams }),
      fitted: world.fits.get(2024)?.base ?? solvePremiumTable({ teams: REPLAY.teams }),
    };
    expect(replay(s, pools, tables, 5)).toEqual(replay(s, pools, tables, 5));
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

  it("the numbers are the ones in docs/evals/phase3-waivers-seeding.md", () => {
    writeOrCompare("premium", premiumSection(world));
    writeOrCompare("waivers", waiversSection(world));
  });
});
