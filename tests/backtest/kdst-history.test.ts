// kdst-history.test.ts — plan 10 §3.3 C7 "K/D-ST: beats 'last week's score' clearly and matches
// 'lowest implied total'; the share of D/ST variance explained by rare_c reported", on history:
// every regular-season team-week of 2023–2025 (weeks 2–17 evaluated; plan 10 D9's three backtest
// seasons) under the reference league's scoring and each probe league's recorded scoring (research
// 05 §8.4 #8; sib research 05 §8 Evaluation "weekly rank correlation and MAE … the product must
// beat (a) clearly and at least match (b)"). The data: tests/backtest/data/kdst_history (nflverse,
// re-hashed on read). Definitions fixed before the numbers were read — "clearly": pooled over the
// three seasons the paired weekly ρ gain over last week's score is ≥ 0.05 with its seeded bootstrap
// 95 % interval above 0, the gain is positive in every season, and the model's MAE is below last
// week's in every season; "matches": the model orders the candidates exactly as the implied total
// does, every week (the model's only matchup input is the implied total — a fact, recorded). The
// numbers are docs/evals/phase3-kdst-news.md's (UPDATE_EVALS=1 rewrites them; else asserted equal).
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DST_FF_RATE,
  DST_RARE_RATES,
  dstExpectation,
  kickerExpectation,
} from "../../src/domain/analytics/kdst.js";
import { KDST } from "../../src/domain/analytics/constants.js";
import { normalizeSettings } from "../../src/domain/scoring/settings.js";
import {
  c7Section,
  DST_EVENT_CANONICALS,
  espnCrossCheck,
  espnSection,
  evalDocSection,
  KDST_HISTORY_FINAL_WEEK,
  KDST_HISTORY_SEASONS,
  kdstHistoryManifest,
  kickRows,
  kickSection,
  loadKdstHistory,
  observedDstRates,
  rareSection,
  rareShare,
  ratesSection,
  replayPosition,
  scorings,
  summarise,
  writeEvalDocSection,
  type EspnCheck,
  type KdstHistory,
  type RareShare,
  type Summary,
  type WeekEval,
} from "./helpers/kdst-history.js";

let h: KdstHistory;
let weeks: Map<string, WeekEval[]>;
let summaries: Summary[];
let rare: RareShare[];
let espn: EspnCheck[];
let rateRows: { label: string; rates: Readonly<Record<string, number>> }[];
const MODEL_RATES: Readonly<Record<string, number>> = {
  ...DST_RARE_RATES,
  dst_sack: KDST.rates.dst_sack,
  dst_int: KDST.rates.dst_int,
  dst_fr: KDST.rates.dst_fr,
  dst_ff: DST_FF_RATE,
};

beforeAll(() => {
  h = loadKdstHistory();
  weeks = new Map();
  summaries = [];
  rare = [];
  for (const sc of scorings()) {
    for (const pos of ["D/ST", "K"] as const) {
      const w = replayPosition(h, sc.settings, pos);
      weeks.set(`${sc.name}|${pos}`, w);
      for (const s of [...KDST_HISTORY_SEASONS, 0]) summaries.push(summarise(sc.name, w, s));
    }
    rare.push(rareShare(h, sc.settings, sc.name));
  }
  espn = espnCrossCheck(h);
  rateRows = [
    ...KDST_HISTORY_SEASONS.map((s) => ({ label: String(s), rates: observedDstRates(h, [s]) })),
    { label: "pooled", rates: observedDstRates(h) },
  ];
  if (process.env.UPDATE_EVALS === "1") {
    writeEvalDocSection("c7", c7Section(summaries));
    writeEvalDocSection("c7-rare", rareSection(rare));
    writeEvalDocSection("c7-rates", ratesSection(rateRows, MODEL_RATES));
    writeEvalDocSection("c7-espn", espnSection(espn));
    writeEvalDocSection("c7-kick", kickSection(kickRows(h)));
  }
}, 120_000);

describe("the history (tests/backtest/data/kdst_history)", () => {
  it("holds every regular-season game of weeks 1–17 of three seasons, each with a line", () => {
    expect(kdstHistoryManifest().seasons).toEqual([2023, 2024, 2025]);
    for (const season of KDST_HISTORY_SEASONS) {
      const games = h.games.filter((g) => g.season === season);
      expect(games, String(season)).toHaveLength(256);
      for (const g of games) {
        expect(typeof g.spread_line).toBe("number");
        expect(typeof g.total_line).toBe("number");
        expect(typeof g.home_score).toBe("number");
      }
      const weeksSeen = new Set(games.map((g) => g.week));
      expect(weeksSeen.size).toBe(KDST_HISTORY_FINAL_WEEK);
    }
  });

  it("has one D/ST week per team-game with its points-allowed facts and opponent yardage", () => {
    expect(h.dst).toHaveLength(2 * h.games.length);
    for (const r of h.dst) {
      expect(typeof r.opp_score).toBe("number");
      expect(typeof r.opp_passing_yards).toBe("number");
      expect(typeof r.opp_rushing_yards).toBe("number");
      const st = (r.st_kr_td as number) + (r.st_pr_td as number) + (r.st_blk_td as number);
      expect(st).toBeLessThanOrEqual(r.special_teams_tds as number);
    }
    // every special-teams TD the stats credit is split by pbp, except the two the manifest notes
    expect(kdstHistoryManifest().notes).toHaveLength(2);
  });

  it("has at most one kicker row per team-week (two team-weeks kicked nothing: 0 points)", () => {
    const seen = new Set(h.k.map((r) => `${String(r.season)}|${String(r.week)}|${String(r.team)}`));
    expect(seen.size).toBe(h.k.length);
    expect(h.dst.length - seen.size).toBe(2);
  });
});

describe("C7 (hard) — matches the implied-total baseline", () => {
  it("orders the candidates exactly as the implied total does, every evaluated week", () => {
    for (const [k, w] of weeks) {
      expect(w.length, k).toBe(3 * (KDST_HISTORY_FINAL_WEEK - 1));
      for (const r of w) {
        expect(r.same_order_as_implied, `${k} ${String(r.season)} wk ${String(r.week)}`).toBe(true);
        expect(r.rho_model).toBe(r.rho_implied);
      }
    }
  });

  it("is monotone in the implied totals under every scoring (property)", () => {
    const all = scorings();
    fc.assert(
      fc.property(
        fc.constantFrom(...all),
        fc.double({ min: 8, max: 40, noNaN: true }),
        fc.double({ min: 0.25, max: 10, noNaN: true }),
        (sc, x, d) => {
          expect(dstExpectation(sc.settings, x + d).e).toBeLessThanOrEqual(
            dstExpectation(sc.settings, x).e,
          );
          expect(kickerExpectation(sc.settings, x + d).e).toBeGreaterThanOrEqual(
            kickerExpectation(sc.settings, x).e,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("C7 (hard) — beats last week's score clearly", () => {
  it("pooled ρ gain ≥ 0.05 with its 95 % interval above 0, under every scoring, K and D/ST", () => {
    for (const s of summaries.filter((x) => x.season === 0)) {
      const label = `${s.scoring} ${s.position}`;
      expect(s.rho_gain.mean, label).toBeGreaterThanOrEqual(0.05);
      expect(s.rho_gain.lo, label).toBeGreaterThan(0);
    }
  });

  it("the gain is positive and the MAE lower in every season (not one season carrying the rest)", () => {
    for (const s of summaries.filter((x) => x.season !== 0)) {
      const label = `${s.scoring} ${s.position} ${String(s.season)}`;
      expect(s.rho_gain.mean, label).toBeGreaterThan(0);
      expect(s.mae_model, label).toBeLessThan(s.mae_last);
    }
  });
});

describe("C7 (reported) — the rare-event share of D/ST variance; the constants", () => {
  it("the rare-event constant equals the history's mean rare points under every scoring", () => {
    for (const r of rare) {
      expect(Math.abs(r.rare_c - r.mean_rare), r.scoring).toBeLessThan(0.005);
      expect(r.share_var).toBeGreaterThan(0);
      expect(r.share_var).toBeLessThan(1);
      expect(r.team_weeks).toBe(h.dst.length);
    }
  });

  it("DST_RARE_RATES and DST_FF_RATE are the history's pooled per-game rates (4 dp)", () => {
    const pooled = observedDstRates(h);
    const dp4 = (x: number | undefined): number => Math.round((x ?? Number.NaN) * 1e4) / 1e4;
    for (const [c, v] of Object.entries(DST_RARE_RATES)) expect(v, c).toBe(dp4(pooled[c]));
    expect(DST_FF_RATE).toBe(dp4(pooled.dst_ff));
    for (const c of DST_EVENT_CANONICALS) expect(Number.isFinite(pooled[c])).toBe(true);
  });

  it("rare_c scores exactly the TD members the league scores (none scores 94; all score 103/104)", () => {
    const only = (items: { statId: number; points: number }[]) =>
      normalizeSettings({
        scoringItems: items.map((i) => ({ ...i, pointsOverrides: { "16": i.points } })),
      });
    const r = DST_RARE_RATES;
    const at = (items: { statId: number; points: number }[]): number =>
      dstExpectation(only(items), 20).rare_c ?? Number.NaN;
    expect(at([{ statId: 103, points: 6 }])).toBeCloseTo(6 * (r.dst_int_td ?? 0), 3);
    expect(at([{ statId: 104, points: 6 }])).toBeCloseTo(6 * (r.dst_fr_td ?? 0), 3);
    expect(at([{ statId: 94, points: 6 }])).toBeCloseTo(6 * (r.dst_td ?? 0), 3);
    expect(at([{ statId: 101, points: 6 }])).toBeCloseTo(6 * (r.kr_td ?? 0), 3);
    expect(at([{ statId: 102, points: 6 }])).toBeCloseTo(6 * (r.pr_td ?? 0), 3);
    expect(at([{ statId: 93, points: 6 }])).toBeCloseTo(6 * (r.dst_blk_td ?? 0), 3);
    expect(at([{ statId: 105, points: 6 }])).toBeCloseTo(6 * (r.ret_td_total ?? 0), 3);
    expect(at([{ statId: 98, points: 2 }])).toBeCloseTo(2 * (r.dst_safety ?? 0), 3);
    expect(at([{ statId: 97, points: 2 }])).toBeCloseTo(2 * (r.dst_blk ?? 0), 3);
    expect(at([{ statId: 95, points: 2 }])).toBe(0);
    // forced fumbles (106) ride with the takeaways, scaled like them
    const ff = dstExpectation(only([{ statId: 106, points: 1 }]), KDST.leagueImplied);
    expect(ff.takeaways_e).toBeCloseTo(DST_FF_RATE, 3);
    expect(ff.rare_c).toBe(0);
  });

  it("(reported) docs/evals/phase3-kdst-news.md holds this replay's numbers", () => {
    expect(evalDocSection("c7")).toBe(c7Section(summaries));
    expect(evalDocSection("c7-rare")).toBe(rareSection(rare));
    expect(evalDocSection("c7-rates")).toBe(ratesSection(rateRows, MODEL_RATES));
    expect(evalDocSection("c7-espn")).toBe(espnSection(espn));
    expect(evalDocSection("c7-kick")).toBe(kickSection(kickRows(h)));
  });
});

describe("the realised points against ESPN's own (league-b box scores, 2024–2025)", () => {
  it("(hard) the D/ST truth equals ESPN's appliedTotal on ≥ 95 % of rostered D/ST weeks, each season", () => {
    for (const r of espn.filter((x) => x.position === "D/ST")) {
      expect(r.entries, String(r.season)).toBeGreaterThanOrEqual(150);
      expect(r.matched / r.entries, String(r.season)).toBeGreaterThanOrEqual(0.95);
      expect(r.team_unknown).toBe(0);
    }
  });

  it("(reported) kickers: mapped by the recording's proTeamId, so a roster move reads as a miss", () => {
    for (const r of espn.filter((x) => x.position === "K")) {
      expect(r.entries).toBeGreaterThan(0);
      expect(r.matched / r.entries).toBeGreaterThan(0.9);
    }
  });
});
