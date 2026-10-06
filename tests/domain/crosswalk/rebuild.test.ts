// rebuild.test.ts — src/domain/crosswalk/rebuild.ts, the `crosswalk rebuild` use case over fake ports
// (plan 06 §1.3: roster_weekly + ds_players + overrides + persisted pairs → delta writes + report;
// research 04 §C step 2: nflverse players asked only for the ids roster_weekly lacks).
import { describe, expect, it } from "vitest";
import type { DatasetStamp } from "../../../src/domain/analytics/types.js";
import { rebuildCrosswalk } from "../../../src/domain/crosswalk/rebuild.js";
import type {
  CrosswalkPair,
  CrosswalkRepository,
  EspnPlayerIdentity,
  NflPlayerRecord,
  NflPlayersReader,
  NflRosterPlayer,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../../../src/domain/crosswalk/types.js";
import {
  FIXTURE,
  LATER,
  NOW,
  fixturePlayersRecords,
  fixtureRosterRows,
  fx,
  fxUnit,
  identity,
} from "./helpers.js";

function stamp(source: DatasetStamp["source"], cls: DatasetStamp["freshness_class"]): DatasetStamp {
  return {
    source,
    as_of: NOW,
    fetched_at: NOW,
    checked_at: NOW,
    freshness_class: cls,
    file_version: "v1",
  };
}
const ROSTER_STAMP = stamp("nflverse:roster_weekly", "nflverse_roster_weekly");
const UNIVERSE_STAMP = stamp("espn:players", "espn_players");
const PLAYERS_STAMP = stamp("nflverse:players", "nflverse_players");

function rosterReader(rows: readonly NflRosterPlayer[], loaded = true): RosterWeeklyReader {
  return {
    latest: () => ({ rows, stamp: loaded ? ROSTER_STAMP : null }),
    byEspnId: () => ({ rows: [], stamp: null }),
  };
}

function universeReader(rows: readonly EspnPlayerIdentity[], loaded = true): PlayerUniverseReader {
  return {
    all: () => ({ rows, stamp: loaded ? UNIVERSE_STAMP : null }),
    byIds: () => ({ rows: [], stamp: null }),
  };
}

function playersReader(records: readonly NflPlayerRecord[]): NflPlayersReader & {
  readonly asked: number[][];
} {
  const asked: number[][] = [];
  return {
    asked,
    byEspnIds: (ids) => {
      asked.push([...ids]);
      return {
        rows: records.filter((r) => r.espn_id !== null && ids.includes(r.espn_id)),
        stamp: PLAYERS_STAMP,
      };
    },
  };
}

function memoryRepo(initial: readonly CrosswalkPair[] = []): CrosswalkRepository & {
  readonly upserts: CrosswalkPair[][];
  readonly touches: number[][];
} {
  const pairs = new Map(initial.map((p) => [p.espn_id, p]));
  const upserts: CrosswalkPair[][] = [];
  const touches: number[][] = [];
  return {
    upserts,
    touches,
    get: (id) => pairs.get(id) ?? null,
    byGsis: (g) => [...pairs.values()].filter((p) => p.gsis_id === g),
    upsertDelta: (ps) => {
      upserts.push([...ps]);
      for (const p of ps) pairs.set(p.espn_id, p);
      return ps.length;
    },
    touch: (ids) => {
      touches.push([...ids]);
      return { written: true };
    },
    count: () => pairs.size,
  };
}

const UNIVERSE = (): EspnPlayerIdentity[] => [
  ...FIXTURE.players.map((p) => identity(p)),
  ...FIXTURE.team_units.map((u) => identity(u)),
];

describe("rebuildCrosswalk", () => {
  it("resolves the fixture universe, asks nflverse players only for the unpaired ids, writes the delta", () => {
    const players = playersReader(fixturePlayersRecords());
    const repo = memoryRepo();
    const out = rebuildCrosswalk({
      season: FIXTURE.season,
      roster: rosterReader(fixtureRosterRows()),
      universe: universeReader(UNIVERSE()),
      nflPlayers: players,
      repository: repo,
      overrides: [],
      now: NOW,
      rostered: new Set(FIXTURE.players.map((p) => p.espn_id)),
    });
    if (out.status !== "done") throw new Error("expected done");
    // the free agent is the only person roster_weekly does not pair; team units are never asked
    expect(players.asked).toEqual([[fx("Joe Mixon").espn_id]]);
    expect(out.written).toBe(FIXTURE.players.length);
    expect(repo.upserts).toHaveLength(1);
    expect(out.touched).toBeNull();
    expect(out.run.alert.triggered).toBe(false);
    expect(out.run.team_units.map((t) => t.espn_id)).toContain(fxUnit(-16014).espn_id);
    expect(out.stamps).toEqual({
      roster_weekly: ROSTER_STAMP,
      players_universe: UNIVERSE_STAMP,
      nfl_players: PLAYERS_STAMP,
    });
    expect(repo.count()).toBe(FIXTURE.players.length);
  });

  it("a second run writes nothing and touches every unchanged pair", () => {
    const repo = memoryRepo();
    const deps = {
      season: FIXTURE.season,
      roster: rosterReader(fixtureRosterRows()),
      universe: universeReader(UNIVERSE()),
      nflPlayers: playersReader(fixturePlayersRecords()),
      repository: repo,
      overrides: [],
      now: NOW,
    };
    rebuildCrosswalk(deps);
    const second = rebuildCrosswalk({ ...deps, now: LATER });
    if (second.status !== "done") throw new Error("expected done");
    expect(second.written).toBe(0);
    expect(repo.upserts).toHaveLength(1);
    expect(second.touched).toEqual({ written: true });
    expect(repo.touches).toEqual([FIXTURE.players.map((p) => p.espn_id)]);
  });

  it("does not ask nflverse players when every person is paired, or when no reader exists", () => {
    const players = playersReader([]);
    const roster = rosterReader(fixtureRosterRows());
    const universe = universeReader(
      FIXTURE.players
        .filter((p) => p.id_source === "nflverse:roster_weekly")
        .map((p) => identity(p)),
    );
    const a = rebuildCrosswalk({
      season: 2026,
      roster,
      universe,
      nflPlayers: players,
      repository: memoryRepo(),
      overrides: [],
      now: NOW,
    });
    expect(players.asked).toEqual([]);
    expect(a.stamps.nfl_players).toBeNull();
    const b = rebuildCrosswalk({
      season: 2026,
      roster,
      universe: universeReader([identity(fx("Joe Mixon"))]),
      nflPlayers: null,
      repository: memoryRepo(),
      overrides: [],
      now: NOW,
      rostered: new Set([fx("Joe Mixon").espn_id]),
    });
    if (b.status !== "done") throw new Error("expected done");
    expect(b.run.alert.espn_ids).toEqual([fx("Joe Mixon").espn_id]);
  });

  it.each([
    ["roster_weekly never loaded", false, true, "roster_weekly_never_loaded"],
    ["the universe never loaded", true, false, "players_universe_never_loaded"],
  ] as const)("skips, writing nothing, when %s", (_label, rosterLoaded, universeLoaded, reason) => {
    const repo = memoryRepo();
    const out = rebuildCrosswalk({
      season: 2026,
      roster: rosterReader([], rosterLoaded),
      universe: universeReader(UNIVERSE(), universeLoaded),
      nflPlayers: playersReader([]),
      repository: repo,
      overrides: [],
      now: NOW,
    });
    expect(out).toMatchObject({ status: "skipped", reason });
    expect(repo.upserts).toEqual([]);
    expect(repo.touches).toEqual([]);
  });

  it("asks for each unpaired person id once, ascending, never a team unit or a malformed id", () => {
    const players = playersReader(fixturePlayersRecords());
    const mixon = identity(fx("Joe Mixon"));
    const stranger = { ...mixon, espn_id: 9000500, full_name: "Orrin Vexley" };
    rebuildCrosswalk({
      season: 2026,
      roster: rosterReader(fixtureRosterRows()),
      universe: universeReader([
        stranger,
        mixon,
        stranger,
        identity(fxUnit(-16021)),
        { ...mixon, espn_id: 0 },
      ]),
      nflPlayers: players,
      repository: memoryRepo(),
      overrides: [],
      now: NOW,
    });
    expect(players.asked).toEqual([[mixon.espn_id, 9000500]]);
  });

  it("an override from the checked-in list wins through the rebuild too", () => {
    const allen = fx("Josh Allen");
    const out = rebuildCrosswalk({
      season: 2026,
      roster: rosterReader(fixtureRosterRows()),
      universe: universeReader([identity(allen)]),
      nflPlayers: null,
      repository: memoryRepo(),
      overrides: [{ espn_id: allen.espn_id, gsis_id: allen.gsis_id, note: null }],
      now: NOW,
    });
    if (out.status !== "done") throw new Error("expected done");
    expect(out.run.pairs[0]).toMatchObject({ method: "override", source: "overrides" });
  });
});
