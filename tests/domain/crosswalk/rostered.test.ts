// rostered.test.ts — the crosswalk alert's "rostered" set from the store's roster snapshots
// (src/domain/crosswalk/rostered.ts; research 04 §C step 5: "ESPN ids on any fantasy roster of the
// league"). One rule for `eff crosswalk rebuild` and espn_get_status's snapshot fallback (Stage C
// finding status-crosswalk-counts-disagree-alert): every team's newest snapshot taken in the newest
// run, never one team's, never an older run.
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_TEAM_PROBE_MAX,
  newestTeamSnapshots,
  snapshotLeagueRostered,
} from "../../../src/domain/crosswalk/rostered.js";
import type { RosterSnapshot, RosterSnapshotRepository } from "../../../src/domain/league/types.js";

function snap(team: number, takenAt: string, ids: readonly number[]): RosterSnapshot {
  return {
    team_id: team,
    week: 5,
    taken_at: takenAt,
    roster: { entries: ids.map((id) => ({ player: { ref: { id } } })) },
  } as unknown as RosterSnapshot;
}

/** A repository over per-team snapshot lists (newest first, as latestTwo returns them). */
function repo(byTeam: Readonly<Record<number, readonly RosterSnapshot[]>>): {
  r: Pick<RosterSnapshotRepository, "latestTwo">;
  asked: number[];
} {
  const asked: number[] = [];
  return {
    asked,
    r: {
      latestTwo: (t) => {
        asked.push(t);
        return (byTeam[t] ?? []).slice(0, 2);
      },
    },
  };
}

const RUN_1 = "2026-10-05T07:00:00.000Z";
const RUN_2 = "2026-10-06T07:00:00.000Z";

describe("snapshotLeagueRostered (Stage C status-crosswalk-counts-disagree-alert)", () => {
  it("is every team's roster in the newest run — a rival's players included, not the owner's alone", () => {
    const { r } = repo({
      1: [snap(1, RUN_2, [11, 12])],
      2: [snap(2, RUN_2, [21, 22])],
      10: [snap(10, RUN_2, [101])],
    });
    expect(snapshotLeagueRostered(r)).toEqual(new Set([11, 12, 21, 22, 101]));
  });

  it("a team's older snapshot is no longer its roster: only the newest run counts", () => {
    const { r } = repo({
      1: [snap(1, RUN_2, [11]), snap(1, RUN_1, [19])],
      // team 2 missed the newest run: its older roster is not read as current
      2: [snap(2, RUN_1, [21])],
      3: [snap(3, RUN_2, [31])],
    });
    expect(snapshotLeagueRostered(r)).toEqual(new Set([11, 31]));
  });

  it("null when no team has a snapshot — never an empty 'nobody is rostered'", () => {
    const { r, asked } = repo({});
    expect(snapshotLeagueRostered(r)).toBeNull();
    // every team id up to the probe bound is asked (ESPN leagues hold ≤ 20 teams)
    expect(asked).toEqual(Array.from({ length: SNAPSHOT_TEAM_PROBE_MAX }, (_, i) => i + 1));
  });

  it("an unparseable stamp never outranks a real one, and counts only when no stamp parses", () => {
    const mixed = repo({ 1: [snap(1, "not a time", [11])], 2: [snap(2, RUN_1, [21])] });
    expect(snapshotLeagueRostered(mixed.r)).toEqual(new Set([21]));
    const none = repo({ 1: [snap(1, "x", [11])], 2: [snap(2, "y", [21])] });
    expect(snapshotLeagueRostered(none.r)).toEqual(new Set([11, 21]));
  });

  it("newestTeamSnapshots reads each team's newest snapshot once", () => {
    const { r } = repo({
      4: [snap(4, RUN_2, [41]), snap(4, RUN_1, [49])],
      7: [snap(7, RUN_1, [71])],
    });
    expect(newestTeamSnapshots(r).map((s) => [s.team_id, s.taken_at])).toEqual([
      [4, RUN_2],
      [7, RUN_1],
    ]);
  });
});
