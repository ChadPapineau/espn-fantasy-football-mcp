// project.test.ts — E1 v2-opportunity end to end (plan 07 E1: model_version "v2-opportunity",
// basis player_sim, weight_espn 1.0 — ESPN's mean is the point estimate, ADV OBJ-02 — the 25 % flag;
// plan 01 §1.1: cooperative batches and the 8 s CPU deadline → partial, never cached): the served
// mean equals ESPN's at weight 1 and the own mean at weight 0, the ensemble's distribution is the
// simulation anchored to it, a ruled-out player is a point mass at 0 whatever ESPN says, positions v2
// does not model are listed with a reason, the run is deterministic with the deadline off, the
// deadline stops sampling with every player at the same count, the work yields, and hostile inputs
// are refused or never read as numbers.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../../src/domain/clock.js";
import { AnalyticsError } from "../../../../src/domain/analytics/errors.js";
import {
  MODEL_VERSION_V2,
  V2_SIMS,
  WEIGHT_ESPN_V2,
} from "../../../../src/domain/analytics/projections-v2/constants.js";
import {
  V2_DEADLINE_SKIP,
  ensembleMean,
  pinDist,
  projectV2,
  v2SampleCount,
} from "../../../../src/domain/analytics/projections-v2/project.js";
import type { V2Request, V2Target } from "../../../../src/domain/analytics/projections-v2/types.js";
import { instantPacer, steppingPacer } from "../helpers.js";
import { qbGame, rbGame, settings, target, teamSeason, wrGame } from "./helpers/synthetic.js";

const weeks = [1, 2, 3, 4, 5, 6, 7, 8];
const wr = target(
  "WR",
  weeks.map((w) => wrGame(w)),
  { espn_mean: 14 },
);
const rb = target(
  "RB",
  weeks.map((w) => rbGame(w)),
  { espn_mean: 12 },
);
const qb = target(
  "QB",
  weeks.map((w) => qbGame(w)),
  { espn_mean: 19 },
);

const req = (over: Partial<V2Request> = {}): V2Request => ({
  targets: [wr, rb, qb],
  season: 2025,
  week: 9,
  settings: settings(),
  team_games: teamSeason(8),
  markets: { AAA: { implied: 23, spread: 2, total: 44 } },
  weather: { AAA: { roof: "outdoors", temp_f: 55, wind_mph: 6, precip_prob: null } },
  opponents: { AAA: "BBB" },
  matchup: null,
  clock: fixedClock("2025-11-01T12:00:00Z"),
  rng: seededRng(42),
  pacer: instantPacer,
  deadline_ms: null,
  n_sims: 1000,
  ...over,
});

describe("projectV2", () => {
  it("serves ESPN's mean at the shipped weight with a player_sim distribution", async () => {
    expect(WEIGHT_ESPN_V2).toBe(1);
    const out = await projectV2(req());
    expect(out.data.model_version).toBe(MODEL_VERSION_V2);
    expect(out.data.completed_samples).toBe(1000);
    expect(out.partial).toBe(false);
    expect(out.data.projections).toHaveLength(3);
    for (const p of out.data.projections) {
      const w = p.weeks[0];
      expect(w?.points.basis).toBe("player_sim");
      expect(w?.inputs.weight_espn).toBe(1);
      expect(w?.points.mean).toBe(w?.inputs.espn);
      expect(w?.points.p10).toBeLessThanOrEqual(w?.points.p50 ?? 0);
      expect(w?.points.p50).toBeLessThanOrEqual(w?.points.p90 ?? 0);
      expect(p.drivers.find((d) => d.name === "espn_projection")?.contribution).toBe(
        w?.inputs.espn,
      );
      expect(p.ros_total).toBeNull();
    }
    const d = out.details.find((x) => x.player_id === wr.player_id);
    expect(d?.own?.basis).toBe("player_sim");
    expect(d?.expectation?.td_basis).toBe("ffopportunity");
    expect(d?.turnover?.expected_points).toBeLessThanOrEqual(0);
    expect(d?.matchup).toMatchObject({ opponent: "BBB", mult: 1, afpa: null, espn_rating: null });
    expect(out.data.projections[0]?.weeks[0]?.opponent).toBe("BBB");
    expect(out.data.projections[0]?.weeks[0]?.implied_total).toBe(23);
  });

  it("weight 0 serves the model's own mean; the disagreement flag compares the two", async () => {
    const out = await projectV2(req({ weight_espn: 0, targets: [{ ...wr, espn_mean: 100 }] }));
    const w = out.data.projections[0]?.weeks[0];
    expect(w?.inputs.weight_espn).toBe(0);
    expect(w?.points.mean).toBe(w?.inputs.own);
    expect(w?.disagreement.flagged).toBe(true);
    expect(w?.disagreement.pct).toBeGreaterThan(0.25);
  });

  it("a mixture weight blends the means", async () => {
    const out = await projectV2(req({ weight_espn: 0.5, targets: [wr] }));
    const w = out.data.projections[0]?.weeks[0];
    expect(w?.points.mean).toBeCloseTo(0.5 * 14 + 0.5 * (w?.inputs.own ?? 0), 3);
  });

  it("no ESPN mean: the own mean, said in assumptions", async () => {
    const out = await projectV2(req({ targets: [{ ...wr, espn_mean: null }] }));
    const p = out.data.projections[0];
    expect(p?.weeks[0]?.inputs.weight_espn).toBe(0);
    expect(p?.weeks[0]?.points.mean).toBe(p?.weeks[0]?.inputs.own);
    expect(p?.assumptions.some((a) => a.text.startsWith("no ESPN projection"))).toBe(true);
  });

  it("an ESPN mean the simulation cannot carry falls back to the positional CV, said", async () => {
    const out = await projectV2(req({ targets: [{ ...wr, espn_mean: 200 }] }));
    const p = out.data.projections[0];
    expect(p?.weeks[0]?.points.basis).toBe("position_cv");
    expect(p?.weeks[0]?.points.mean).toBe(200);
    expect(p?.assumptions.some((a) => a.text.includes("positional CV"))).toBe(true);
  });

  it("a ruled-out player is a point mass at 0 whatever ESPN says", async () => {
    const out = await projectV2(
      req({ targets: [{ ...wr, availability: { designation: "Out", practice: null } }] }),
    );
    const w = out.data.projections[0]?.weeks[0];
    expect(w?.points).toMatchObject({ mean: 0, p90: 0, p_zero: 1 });
    expect(w?.p_active).toBe(0);
    // the label reads as v1's: the shipped weight on ESPN's mean, whatever the designation
    expect(w?.inputs.weight_espn).toBe(1);
    expect(out.data.projections[0]?.assumptions.some((a) => a.text.includes("rules him out"))).toBe(
      true,
    );
  });

  it("a Questionable player carries a zero mass and the trend basis", async () => {
    const out = await projectV2(
      req({ targets: [{ ...wr, availability: { designation: "Questionable", practice: "DNP" } }] }),
    );
    expect(out.details[0]?.p_active).toBeLessThan(1);
    expect(out.details[0]?.p_active_basis).toBe("trend_model");
    expect(out.data.projections[0]?.weeks[0]?.points.p_zero).toBeGreaterThan(0.2);
  });

  it("lists what v2 does not model, with the reason", async () => {
    const k = target("WR", [], { position: "K", position_id: 5, player_id: 1 });
    const noTeam = target(
      "WR",
      weeks.map((w) => wrGame(w)),
      { team: null, player_id: 2 },
    );
    const rookie = target("RB", [], { player_id: 3 });
    const out = await projectV2(req({ targets: [k, noTeam, rookie, wr] }));
    expect(out.data.projections.map((p) => p.player_id)).toEqual([wr.player_id]);
    expect(out.details.map((d) => d.skipped)).toEqual([
      "position_not_modelled",
      "no_team",
      "no_history",
      null,
    ]);
    expect(out.warnings).toContain("3 players not modelled by v2");
  });

  it("only skipped targets: nothing is sampled and nothing is partial", async () => {
    const out = await projectV2(req({ targets: [target("RB", [])], deadline_ms: 0 }));
    expect(out.data.projections).toEqual([]);
    expect(out.partial).toBe(false);
  });

  it("is deterministic with the deadline off (same seed, same answer)", async () => {
    const a = await projectV2(req());
    const b = await projectV2(req());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = await projectV2(req({ rng: seededRng(43) }));
    expect(JSON.stringify(c.details[0]?.own)).not.toBe(JSON.stringify(a.details[0]?.own));
  });

  it("the CPU deadline stops sampling: partial, every player at the same count, said", async () => {
    const out = await projectV2(req({ pacer: steppingPacer(5), deadline_ms: 20 }));
    expect(out.partial).toBe(true);
    expect(out.data.completed_samples).toBeLessThan(1000);
    expect(out.warnings.some((w) => w.startsWith("partial:"))).toBe(true);
  });

  it("one budget through set-up, sampling and scoring: a target the deadline reached first is skipped (E1 keeps v1), said", async () => {
    // Stage C finding analytics-cpu-deadline-per-run (round 2): the set-up and the scoring ran with
    // no deadline, so v2 passed 8 s on a slow CPU however early its sampler stopped
    const many: V2Target[] = Array.from({ length: 12 }, (_, i) => ({ ...wr, player_id: i + 1 }));
    const out = await projectV2(req({ targets: many, pacer: steppingPacer(1), deadline_ms: 6 }));
    expect(out.partial).toBe(true);
    const late = out.details.filter((d) => d.skipped === V2_DEADLINE_SKIP);
    expect(late.length).toBeGreaterThan(0);
    expect(out.data.projections.length + late.length).toBe(12);
    expect(out.details).toHaveLength(12);
    expect(
      out.warnings.filter((w) =>
        /^partial: \d+ of 12 players modelled by v2 before the CPU deadline \(v1-ensemble serves the rest\)$/.test(
          w,
        ),
      ),
    ).toHaveLength(1);
    // a deadline skip is not "not modelled"
    expect(out.warnings.some((w) => w.endsWith("players not modelled by v2"))).toBe(false);
    // off: every one modelled, nothing said
    const off = await projectV2(req({ targets: many }));
    expect(off.partial).toBe(false);
    expect(off.data.projections).toHaveLength(12);
    expect(off.warnings.filter((w) => w.startsWith("partial:"))).toEqual([]);
  });

  it("yields to the event loop between batches", async () => {
    const pacer = steppingPacer(3);
    await projectV2(req({ pacer }));
    expect(pacer.yields).toBeGreaterThan(3);
  });

  it("shares n_sims down over a large call and says so", async () => {
    expect(v2SampleCount(undefined, 1)).toBe(V2_SIMS.default);
    expect(v2SampleCount(20000, 1)).toBe(V2_SIMS.max);
    expect(v2SampleCount(3000, 128)).toBe(Math.floor(V2_SIMS.maxTotalLines / 128));
    expect(v2SampleCount(3000, 100000)).toBe(V2_SIMS.min);
    const many: V2Target[] = Array.from({ length: 64 }, (_, i) => ({ ...wr, player_id: i + 1 }));
    const out = await projectV2(req({ targets: many, n_sims: 3000 }));
    expect(out.warnings.some((w) => w.startsWith("n_sims shared down"))).toBe(true);
    expect(out.data.completed_samples).toBeLessThan(3000);
  });

  it("include_stat_line adds the expected line", async () => {
    const out = await projectV2(req({ targets: [wr], include_stat_line: true }));
    expect(out.data.projections[0]?.stat_line_expectation?.targets).toBeGreaterThan(0);
    expect(out.details[0]?.stat_line_expectation?.targets).toBeGreaterThan(0);
  });

  it("refuses without S and on out-of-bound requests", async () => {
    await expect(projectV2(req({ settings: null }))).rejects.toMatchObject({ code: "no_settings" });
    await expect(projectV2(req({ targets: [] }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ week: 0 }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ week: 2.5 }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ season: 1800 }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ n_sims: 10 }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ n_sims: 1e9 }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ weight_espn: 1.5 }))).rejects.toBeInstanceOf(AnalyticsError);
    await expect(projectV2(req({ weight_espn: Number.NaN }))).rejects.toBeInstanceOf(
      AnalyticsError,
    );
    const tooMany = Array.from({ length: 65 }, () => wr);
    await expect(projectV2(req({ targets: tooMany }))).rejects.toBeInstanceOf(AnalyticsError);
  });

  it("hostile numbers in the inputs never become projections", async () => {
    const bad = target(
      "WR",
      [
        ...weeks.map((w) => wrGame(w)),
        wrGame(7, { targets: Number.POSITIVE_INFINITY }, 2024),
        wrGame(8, { rec_yd: Number.NaN }, 2024),
      ],
      { espn_mean: Number.NaN },
    );
    const out = await projectV2(
      req({
        targets: [bad],
        markets: { AAA: { implied: Number.NaN, spread: Number.POSITIVE_INFINITY, total: null } },
      }),
    );
    const p = out.data.projections[0];
    expect(p?.weeks[0]?.inputs.espn).toBeNull();
    expect(Number.isFinite(p?.weeks[0]?.points.mean)).toBe(true);
    expect(p?.assumptions.some((a) => a.text.startsWith("no market line"))).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/NaN|Infinity/);
  });
});

describe("ensembleMean / pinDist", () => {
  it("blends only with an ESPN mean, clamping the weight", () => {
    expect(ensembleMean(null, 8, 1)).toEqual({ mean: 8, weight: 0 });
    expect(ensembleMean(12, 8, 1)).toEqual({ mean: 12, weight: 1 });
    expect(ensembleMean(12, 8, 2)).toEqual({ mean: 12, weight: 1 });
    expect(ensembleMean(12, 8, -1)).toEqual({ mean: 8, weight: 0 });
    expect(ensembleMean(Number.NaN, 8, 1)).toEqual({ mean: 8, weight: 0 });
  });

  it("property: pinning scales the quantiles exactly and keeps the zero mass", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 30, noNaN: true }),
        fc.double({ min: 0.1, max: 60, noNaN: true }),
        (m, t) => {
          const d = {
            mean: m,
            p10: m * 0.3,
            p25: m * 0.6,
            p50: m * 0.9,
            p75: m * 1.3,
            p90: m * 1.8,
            p_zero: 0.1,
            basis: "player_sim" as const,
          };
          const p = pinDist(d, t);
          expect(p.mean).toBeCloseTo(t, 3);
          expect(p.p90).toBeCloseTo(1.8 * t, 3);
          expect(p.p10).toBeCloseTo(0.3 * t, 3);
          expect(p.p_zero).toBe(0.1);
        },
      ),
    );
    const zero = {
      mean: 0,
      p10: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p_zero: 1,
      basis: "player_sim" as const,
    };
    expect(pinDist(zero, 5)).toBe(zero);
  });
});
