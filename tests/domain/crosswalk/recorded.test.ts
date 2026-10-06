// recorded.test.ts — plan 10 A6a over ESPN's OWN identities: every fixture-roster player and unit,
// read back from the recorded players_wl (fullName, defaultPositionId, proTeamId, percentOwned) and
// rostered per the recorded mRoster pages, resolves with confidence 1, and the alert count of
// rostered or ≥ 1 %-owned players without a confidence-1.0 pair is 0 (research 04 §C step 5).
import { describe, expect, it } from "vitest";
import { crosswalkStatus } from "../../../src/domain/crosswalk/resolver.js";
import {
  FIXTURE,
  fixturePlayersRecords,
  fixtureRosterRows,
  recordedIdentity,
  recordedRosteredIds,
  run,
} from "./helpers.js";

describe("A6a on the recorded ESPN identities", () => {
  const identities = [...FIXTURE.players, ...FIXTURE.team_units].map((p) =>
    recordedIdentity(p.espn_id),
  );
  const rostered = recordedRosteredIds();

  it("the recorded identities are the fixture roster's (names, positions, pro teams)", () => {
    for (const p of [...FIXTURE.players, ...FIXTURE.team_units]) {
      const id = recordedIdentity(p.espn_id);
      expect(id.full_name).toBe(p.espn_name);
      expect(id.position_id).toBe(p.espn_position_id);
      expect(id.pro_team_id).toBe(p.espn_pro_team_id);
      expect(id.pro_team).toBe(p.espn_team);
    }
  });

  it("most fixture players are rostered in a recorded league, and every one is ≥ 1 % owned", () => {
    const onRoster = FIXTURE.players.filter((p) => rostered.has(p.espn_id));
    expect(onRoster.length).toBeGreaterThanOrEqual(20);
    for (const id of identities) expect(id.percent_owned ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("every player resolves by id at 1.0, every unit by its team; the alert count is 0", () => {
    const r = run(identities, {
      rows: fixtureRosterRows(),
      records: fixturePlayersRecords(),
      rostered,
    });
    for (const p of FIXTURE.players) {
      const res = r.resolved.find((x) => x.espn_id === p.espn_id)?.resolution;
      expect(res, p.espn_name).toMatchObject({ status: "matched", pair: { gsis_id: p.gsis_id } });
      if (res !== undefined) expect(crosswalkStatus(res)).toEqual({ method: "id", confidence: 1 });
    }
    expect(r.team_units).toEqual(
      FIXTURE.team_units.map((u) => ({ espn_id: u.espn_id, nfl_team: u.team })),
    );
    expect(r.alert).toEqual({ threshold: 1, count: 0, espn_ids: [], triggered: false });
    expect(r.report.unmatched_rostered).toEqual([]);
    expect(r.report.unmatched_top_owned).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("without nflverse ids, everyone but the nickname and the free agent still resolves (0.8)", () => {
    const r = run(identities, {
      rows: fixtureRosterRows().map((row) => ({ ...row, espn_id: null })),
      records: [],
      rostered,
    });
    const expectedGaps = FIXTURE.players
      .filter((p) => p.tags.includes("nickname_differs") || p.tags.includes("free_agent"))
      .map((p) => p.espn_id)
      .sort((a, b) => a - b);
    const lowOrMissing = FIXTURE.players
      .filter((p) => !expectedGaps.includes(p.espn_id))
      .map((p) => p.espn_id);
    // the alert counts every rostered / ≥ 1 %-owned player without a 1.0 pair — all of them here
    expect(r.alert.espn_ids).toEqual([...lowOrMissing, ...expectedGaps].sort((a, b) => a - b));
    expect(r.report.matched).toBe(FIXTURE.players.length - expectedGaps.length);
    const unresolved = [...r.report.unmatched_rostered, ...r.report.unmatched_top_owned]
      .map((e) => e.player.espn_id)
      .sort((a, b) => a - b);
    expect(unresolved).toEqual(expectedGaps);
  });
});
