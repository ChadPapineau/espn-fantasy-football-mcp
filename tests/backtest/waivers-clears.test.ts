// waivers-clears.test.ts — plan 10 C5's second half (soft, with numbers): is E5's P(clears_to_FA)
// calibrated within ±10 points on a league's own history (research 05 §1.6 "working", §8.4
// reliability by decile)? The probe leagues' finished seasons carry no mTransactions2 (keyless), so
// the claim feed itself is not visible; what IS visible is every team's roster in every week of
// league-b's 2024 and 2025 seasons (box scores, weeks 1–17, through the provider's own normaliser).
// The calibration set is the players a team dropped between week w and week w + 1: each was a
// waiver candidate whose fate is visible — another team rostered him the next week (claimed) or
// nobody did (cleared). E5's prediction for him is its own formula, (1 − q(r))^(N − 1), with r his
// ESPN projection for week w over the league's replacement level at his position that week (the
// projection of the last dedicated starter, all rostered players ranked — the worst rostered one
// when fewer are rostered than there are seats, as with D/ST some weeks). Caveats, said in the doc:
// dropped players are a subset of the pool; league-b is a FAAB league; a re-add the next week may be
// a free-agent pickup after the player cleared (the two-week window is the looser reading). A team
// whose next-week roster had an entry withheld by the scrub is skipped (the withheld entry could
// be the "dropped" player). The held-out demand scale and the held-out demand curve (intercept and
// slope fitted separately — the B2b fix): fitted on one season, scored on the other.
import { beforeAll, describe, expect, it } from "vitest";
import {
  calibrateClearsToFa,
  clearProbability,
  clearProbabilityCurve,
  fitDemandCurve,
  fitDemandScale,
  type ClearsCalibration,
  type ClearsOutcome,
  type DemandCurveFit,
  type DemandScaleFit,
} from "../../src/domain/analytics/waiver-fit/index.js";
import { newCounts, normalizeBoxScores } from "../../src/providers/espn/normalize.js";
import { mBoxscoreSchema } from "../../src/providers/espn/views/schedule.schema.js";
import { writeOrCompare } from "../domain/analytics/seeding-reproduce/doc.js";
import { historyBody, historyEntries } from "../fixtures/helpers/history-fixtures.js";

const SLOT = "league-b";
const SEASONS = [2024, 2025] as const;
const FINAL_WEEK = 17;
/** Position id → its dedicated starting slot id (QB 0, RB 2, WR 4, TE 6, K 17, D/ST 16). */
const POS_SLOT: Readonly<Record<number, string>> = {
  1: "0",
  2: "2",
  3: "4",
  4: "6",
  5: "17",
  16: "16",
};

interface Seat {
  readonly position_id: number;
  readonly proj: number | null;
}
type Rosters = Map<number, Map<number, Seat>>;

/** Every team's roster in one week, through the provider's normaliser. */
function rostersOf(season: number, week: number): Rosters {
  const body = mBoxscoreSchema.parse(historyBody(season, SLOT, `mBoxscore.sp${String(week)}`));
  const out: Rosters = new Map();
  for (const m of normalizeBoxScores(body, week, season, false, null, newCounts()))
    for (const side of [m.home, m.away]) {
      if (side === null) continue;
      const seats = new Map<number, Seat>();
      for (const e of side.entries)
        seats.set(e.player.ref.id, {
          position_id: e.player.position_id,
          proj: e.projected?.applied_total ?? null,
        });
      out.set(side.team_id, seats);
    }
  return out;
}

/** Teams with an entry withheld by the scrub in that week's box score. */
function incompleteTeams(season: number, week: number): Set<number> {
  const out = new Set<number>();
  for (const e of historyEntries(season, SLOT, `mBoxscore.sp${String(week)}`))
    for (const t of e.incomplete?.team_ids ?? []) out.add(t);
  return out;
}

/** The league's replacement projection by position in one week (the last dedicated starter). */
function replacementOf(
  rosters: Rosters,
  counts: Readonly<Record<string, number>>,
): Map<number, number> {
  const teams = rosters.size;
  const byPos = new Map<number, number[]>();
  for (const seats of rosters.values())
    for (const s of seats.values())
      if (s.proj !== null && Number.isFinite(s.proj))
        byPos.set(s.position_id, [...(byPos.get(s.position_id) ?? []), s.proj]);
  const out = new Map<number, number>();
  for (const [pos, projs] of byPos) {
    const slot = POS_SLOT[pos];
    const starters = slot === undefined ? 0 : (counts[slot] ?? 0);
    const sorted = [...projs].sort((a, b) => b - a);
    // fewer rostered than starting seats (a team carrying none that week): the worst one rostered
    out.set(pos, starters > 0 ? (sorted[Math.min(teams * starters, sorted.length) - 1] ?? 0) : 0);
  }
  return out;
}

/** One dropped player and his fate. */
interface Drop extends ClearsOutcome {
  readonly week: number;
  readonly team_id: number;
  readonly player_id: number;
  /** Not rostered by another team in week w + 1 or w + 2 (the looser reading). */
  readonly cleared_two_weeks: boolean;
}

function dropsOf(season: number): { drops: Drop[]; skipped: number; teams: number } {
  const settings = historyBody(season, SLOT, "mSettings") as {
    settings: { rosterSettings: { lineupSlotCounts: Record<string, number> } };
  };
  const counts = settings.settings.rosterSettings.lineupSlotCounts;
  const weeks = new Map<number, Rosters>();
  for (let w = 1; w <= FINAL_WEEK; w++) weeks.set(w, rostersOf(season, w));
  const teams = [...(weeks.get(1)?.keys() ?? [])].sort((a, b) => a - b);
  const drops: Drop[] = [];
  let skipped = 0;
  const rosteredBy = (w: number, player: number, except: number): boolean =>
    [...(weeks.get(w)?.entries() ?? [])].some(([t, seats]) => t !== except && seats.has(player));
  for (let w = 1; w < FINAL_WEEK; w++) {
    const now: Rosters = weeks.get(w) ?? new Map<number, Map<number, Seat>>();
    const next: Rosters = weeks.get(w + 1) ?? new Map<number, Map<number, Seat>>();
    const withheldNext = incompleteTeams(season, w + 1);
    const repl = replacementOf(now, counts);
    for (const team of teams) {
      const a = now.get(team) ?? new Map<number, Seat>();
      const b = next.get(team) ?? new Map<number, Seat>();
      for (const [player, seat] of a) {
        if (b.has(player)) continue;
        if (withheldNext.has(team)) {
          skipped += 1;
          continue;
        }
        const r = Math.max(0, (seat.proj ?? 0) - (repl.get(seat.position_id) ?? 0));
        const claimed1 = rosteredBy(w + 1, player, team);
        const claimed2 = claimed1 || (w + 2 <= FINAL_WEEK && rosteredBy(w + 2, player, team));
        drops.push({
          week: w,
          team_id: team,
          player_id: player,
          r,
          rivals: teams.length - 1,
          cleared: !claimed1,
          cleared_two_weeks: !claimed2,
        });
      }
    }
  }
  return { drops, skipped, teams: teams.length };
}

interface SeasonRun {
  readonly season: number;
  readonly drops: Drop[];
  readonly skipped: number;
  readonly cold: ClearsCalibration;
  readonly coldTwo: ClearsCalibration;
  readonly scale: DemandScaleFit;
  readonly fitted: ClearsCalibration;
  readonly curve: DemandCurveFit;
  readonly curved: ClearsCalibration;
}

const runs = new Map<number, SeasonRun>();
beforeAll(() => {
  const raw = new Map(SEASONS.map((s) => [s, dropsOf(s)] as const));
  for (const s of SEASONS) {
    const own = raw.get(s);
    const other = raw.get(s === 2024 ? 2025 : 2024);
    if (own === undefined || other === undefined) throw new Error("missing season");
    const scale = fitDemandScale(other.drops);
    const curve = fitDemandCurve(other.drops);
    runs.set(s, {
      season: s,
      drops: own.drops,
      skipped: own.skipped,
      cold: calibrateClearsToFa(
        own.drops.map((d) => ({ p: clearProbability(d.r, d.rivals), cleared: d.cleared })),
      ),
      coldTwo: calibrateClearsToFa(
        own.drops.map((d) => ({
          p: clearProbability(d.r, d.rivals),
          cleared: d.cleared_two_weeks,
        })),
      ),
      scale,
      fitted: calibrateClearsToFa(
        own.drops.map((d) => ({
          p: clearProbability(d.r, d.rivals, scale.scale),
          cleared: d.cleared,
        })),
      ),
      curve,
      curved: calibrateClearsToFa(
        own.drops.map((d) => ({
          p: clearProbabilityCurve(d.r, d.rivals, curve.q0, curve.q1),
          cleared: d.cleared,
        })),
      ),
    });
  }
}, 120_000);

const pct = (x: number | null): string => (x === null ? "—" : (x * 100).toFixed(1));
const signed = (x: number | null): string =>
  x === null ? "—" : `${x >= 0 ? "+" : "−"}${(Math.abs(x) * 100).toFixed(1)}`;

function clearsSection(): string {
  const lines = [
    "P(clears_to_FA) on league-b's real drops (2024, 2025): a player dropped between week w and w + 1 is **claimed** when another team rosters him in week w + 1, else **cleared**; E5's prediction is (1 − q(r))⁹ with r = his ESPN week-w projection over the league's replacement projection at his position. Points are percentage points.",
    "",
    "| season | drops | skipped (withheld next week) | observed clear rate | mean predicted (cold) | in the large (cold) | worst judged decile (cold) | within ±10 (cold) | λ fitted on the other season | in the large (λ) | worst judged decile (λ) | within ±10 (λ) | clear rate, two-week window |",
    "|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|---:|",
  ];
  for (const s of SEASONS) {
    const r = runs.get(s);
    if (r === undefined) continue;
    lines.push(
      `| ${String(s)} | ${String(r.cold.n)} | ${String(r.skipped)} | ${pct(r.cold.base_rate)} | ${pct(r.cold.mean_p)} | ${signed(r.cold.in_the_large)} | ${pct(r.cold.max_abs_deviation)} | ${r.cold.within_tolerance === null ? "—" : r.cold.within_tolerance ? "yes" : "**no**"} | ${r.scale.scale.toFixed(2)}${r.scale.at_bound ? " (at the bound)" : ""} | ${signed(r.fitted.in_the_large)} | ${pct(r.fitted.max_abs_deviation)} | ${r.fitted.within_tolerance === null ? "—" : r.fitted.within_tolerance ? "yes" : "**no**"} | ${pct(r.coldTwo.base_rate)} |`,
    );
  }
  lines.push(
    "",
    "The demand curve fitted on the other season (intercept q0 per rival and slope q1, maximum likelihood — the B2b fix; the cold start is q0 0.05, q1 0.08):",
    "",
    "| season | q0 fitted on the other season | q1 fitted on the other season | in the large (curve) | worst judged decile (curve) | judged deciles | within ±10 (curve) |",
    "|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const s of SEASONS) {
    const r = runs.get(s);
    if (r === undefined) continue;
    const bound = (b: boolean): string => (b ? " (at the bound)" : "");
    lines.push(
      `| ${String(s)} | ${r.curve.q0.toFixed(4)}${bound(r.curve.at_bound.q0)} | ${r.curve.q1.toFixed(4)}${bound(r.curve.at_bound.q1)} | ${signed(r.curved.in_the_large)} | ${pct(r.curved.max_abs_deviation)} | ${String(r.curved.bins.filter((b) => b.judged).length)} | ${r.curved.within_tolerance === null ? "—" : r.curved.within_tolerance ? "yes" : "**no**"} |`,
    );
  }
  const all = SEASONS.map((s) => runs.get(s));
  const coldOk = all.every((r) => r?.cold.within_tolerance === true);
  const fitOk = all.every((r) => r?.fitted.within_tolerance === true);
  const curveOk = all.every((r) => r?.curved.within_tolerance === true);
  lines.push(
    "",
    `**C5, P(clears_to_FA) within ±10 points (n ≥ 30 per season, so not soft by n):** cold-start demand **${coldOk ? "met" : "not met"}**; with the demand scale fitted on the other season **${fitOk ? "met" : "not met"}**; with the demand curve fitted on the other season **${curveOk ? "met" : "not met"}** (soft).`,
  );
  return lines.join("\n");
}

describe("C5 — P(clears_to_FA) on league-b's recorded drops", () => {
  it("each season yields ≥ 30 drops with E5's own prediction; the outcome windows nest", () => {
    for (const s of SEASONS) {
      const r = runs.get(s);
      expect(r?.cold.n ?? 0).toBeGreaterThanOrEqual(30);
      expect(r?.cold.soft).toBe(false);
      for (const d of r?.drops ?? []) {
        expect(d.rivals).toBe(9);
        expect(d.r).toBeGreaterThanOrEqual(0);
        // cleared over two weeks implies cleared the next week
        if (d.cleared_two_weeks) expect(d.cleared).toBe(true);
      }
      expect(r?.coldTwo.base_rate ?? 1).toBeLessThanOrEqual(r?.cold.base_rate ?? 0);
    }
  });

  it("the held-out demand scale is a finite likelihood optimum that does not lose to the cold curve on its own season", () => {
    for (const s of SEASONS) {
      const r = runs.get(s);
      expect(Number.isFinite(r?.scale.scale)).toBe(true);
      expect(r?.scale.log_likelihood ?? -1).toBeGreaterThanOrEqual(
        (r?.scale.log_likelihood_cold ?? 0) - 1e-9,
      );
    }
  });

  it("the held-out demand curve is a likelihood optimum at least as good as the cold curve and the best multiplier on its own season", () => {
    for (const s of SEASONS) {
      const r = runs.get(s);
      expect(r?.curve.n ?? 0).toBeGreaterThanOrEqual(30);
      expect(r?.curve.log_likelihood ?? -1).toBeGreaterThanOrEqual(
        (r?.curve.log_likelihood_cold ?? 0) - 1e-9,
      );
      expect(r?.curve.log_likelihood ?? -1).toBeGreaterThanOrEqual(
        (r?.scale.log_likelihood ?? 0) - 1e-6,
      );
    }
  });

  it("the numbers are the ones in docs/evals/phase3-waivers-seeding.md", () => {
    writeOrCompare("clears", clearsSection());
  });
});
