// kdst-history.ts — plan 10 §3.3 C7 on history: the K/D-ST bracket model (src/domain/analytics/
// kdst.ts) replayed over every regular-season team-week of the three backtest seasons (2023–2025,
// plan 10 D9 / [A-3]) against research 05 §8.4 #8's baselines — "most points last week" and the
// implied total (D/ST: the lowest opponent implied total; K: the highest own implied total) — under
// each probe league's own recorded scoring and the reference league's (fx-10h); sib research 05 §8
// Evaluation: "weekly rank correlation and MAE … the product must beat (a) clearly and at least match
// (b) … report the share of DEF variance explained by the rare-event constant". The data is the
// committed nflverse derivation in tests/backtest/data/kdst_history (make-kdst-history.ts, every file
// re-hashed on read); realised points are the shipped translator (statLineFromTeamDefense /
// statLineFromPlayerWeek) and engine under each S. Pure and deterministic; nothing is fetched.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KDST } from "../../../src/domain/analytics/constants.js";
import { dstExpectation, kickerExpectation } from "../../../src/domain/analytics/kdst.js";
import { spearman } from "../../../src/domain/analytics/math.js";
import { seededRng } from "../../../src/domain/clock.js";
import { score as engineScore } from "../../../src/domain/scoring/engine.js";
import {
  parseKickList,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "../../../src/domain/scoring/nflverse.js";
import { teamOfProTeamId } from "../../../src/domain/crosswalk/teams.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { Canonical, ScoringSettings, StatLine } from "../../../src/domain/scoring/types.js";
import { historyBody } from "../../fixtures/helpers/history-fixtures.js";
import { decodeTsv } from "../../sources/nflverse/helpers/tsv.js";

export const ROOT = new URL("../../../", import.meta.url).pathname;
/** This suite's data (see its README.md for the attribution). */
export const KDST_HISTORY_DIR = join(ROOT, "tests/backtest/data/kdst_history");
/** The backtest seasons (plan 10 D9: ≥ 3 in Phase 3 — the history files' [current − 3, current − 1]). */
export const KDST_HISTORY_SEASONS = Object.freeze([2023, 2024, 2025] as const);
/** The last fantasy week kept (ESPN's `finalScoringPeriod` 17; week 18 is not a fantasy week). */
export const KDST_HISTORY_FINAL_WEEK = 17;
/** The first evaluated week (week 1 has no "last week"). */
export const KDST_FIRST_EVAL_WEEK = 2;

export const GAME_COLUMNS = Object.freeze([
  "game_id",
  "season",
  "week",
  "home_team",
  "away_team",
  "home_score",
  "away_score",
  "spread_line",
  "total_line",
  "espn",
] as const);

export const DST_COLUMNS = Object.freeze([
  "season",
  "week",
  "team",
  "opponent_team",
  "game_id",
  "home",
  "def_sacks",
  "def_interceptions",
  "def_fumbles_forced",
  "fumble_recovery_opp",
  "def_tds",
  "fumble_recovery_tds_opp",
  "special_teams_tds",
  "def_safeties",
  "def_fg_blocks",
  "def_punt_blocks",
  "def_pat_blocks",
  "punt_return_yards",
  "kickoff_return_yards",
  "opp_passing_yards",
  "opp_sack_yards_lost",
  "opp_rushing_yards",
  "opp_score",
  "opp_int_tds",
  "opp_fumble_tds",
  "opp_safeties",
  "st_kr_td",
  "st_pr_td",
  "st_blk_td",
  "st_other_td",
] as const);

export const K_COLUMNS = Object.freeze([
  "season",
  "week",
  "team",
  "opponent_team",
  "position",
  "fg_att",
  "fg_made_list",
  "fg_missed_list",
  "fg_blocked_list",
  "pat_att",
  "pat_made",
  "pat_missed",
  "pat_blocked",
] as const);

/** The data directory's manifest. */
export interface KdstHistoryManifest {
  readonly $comment: string;
  readonly retrieved: string;
  readonly seasons: readonly number[];
  readonly final_week: number;
  readonly files: readonly {
    readonly path: string;
    readonly rows: number;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly upstream: readonly {
    readonly file: string;
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly rows: number;
    readonly nflverse_timestamp: string | null;
  }[];
  readonly notes: readonly string[];
}

type Row = Readonly<Record<string, unknown>>;

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** The committed manifest. */
export function kdstHistoryManifest(): KdstHistoryManifest {
  return JSON.parse(
    readFileSync(join(KDST_HISTORY_DIR, "manifest.json"), "utf8"),
  ) as KdstHistoryManifest;
}

function loadFile(name: string, columns: readonly string[]): Row[] {
  const entry = kdstHistoryManifest().files.find((f) => f.path === name);
  if (entry === undefined) throw new Error(`kdst_history: ${name} is not in the manifest`);
  const text = readFileSync(join(KDST_HISTORY_DIR, name), "utf8");
  if (sha(text) !== entry.sha256)
    throw new Error(`kdst_history: ${name} does not hash to its entry`);
  const cells = decodeTsv(
    columns.map((c) => ({ name: c })),
    text,
  );
  if (cells.length !== entry.rows) throw new Error(`kdst_history: ${name} row count differs`);
  return cells.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null])));
}

/** The three committed tables, every file re-hashed. */
export interface KdstHistory {
  readonly games: readonly Row[];
  readonly dst: readonly Row[];
  readonly k: readonly Row[];
}

let cached: KdstHistory | null = null;
export function loadKdstHistory(): KdstHistory {
  cached ??= {
    games: loadFile("games.tsv", GAME_COLUMNS),
    dst: loadFile("dst.tsv", DST_COLUMNS),
    k: loadFile("k.tsv", K_COLUMNS),
  };
  return cached;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const nn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// --- realised points under S ------------------------------------------------------------------------

/** The rare-event members of a D/ST line (sib research 05 §8.2: return and defensive TDs, safeties, blocks). */
export const DST_RARE_CANONICALS: readonly Canonical[] = Object.freeze([
  "dst_td",
  "dst_int_td",
  "dst_fr_td",
  "kr_td",
  "pr_td",
  "dst_blk_td",
  "ret_td_total",
  "dst_safety",
  "dst_blk",
]);

function withValues(line: StatLine, patch: Readonly<Record<Canonical, number>>): StatLine {
  const values = { ...line.values, ...patch };
  return { ...line, values, present: Object.keys(values).sort() };
}

function only(line: StatLine, keys: readonly Canonical[]): StatLine {
  const values: Record<Canonical, number> = {};
  for (const k of keys) {
    const v = line.values[k];
    if (v !== undefined) values[k] = v;
  }
  return { ...line, values, present: Object.keys(values).sort() };
}

/**
 * A D/ST team-week's realised line: the shipped translator over the derived row, with the
 * special-teams TD split (kick / punt / blocked-kick returns, from pbp) filled in — the translator
 * leaves them absent when the week has a special-teams TD, because weekly totals cannot split it.
 */
export function dstLine(r: Row): StatLine {
  const score = nn(r.opp_score);
  const line = statLineFromTeamDefense(r, {
    pointsAllowed:
      score === null
        ? null
        : {
            score,
            opponent_int_tds: n(r.opp_int_tds),
            opponent_fumble_tds: n(r.opp_fumble_tds),
            opponent_safeties: n(r.opp_safeties),
          },
  });
  return withValues(line, {
    kr_td: n(r.st_kr_td),
    pr_td: n(r.st_pr_td),
    dst_blk_td: n(r.st_blk_td),
  });
}

/** Points of a line under S (the engine's exact value). */
export const pointsOf = (line: StatLine, s: ScoringSettings): number =>
  engineScore(line, s).points_exact;

/** The rare-event part of a D/ST line's points under S. */
export const rarePointsOf = (line: StatLine, s: ScoringSettings): number =>
  pointsOf(only(line, DST_RARE_CANONICALS), s);

// --- implied totals and the per-team weekly table ---------------------------------------------------

export interface TeamWeek {
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly opponent: string;
  readonly team_implied: number | null;
  readonly opp_implied: number | null;
}

/** Implied totals per team-week: home = (total + spread) / 2, away = (total − spread) / 2. */
export function teamWeeks(h: KdstHistory): Map<string, TeamWeek> {
  const out = new Map<string, TeamWeek>();
  for (const g of h.games) {
    const total = nn(g.total_line);
    const spread = nn(g.spread_line);
    const home = total === null || spread === null ? null : (total + spread) / 2;
    const away = total === null || spread === null ? null : (total - spread) / 2;
    const season = n(g.season);
    const week = n(g.week);
    const ht = String(g.home_team);
    const at = String(g.away_team);
    out.set(key(season, week, ht), {
      season,
      week,
      team: ht,
      opponent: at,
      team_implied: home,
      opp_implied: away,
    });
    out.set(key(season, week, at), {
      season,
      week,
      team: at,
      opponent: ht,
      team_implied: away,
      opp_implied: home,
    });
  }
  return out;
}

const key = (season: number, week: number, team: string): string =>
  `${String(season)}|${String(week)}|${team}`;

/** Realised D/ST points per team-week under S, with the rare part. */
export function dstRealised(
  h: KdstHistory,
  s: ScoringSettings,
): Map<string, { readonly total: number; readonly rare: number }> {
  const out = new Map<string, { total: number; rare: number }>();
  for (const r of h.dst) {
    const line = dstLine(r);
    out.set(key(n(r.season), n(r.week), String(r.team)), {
      total: pointsOf(line, s),
      rare: rarePointsOf(line, s),
    });
  }
  return out;
}

/**
 * Realised kicking points per team-week under S (every position-K row of the team that week; a
 * team-week with no K row — nothing kicked — is absent here and reads as 0 in the replay).
 */
export function kRealised(h: KdstHistory, s: ScoringSettings): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of h.k) {
    const k = key(n(r.season), n(r.week), String(r.team));
    out.set(k, (out.get(k) ?? 0) + pointsOf(statLineFromPlayerWeek(r), s));
  }
  return out;
}

// --- the replay ---------------------------------------------------------------------------------------

export type KdstPos = "K" | "D/ST";

/** One evaluated week: the candidates and the per-predictor rank correlations and errors. */
export interface WeekEval {
  readonly season: number;
  readonly week: number;
  readonly position: KdstPos;
  readonly n: number;
  readonly rho_model: number | null;
  readonly rho_implied: number | null;
  readonly rho_last: number | null;
  /** Whether the model's ranking equals the implied-total ranking (every pair ordered alike). */
  readonly same_order_as_implied: boolean;
  readonly mae_model: number;
  readonly mae_last: number;
  /** Mean of (model e − realised): the model's level error. */
  readonly bias_model: number;
  /** Mean realised points of each predictor's top pick (ties: mean over the tied). */
  readonly top_model: number;
  readonly top_last: number;
  readonly top_best: number;
}

function topOf(pred: readonly number[], real: readonly number[]): number {
  const best = Math.max(...pred);
  const picks = real.filter((_, i) => pred[i] === best);
  return picks.reduce((a, b) => a + b, 0) / picks.length;
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      const x = Math.sign((a[i] ?? 0) - (a[j] ?? 0));
      const y = Math.sign((b[i] ?? 0) - (b[j] ?? 0));
      if (x !== y) return false;
    }
  return true;
}

/** Every evaluated team-week of one position under S. */
export function replayPosition(h: KdstHistory, s: ScoringSettings, pos: KdstPos): WeekEval[] {
  const tw = teamWeeks(h);
  const dst = pos === "D/ST" ? dstRealised(h, s) : null;
  const kk = pos === "K" ? kRealised(h, s) : null;
  // a team that kicked nothing that week has no K row: its kicking points are 0
  const real = (k: string): number | null =>
    dst !== null ? (dst.get(k)?.total ?? null) : (kk?.get(k) ?? 0);
  const out: WeekEval[] = [];
  for (const season of KDST_HISTORY_SEASONS) {
    const last = new Map<string, number>();
    for (let week = 1; week <= KDST_HISTORY_FINAL_WEEK; week++) {
      const model: number[] = [];
      const implied: number[] = [];
      const prev: number[] = [];
      const actual: number[] = [];
      const played: [string, number][] = [];
      for (const t of tw.values()) {
        if (t.season !== season || t.week !== week) continue;
        const k = key(season, week, t.team);
        const a = real(k);
        if (a === null) continue;
        played.push([t.team, a]);
        const before = last.get(t.team);
        if (before === undefined) continue;
        model.push(
          pos === "D/ST"
            ? dstExpectation(s, t.opp_implied, t.team_implied).e
            : kickerExpectation(s, t.team_implied, t.opp_implied).e,
        );
        implied.push(pos === "D/ST" ? -(t.opp_implied ?? 0) : (t.team_implied ?? 0));
        prev.push(before);
        actual.push(a);
      }
      for (const [team, a] of played) last.set(team, a);
      if (week < KDST_FIRST_EVAL_WEEK || actual.length < 3) continue;
      const mae = (p: readonly number[]): number =>
        p.reduce((acc, x, i) => acc + Math.abs(x - (actual[i] ?? 0)), 0) / p.length;
      out.push({
        season,
        week,
        position: pos,
        n: actual.length,
        rho_model: spearman(model, actual),
        rho_implied: spearman(implied, actual),
        rho_last: spearman(prev, actual),
        same_order_as_implied: sameOrder(model, implied),
        mae_model: mae(model),
        mae_last: mae(prev),
        bias_model: model.reduce((acc, x, i) => acc + x - (actual[i] ?? 0), 0) / model.length,
        top_model: topOf(model, actual),
        top_last: topOf(prev, actual),
        top_best: Math.max(...actual),
      });
    }
  }
  return out;
}

// --- summaries ----------------------------------------------------------------------------------------

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

const variance = (xs: readonly number[]): number => {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};

/** The paired mean difference with a seeded bootstrap 95 % interval over the weeks. */
export interface PairedDiff {
  readonly mean: number;
  readonly lo: number;
  readonly hi: number;
  readonly weeks: number;
}

export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_SEED = 20_261_010;

export function pairedDiff(diffs: readonly number[], label: string): PairedDiff {
  const rng = seededRng(BOOTSTRAP_SEED).fork(label);
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    let s = 0;
    let left = diffs.length;
    while (left-- > 0) s += diffs[Math.floor(rng.next() * diffs.length)] ?? 0;
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(diffs),
    lo: means[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)] ?? Number.NaN,
    hi: means[Math.ceil(0.975 * BOOTSTRAP_RESAMPLES) - 1] ?? Number.NaN,
    weeks: diffs.length,
  };
}

/** One scoring × position × season summary (season 0 = the three seasons pooled). */
export interface Summary {
  readonly scoring: string;
  readonly position: KdstPos;
  readonly season: number;
  readonly weeks: number;
  readonly candidates: number;
  readonly rho_model: number;
  readonly rho_implied: number;
  readonly rho_last: number;
  readonly rho_gain: PairedDiff;
  readonly mae_model: number;
  readonly mae_last: number;
  readonly bias_model: number;
  readonly top_model: number;
  readonly top_last: number;
  readonly top_best: number;
  readonly same_order_weeks: number;
}

export function summarise(scoring: string, rows: readonly WeekEval[], season: number): Summary {
  const xs = rows.filter((r) => season === 0 || r.season === season);
  const pick = (f: (r: WeekEval) => number | null): number[] =>
    xs.map(f).filter((x): x is number => x !== null);
  const pos = xs[0]?.position ?? "D/ST";
  return {
    scoring,
    position: pos,
    season,
    weeks: xs.length,
    candidates: xs.reduce((a, r) => a + r.n, 0),
    rho_model: mean(pick((r) => r.rho_model)),
    rho_implied: mean(pick((r) => r.rho_implied)),
    rho_last: mean(pick((r) => r.rho_last)),
    rho_gain: pairedDiff(
      xs.map((r) => (r.rho_model ?? 0) - (r.rho_last ?? 0)),
      `${scoring}:${pos}:${String(season)}`,
    ),
    mae_model: mean(xs.map((r) => r.mae_model)),
    mae_last: mean(xs.map((r) => r.mae_last)),
    bias_model: mean(xs.map((r) => r.bias_model)),
    top_model: mean(xs.map((r) => r.top_model)),
    top_last: mean(xs.map((r) => r.top_last)),
    top_best: mean(xs.map((r) => r.top_best)),
    same_order_weeks: xs.filter((r) => r.same_order_as_implied).length,
  };
}

/** The rare-event share of D/ST variance under S (every team-week, weeks 1..final, three seasons). */
export interface RareShare {
  readonly scoring: string;
  readonly team_weeks: number;
  readonly mean_total: number;
  readonly mean_rare: number;
  readonly rare_c: number;
  readonly mean_model: number;
  readonly var_total: number;
  /** Var(rare) / Var(total). */
  readonly share_var: number;
  /** 1 − Var(total − rare) / Var(total): the variance gone if rare events were removed (covariance in). */
  readonly share_removed: number;
  /** Var(rare) / Var(total − model e): the model's residual variance a constant cannot explain. */
  readonly share_of_residual: number;
}

export function rareShare(h: KdstHistory, s: ScoringSettings, scoring: string): RareShare {
  const tw = teamWeeks(h);
  const real = dstRealised(h, s);
  const total: number[] = [];
  const rare: number[] = [];
  const resid: number[] = [];
  const model: number[] = [];
  for (const [k, v] of real) {
    const t = tw.get(k);
    if (t === undefined) continue;
    const e = dstExpectation(s, t.opp_implied, t.team_implied).e;
    total.push(v.total);
    rare.push(v.rare);
    resid.push(v.total - e);
    model.push(e);
  }
  const vt = variance(total);
  return {
    scoring,
    team_weeks: total.length,
    mean_total: mean(total),
    mean_rare: mean(rare),
    rare_c: dstExpectation(s, null).rare_c ?? 0,
    mean_model: mean(model),
    var_total: vt,
    share_var: variance(rare) / vt,
    share_removed: 1 - variance(total.map((x, i) => x - (rare[i] ?? 0))) / vt,
    share_of_residual: variance(rare) / variance(resid),
  };
}

/** The D/ST events whose per-game rates the history measures (kdst.ts constants beside them). */
export const DST_EVENT_CANONICALS: readonly Canonical[] = Object.freeze([
  ...DST_RARE_CANONICALS,
  "dst_sack",
  "dst_int",
  "dst_fr",
  "dst_ff",
]);

/**
 * Observed D/ST event rates per team-game, over the given seasons (default all three) — the fit
 * behind kdst.ts `DST_RARE_RATES` and `DST_FF_RATE`, and the check on KDST's other event rates.
 */
export function observedDstRates(
  h: KdstHistory,
  seasons: readonly number[] = KDST_HISTORY_SEASONS,
): Readonly<Record<string, number>> {
  const sums: Record<string, number> = {};
  let games = 0;
  for (const r of h.dst) {
    if (!seasons.includes(n(r.season))) continue;
    const line = dstLine(r);
    games++;
    for (const c of DST_EVENT_CANONICALS) sums[c] = (sums[c] ?? 0) + (line.values[c] ?? 0);
  }
  return Object.fromEntries(
    DST_EVENT_CANONICALS.map((c) => [c, games === 0 ? Number.NaN : (sums[c] ?? 0) / games]),
  );
}

// --- the kicker inputs the history shows, beside the model's constants (reported) -----------------

/** Kicking per team-game: attempts and makes by distance band, PATs, against the model's constants. */
export interface KickRow {
  readonly item: string;
  readonly model: number;
  readonly observed: number;
}

const BANDS = [
  { label: "< 40", lo: 0, hi: 39, model: 0 },
  { label: "40–49", lo: 40, hi: 49, model: 1 },
  { label: "50–59", lo: 50, hi: 59, model: 2 },
  { label: "60+", lo: 60, hi: 200, model: 3 },
] as const;

export function kickRows(h: KdstHistory): KickRow[] {
  const tw = teamWeeks(h);
  const games = h.dst.length;
  let implied = 0;
  for (const r of h.dst)
    implied += tw.get(key(n(r.season), n(r.week), String(r.team)))?.team_implied ?? 0;
  const att = BANDS.map(() => 0);
  const made = BANDS.map(() => 0);
  let patAtt = 0;
  let patMade = 0;
  for (const r of h.k) {
    const m = parseKickList(r.fg_made_list);
    const x = [...parseKickList(r.fg_missed_list), ...parseKickList(r.fg_blocked_list)];
    BANDS.forEach((b, i) => {
      const inBand = (d: number): boolean => d >= b.lo && d <= b.hi;
      made[i] = (made[i] ?? 0) + m.filter(inBand).length;
      att[i] = (att[i] ?? 0) + m.filter(inBand).length + x.filter(inBand).length;
    });
    patAtt += n(r.pat_att);
    patMade += n(r.pat_made);
  }
  const totalAtt = att.reduce((a, b) => a + b, 0);
  const meanImplied = implied / games;
  // the model's mean attempts over the same games (attempts ∝ (implied / league)^β)
  let modelAtt = 0;
  for (const r of h.dst) {
    const t =
      tw.get(key(n(r.season), n(r.week), String(r.team)))?.team_implied ?? KDST.leagueImplied;
    modelAtt += KDST.fgAttempts * (t / KDST.leagueImplied) ** KDST.fgAttemptsBeta;
  }
  const rows: KickRow[] = [
    { item: "FG attempts per team-game", model: modelAtt / games, observed: totalAtt / games },
  ];
  BANDS.forEach((b, i) => {
    const mix = KDST.fgMix[b.model];
    rows.push({
      item: `share of attempts ${b.label} yd`,
      model: mix?.share ?? Number.NaN,
      observed: (att[i] ?? 0) / totalAtt,
    });
    rows.push({
      item: `make rate ${b.label} yd`,
      model: mix?.make ?? Number.NaN,
      observed: (made[i] ?? 0) / Math.max(1, att[i] ?? 0),
    });
  });
  rows.push(
    {
      item: "PAT attempts per team-game",
      model: KDST.patPerPoint * meanImplied,
      observed: patAtt / games,
    },
    { item: "PAT make rate", model: KDST.patMake, observed: patMade / Math.max(1, patAtt) },
  );
  return rows;
}

/** The kicker table. */
export function kickSection(rows: readonly KickRow[]): string {
  const lines = ["| item | model constant | 2023–2025 observed |", "|---|---:|---:|"];
  for (const r of rows) lines.push(`| ${r.item} | ${f3(r.model)} | ${f3(r.observed)} |`);
  return lines.join("\n");
}

// --- the realised points against ESPN's own (league-b's recorded box scores, 2024 and 2025) -------

/** One season × position of the cross-check. */
export interface EspnCheck {
  readonly season: number;
  readonly position: KdstPos;
  /** Rostered entries with an ESPN actual whose team-week the history holds. */
  readonly entries: number;
  /** … whose realised points under that season's league-b scoring equal ESPN's appliedTotal ± 0.01. */
  readonly matched: number;
  /** Rostered entries whose current team ESPN no longer gives (a free agent now: proTeamId 0). */
  readonly team_unknown: number;
  readonly mismatches: readonly {
    readonly week: number;
    readonly team: string;
    readonly ours: number;
    readonly espn: number;
  }[];
}

interface BoxStat {
  readonly statSourceId: number;
  readonly statSplitTypeId: number;
  readonly scoringPeriodId: number;
  readonly seasonId: number;
  readonly appliedTotal?: number;
}
interface BoxEntry {
  readonly playerId: number;
  readonly playerPoolEntry: {
    readonly player: {
      readonly defaultPositionId: number;
      readonly proTeamId: number;
      readonly stats: readonly BoxStat[];
    };
  };
}
interface BoxSide {
  readonly rosterForCurrentScoringPeriod: { readonly entries: readonly BoxEntry[] };
}

/**
 * Every rostered D/ST and K of league-b's recorded box scores (2024 and 2025, weeks 1–17 — the only
 * finished seasons with box scores) against the history's realised points under that season's own
 * league-b scoring. A D/ST is its team, so its check is exact; a kicker is mapped by the proTeamId
 * the history recording carries — his team when recorded, not necessarily that week's — so a K
 * mismatch can be a roster move, not a scoring difference.
 */
export function espnCrossCheck(h: KdstHistory): EspnCheck[] {
  const out: EspnCheck[] = [];
  for (const season of [2024, 2025]) {
    const settings = normalizeSettings(
      (historyBody(season, "league-b", "mSettings") as { settings: { scoringSettings: unknown } })
        .settings.scoringSettings,
    );
    const dst = dstRealised(h, settings);
    const kk = kRealised(h, settings);
    const acc: Record<
      KdstPos,
      { entries: number; matched: number; unknown: number; bad: EspnCheck["mismatches"][number][] }
    > = {
      "D/ST": { entries: 0, matched: 0, unknown: 0, bad: [] },
      K: { entries: 0, matched: 0, unknown: 0, bad: [] },
    };
    for (let week = 1; week <= KDST_HISTORY_FINAL_WEEK; week++) {
      const body = historyBody(season, "league-b", `mBoxscore.sp${String(week)}`) as unknown as {
        schedule: readonly { readonly home?: BoxSide; readonly away?: BoxSide }[];
      };
      const seen = new Set<number>();
      for (const m of body.schedule)
        for (const side of [m.home, m.away]) {
          for (const e of side?.rosterForCurrentScoringPeriod.entries ?? []) {
            const p = e.playerPoolEntry.player;
            const pos: KdstPos | null =
              p.defaultPositionId === 16 ? "D/ST" : p.defaultPositionId === 5 ? "K" : null;
            if (pos === null || seen.has(e.playerId)) continue;
            seen.add(e.playerId);
            const espn = p.stats.find(
              (x) =>
                x.statSourceId === 0 &&
                x.statSplitTypeId === 1 &&
                x.scoringPeriodId === week &&
                x.seasonId === season,
            )?.appliedTotal;
            if (espn === undefined) continue;
            const a = acc[pos];
            const team = teamOfProTeamId(p.proTeamId);
            if (team === null) {
              a.unknown++;
              continue;
            }
            const k = key(season, week, team);
            const ours = pos === "D/ST" ? dst.get(k)?.total : (kk.get(k) ?? 0);
            if (ours === undefined) continue;
            a.entries++;
            if (Math.abs(ours - espn) <= 0.01) a.matched++;
            else a.bad.push({ week, team, ours, espn });
          }
        }
    }
    for (const pos of ["D/ST", "K"] as const) {
      const a = acc[pos];
      out.push({
        season,
        position: pos,
        entries: a.entries,
        matched: a.matched,
        team_unknown: a.unknown,
        mismatches: a.bad,
      });
    }
  }
  return out;
}

// --- the scorings ---------------------------------------------------------------------------------

/** The scorings the replay runs under: the three recorded probe leagues and the reference league. */
export function scorings(): readonly {
  readonly name: string;
  readonly settings: ScoringSettings;
}[] {
  const read = (rel: string): ScoringSettings =>
    normalizeSettings(
      (
        JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as {
          settings: { scoringSettings: unknown };
        }
      ).settings.scoringSettings,
    );
  return [
    { name: "reference (fx-10h)", settings: read("fixtures/espn/fx-10h/league/mSettings.json") },
    { name: "league-a", settings: read("fixtures/espn/recorded/league-a/mSettings.json") },
    { name: "league-b", settings: read("fixtures/espn/recorded/league-b/mSettings.json") },
    { name: "league-c", settings: read("fixtures/espn/recorded/league-c/mSettings.json") },
  ];
}

// --- docs/evals/phase3-kdst-news.md generated sections --------------------------------------------

export const EVAL_DOC = join(ROOT, "docs/evals/phase3-kdst-news.md");
const marker = (name: string, edge: "start" | "end"): string => `<!-- ${name}:${edge} -->`;

/** The committed text of a generated section. */
export function evalDocSection(name: string): string {
  const text = readFileSync(EVAL_DOC, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0) throw new Error(`${EVAL_DOC} has no ${name} section`);
  return text.slice(a + marker(name, "start").length, b).trim();
}

/** Rewrites a generated section (UPDATE_EVALS=1 only). */
export function writeEvalDocSection(name: string, body: string): void {
  const text = readFileSync(EVAL_DOC, "utf8");
  const a = text.indexOf(marker(name, "start"));
  const b = text.indexOf(marker(name, "end"));
  if (a < 0 || b < 0) throw new Error(`${EVAL_DOC} has no ${name} section`);
  writeFileSync(
    EVAL_DOC,
    `${text.slice(0, a + marker(name, "start").length)}\n${body}\n${text.slice(b)}`,
  );
}

const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "—");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "—");

/** The C7 table: one row per scoring × position × season (and pooled). */
export function c7Section(rows: readonly Summary[]): string {
  const lines = [
    "| scoring | pos | season | weeks | cand. | ρ model | ρ implied | ρ last week | ρ gain vs last week [95 % CI] | MAE model | MAE last week | model bias | top pick: model | top pick: last week | best |",
    "|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.scoring} | ${r.position} | ${r.season === 0 ? "**pooled**" : String(r.season)} | ${String(r.weeks)} | ${String(r.candidates)} | ${f3(r.rho_model)} | ${f3(r.rho_implied)} | ${f3(r.rho_last)} | ${f3(r.rho_gain.mean)} [${f3(r.rho_gain.lo)}, ${f3(r.rho_gain.hi)}] | ${f2(r.mae_model)} | ${f2(r.mae_last)} | ${f2(r.bias_model)} | ${f2(r.top_model)} | ${f2(r.top_last)} | ${f2(r.top_best)} |`,
    );
  return lines.join("\n");
}

/** One scoring × season row of the return-yards check (Stage C: `returns_e`). */
export interface ReturnsRow {
  readonly scoring: string;
  readonly season: number;
  readonly team_weeks: number;
  readonly kr_yd: number;
  readonly pr_yd: number;
  /** The realised return-yard points per team-game under S. */
  readonly realised: number;
  /** The model's `returns_e` (the 2023-fitted constant scored under S). */
  readonly model: number;
}

/** The return-yard members of a D/ST line (ESPN 114, 115). */
export const DST_RETURN_CANONICALS: readonly Canonical[] = Object.freeze(["kr_yd", "pr_yd"]);

/** Realised return yards and their points per scoring × season against the model's constant. */
export function returnsRows(h: KdstHistory): ReturnsRow[] {
  const out: ReturnsRow[] = [];
  for (const sc of scorings()) {
    const model = dstExpectation(sc.settings, null).returns_e ?? Number.NaN;
    for (const season of KDST_HISTORY_SEASONS) {
      const rows = h.dst.filter((r) => n(r.season) === season);
      const lines = rows.map((r) => dstLine(r));
      out.push({
        scoring: sc.name,
        season,
        team_weeks: rows.length,
        kr_yd: mean(lines.map((l) => l.values.kr_yd ?? 0)),
        pr_yd: mean(lines.map((l) => l.values.pr_yd ?? 0)),
        realised: mean(lines.map((l) => pointsOf(only(l, DST_RETURN_CANONICALS), sc.settings))),
        model,
      });
    }
  }
  return out;
}

/** The return-yards table (fitted on 2023; 2024–2025 held out). */
export function returnsSection(rows: readonly ReturnsRow[]): string {
  const lines = [
    "| scoring | season | team-games | kick return yd / game | punt return yd / game | realised return pts | model `returns_e` | model − realised |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.scoring} | ${String(r.season)}${r.season === 2023 ? " (fit)" : " (held out)"} | ${String(r.team_weeks)} | ${f2(r.kr_yd)} | ${f2(r.pr_yd)} | ${f3(r.realised)} | ${f3(r.model)} | ${f3(Math.abs(r.model - r.realised) < 5e-4 ? 0 : r.model - r.realised)} |`,
    );
  return lines.join("\n");
}

/** The cross-check table and the D/ST mismatches. */
export function espnSection(rows: readonly EspnCheck[]): string {
  const lines = [
    "| season | pos | rostered entries | equal to ESPN ± 0.01 | share | team unknown now |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${String(r.season)} | ${r.position} | ${String(r.entries)} | ${String(r.matched)} | ${f3(r.matched / r.entries)} | ${String(r.team_unknown)} |`,
    );
  lines.push(
    "",
    "D/ST weeks that differ (ours vs ESPN's appliedTotal under league-b's scoring):",
    "",
  );
  for (const r of rows.filter((x) => x.position === "D/ST"))
    for (const m of r.mismatches)
      lines.push(
        `- ${String(r.season)} week ${String(m.week)} ${m.team}: ${f2(m.ours)} vs ${f2(m.espn)}`,
      );
  return lines.join("\n");
}

/** The observed event rates per season and pooled, beside the model's constants. */
export function ratesSection(
  perSeason: readonly {
    readonly label: string;
    readonly rates: Readonly<Record<string, number>>;
  }[],
  model: Readonly<Record<string, number>>,
): string {
  const head = ["| member | model constant |", ...perSeason.map((p) => ` ${p.label} |`)].join("");
  const sep = ["|---|---:|", ...perSeason.map(() => "---:|")].join("");
  const lines = [head, sep];
  for (const c of DST_EVENT_CANONICALS)
    lines.push(
      `| \`${c}\` | ${model[c] === undefined ? "—" : f3(model[c])} |${perSeason.map((p) => ` ${f3(p.rates[c] ?? Number.NaN)} |`).join("")}`,
    );
  return lines.join("\n");
}

/** The rare-event table. */
export function rareSection(rows: readonly RareShare[]): string {
  const lines = [
    "| scoring | team-weeks | mean D/ST pts | mean rare pts | model `rare_c` | mean model `e` | Var(total) | Var(rare) / Var(total) | 1 − Var(total − rare) / Var(total) | Var(rare) / Var(total − e) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.scoring} | ${String(r.team_weeks)} | ${f2(r.mean_total)} | ${f3(r.mean_rare)} | ${f3(r.rare_c)} | ${f2(r.mean_model)} | ${f2(r.var_total)} | ${f3(r.share_var)} | ${f3(r.share_removed)} | ${f3(r.share_of_residual)} |`,
    );
  return lines.join("\n");
}
