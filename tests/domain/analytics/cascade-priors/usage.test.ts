// usage.test.ts — the team-game usage aggregation from pbp (plan 10 §3.3 "from pbp history"): the
// definitions restated in the domain equal the store's (PBP_KEPT_PLAY_TYPES, RED_ZONE_YARDLINE,
// redZoneFlag, PBP_TARGET_SQL / PBP_CARRY_SQL as a truth table), the aggregation on adversarial
// synthetic plays (sacks, two-point tries, nullified plays, the post-season, bigint and garbage
// cells, depth listings of a week the team did not play), and on the committed real 2023 game
// (fixtures/history: 2023_09_BUF_CIN) every player's targets and carries equal nflverse's
// stats_player_week for that game.
import { describe, expect, it } from "vitest";
import {
  KEPT_PLAY_TYPES,
  RED_ZONE_YARDLINE,
  isCarry,
  isRedZone,
  isTarget,
  usageFromPlays,
  usagePosition,
  type PbpPlay,
} from "../../../../src/domain/analytics/cascade-priors/usage.js";
import {
  PBP_KEPT_PLAY_TYPES,
  RED_ZONE_YARDLINE as STORE_RZ,
  redZoneFlag,
} from "../../../../src/store/datasets/derive.js";
import { PBP_CARRY_SQL, PBP_TARGET_SQL } from "../../../../src/store/datasets/tables.js";
import { hRows } from "../../../sources/nflverse/helpers/history-fixtures.js";

function play(over: Partial<Record<keyof PbpPlay, unknown>> = {}): PbpPlay {
  return {
    season: 2023,
    week: 3,
    season_type: "REG",
    posteam: "T1",
    play_type: "pass",
    pass_attempt: 1,
    rush_attempt: 0,
    sack: 0,
    two_point_attempt: 0,
    receiver_player_id: "a",
    rusher_player_id: null,
    yardline_100: 45,
    ...over,
  };
}

describe("the definitions are the store's", () => {
  it("kept play types and the red-zone line", () => {
    expect([...KEPT_PLAY_TYPES]).toEqual([...PBP_KEPT_PLAY_TYPES]);
    expect(RED_ZONE_YARDLINE).toBe(STORE_RZ);
  });
  it("isRedZone ≡ redZoneFlag = 1 on every yard line and on junk", () => {
    for (const y of [
      -1,
      0,
      1,
      5,
      19,
      20,
      21,
      50,
      99,
      100,
      20.5,
      Number.NaN,
      null,
      undefined,
      "15",
      Infinity,
    ])
      expect(isRedZone(play({ yardline_100: y }))).toBe(
        typeof y === "number" ? redZoneFlag(y) === 1 : false,
      );
    expect(isRedZone(play({ yardline_100: 12n }))).toBe(true);
  });
  it("targets and carries follow the store's SQL predicates (a full truth table)", () => {
    expect(PBP_TARGET_SQL).toBe("pass_attempt = 1 AND sack = 0 AND two_point_attempt = 0");
    expect(PBP_CARRY_SQL).toBe("rush_attempt = 1 AND two_point_attempt = 0");
    for (const pa of [0, 1, null])
      for (const sack of [0, 1, null])
        for (const tp of [0, 1, null])
          for (const rec of ["a", null, ""]) {
            const p = play({
              pass_attempt: pa,
              sack,
              two_point_attempt: tp,
              receiver_player_id: rec,
            });
            expect(isTarget(p)).toBe(pa === 1 && sack === 0 && tp === 0 && rec === "a");
          }
    for (const ra of [0, 1, null])
      for (const tp of [0, 1, null])
        for (const rush of ["b", null]) {
          const p = play({ rush_attempt: ra, two_point_attempt: tp, rusher_player_id: rush });
          expect(isCarry(p)).toBe(ra === 1 && tp === 0 && rush === "b");
        }
  });
  it("position groups: QB/RB/WR/TE, everything else OTHER", () => {
    expect(["QB", "RB", "WR", "TE"].map(usagePosition)).toEqual(["QB", "RB", "WR", "TE"]);
    for (const v of ["FB", "K", "rb", "", null, 3, undefined])
      expect(usagePosition(v)).toBe("OTHER");
  });
});

describe("usageFromPlays", () => {
  const positions = new Map([
    ["a", "WR" as const],
    ["b", "RB" as const],
    ["q", "QB" as const],
  ]);
  it("counts targets, carries and red-zone subsets per team-game; skips what the store skips", () => {
    const rows = usageFromPlays(
      [
        play(),
        play({ yardline_100: 8 }),
        play({ sack: 1 }), // a sack is no target
        play({ two_point_attempt: 1 }), // a two-point try is no target
        play({ play_type: "no_play" }), // nullified
        play({ play_type: null }), // a marker
        play({ season_type: "POST" }), // post-season
        play({ week: 0 }), // no such week
        play({ posteam: null }),
        play({
          play_type: "run",
          pass_attempt: 0,
          rush_attempt: 1n,
          receiver_player_id: null,
          rusher_player_id: "b",
          yardline_100: 3,
        }),
        play({
          play_type: "run",
          pass_attempt: 0,
          rush_attempt: 1,
          receiver_player_id: null,
          rusher_player_id: "q",
          week: 4,
        }),
        play({ receiver_player_id: "z" }), // a receiver with no known position
      ],
      positions,
    );
    expect(rows).toEqual([
      {
        season: 2023,
        week: 3,
        team: "T1",
        player: "a",
        position: "WR",
        depth: null,
        targets: 2,
        carries: 0,
        rz_targets: 1,
        rz_carries: 0,
      },
      {
        season: 2023,
        week: 3,
        team: "T1",
        player: "b",
        position: "RB",
        depth: null,
        targets: 0,
        carries: 1,
        rz_targets: 0,
        rz_carries: 1,
      },
      {
        season: 2023,
        week: 3,
        team: "T1",
        player: "z",
        position: "OTHER",
        depth: null,
        targets: 1,
        carries: 0,
        rz_targets: 0,
        rz_carries: 0,
      },
      {
        season: 2023,
        week: 4,
        team: "T1",
        player: "q",
        position: "QB",
        depth: null,
        targets: 0,
        carries: 1,
        rz_targets: 0,
        rz_carries: 0,
      },
    ]);
  });
  it("depth listings: a zero row for a listed player of a week played, ignored otherwise", () => {
    const rows = usageFromPlays([play()], positions, [
      { season: 2023, week: 3, team: "T1", player: "a", position: "WR", rank: 2 },
      { season: 2023, week: 3, team: "T1", player: "a", position: "WR", rank: 1 }, // min rank
      { season: 2023, week: 3, team: "T1", player: "c", position: "TE", rank: 1 }, // zero row
      { season: 2023, week: 3, team: "T1", player: "b", position: "WR", rank: 3 }, // not his position
      { season: 2023, week: 5, team: "T1", player: "c", position: "TE", rank: 1 }, // a bye
      { season: 2023, week: 3, team: "T2", player: "d", position: "WR", rank: 1 }, // T2 did not play
      { season: 2023, week: 3, team: "T1", player: "e", position: "RB", rank: 0 }, // bad rank
      { season: 2023, week: 3, team: "T1", player: "f", position: "RB", rank: 1.5 }, // bad rank
    ]);
    expect(rows.map((r) => [r.player, r.position, r.depth, r.targets])).toEqual([
      ["a", "WR", 1, 1],
      ["b", "RB", null, 0],
      ["c", "TE", 1, 0],
    ]);
  });
  it("rows come sorted (season, team, week, player) whatever the play order", () => {
    const rows = usageFromPlays(
      [
        play({ posteam: "T2", receiver_player_id: "b" }),
        play({ season: 2022, receiver_player_id: "c" }),
        play({ week: 2, receiver_player_id: "d" }),
        play({ receiver_player_id: "a" }),
      ],
      new Map(),
    );
    expect(rows.map((r) => `${String(r.season)}${r.team}${String(r.week)}${r.player}`)).toEqual([
      "2022T13c",
      "2023T12d",
      "2023T13a",
      "2023T23b",
    ]);
  });
  it("on the committed real 2023 game, every player's targets and carries equal stats_player_week", () => {
    const plays = hRows("nflverse:pbp@2023") as unknown as PbpPlay[];
    const stats = hRows("nflverse:stats_player_week@2023");
    const game = stats.filter((r) => r.week === 9 && r.season_type === "REG");
    const pos = new Map(game.map((r) => [String(r.player_id), usagePosition(r.position_group)]));
    const rows = usageFromPlays(plays, pos).filter((r) => r.week === 9);
    expect(rows.length).toBeGreaterThan(10);
    const teams = new Set(rows.map((r) => r.team));
    let checked = 0;
    for (const s of game) {
      if (!teams.has(String(s.team))) continue;
      const r = rows.find((x) => x.player === s.player_id);
      expect(r?.targets ?? 0).toBe(Number(s.targets ?? 0));
      expect(r?.carries ?? 0).toBe(Number(s.carries ?? 0));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
    // and every pbp row with an opportunity is a known stats player of the game
    for (const r of rows) expect(game.some((s) => s.player_id === r.player)).toBe(true);
  });
});
