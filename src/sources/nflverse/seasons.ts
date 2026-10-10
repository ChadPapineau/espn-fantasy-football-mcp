// seasons.ts — historical season selection (plan 10 §3.3 "≥ 3 historical seasons" [A-3]; D9 "≥ 3 in
// Phase 3"; plan 01 §5.5: every dataset file is published WHOLE into a fresh per-source file). Every
// dataset file the held-out backtests read holds the backtest seasons [current − 3, current − 1]
// (tables.ts `backtestSeasonsFor`) whatever seasons a run names: the seven `<source>_history` files
// (phase2.ts `historyFileSeasons`) and `nflverse:schedules`, whose one games.parquet covers every
// season (tables.ts HISTORY_DATASET_SOURCES: "the runner adds the prior seasons to that source's
// ctx.seasons" — done at the source, so every caller gets it). Because a publish rewrites its file,
// a run naming fewer seasons (the CLI's two-season default for the history twins, a one-off
// `--seasons`) would otherwise SHRINK the file below what the backtests read; with the floor every
// publish carries them, and the history version (month + seasons) moves the moment the set grows, so
// the first refresh after this change republishes with the third season. The current season is
// config `defaultSeason` of the run's clock (the July rollover), as in phase2.ts historyRunSeasons.
// Grounded on the 2023–2025 release files: docs/evals/phase3-data.md.
import { defaultSeason } from "../../config/schema.js";
import { backtestSeasonsFor } from "../../store/datasets/tables.js";
import type { SourceContext } from "../source.js";
import { MIN_SEASON, runSeasons } from "./release.js";

/**
 * The backtest seasons for the run's clock: [current − 3, current − 1] with current = config
 * `defaultSeason(nowMs)`, none before nflverse's first season. A clock whose season the contract
 * cannot place (before 2001 or after 2999 — a test clock at the epoch) has no floor: [].
 */
export function backtestSeasons(nowMs: number): readonly number[] {
  let current: number;
  try {
    current = defaultSeason(nowMs);
  } catch {
    return Object.freeze([]);
  }
  if (!Number.isInteger(current) || current < 2001 || current > 2999) return Object.freeze([]);
  return Object.freeze(backtestSeasonsFor(current).filter((s) => s >= MIN_SEASON));
}

/**
 * A run's seasons with the backtest floor: the run's seasons (validated and de-duplicated —
 * release.ts `runSeasons`; a malformed season throws) united with `backtestSeasons(nowMs)`,
 * ascending. An EMPTY run stays empty: "no seasons" means no request, never "the floor only".
 */
export function withBacktestSeasons(seasons: readonly number[], nowMs: number): readonly number[] {
  const run = runSeasons(seasons);
  if (run.length === 0) return Object.freeze([]);
  return Object.freeze([...new Set([...run, ...backtestSeasons(nowMs)])].sort((a, b) => a - b));
}

/** `ctx` with its seasons widened by `withBacktestSeasons` (everything else unchanged). */
export function withBacktestContext(ctx: SourceContext): SourceContext {
  return { ...ctx, seasons: withBacktestSeasons(ctx.seasons, ctx.clock.nowMs()) };
}
