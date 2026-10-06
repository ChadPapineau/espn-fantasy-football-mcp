// crosswalk.ts — `eff crosswalk rebuild` and the in-process chain after `refresh nflverse:daily` /
// `refresh espn:players` (plan 06 §1.3 row "crosswalk rebuild — chained after nflverse:daily and
// espn:players": crosswalk rows + the unmatched report; notification when any rostered or ≥ 1 %
// owned ESPN player lacks a confidence-1.0 pair, threshold 1). launchd cannot chain jobs, so the
// refresh that publishes either input runs the rebuild itself (decision recorded). The notification
// carries counts only — never a player name (plan 06 §2).
import type { Config, LenientConfig } from "../config/schema.js";
import { CHECKED_IN_OVERRIDES } from "../domain/crosswalk/overrides.js";
import { rebuildCrosswalk } from "../domain/crosswalk/rebuild.js";
import { statusCounts } from "../domain/crosswalk/resolver.js";
import type { Store } from "../store/types.js";
import { EXIT } from "./exit.js";
import type { CliIo } from "./io.js";
import type { Logger } from "./log.js";
import type { Notifier } from "./notify.js";

/** One rebuild's printable outcome. */
export interface CrosswalkOutcome {
  readonly code: number;
  readonly lines: readonly string[];
  readonly alert: boolean;
}

/** ESPN ids on the user's team in its newest roster snapshot (the alert's "rostered" set). */
export function rosteredIds(store: Store, teamId: number | null): ReadonlySet<number> {
  if (teamId === null) return new Set();
  try {
    const [latest] = store.repos.rosterSnapshots.latestTwo(teamId);
    return new Set(latest?.roster.entries.map((e) => e.player.ref.id) ?? []);
  } catch {
    return new Set();
  }
}

/** Runs one rebuild over the open store (never throws for a data problem). */
export async function runCrosswalkRebuild(
  io: CliIo,
  config: Pick<LenientConfig | Config, "season" | "teamId">,
  store: Store,
  log: Logger,
  notifier: Notifier | null,
): Promise<CrosswalkOutcome> {
  let r;
  try {
    r = rebuildCrosswalk({
      season: config.season,
      roster: store.rosterWeekly,
      universe: store.playerUniverse,
      nflPlayers: store.nflPlayers,
      repository: store.repos.crosswalk,
      overrides: CHECKED_IN_OVERRIDES,
      now: io.clock.nowIso(),
      rostered: rosteredIds(store, config.teamId),
    });
  } catch (e) {
    log.error("crosswalk.failed", { error: e });
    if (notifier !== null) await notifier.failure("crosswalk-rebuild", "INTERNAL");
    return { code: EXIT.error, lines: ["crosswalk rebuild FAILED (see the log)"], alert: false };
  }
  if (r.status === "skipped")
    return {
      code: EXIT.ok,
      lines: [`crosswalk rebuild skipped: ${r.reason}`],
      alert: false,
    };
  const c = statusCounts(r.run.report);
  const lines = [
    `crosswalk rebuild: ${String(r.written)} pair(s) written, ${String(c.matched)} matched, ${String(c.unmatched_rostered)} rostered and ${String(c.unmatched_top_owned)} top-owned unmatched`,
  ];
  log.info("crosswalk.rebuilt", { written: r.written, ...c, alert: r.run.alert.count });
  if (r.run.alert.triggered) {
    lines.push(
      `→ ${String(r.run.alert.count)} rostered or ≥ 1 %-owned ESPN player(s) lack a confident nflverse pair (add an override in data/crosswalk/overrides.json)`,
    );
    if (notifier !== null)
      await notifier.info(
        `Crosswalk: ${String(r.run.alert.count)} rostered or top-owned ESPN player(s) lack a confident match — run \`eff status\``,
      );
  }
  return { code: EXIT.ok, lines, alert: r.run.alert.triggered };
}
