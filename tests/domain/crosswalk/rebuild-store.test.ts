// rebuild-store.test.ts — Stage C finding crosswalk-rejected-pair-persists over the REAL store: what
// src/domain/crosswalk/rebuild.ts decides is what src/store/repos/crosswalk.ts holds afterwards, so the
// tool-time path (`get` → crosswalkStatusOfPair, `byGsis`) never serves a pair the rebuild refused
// (plan 07 C1) and the alert and the status agree (plan 06 §1.3; research 04 §C step 5). The model in
// helpers.ts (`storeModel`) stands in for the store elsewhere; this file holds the two to the same
// contract, corrupt rows included. Fictional people only.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetStamp } from "../../../src/domain/analytics/types.js";
import { rebuildCrosswalk } from "../../../src/domain/crosswalk/rebuild.js";
import { crosswalkStatusOfPair } from "../../../src/domain/crosswalk/resolver.js";
import type {
  CrosswalkOverride,
  EspnPlayerIdentity,
  NflRosterPlayer,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../../../src/domain/crosswalk/types.js";
import type { Store } from "../../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "../../store/helpers/env.js";
import { LATER, NOW, fxUnit, identity, pair, synthIdentity, synthRow } from "./helpers.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache("eff-xw-rebuild-");
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

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

function rebuild(
  rows: readonly NflRosterPlayer[],
  players: readonly EspnPlayerIdentity[],
  opts: { readonly now?: string; readonly overrides?: readonly CrosswalkOverride[] } = {},
) {
  const rs = stamp("nflverse:roster_weekly", "nflverse_roster_weekly");
  const us = stamp("espn:players", "espn_players");
  const roster: RosterWeeklyReader = {
    latest: () => ({ rows, stamp: rs }),
    byEspnId: () => ({ rows: [], stamp: rs }),
  };
  const universe: PlayerUniverseReader = {
    all: () => ({ rows: players, stamp: us }),
    byIds: () => ({ rows: [], stamp: us }),
  };
  const out = rebuildCrosswalk({
    season: 2026,
    roster,
    universe,
    nflPlayers: null,
    repository: s.repos.crosswalk,
    overrides: opts.overrides ?? [],
    now: opts.now ?? NOW,
  });
  if (out.status !== "done") throw new Error("expected done");
  return out;
}

/** What a tool reads for a person: the stored row's gsis id and the C1 block. */
function toolView(espnId: number) {
  const row = s.repos.crosswalk.get(espnId);
  return {
    gsis_id: row?.espn_id === espnId ? row.gsis_id : null,
    crosswalk: crosswalkStatusOfPair({ espn_id: espnId, position_id: 3 }, row),
  };
}

const NONE = { gsis_id: null, crosswalk: { method: "none", confidence: 0 } };

/** Inserts rows `upsertDelta` refuses but `get` reads (a corrupt table). */
function plantRaw(values: string): void {
  const raw = new DatabaseSync(t.storePath);
  try {
    raw.exec(
      `INSERT INTO crosswalk (espn_id, gsis_id, method, source, confidence, first_seen, last_seen, last_seen_ms) VALUES ${values}`,
    );
  } finally {
    raw.close();
  }
}

// repro (a): a name match (0.8) that nflverse later gives to another ESPN id
const G = "00-0099701";
const BY_NAME = 9000701;
const BY_ID = 9000702;
const byName = synthIdentity({ espn_id: BY_NAME, full_name: "Orrin Vexley", percent_owned: 40 });
const byId = synthIdentity({ espn_id: BY_ID, full_name: "Orrin Vexley", percent_owned: 40 });
const nameOnly = [synthRow({ gsis_id: G, full_name: "Orrin Vexley", jersey_number: 11 })];
const withId = [
  synthRow({ gsis_id: G, full_name: "Orrin Vexley", jersey_number: 11, espn_id: BY_ID }),
];

describe("over the real store, a rebuild leaves exactly the pairs it accepts", () => {
  it("repro (a): the refuted name match is removed; get, byGsis and the C1 block agree with the run", () => {
    const first = rebuild(nameOnly, [byName]);
    expect(first).toMatchObject({ written: 1, removed: 0 });
    expect(toolView(BY_NAME)).toEqual({
      gsis_id: G,
      crosswalk: { method: "match", confidence: 0.8 },
    });

    const second = rebuild(withId, [byName, byId], { now: LATER });
    expect(second.run.rejected.map((p) => p.espn_id)).toEqual([BY_NAME]);
    expect(second).toMatchObject({ written: 1, removed: 1 });
    expect(toolView(BY_NAME)).toEqual(NONE);
    expect(s.repos.crosswalk.byGsis(G).map((p) => [p.espn_id, p.method])).toEqual([[BY_ID, "id"]]);
    expect(s.repos.crosswalk.count()).toBe(1);

    // the store holds what the run decided: the next rebuild writes and removes nothing
    expect(rebuild(withId, [byName, byId], { now: LATER })).toMatchObject({
      written: 0,
      removed: 0,
    });
  });

  it("repro (c): a removed override's pair is removed", () => {
    const victim = synthIdentity({ espn_id: 9000711, full_name: "Cassius Thornby" });
    const rows = [
      synthRow({
        gsis_id: "00-0099712",
        full_name: "Bastian Quell",
        team: "BUF",
        espn_id: 9000712,
      }),
    ];
    const overrides = [{ espn_id: 9000711, gsis_id: "00-0099712", note: null }];
    expect(rebuild(rows, [victim], { overrides })).toMatchObject({ written: 1, removed: 0 });
    expect(toolView(9000711).crosswalk).toEqual({ method: "override", confidence: 1 });

    const out = rebuild(rows, [victim]);
    expect(out.run.rejected.map((p) => p.espn_id)).toEqual([9000711]);
    expect(out.removed).toBe(1);
    expect(toolView(9000711)).toEqual(NONE);
    expect(s.repos.crosswalk.byGsis("00-0099712")).toEqual([]);
  });

  it("a rewrite between the run's read and its removal is kept (compare-and-delete)", () => {
    const victim = synthIdentity({ espn_id: 9000721, full_name: "Nobody Atall" });
    const stale = pair({
      espn_id: 9000721,
      gsis_id: "00-0099721",
      method: "match",
      confidence: 0.8,
    });
    s.repos.crosswalk.upsertDelta([stale]);
    const rewritten = {
      ...stale,
      method: "override" as const,
      source: "overrides" as const,
      confidence: 1,
    };
    const repo = s.repos.crosswalk;
    const refuting = [
      synthRow({ gsis_id: "00-0099721", full_name: "Someone Else", espn_id: 9000722 }),
    ];
    const rs = stamp("nflverse:roster_weekly", "nflverse_roster_weekly");
    const us = stamp("espn:players", "espn_players");
    const out = rebuildCrosswalk({
      season: 2026,
      // nflverse gives the stored gsis to another ESPN id: the run refutes the pair
      roster: {
        latest: () => ({ rows: refuting, stamp: rs }),
        byEspnId: () => ({ rows: [], stamp: rs }),
      },
      universe: {
        all: () => ({ rows: [victim], stamp: us }),
        byIds: () => ({ rows: [], stamp: us }),
      },
      nflPlayers: null,
      repository: {
        get: (id) => repo.get(id),
        byGsis: (g) => repo.byGsis(g),
        upsertDelta: (ps) => repo.upsertDelta(ps),
        touch: (ids, at) => repo.touch(ids, at),
        count: () => repo.count(),
        countMatchedByName: () => repo.countMatchedByName(),
        removeRejected: (ps) => {
          repo.upsertDelta([rewritten]);
          return repo.removeRejected(ps);
        },
      },
      overrides: [],
      now: NOW,
    });
    if (out.status !== "done") throw new Error("expected done");
    expect(out.run.rejected).toEqual([stale]);
    expect(out.removed).toBe(0);
    expect(repo.get(9000721)).toMatchObject({ method: "override", confidence: 1 });
  });

  it("corrupt rows the run reads are removed too, so a later rebuild never fails on them", () => {
    // a team unit's negative id (a team unit is never paired), an out-of-range confidence, a
    // non-finite one, a bad gsis and method: rows only a corrupt table holds, each read by `get`
    const unit = identity(fxUnit(-16021));
    const ghosts = [9000731, 9000732, 9000733].map((id) =>
      synthIdentity({ espn_id: id, full_name: `Nobody ${String(id)}` }),
    );
    plantRaw(`(-16021, '00-0099730', 'match', 'matcher', 0.8, 'x', 'y', 0),
      (9000731, '00-0099731', 'match', 'matcher', 1.5, 'x', 'y', 0),
      (9000732, '00-0099732', 'id', 'nflverse:roster_weekly', 9e999, 'x', 'y', 0),
      (9000733, 'bad', 'guess', 'nowhere', 0.5, 'x', 'y', 0)`);
    expect(s.repos.crosswalk.count()).toBe(4);

    const out = rebuild([], [unit, ...ghosts]);
    expect(out.run.rejected.map((p) => p.espn_id)).toEqual([-16021, 9000731, 9000732, 9000733]);
    expect(out.removed).toBe(4);
    expect(s.repos.crosswalk.count()).toBe(0);
    expect(rebuild([], [unit, ...ghosts])).toMatchObject({ written: 0, removed: 0 });
  });

  it("pairs never expire: a stored player the run does not resolve keeps his pair", () => {
    const kept = pair({
      espn_id: 9000741,
      gsis_id: "00-0099741",
      method: "match",
      confidence: 0.8,
    });
    s.repos.crosswalk.upsertDelta([kept]);
    expect(rebuild([], [])).toMatchObject({ written: 0, removed: 0 });
    expect(s.repos.crosswalk.get(9000741)).toEqual(kept);
  });
});
