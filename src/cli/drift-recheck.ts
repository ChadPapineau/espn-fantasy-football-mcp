// drift-recheck.ts — which red drift views the daily probe can re-judge, and the command that
// re-judges the rest (src/cli/refresh-drift.ts; plan 01 §7). A light module: the probe, doctor and
// the refresh parser name the command without loading the ESPN job stack.
import { parseDiffs } from "../drift/index.js";
import type { EspnView } from "../providers/espn/types.js";

/** `eff refresh espn:drift`: re-read every view drift_state marks red. */
export const DRIFT_REFRESH_TARGET = "espn:drift";

/** The views `eff probe` itself reads (its host and shape probes, src/cli/probe.ts). */
export const PROBE_VIEWS: readonly EspnView[] = Object.freeze([
  "proTeamSchedules_wl",
  "mSettings",
  "mNav",
  "mTeam",
]);

/** The views a drift row marks red (a removed key), in the row's order. */
export function redViews(diffJson: string): EspnView[] {
  return parseDiffs(diffJson)
    .filter((d) => d.removed.length > 0)
    .map((d) => d.view);
}

/**
 * The red views of a row the daily probe never reads: only a read of each can clear it, so doctor
 * and the probe name `eff refresh espn:drift` for them (Stage C final gate: mPendingTransactions
 * stayed red 16 days while every probe was green, and "run eff probe" went in a circle).
 */
export function redViewsOutsideProbe(diffJson: string): EspnView[] {
  return redViews(diffJson).filter((v) => !PROBE_VIEWS.includes(v));
}
