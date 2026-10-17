// startsit-report.ts — the generated sections of docs/evals/phase3-startsit.md (plan 10 C2, C3): the
// tests assert each committed section equals what a fresh held-out replay computes; UPDATE_EVALS=1
// rewrites a section (the same convention as docs/evals/1a-backtest.md). Numbers only — no team or
// player name ever enters the doc (ids are not written either: every line is an aggregate). Stage C
// (changelog R6-2) adds the `pwin-after` section: each P(win) family against the calibrated
// forecaster's sampling distribution of its reliability term, its margin calibration, the
// optimiser's selection bias in level, and the sparse tail decile read by its margins; changelog
// R7-1 the `keep-band` section: the regret of the lineup E2 tells the user to set beside its
// assignment's.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seededRng } from "../../../../../src/domain/clock.js";
import {
  compareRegret,
  didItMatter,
  marginCalibration,
  reliabilityByDecile,
  reliabilityNull,
  regretOf,
  type EspnComparison,
  type H2hPairFacts,
  type MarginCalibration,
  type ReliabilityNull,
  type ObjectiveSwitchDecision,
  type ObjectiveSwitchEvidence,
  type ReliabilityReport,
  type StartSitRow,
  type StartSitRule,
} from "../../../../../src/domain/analytics/calibration/index.js";
import type { HistoryReplay } from "./replay-history.js";

export const EVALS_DOC = path.resolve(
  import.meta.dirname,
  "../../../../../docs/evals/phase3-startsit.md",
);

const marker = (name: string, edge: "start" | "end"): string => `<!-- ${name}:${edge} -->`;

function bounds(text: string, name: string): [number, number] {
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0 || b < a)
    throw new Error(`docs/evals/phase3-startsit.md has no ${name} section`);
  return [a + marker(name, "start").length, b];
}

/** The committed text of a generated section. */
export function docSection(name: string): string {
  const text = readFileSync(EVALS_DOC, "utf8");
  const [a, b] = bounds(text, name);
  return text.slice(a, b).trim();
}

/** Rewrites a generated section (UPDATE_EVALS=1 only). */
export function writeDocSection(name: string, body: string): void {
  const text = readFileSync(EVALS_DOC, "utf8");
  const [a, b] = bounds(text, name);
  writeFileSync(EVALS_DOC, `${text.slice(0, a)}\n${body}\n${text.slice(b)}`);
}

const f = (x: number | null, d = 2): string => (x === null ? "—" : x.toFixed(d));
const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)} %`);

const RULE_LABEL: Readonly<Record<StartSitRule, string>> = {
  hindsight: "hindsight best",
  auto: "E2 `auto` (the product)",
  keep_band: "keep unless outside the band (E2's advice, R7-1)",
  mean: "E2 `mean`",
  pwin: "E2 `pwin`",
  espn_projection: "start by ESPN's projection",
  last_week: "start by last week's points",
  manager: "the manager's lineup as played",
};

const BASIS_LABEL = (b: HistoryReplay["basis"]): string =>
  b === "position_cv" ? "position_cv (`core`)" : "v2-opportunity where modelled (`full`)";

/** The replay's coverage per basis and season. */
export function coverageSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    "| basis | season | team-weeks replayed | skipped (withheld entry) | not head-to-head | head-to-head with a result | player-weeks without an ESPN projection | starters on player_sim | player_sim player-weeks | …served by v2-opportunity | …of them QB | …mean ≠ ESPN's (> 0.01) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const rp of replays)
    for (const s of rp.seasons) {
      const h2h = s.rows.filter((r) => r.h2h !== null && r.h2h.outcome_played !== null).length;
      const share = s.rows.reduce((a, r) => a + r.player_sim_share, 0) / Math.max(1, s.rows.length);
      lines.push(
        `| ${BASIS_LABEL(rp.basis)} | ${String(s.season)} | ${String(s.rows.length)} | ${String(s.skipped_incomplete)} | ${String(s.not_h2h)} | ${String(h2h)} | ${String(s.no_projection)} | ${pct(share)} | ${String(s.player_sim_weeks)} | ${String(s.v2_weeks)} | ${String(s.v2_qb_weeks)} | ${String(s.player_sim_off_espn)} |`,
      );
    }
  return lines.join("\n");
}

const RULES: readonly StartSitRule[] = [
  "auto",
  "mean",
  "pwin",
  "espn_projection",
  "last_week",
  "manager",
];

function meanRegret(rows: readonly StartSitRow[], rule: StartSitRule): number | null {
  const xs = rows.flatMap((r) => {
    const x = regretOf(r, rule);
    return x === null ? [] : [x];
  });
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Mean regret per team-week of every rule, per basis and season (weeks ≥ 2 so last week exists). */
export function regretSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    `| basis | season | team-weeks (weeks ≥ 2) | ${RULES.map((r) => RULE_LABEL[r]).join(" | ")} |`,
    `|---|---:|---:|${RULES.map(() => "---:").join("|")}|`,
  ];
  for (const rp of replays) {
    const seasons = [...new Set(rp.rows.map((r) => r.season))].sort((a, b) => a - b);
    for (const s of [...seasons, null]) {
      const rows = rp.rows.filter((r) => r.week >= 2 && (s === null || r.season === s));
      lines.push(
        `| ${BASIS_LABEL(rp.basis)} | ${s === null ? "**both**" : String(s)} | ${String(rows.length)} | ${RULES.map((r) => f(meanRegret(rows, r))).join(" | ")} |`,
      );
    }
  }
  return lines.join("\n");
}

/** C2's regret clause: E2 `auto` against both baselines, per season. */
export function baselineSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    "| basis | baseline | season | team-weeks | regret: E2 `auto` | regret: baseline | difference | identical lineups | verdict |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const rp of replays)
    for (const [b, from] of [
      ["last_week", 2],
      ["espn_projection", 1],
    ] as const) {
      const c = compareRegret(rp.rows, "auto", b, { from_week: from });
      for (const x of [...c.by_season, c.pooled]) {
        const verdict =
          x.diff === null
            ? "—"
            : x.identical === x.n
              ? "identical lineups (not informative)"
              : x.diff < 0
                ? "below"
                : x.diff === 0
                  ? "equal"
                  : "above";
        lines.push(
          `| ${BASIS_LABEL(rp.basis)} | ${RULE_LABEL[b]} | ${x.season === null ? "**both**" : String(x.season)} | ${String(x.n)} | ${f(x.mean_a, 4)} | ${f(x.mean_b, 4)} | ${f(x.diff, 4)} | ${String(x.identical)} | ${verdict} |`,
        );
      }
    }
  return lines.join("\n");
}

/**
 * The switch rule's evidence and decision; `allSim` = replayed team-weeks whose whole lineup was
 * player_sim (the only lineups the switch could ever apply to), of `n` replayed.
 */
export function switchSection(
  e: ObjectiveSwitchEvidence,
  d: ObjectiveSwitchDecision,
  allSim: number,
  n: number,
): string {
  const lines = [
    `Evidence basis: what \`full\` serves — player_sim (v2-opportunity for every QB/RB/WR/TE it models, else Phase 2's basis) on ${pct(e.player_sim_share)} of the replayed starters; K and D/ST keep position_cv, so ${String(allSim)} of ${String(n)} replayed lineups are all-player_sim (the only lineups the switch could apply to).`,
    "",
    "| season | team-weeks | pwin ≠ mean | regret: mean | regret: pwin | team-weeks after week 3 | regret after week 3: mean | regret after week 3: pwin |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const s of e.seasons)
    lines.push(
      `| ${String(s.season)} | ${String(s.n)} | ${String(s.n_differing)} | ${f(s.regret_mean, 4)} | ${f(s.regret_pwin, 4)} | ${String(s.n_later)} | ${f(s.regret_mean_later, 4)} | ${f(s.regret_pwin_later, 4)} |`,
    );
  lines.push(
    "",
    `**Decision: \`${d.status}\`** — pwin ${d.switch ? "becomes" : "does not become"} the \`auto\` default for player_sim.`,
    "",
    ...d.reasons.map((r) => `- ${r}`),
  );
  return lines.join("\n");
}

/** P(win) pairs of a replay: the matchup as played, or E2's own counterfactual. */
export function pwinPairs(
  rows: readonly StartSitRow[],
  family: "played" | "auto",
): { p: number; outcome: boolean }[] {
  return rows.flatMap((r) => {
    const h = r.h2h;
    if (h === null) return [];
    const o = family === "played" ? h.outcome_played : h.outcome_auto;
    const p = family === "played" ? h.p_win_played : h.p_win_auto;
    return o === null ? [] : [{ p, outcome: o }];
  });
}

function reliabilityTable(rep: ReliabilityReport): string[] {
  const lines = [
    "| decile | forecasts | mean P(win) | won | gap (points) | Wilson 95 % | n to resolve ±5 | verdict | consistent |",
    "|---|---:|---:|---:|---:|---|---:|---|---|",
  ];
  for (const b of rep.bins) {
    if (b.n === 0) continue;
    lines.push(
      `| ${f(b.lo, 1)}–${f(b.hi, 1)} | ${String(b.n)} | ${f(b.mean_p, 3)} | ${f(b.rate, 3)} | ${f(b.gap === null ? null : b.gap * 100, 1)} | ${b.wilson === null ? "—" : `${f(b.wilson[0], 3)}–${f(b.wilson[1], 3)}`} | ${String(b.n_to_resolve ?? "—")} | ${b.verdict} | ${b.consistent === null ? "—" : b.consistent ? "yes" : "no"} |`,
    );
  }
  return lines;
}

/** C2's calibration clause per basis: the matchup as played (primary) and E2's counterfactual. */
export function calibrationSection(replays: readonly HistoryReplay[]): string {
  const lines: string[] = [];
  for (const rp of replays)
    for (const family of ["played", "auto"] as const) {
      const rep = reliabilityByDecile(pwinPairs(rp.rows, family));
      const d = rep.brier.decomposition;
      lines.push(
        `**${BASIS_LABEL(rp.basis)} — ${family === "played" ? "P(win) of the two lineups as played vs the result (primary)" : "E2's `p_win_after` (auto lineup vs the opponent's best-by-mean lineup) vs its counterfactual result"}:** status \`${rep.status}\`; ${String(rep.n)} forecasts; Brier ${f(rep.brier.value, 4)} (coin flip 0.2500; reliability ${f(d.reliability, 4)} — a perfectly calibrated forecaster issuing these forecasts expects ${f(rep.reliability_if_calibrated, 4)} from sampling alone; resolution ${f(d.resolution, 4)}, uncertainty ${f(d.uncertainty, 4)}); checked deciles ${String(rep.bins_checked)}, outside ±5: ${rep.bins_outside.length === 0 ? "none" : rep.bins_outside.map(String).join(", ")}; largest checked gap ${f(rep.max_checked_gap === null ? null : rep.max_checked_gap * 100, 1)} points; family-wise consistent: ${rep.consistent ? "yes" : "no"}.`,
        "",
        ...reliabilityTable(rep),
        "",
      );
    }
  return lines.join("\n").trimEnd();
}

/** The "did it matter" shares per basis. */
export function didItMatterSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    "| basis | rule vs reference | head-to-head team-weeks | lineups differ | result flips | → a win | → a loss | share of differing | share of all |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const rp of replays)
    for (const [a, b] of [
      ["auto", "manager"],
      ["pwin", "mean"],
    ] as const) {
      const d = didItMatter(rp.rows, a, b);
      lines.push(
        `| ${BASIS_LABEL(rp.basis)} | ${RULE_LABEL[a]} vs ${RULE_LABEL[b]} | ${String(d.n_h2h)} | ${String(d.n_changed)} | ${String(d.n_decisive)} | ${String(d.n_helped)} | ${String(d.n_hurt)} | ${pct(d.share_of_changed)} | ${pct(d.share_of_all)} |`,
      );
    }
  return lines.join("\n");
}

/** The R7-1 policy's team-weeks: how often E2's advice keeps the lineup it was handed. */
export interface KeepBandCounts {
  readonly n: number;
  /** E2's assignment differs from the lineup it was handed (the manager's, as played). */
  readonly changed: number;
  /** …and every change is held: the advice is no move. */
  readonly all_held: number;
  /** …and some change is made. */
  readonly some_made: number;
  /** …of those, the advice still holds at least one coin flip. */
  readonly some_held: number;
}

export function keepBandCounts(rows: readonly StartSitRow[]): KeepBandCounts {
  let changed = 0;
  let allHeld = 0;
  let someMade = 0;
  let someHeld = 0;
  for (const r of rows) {
    const k = r.lineup_key;
    if (k.auto === k.manager) continue;
    changed += 1;
    if (k.keep_band === k.manager) allHeld += 1;
    else {
      someMade += 1;
      if (k.keep_band !== k.auto) someHeld += 1;
    }
  }
  return {
    n: rows.length,
    changed,
    all_held: allHeld,
    some_made: someMade,
    some_held: someHeld,
  };
}

/**
 * Changelog R7-1 (soft): the regret of "keep unless outside the band" — the lineup E2 under `auto`
 * tells the user to set — beside its mean-optimal assignment's (`auto`, what C2 judges), per basis
 * and season, with both baselines, the manager's lineup and the "did it matter" share against `auto`.
 */
export function keepBandSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    "| basis | season | team-weeks | E2's assignment changes the lineup | …every change held (no move) | …some change made | …of them holding a coin flip | regret: E2's assignment (`auto`) | regret: keep unless outside the band | difference | regret: the manager's lineup as played |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const rp of replays) {
    const seasons = [...new Set(rp.rows.map((r) => r.season))].sort((a, b) => a - b);
    for (const s of [...seasons, null]) {
      const rows = rp.rows.filter((r) => s === null || r.season === s);
      const c = keepBandCounts(rows);
      const a = meanRegret(rows, "auto");
      const k = meanRegret(rows, "keep_band");
      lines.push(
        `| ${BASIS_LABEL(rp.basis)} | ${s === null ? "**both**" : String(s)} | ${String(c.n)} | ${String(c.changed)} | ${String(c.all_held)} | ${String(c.some_made)} | ${String(c.some_held)} | ${f(a, 4)} | ${f(k, 4)} | ${f(a === null || k === null ? null : k - a, 4)} | ${f(meanRegret(rows, "manager"), 4)} |`,
      );
    }
  }
  lines.push(
    "",
    "| basis | the advice vs | season | team-weeks | regret: the advice | regret: the other rule | difference | identical lineups |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const rp of replays)
    for (const [b, from] of [
      ["last_week", 2],
      ["espn_projection", 1],
    ] as const) {
      const c = compareRegret(rp.rows, "keep_band", b, { from_week: from });
      for (const x of [...c.by_season, c.pooled])
        lines.push(
          `| ${BASIS_LABEL(rp.basis)} | ${RULE_LABEL[b]} | ${x.season === null ? "**both**" : String(x.season)} | ${String(x.n)} | ${f(x.mean_a, 4)} | ${f(x.mean_b, 4)} | ${f(x.diff, 4)} | ${String(x.identical)} |`,
        );
    }
  lines.push(
    "",
    "| basis | rule vs reference | head-to-head team-weeks | lineups differ | result flips | → a win | → a loss | share of differing | share of all |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const rp of replays) {
    const d = didItMatter(rp.rows, "keep_band", "auto");
    lines.push(
      `| ${BASIS_LABEL(rp.basis)} | ${RULE_LABEL.keep_band} vs ${RULE_LABEL.auto} | ${String(d.n_h2h)} | ${String(d.n_changed)} | ${String(d.n_decisive)} | ${String(d.n_helped)} | ${String(d.n_hurt)} | ${pct(d.share_of_changed)} | ${pct(d.share_of_all)} |`,
    );
  }
  return lines.join("\n");
}

/** C3's comparison line(s). */
export function comparatorSection(rows: readonly { label: string; c: EspnComparison }[]): string {
  const lines = [
    "| comparison | status | periods with an ESPN number | periods without | our forecasts | our Brier (all) | compared forecasts | our Brier (compared) | ESPN's Brier (compared) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const { label, c } of rows)
    lines.push(
      `| ${label} | \`${c.status}\` | ${String(c.periods.length)} | ${String(c.periods_without_espn)} | ${String(c.n_ours)} | ${f(c.brier_ours_all, 4)} | ${String(c.n_compared)} | ${f(c.brier_ours_compared, 4)} | ${f(c.brier_espn_compared, 4)} |`,
    );
  return lines.join("\n");
}

/** One side per matchup (the lower team id): a mirrored family's independent events. */
export function oneSidePerMatchup(rows: readonly StartSitRow[]): StartSitRow[] {
  return rows.filter(
    (r) => r.h2h !== null && r.h2h.opponent_id !== null && r.team_id < r.h2h.opponent_id,
  );
}

/** The seeded draws behind every null distribution in the doc (deterministic, per basis and family). */
export const NULL_SEED = 20261011;

/** A P(win) family's reliability term against the calibrated forecaster's distribution (R6-2). */
export function familyNull(
  rp: HistoryReplay,
  family: "played" | "auto",
  sims?: number,
): ReliabilityNull {
  const events = pwinPairs(oneSidePerMatchup(rp.rows), family);
  return reliabilityNull(events, {
    rng: seededRng(NULL_SEED).fork(`${rp.basis}:${family}`),
    mirrored: true,
    ...(sims === undefined ? {} : { sims }),
  });
}

/** A P(win) family's margin calibration, one side per matchup (R6-2). */
export function familyMargins(rp: HistoryReplay, family: "played" | "auto"): MarginCalibration {
  return marginCalibration(
    oneSidePerMatchup(rp.rows).flatMap((r) => {
      const h = r.h2h;
      if (h === null) return [];
      const x: H2hPairFacts = family === "played" ? h.played : h.auto;
      return [{ mean: x.mu_m - x.mu_o, sd: x.sd, realised: x.real_m - x.real_o }];
    }),
  );
}

/** The optimiser's selection bias in level, every head-to-head side (R6-2). */
export interface SelectionLevel {
  readonly n: number;
  /** Mean realised − projected total of my lineup as played. */
  readonly played: number;
  /** …of E2's best-by-mean (auto) lineup. */
  readonly auto: number;
  /** Mean projected total of the opponent's best-by-mean lineup minus his lineup as played. */
  readonly opp_projected_gap: number;
  /** …the same in realised points. */
  readonly opp_realised_gap: number;
}

export function selectionLevel(rows: readonly StartSitRow[]): SelectionLevel {
  const hs = rows.flatMap((r) => (r.h2h === null ? [] : [r.h2h]));
  const mean = (f: (h: (typeof hs)[number]) => number): number =>
    hs.reduce((s, h) => s + f(h), 0) / Math.max(1, hs.length);
  return {
    n: hs.length,
    played: mean((h) => h.played.real_m - h.played.mu_m),
    auto: mean((h) => h.auto.real_m - h.auto.mu_m),
    opp_projected_gap: mean((h) => h.auto.mu_o - h.played.mu_o),
    opp_realised_gap: mean((h) => h.auto.real_o - h.played.real_o),
  };
}

/** The exact binomial upper tail P(X ≥ k | n, p). */
export function binomialUpperTail(k: number, n: number, p: number): number {
  let total = 0;
  let c = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) c = (c * (n - i + 1)) / i;
    if (i >= k) total += c * p ** i * (1 - p) ** (n - i);
  }
  return Math.min(1, total);
}

/** E2's p_win_after decile [lo, hi) read from the underdog's side: binary results and margins. */
export interface TailDecile {
  readonly n: number;
  readonly mean_p: number;
  readonly wins: number;
  /** Underdog wins by fewer than 10 points. */
  readonly close_wins: number;
  readonly forecast_margin: number;
  readonly realised_margin: number;
  /** Standard error of the mean realised margin (the residuals' spread / √n). */
  readonly realised_se: number;
  /** P(≥ wins | n, mean_p) before any multiplicity over the deciles. */
  readonly binomial_p: number;
}

export function tailDecile(rows: readonly StartSitRow[], lo: number, hi: number): TailDecile {
  const xs = rows
    .flatMap((r) => (r.h2h === null ? [] : [r.h2h]))
    .filter((h) => h.outcome_auto !== null && h.p_win_auto >= lo && h.p_win_auto < hi);
  const n = xs.length;
  const mean = (f: (h: (typeof xs)[number]) => number): number =>
    xs.reduce((s, h) => s + f(h), 0) / Math.max(1, n);
  const d = (h: (typeof xs)[number]): number => h.auto.mu_m - h.auto.mu_o;
  const rd = (h: (typeof xs)[number]): number => h.auto.real_m - h.auto.real_o;
  const resid = Math.sqrt(mean((h) => (rd(h) - d(h)) ** 2));
  const wins = xs.filter((h) => h.outcome_auto === true).length;
  const meanP = mean((h) => h.p_win_auto);
  return {
    n,
    mean_p: meanP,
    wins,
    close_wins: xs.filter((h) => h.outcome_auto === true && rd(h) < 10).length,
    forecast_margin: mean(d),
    realised_margin: mean(rd),
    realised_se: resid / Math.sqrt(Math.max(1, n)),
    binomial_p: binomialUpperTail(wins, n, meanP),
  };
}

const FAMILY_LABEL = {
  played: "P(win) of the two lineups as played (primary)",
  auto: "E2's `p_win_after` (auto vs the opponent's best-by-mean lineup)",
} as const;

/** The R6-2 investigation, generated (docs/evals/phase3-startsit.md `pwin-after`). */
export function pwinAfterSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    "| basis | forecast family | matchups (forecasts) | reliability term | calibrated forecaster: mean | …95th percentile | P(term ≥ observed) | margin slope (95 % CI) | mean squared standardised residual (range if the spread is right) |",
    "|---|---|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const rp of replays)
    for (const family of ["played", "auto"] as const) {
      const nu = familyNull(rp, family);
      const m = familyMargins(rp, family);
      lines.push(
        `| ${BASIS_LABEL(rp.basis)} | ${FAMILY_LABEL[family]} | ${String(nu.events)} (${String(nu.forecasts)}) | ${f(nu.observed, 4)} | ${f(nu.mean, 4)} | ${f(nu.q95, 4)} | ${f(nu.p_value, 3)} | ${f(m.slope, 2)} (${f(m.slope_ci[0], 2)}–${f(m.slope_ci[1], 2)}) | ${f(m.z2, 3)} (${f(m.z2_range[0], 2)}–${f(m.z2_range[1], 2)}) |`,
      );
    }
  lines.push(
    "",
    "| basis | head-to-head sides | my lineup: realised − projected, as played | …E2's best-by-mean lineup | the opponent's best-by-mean − as played: projected | …realised |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const rp of replays) {
    const s = selectionLevel(rp.rows);
    lines.push(
      `| ${BASIS_LABEL(rp.basis)} | ${String(s.n)} | ${f(s.played)} | ${f(s.auto)} | ${f(s.opp_projected_gap)} | ${f(s.opp_realised_gap)} |`,
    );
  }
  lines.push(
    "",
    "| basis | E2's `p_win_after` decile (the underdog's side; its mirror is 0.7–0.8) | matchups | mean forecast | underdog won | …by < 10 points | forecast margin | realised margin (± 1 SE) | binomial P(≥ won), before multiplicity |",
    "|---|---|---:|---:|---:|---:|---:|---|---:|",
  );
  for (const rp of replays) {
    const t = tailDecile(rp.rows, 0.2, 0.3);
    lines.push(
      `| ${BASIS_LABEL(rp.basis)} | 0.2–0.3 | ${String(t.n)} | ${f(t.mean_p, 3)} | ${String(t.wins)} | ${String(t.close_wins)} | ${f(t.forecast_margin, 1)} | ${f(t.realised_margin, 1)} ± ${f(t.realised_se, 1)} | ${f(t.binomial_p, 3)} |`,
    );
  }
  return lines.join("\n");
}
