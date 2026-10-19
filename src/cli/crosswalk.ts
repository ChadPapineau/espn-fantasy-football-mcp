// crosswalk.ts — `eff crosswalk rebuild` and the in-process chain after `refresh nflverse:daily` /
// `refresh espn:players` (plan 06 §1.3 row "crosswalk rebuild — chained after nflverse:daily and
// espn:players": crosswalk rows + the unmatched report; notification when any rostered or ≥ 1 %
// owned ESPN player lacks a confidence-1.0 pair, threshold 1). launchd cannot chain jobs, so the
// refresh that publishes either input runs the rebuild itself (decision recorded). The notification
// carries counts only — never a player name (plan 06 §2). When the rebuild alerts, it lists each
// alerted ESPN id with why it lacks a confidence-1.0 pair (ids, codes and numbers only — never a
// name) and how an override is really made, and the notification points at this command (Stage C
// finding crosswalk-alert-remediation-dead: the advice named a file the runtime never reads and an
// `eff status` that has no crosswalk section). Rostered players are listed first (the cap once hid
// every rostered one behind ≥ 1 %-owned ids), `--all` lists every alerted id, the advice names every
// key an override row needs (`note` too: the compiled copy's type requires it), and the summary says
// how many matched players were paired only by name — research 04 §C step 2's "matched by name",
// the players the alert lists although they count as matched.
import type { Config, LenientConfig } from "../config/schema.js";
import { CHECKED_IN_OVERRIDES } from "../domain/crosswalk/overrides.js";
import { rebuildCrosswalk } from "../domain/crosswalk/rebuild.js";
import {
  statusCounts,
  type CrosswalkDiagnostic,
  type CrosswalkResolution,
  type CrosswalkRun,
} from "../domain/crosswalk/resolver.js";
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

/** Most alerted players the rebuild lists (the rest are counted). */
export const MAX_ALERT_LINES = 25;

/**
 * How an override is made (research 04 §C step 3): the runtime reads only the overrides compiled into
 * the build (`CHECKED_IN_OVERRIDES`; the package ships `dist`, not `data/`), so an override is a code
 * change in a checkout — the JSON file and its compiled copy together (a test holds them equal), each
 * row with every key `CrosswalkOverride` requires — and it lives in that build only: the launchd jobs'
 * chained rebuild runs the build they were installed from, and one without the row drops the pair
 * again (a `stale_override_pair` diagnostic).
 */
export const OVERRIDE_HOWTO =
  "an override is a code change in a checkout: add {espn_id, gsis_id, note} (note: a short public reason, or null) to data/crosswalk/overrides.json AND to CHECKED_IN_OVERRIDES in src/domain/crosswalk/overrides.ts (a test holds them equal), `npm run build`, then `eff crosswalk rebuild` — from the install your launchd jobs and MCP client run (`eff print-config` shows its path; else `eff install-launchd` from this one), or the next chained rebuild drops it";

const GSIS_SHOWN = 3;

/** Why one alerted ESPN player lacks a confidence-1.0 pair (ids, codes and numbers only). */
export function alertReason(resolution: CrosswalkResolution): string {
  const ids = (c: readonly { readonly gsis_id: string }[]): string =>
    c.length === 0
      ? ""
      : ` — candidates ${c
          .slice(0, GSIS_SHOWN)
          .map((x) => x.gsis_id)
          .join(", ")}${c.length > GSIS_SHOWN ? ` (+${String(c.length - GSIS_SHOWN)})` : ""}`;
  switch (resolution.status) {
    case "matched":
      return `paired by ${resolution.pair.method} only (confidence ${String(resolution.pair.confidence)}) with ${resolution.pair.gsis_id}`;
    case "ambiguous":
      return `ambiguous between ${String(resolution.candidates.length)} nflverse player(s)${ids(resolution.candidates)}`;
    case "unmatched":
      return `no nflverse pair (${resolution.reason})${ids(resolution.candidates)}`;
    case "team_unit":
      return "a team unit (paired by its team)";
  }
}

/** The diagnostics a rebuild noticed, by code, with the ESPN ids involved (none: no line). */
export function diagnosticsLine(diagnostics: readonly CrosswalkDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;
  const byCode = new Map<string, number[]>();
  for (const d of diagnostics) {
    const ids = byCode.get(d.code) ?? [];
    if (d.espn_id !== null && !ids.includes(d.espn_id)) ids.push(d.espn_id);
    byCode.set(d.code, ids);
  }
  const parts = [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, ids]) => {
      const n = diagnostics.filter((d) => d.code === code).length;
      const shown = ids.slice(0, 5).map((i) => `espn ${String(i)}`);
      return `${code} ×${String(n)}${shown.length > 0 ? ` (${shown.join(", ")}${ids.length > 5 ? ", …" : ""})` : ""}`;
    });
  return `  diagnostics: ${parts.join("; ")}`;
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

/** The alerted ids in listing order: the user's rostered players first, each group ascending. */
export function alertOrder(
  espnIds: readonly number[],
  rostered: ReadonlySet<number>,
): readonly number[] {
  return [
    ...espnIds.filter((id) => rostered.has(id)),
    ...espnIds.filter((id) => !rostered.has(id)),
  ];
}

/**
 * Matched players paired with less than confidence 1.0 — by name, team and position, never by an id
 * (research 04 §C step 2: "matched by name").
 */
export function matchedByName(run: Pick<CrosswalkRun<unknown>, "resolved">): number {
  return run.resolved.filter(
    (p) => p.resolution.status === "matched" && p.resolution.pair.confidence < 1,
  ).length;
}

/** Runs one rebuild over the open store (never throws for a data problem). */
export async function runCrosswalkRebuild(
  io: CliIo,
  config: Pick<LenientConfig | Config, "season" | "teamId">,
  store: Store,
  log: Logger,
  notifier: Notifier | null,
  opts: { readonly all?: boolean } = {},
): Promise<CrosswalkOutcome> {
  const rostered = rosteredIds(store, config.teamId);
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
      rostered,
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
  const byName = matchedByName(r.run);
  const lines = [
    `crosswalk rebuild: ${String(r.written)} pair(s) written, ${String(c.matched)} matched (${String(byName)} of them only by name), ${String(c.unmatched_rostered)} rostered and ${String(c.unmatched_top_owned)} top-owned unmatched`,
  ];
  log.info("crosswalk.rebuilt", {
    written: r.written,
    ...c,
    matched_by_name: byName,
    alert: r.run.alert.count,
  });
  if (r.run.alert.triggered) {
    lines.push(
      `→ ${String(r.run.alert.count)} rostered or ≥ 1 %-owned ESPN player(s) lack a confident nflverse pair:`,
    );
    const byId = new Map(r.run.resolved.map((p) => [p.espn_id, p]));
    const ordered = alertOrder(r.run.alert.espn_ids, rostered);
    const shown = opts.all === true ? ordered : ordered.slice(0, MAX_ALERT_LINES);
    for (const id of shown) {
      const p = byId.get(id);
      const why = rostered.has(id) ? "rostered" : "≥ 1 % owned";
      lines.push(
        `    espn ${String(id)} (${why}): ${p === undefined ? "not in this run" : alertReason(p.resolution)}`,
      );
    }
    const hidden = ordered.slice(shown.length);
    if (hidden.length > 0) {
      const hiddenRostered = hidden.filter((id) => rostered.has(id)).length;
      lines.push(
        `    … ${String(hidden.length)} more, ${hiddenRostered === 0 ? "none" : String(hiddenRostered)} rostered (\`eff crosswalk rebuild --all\` lists every one)`,
      );
    }
    lines.push(`  ${OVERRIDE_HOWTO}`);
    if (notifier !== null)
      await notifier.info(
        `Crosswalk: ${String(r.run.alert.count)} rostered or top-owned ESPN player(s) lack a confident match — run \`eff crosswalk rebuild\` for the list`,
      );
  }
  const diag = diagnosticsLine(r.run.diagnostics);
  if (diag !== null) lines.push(diag);
  return { code: EXIT.ok, lines, alert: r.run.alert.triggered };
}
