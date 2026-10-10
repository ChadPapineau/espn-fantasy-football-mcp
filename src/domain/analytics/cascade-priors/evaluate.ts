// evaluate.ts — plan 10 C6 (and B6's soft report): on an absence set, each method's predicted
// opportunity-share change per teammate against the realised change over the absence games (sib
// research 05 §6 Evaluation: "predicted beneficiary opportunity shares versus realised over the next
// 1–4 weeks (MAE), hit rate of the top predicted beneficiary being the top realised … 'working' = MAE
// below the naive depth-chart-next-man-up rule and top-beneficiary hit rate above it"). Methods:
// cascade v2 (E7's own `redistribute` with the prior table), cascade v1 (role affinity, the B6
// baseline), next man up by usage (the same-position teammate with the most of the starter's main
// component inherits every vacated share — B6's rule) and next man up by the depth chart (the
// best-ranked same-position teammate on the first absence week's chart; usage breaks ties). The
// beneficiary share (the headline) is a teammate's change in his share of the STARTER'S opportunity
// mix — targets and carries weighted by the starter's own targets and carries — as a fraction of the
// starter's share: a receiver's absence is judged by who took his targets, not by whose carry share
// swung (B6's targets + carries measure crowned a back in 16 of 71 receiver absences; it is reported
// beside it). No team evidence is used (the prior alone is under test). Pure. New here.
import { redistribute, type CascadeTeammate } from "../cascade.js";
import type { BareText } from "../../league/types.js";
import { DEFAULT_ABSENCE_RULES, findAbsences } from "./absences.js";
import { mainComponent } from "./predict.js";
import { buildPriorTable } from "./table.js";
import type {
  AbsenceEvent,
  AbsenceRules,
  CascadeCrossValidation,
  CascadeEvaluation,
  CascadeMethod,
  CascadePriorTable,
  ComponentShares,
  InjuredPosition,
  MethodScore,
  PairedHits,
  UsageRow,
} from "./types.js";
import { CASCADE_METHODS, INJURED_POSITIONS } from "./types.js";

const INJURED_KEYS = INJURED_POSITIONS;

/** The reception points v1's affinity split is run with (the reference league's half-PPR). */
export const EVAL_RECEPTION_POINTS = 0.5;

type Delta = Readonly<Record<"targets" | "carries" | "rz", number>>;

/** A teammate of an absence as E7 sees him (pre shares as his usage; no status, no evidence). */
export function cascadeMateOf(t: AbsenceEvent["teammates"][number]): CascadeTeammate {
  return {
    player_id: null,
    gsis_id: null,
    name: t.player as BareText,
    position: t.position,
    injury_status: null,
    usage: {
      target_share: t.pre.targets,
      carry_share: t.pre.carries,
      rz_share: t.pre.rz,
      snap_pct: null,
    },
    percent_change: null,
    availability: { status: null, waiver_process_date: null },
    depth_rank: t.depth,
  };
}

const usageOf = (s: ComponentShares) => ({
  target_share: s.targets,
  carry_share: s.carries,
  rz_share: s.rz,
});

/** Each method's predicted share changes for one absence (index-aligned with its teammates). */
export function predictions(
  e: AbsenceEvent,
  table: CascadePriorTable,
): Readonly<Record<CascadeMethod, readonly Delta[]>> {
  const mates = e.teammates.map(cascadeMateOf);
  const injured = { position: e.injured.position, usage: usageOf(e.injured.pre) };
  const v2 = redistribute(injured, mates, 0, EVAL_RECEPTION_POINTS, {
    priors: table,
    team_volume: e.team_pre,
  }).allocs.map((a) => a.delta);
  const v1 = redistribute(injured, mates, 0, EVAL_RECEPTION_POINTS).allocs.map((a) => a.delta);
  const main = mainComponent(e.injured.position);
  const same = e.teammates
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.position === e.injured.position);
  const byUsage = [...same].sort(
    (a, b) => b.t.pre[main] - a.t.pre[main] || b.t.pre_opportunities - a.t.pre_opportunities,
  )[0];
  const byDepth = [...same].sort(
    (a, b) =>
      (a.t.depth ?? Number.POSITIVE_INFINITY) - (b.t.depth ?? Number.POSITIVE_INFINITY) ||
      b.t.pre[main] - a.t.pre[main] ||
      b.t.pre_opportunities - a.t.pre_opportunities,
  )[0];
  const inherit = (pick: { i: number } | undefined): Delta[] =>
    e.teammates.map((_, i) =>
      pick?.i === i
        ? { targets: e.injured.pre.targets, carries: e.injured.pre.carries, rz: e.injured.pre.rz }
        : { targets: 0, carries: 0, rz: 0 },
    );
  return {
    v2_table: v2,
    v1_affinity: v1,
    next_man_up_usage: inherit(byUsage),
    next_man_up_depth: inherit(byDepth),
  };
}

/** The realised opportunity-share change of a teammate (post over the team's post volume). */
export function realisedOpportunity(e: AbsenceEvent, t: AbsenceEvent["teammates"][number]): number {
  const share = (s: ComponentShares, v: AbsenceEvent["team_pre"]) =>
    v.targets + v.carries > 0
      ? (s.targets * v.targets + s.carries * v.carries) / (v.targets + v.carries)
      : 0;
  return share(t.post, e.team_post) - share(t.pre, e.team_pre);
}

/** A predicted opportunity-share change (target and carry changes weighted by the volume before). */
export function predictedOpportunity(e: AbsenceEvent, d: Delta): number {
  const v = e.team_pre;
  return v.targets + v.carries > 0
    ? (d.targets * v.targets + d.carries * v.carries) / (v.targets + v.carries)
    : 0;
}

/**
 * The starter's opportunity mix: his targets and carries per game as fractions of his
 * opportunities (both 0 when he had none).
 */
export function opportunityMix(e: AbsenceEvent): {
  readonly targets: number;
  readonly carries: number;
} {
  const t = e.injured.pre.targets * e.team_pre.targets;
  const c = e.injured.pre.carries * e.team_pre.carries;
  return t + c > 0 ? { targets: t / (t + c), carries: c / (t + c) } : { targets: 0, carries: 0 };
}

/**
 * A share change as a beneficiary share: `Σ_c α_c Δs(c) / Σ_c α_c v_c` over targets and carries
 * (α = the starter's mix, v = his shares); 0 when the starter vacated nothing.
 */
export function beneficiaryShare(e: AbsenceEvent, d: Pick<Delta, "targets" | "carries">): number {
  const a = opportunityMix(e);
  const den = a.targets * e.injured.pre.targets + a.carries * e.injured.pre.carries;
  return den > 0 ? (a.targets * d.targets + a.carries * d.carries) / den : 0;
}

/** The index of the largest value (first on a tie); null when empty or every value ≤ 0. */
function argmaxPositive(xs: readonly number[]): number | null {
  let best: number | null = null;
  xs.forEach((x, i) => {
    if (x > 0 && (best === null || x > (xs[best] ?? 0))) best = i;
  });
  return best;
}
function argmax(xs: readonly number[]): number | null {
  let best: number | null = null;
  xs.forEach((x, i) => {
    if (best === null || x > (xs[best] ?? Number.NEGATIVE_INFINITY)) best = i;
  });
  return best;
}

const r4 = (x: number): number => {
  const v = Math.round(x * 1e4) / 1e4;
  return v === 0 ? 0 : v;
};

/**
 * C6 on an absence set with a table: per method the beneficiary-share MAE and top-beneficiary hit
 * rate (the headline), the opportunity-share MAE and hit rate, and the per-component MAEs, over
 * every (absence, teammate). A method's top is its largest predicted gain (none if it predicts no
 * gain: a miss); the realised top is the teammate with the largest realised change on the same
 * measure. Absences without teammates are skipped.
 */
export function evaluateCascade(
  events: readonly AbsenceEvent[],
  table: CascadePriorTable,
): CascadeEvaluation {
  const blank = () => ({ b: 0, opp: 0, t: 0, c: 0, rz: 0, hits: 0, hitsOpp: 0 });
  const acc = Object.fromEntries(CASCADE_METHODS.map((m) => [m, blank()])) as Record<
    CascadeMethod,
    ReturnType<typeof blank>
  >;
  let n = 0;
  let rows = 0;
  const byPos: Record<InjuredPosition, number> = { RB: 0, WR: 0, TE: 0 };
  const eventHits: Record<CascadeMethod, boolean>[] = [];
  for (const e of events) {
    if (e.teammates.length === 0) continue;
    const hit = {} as Record<CascadeMethod, boolean>;
    eventHits.push(hit);
    n += 1;
    byPos[e.injured.position] += 1;
    rows += e.teammates.length;
    const realDelta = e.teammates.map((t) => ({
      targets: t.post.targets - t.pre.targets,
      carries: t.post.carries - t.pre.carries,
      rz: t.post.rz - t.pre.rz,
    }));
    const realB = realDelta.map((d) => beneficiaryShare(e, d));
    const realOpp = e.teammates.map((t) => realisedOpportunity(e, t));
    const top = argmax(realB);
    const topOpp = argmax(realOpp);
    const preds = predictions(e, table);
    for (const m of CASCADE_METHODS) {
      const p = preds[m];
      const a = acc[m];
      const b = p.map((d) => beneficiaryShare(e, d));
      const opp = p.map((d) => predictedOpportunity(e, d));
      realDelta.forEach((r, i) => {
        const d = p[i] ?? { targets: 0, carries: 0, rz: 0 };
        a.b += Math.abs((b[i] ?? 0) - (realB[i] ?? 0));
        a.opp += Math.abs((opp[i] ?? 0) - (realOpp[i] ?? 0));
        a.t += Math.abs(d.targets - r.targets);
        a.c += Math.abs(d.carries - r.carries);
        a.rz += Math.abs(d.rz - r.rz);
      });
      const mine = argmaxPositive(b);
      hit[m] = mine !== null && mine === top;
      if (hit[m]) a.hits += 1;
      const mineOpp = argmaxPositive(opp);
      if (mineOpp !== null && mineOpp === topOpp) a.hitsOpp += 1;
    }
  }
  const per = (x: number, d: number) => (d === 0 ? 0 : r4(x / d));
  const methods = Object.fromEntries(
    CASCADE_METHODS.map((m): [CascadeMethod, MethodScore] => {
      const a = acc[m];
      return [
        m,
        {
          mae_beneficiary_share: per(a.b, rows),
          hit_rate: per(a.hits, n),
          hits: a.hits,
          mae_opportunity: per(a.opp, rows),
          hit_rate_opportunity: per(a.hitsOpp, n),
          mae_targets: per(a.t, rows),
          mae_carries: per(a.c, rows),
          mae_rz: per(a.rz, rows),
        },
      ];
    }),
  ) as Record<CascadeMethod, MethodScore>;
  return { absences: n, teammate_rows: rows, by_position: byPos, methods, event_hits: eventHits };
}

/** Pools evaluations of disjoint absence sets (MAEs weighted by teammate rows, hits summed). */
export function poolEvaluations(parts: readonly CascadeEvaluation[]): CascadeEvaluation {
  const n = parts.reduce((s, p) => s + p.absences, 0);
  const rows = parts.reduce((s, p) => s + p.teammate_rows, 0);
  const byPos: Record<InjuredPosition, number> = { RB: 0, WR: 0, TE: 0 };
  for (const p of parts) for (const k of INJURED_KEYS) byPos[k] += p.by_position[k];
  const w = (m: CascadeMethod, f: (s: MethodScore) => number, by: "rows" | "events") => {
    const d = by === "rows" ? rows : n;
    if (d === 0) return 0;
    const sum = parts.reduce(
      (s, p) => s + f(p.methods[m]) * (by === "rows" ? p.teammate_rows : p.absences),
      0,
    );
    return r4(sum / d);
  };
  const methods = Object.fromEntries(
    CASCADE_METHODS.map((m): [CascadeMethod, MethodScore] => {
      const hits = parts.reduce((s, p) => s + p.methods[m].hits, 0);
      return [
        m,
        {
          mae_beneficiary_share: w(m, (s) => s.mae_beneficiary_share, "rows"),
          hit_rate: n === 0 ? 0 : r4(hits / n),
          hits,
          mae_opportunity: w(m, (s) => s.mae_opportunity, "rows"),
          hit_rate_opportunity: w(m, (s) => s.hit_rate_opportunity, "events"),
          mae_targets: w(m, (s) => s.mae_targets, "rows"),
          mae_carries: w(m, (s) => s.mae_carries, "rows"),
          mae_rz: w(m, (s) => s.mae_rz, "rows"),
        },
      ];
    }),
  ) as Record<CascadeMethod, MethodScore>;
  return {
    absences: n,
    teammate_rows: rows,
    by_position: byPos,
    methods,
    event_hits: parts.flatMap((p) => p.event_hits),
  };
}

/** log C(n, k) by summed logs (n ≤ a few hundred here). */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** An exact McNemar test of method `a` against method `b` on the same absences. */
export function pairedHits(ev: CascadeEvaluation, a: CascadeMethod, b: CascadeMethod): PairedHits {
  let first = 0;
  let second = 0;
  for (const h of ev.event_hits) {
    if (h[a] && !h[b]) first += 1;
    if (h[b] && !h[a]) second += 1;
  }
  const d = first + second;
  const k = Math.min(first, second);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(d, i) - d * Math.LN2);
  return { only_first: first, only_second: second, p_value: r4(Math.min(1, 2 * tail)) };
}

/**
 * Leave-one-season-out C6 over usage rows: per season, the table is built from the OTHER seasons'
 * absences (its shrinkage chosen inside them) and evaluated on that season's absences.
 */
export function crossValidateCascade(
  rows: readonly UsageRow[],
  rules: AbsenceRules = DEFAULT_ABSENCE_RULES,
): CascadeCrossValidation {
  const all = findAbsences(rows, rules);
  const seasons = [...new Set(all.map((e) => e.season))].sort((x, y) => x - y);
  const folds = seasons.map((season) => {
    const train = findAbsences(
      rows.filter((r) => r.season !== season),
      rules,
    );
    const table = buildPriorTable(train, { rules });
    return {
      season,
      shrink_events: table.shrink_events,
      train_absences: train.length,
      evaluation: evaluateCascade(
        all.filter((e) => e.season === season),
        table,
      ),
    };
  });
  return { folds, pooled: poolEvaluations(folds.map((f) => f.evaluation)) };
}
