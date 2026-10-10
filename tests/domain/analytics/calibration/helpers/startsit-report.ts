// startsit-report.ts — the generated sections of docs/evals/phase3-startsit.md (plan 10 C2, C3): the
// tests assert each committed section equals what a fresh held-out replay computes; UPDATE_EVALS=1
// rewrites a section (the same convention as docs/evals/1a-backtest.md). Numbers only — no team or
// player name ever enters the doc (ids are not written either: every line is an aggregate).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compareRegret,
  didItMatter,
  reliabilityByDecile,
  regretOf,
  type EspnComparison,
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
  mean: "E2 `mean`",
  pwin: "E2 `pwin`",
  espn_projection: "start by ESPN's projection",
  last_week: "start by last week's points",
  manager: "the manager's lineup as played",
};

const BASIS_LABEL = (b: HistoryReplay["basis"]): string =>
  b === "position_cv" ? "position_cv (`core`)" : "player_sim where available (`full`)";

/** The replay's coverage per basis and season. */
export function coverageSection(replays: readonly HistoryReplay[]): string {
  const lines = [
    "| basis | season | team-weeks replayed | skipped (withheld entry) | not head-to-head | head-to-head with a result | player-weeks without an ESPN projection | starters on player_sim | player_sim player-weeks | …mean ≠ ESPN's (> 0.01) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const rp of replays)
    for (const s of rp.seasons) {
      const h2h = s.rows.filter((r) => r.h2h !== null && r.h2h.outcome_played !== null).length;
      const share = s.rows.reduce((a, r) => a + r.player_sim_share, 0) / Math.max(1, s.rows.length);
      lines.push(
        `| ${BASIS_LABEL(rp.basis)} | ${String(s.season)} | ${String(s.rows.length)} | ${String(s.skipped_incomplete)} | ${String(s.not_h2h)} | ${String(h2h)} | ${String(s.no_projection)} | ${pct(share)} | ${String(s.player_sim_weeks)} | ${String(s.player_sim_off_espn)} |`,
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

/** The switch rule's evidence and decision. */
export function switchSection(e: ObjectiveSwitchEvidence, d: ObjectiveSwitchDecision): string {
  const lines = [
    `Evidence basis: ${e.basis} where the opportunity inputs exist — ${pct(e.player_sim_share)} of the replayed starters (QB, K and D/ST keep position_cv in E1).`,
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
        `**${BASIS_LABEL(rp.basis)} — ${family === "played" ? "P(win) of the two lineups as played vs the result (primary)" : "E2's `p_win_after` (auto lineup vs the opponent's best-by-mean lineup) vs its counterfactual result"}:** status \`${rep.status}\`; ${String(rep.n)} forecasts; Brier ${f(rep.brier.value, 4)} (coin flip 0.2500; reliability ${f(d.reliability, 4)}, resolution ${f(d.resolution, 4)}, uncertainty ${f(d.uncertainty, 4)}); checked deciles ${String(rep.bins_checked)}, outside ±5: ${rep.bins_outside.length === 0 ? "none" : rep.bins_outside.map(String).join(", ")}; largest checked gap ${f(rep.max_checked_gap === null ? null : rep.max_checked_gap * 100, 1)} points; family-wise consistent: ${rep.consistent ? "yes" : "no"}.`,
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
