// rostered.ts — the crosswalk alert's "rostered" set from the store's roster snapshots (research 04
// §C step 5: the alert covers "ESPN ids on any fantasy roster of the league"; plan 06 §1.3 row
// "crosswalk rebuild"; plan 07 G1 `crosswalk.unmatched_rostered`, which follows the rebuild's alert
// rule "so status and the alert agree"). One rule for both readers: the rebuild (src/cli/crosswalk.ts,
// which has no provider and reads only the store) and espn_get_status's fallback when no roster is
// cached (src/mcp/tools/ops.ts). Before, the rebuild read the owner's own team only, so a rival's
// rostered, under-1 %-owned unpaired player was never alerted and the two surfaces gave different
// counts for one store (Stage C finding status-crosswalk-counts-disagree-alert). Pure. New here.
import type { RosterSnapshot, RosterSnapshotRepository } from "../league/types.js";

/** The highest team id probed for the store's roster snapshots (ESPN leagues hold ≤ 20 teams). */
export const SNAPSHOT_TEAM_PROBE_MAX = 40;

/** Each team's newest stored roster snapshot (teams 1 … SNAPSHOT_TEAM_PROBE_MAX that have one). */
export function newestTeamSnapshots(
  snapshots: Pick<RosterSnapshotRepository, "latestTwo">,
): readonly RosterSnapshot[] {
  const out: RosterSnapshot[] = [];
  for (let t = 1; t <= SNAPSHOT_TEAM_PROBE_MAX; t++) {
    const snap = snapshots.latestTwo(t)[0];
    if (snap !== undefined) out.push(snap);
  }
  return out;
}

/**
 * The ESPN ids on EVERY league roster in the store's newest roster-snapshot run (`eff snapshot
 * rosters` stores every team's in one run): the teams whose newest snapshot was taken at the newest
 * instant any team's was — a team's older snapshot is no longer its roster. Null when no team has
 * a snapshot (the set cannot be read; never an empty "nobody is rostered").
 */
export function snapshotLeagueRostered(
  snapshots: Pick<RosterSnapshotRepository, "latestTwo">,
): ReadonlySet<number> | null {
  const teams = newestTeamSnapshots(snapshots);
  if (teams.length === 0) return null;
  // an unparseable stamp sorts before every real one (it can only be the run when no stamp parses)
  const at = (s: RosterSnapshot): number => {
    const t = Date.parse(s.taken_at);
    return Number.isFinite(t) ? t : -Infinity;
  };
  const newest = Math.max(...teams.map(at));
  return new Set(
    teams
      .filter((s) => at(s) === newest)
      .flatMap((s) => s.roster.entries.map((e) => e.player.ref.id)),
  );
}
