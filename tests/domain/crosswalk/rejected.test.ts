// rejected.test.ts — Stage C finding crosswalk-rejected-pair-persists: a stored pair the run no longer
// accepts leaves the store. src/domain/crosswalk/resolver.ts names those pairs (`CrosswalkRun.rejected`)
// and src/domain/crosswalk/rebuild.ts removes them (`CrosswalkRepository.removeRejected`), so the
// tool-time path — `crosswalkStatusOfPair` over the stored row, `byGsis` back from a gsis id — never
// serves a pair the rebuild refused (plan 07 C1), and the alert and the status agree (plan 06 §1.3;
// research 04 §C step 5). Fictional people only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DatasetStamp } from "../../../src/domain/analytics/types.js";
import { rebuildCrosswalk } from "../../../src/domain/crosswalk/rebuild.js";
import {
  crosswalkStatusOfPair,
  type CrosswalkResolution,
  type CrosswalkRun,
} from "../../../src/domain/crosswalk/resolver.js";
import type {
  CrosswalkOverride,
  CrosswalkPair,
  CrosswalkSource,
  EspnPlayerIdentity,
  NflRosterPlayer,
  PlayerUniverseReader,
  RosterWeeklyReader,
} from "../../../src/domain/crosswalk/types.js";
import {
  LATER,
  NOW,
  fx,
  fxUnit,
  identity,
  pair,
  persistedOf,
  playersRecord,
  rosterRow,
  run,
  samePair,
  storeModel,
  synthIdentity,
  synthRow,
  type StoreModel,
} from "./helpers.js";

function resolutionOf(r: CrosswalkRun<EspnPlayerIdentity>, espnId: number): CrosswalkResolution {
  const hit = r.resolved.find((x) => x.espn_id === espnId);
  if (hit === undefined) throw new Error(`no resolution for ${String(espnId)}`);
  return hit.resolution;
}

function codesOf(r: CrosswalkRun<EspnPlayerIdentity>, espnId: number): string[] {
  return r.diagnostics.filter((d) => d.espn_id === espnId).map((d) => d.code);
}

/** What `rebuildCrosswalk` does with a run, over the store model. */
function apply(store: StoreModel, r: CrosswalkRun<EspnPlayerIdentity>): void {
  if (r.changed.length > 0) store.upsertDelta(r.changed);
  if (r.rejected.length > 0) store.removeRejected(r.rejected);
}

// The finding's repro (a): a WR matched by name + team + position (0.8, stored); nflverse then gives
// that gsis id to another ESPN player.
const G = "00-0099201";
const BY_NAME = 9000201;
const BY_ID = 9000202;
const nameOnlyRows = (): NflRosterPlayer[] => [
  synthRow({ gsis_id: G, full_name: "Orrin Vexley", jersey_number: 11 }),
];
const idRows = (): NflRosterPlayer[] => [
  synthRow({ gsis_id: G, full_name: "Orrin Vexley", jersey_number: 11, espn_id: BY_ID }),
];
const byName = synthIdentity({ espn_id: BY_NAME, full_name: "Orrin Vexley", percent_owned: 40 });
const byId = synthIdentity({ espn_id: BY_ID, full_name: "Orrin Vexley", percent_owned: 40 });

// The finding's repro (c): an override pointed ESPN 9000401 at ESPN 9000402's gsis id, then the
// override was removed from the list.
const OVERRIDDEN = 9000401;
const G_OTHER = "00-0099402";
const overriddenRows = (): NflRosterPlayer[] => [
  synthRow({ gsis_id: G_OTHER, full_name: "Bastian Quell", team: "BUF", espn_id: 9000402 }),
];
const overridden = synthIdentity({ espn_id: OVERRIDDEN, full_name: "Cassius Thornby" });
const overridePair = pair({
  espn_id: OVERRIDDEN,
  gsis_id: G_OTHER,
  method: "override",
  source: "overrides",
});

describe("CrosswalkRun.rejected — the stored pairs a run no longer accepts", () => {
  it("a name match nflverse now gives to another ESPN id is rejected; the id pair takes the gsis", () => {
    const first = run([byName], { rows: nameOnlyRows(), records: [] });
    const stored = first.pairs[0];
    expect(stored).toMatchObject({
      espn_id: BY_NAME,
      gsis_id: G,
      method: "match",
      confidence: 0.8,
    });
    expect(first.rejected).toEqual([]);

    const second = run([byName, byId], {
      rows: idRows(),
      records: [],
      persisted: persistedOf(first.pairs),
    });
    expect(resolutionOf(second, BY_NAME).status).toBe("ambiguous");
    expect(codesOf(second, BY_NAME)).toEqual(["persisted_id_conflict", "candidate_id_conflict"]);
    expect(second.rejected).toEqual([stored]);
    expect(second.pairs).toEqual([
      expect.objectContaining({ espn_id: BY_ID, gsis_id: G, method: "id", confidence: 1 }),
    ]);
  });

  it("a removed override's pair the matcher cannot replace is rejected", () => {
    const r = run([overridden], {
      rows: overriddenRows(),
      records: [],
      persisted: persistedOf([overridePair]),
    });
    expect(resolutionOf(r, OVERRIDDEN)).toMatchObject({ status: "unmatched" });
    expect(codesOf(r, OVERRIDDEN)).toEqual(["stale_override_pair"]);
    expect(r.rejected).toEqual([overridePair]);
    expect(r.pairs).toEqual([]);
  });

  it("a removed override's pair the matcher finds again is rewritten, not rejected", () => {
    const lemon = fx("Makai Lemon");
    const prev = pair({
      espn_id: lemon.espn_id,
      gsis_id: lemon.gsis_id,
      method: "override",
      source: "overrides",
    });
    const r = run([identity(lemon)], {
      rows: [rosterRow(lemon, { espn_id: null })],
      records: [],
      persisted: persistedOf([prev]),
    });
    expect(r.changed).toEqual([
      expect.objectContaining({ method: "match", gsis_id: lemon.gsis_id }),
    ]);
    expect(r.rejected).toEqual([]);
  });

  it.each([
    ["a bad gsis", { gsis_id: "00-1" }],
    ["an unknown method", { method: "guess" }],
    ["method none", { method: "none" }],
    ["an unknown source", { source: "dynastyprocess:ids" }],
    ["confidence > 1", { confidence: 1.5 }],
    ["confidence < 0", { confidence: -0.1 }],
  ])("an invalid stored row (%s) the run cannot replace is rejected as read", (_label, edit) => {
    const ghost = synthIdentity({ espn_id: 9000210, full_name: "Nobody Atall" });
    const row = { ...pair({ espn_id: 9000210, gsis_id: "00-0099210" }), ...edit } as CrosswalkPair;
    const r = run([ghost], { rows: [], records: [], persisted: persistedOf([row]) });
    expect(resolutionOf(r, 9000210).status).toBe("unmatched");
    expect(codesOf(r, 9000210)).toContain("invalid_persisted_pair");
    expect(r.rejected).toEqual([row]);
  });

  it("a stale override's player demoted by the one-gsis rule is rejected", () => {
    // Allen's own pair comes from nflverse players (his roster row has no ESPN id), so the stale
    // override's player name-matches his gsis and only the uniqueness rule refuses it.
    const allen = fx("Josh Allen");
    const prev = pair({
      espn_id: 9000150,
      gsis_id: allen.gsis_id,
      method: "override",
      source: "overrides",
    });
    const r = run([identity(allen), identity(allen, { espn_id: 9000150 })], {
      rows: [rosterRow(allen, { espn_id: null })],
      records: [playersRecord(allen)],
      persisted: persistedOf([prev]),
    });
    expect(resolutionOf(r, 9000150).status).toBe("ambiguous");
    expect(r.rejected).toEqual([prev]);
    expect(r.pairs.map((p) => p.espn_id)).toEqual([allen.espn_id]);
  });

  it("a team unit's stored row is rejected (a team unit is never paired)", () => {
    const unit = synthIdentity({
      espn_id: 9000220,
      full_name: "Chiefs D/ST",
      position_id: 16,
      pro_team_id: 12,
      pro_team: "KC",
    });
    const row = pair({ espn_id: 9000220, gsis_id: "00-0099220", method: "match", confidence: 0.8 });
    const r = run([unit, identity(fxUnit(-16021))], { persisted: persistedOf([row]) });
    expect(r.team_units.map((t) => t.espn_id)).toEqual([9000220, -16021]);
    expect(r.rejected).toEqual([row]);
  });

  it("never rejects a kept, rewritten or unchanged pair, another id's row, or a player not in the run", () => {
    const allen = fx("Josh Allen");
    const love = fx("Jordan Love");
    const kept = pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id, method: "match" });
    expect(
      run([identity(allen)], { rows: [], records: [], persisted: persistedOf([kept]) }).rejected,
    ).toEqual([]);
    const wrong = pair({ espn_id: allen.espn_id, gsis_id: love.gsis_id, method: "match" });
    const rewritten = run([identity(allen)], { persisted: persistedOf([wrong]) });
    expect(rewritten.changed).toEqual([expect.objectContaining({ gsis_id: allen.gsis_id })]);
    expect(rewritten.rejected).toEqual([]);
    const same = pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id });
    const unchanged = run([identity(allen)], { persisted: persistedOf([same]) });
    expect(unchanged.unchanged_ids).toEqual([allen.espn_id]);
    expect(unchanged.rejected).toEqual([]);
    // a lookup that answers with another ESPN id's row: that row is never this run's to remove
    const foreign = pair({ espn_id: 1, gsis_id: "00-0099230", method: "match" });
    const ghost = synthIdentity({ espn_id: 9000230, full_name: "Nobody Atall" });
    const r = run([ghost], { rows: [], records: [], persisted: { get: () => foreign } });
    expect(resolutionOf(r, 9000230).status).toBe("unmatched");
    expect(r.rejected).toEqual([]);
    // pairs never expire: a stored player the run does not resolve keeps his pair
    const absent = run([], { persisted: persistedOf([overridePair]) });
    expect(absent.rejected).toEqual([]);
  });

  it("lists each rejected pair once, ascending by ESPN id", () => {
    const rows = [synthRow({ gsis_id: "00-0099240", full_name: "Lone Name" })];
    const nobody = (id: number) =>
      synthIdentity({ espn_id: id, full_name: `Nobody ${String(id)}` });
    const stored = [9000241, 9000242, 9000243].map((id) =>
      pair({ espn_id: id, gsis_id: "00-0099240", method: "override", source: "overrides" }),
    );
    // input order is not id order, and one player is listed twice
    const r = run([nobody(9000243), nobody(9000241), nobody(9000242), nobody(9000243)], {
      rows,
      records: [],
      persisted: persistedOf(stored),
    });
    expect(r.rejected.map((p) => p.espn_id)).toEqual([9000241, 9000242, 9000243]);
  });
});

// --- the rebuild over the store model ------------------------------------------------------------

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

function rosterReader(rows: readonly NflRosterPlayer[]): RosterWeeklyReader {
  const s = stamp("nflverse:roster_weekly", "nflverse_roster_weekly");
  return { latest: () => ({ rows, stamp: s }), byEspnId: () => ({ rows: [], stamp: s }) };
}

function universeReader(rows: readonly EspnPlayerIdentity[]): PlayerUniverseReader {
  const s = stamp("espn:players", "espn_players");
  return { all: () => ({ rows, stamp: s }), byIds: () => ({ rows: [], stamp: s }) };
}

function rebuild(
  store: StoreModel,
  rows: readonly NflRosterPlayer[],
  players: readonly EspnPlayerIdentity[],
  now = NOW,
  rostered: ReadonlySet<number> = new Set(),
) {
  const out = rebuildCrosswalk({
    season: 2026,
    roster: rosterReader(rows),
    universe: universeReader(players),
    nflPlayers: null,
    repository: store,
    overrides: [],
    now,
    rostered,
  });
  if (out.status !== "done") throw new Error("expected done");
  return out;
}

/** The C1 block and gsis id a tool reads for a person (the tool-time path: the stored row). */
function toolView(store: StoreModel, espnId: number) {
  const row = store.get(espnId);
  return {
    gsis_id: row?.espn_id === espnId ? row.gsis_id : null,
    crosswalk: crosswalkStatusOfPair({ espn_id: espnId, position_id: 3 }, row),
  };
}

describe("rebuildCrosswalk removes what the run rejects", () => {
  it("repro (a): the refuted name match leaves the store; the tools, byGsis and the alert agree", () => {
    const store = storeModel();
    const first = rebuild(store, nameOnlyRows(), [byName]);
    expect(first.written).toBe(1);
    expect(first.removed).toBe(0);
    expect(toolView(store, BY_NAME)).toEqual({
      gsis_id: G,
      crosswalk: { method: "match", confidence: 0.8 },
    });

    const second = rebuild(store, idRows(), [byName, byId], LATER, new Set([BY_NAME]));
    expect(second.run.rejected).toEqual([
      expect.objectContaining({ espn_id: BY_NAME, gsis_id: G }),
    ]);
    expect(second.removed).toBe(1);
    expect(store.get(BY_NAME)).toBeNull();
    expect(toolView(store, BY_NAME)).toEqual({
      gsis_id: null,
      crosswalk: { method: "none", confidence: 0 },
    });
    expect(store.byGsis(G)).toEqual([
      expect.objectContaining({ espn_id: BY_ID, method: "id", confidence: 1 }),
    ]);
    expect(second.run.alert).toMatchObject({ triggered: true, espn_ids: [BY_NAME] });
    expect(second.run.report.unmatched_rostered.map((e) => e.player.espn_id)).toEqual([BY_NAME]);
    expect(store.count()).toBe(1);

    // the store now holds what the run decided: the next rebuild writes and removes nothing
    const third = rebuild(store, idRows(), [byName, byId], LATER, new Set([BY_NAME]));
    expect(third).toMatchObject({ written: 0, removed: 0 });
    expect(third.run.alert.espn_ids).toEqual([BY_NAME]);
  });

  it("repro (c): a removed override's pair leaves the store", () => {
    const store = storeModel([overridePair]);
    expect(toolView(store, OVERRIDDEN).crosswalk).toEqual({ method: "override", confidence: 1 });
    const out = rebuild(store, overriddenRows(), [overridden]);
    expect(out.removed).toBe(1);
    expect(store.removals).toEqual([[overridePair]]);
    expect(toolView(store, OVERRIDDEN)).toEqual({
      gsis_id: null,
      crosswalk: { method: "none", confidence: 0 },
    });
    expect(store.byGsis(G_OTHER)).toEqual([]);
  });

  it("hands the repository each rejected pair as read, so a row rewritten since is kept", () => {
    const store = storeModel([overridePair]);
    const rewritten: CrosswalkPair = {
      ...overridePair,
      method: "match",
      source: "matcher",
      confidence: 0.8,
    };
    const out = rebuildCrosswalk({
      season: 2026,
      roster: rosterReader(overriddenRows()),
      universe: universeReader([overridden]),
      nflPlayers: null,
      repository: {
        ...store,
        // another rebuild rewrites the row between this run's read and its removal
        removeRejected: (pairs) => {
          store.upsertDelta([rewritten]);
          return store.removeRejected(pairs);
        },
      },
      overrides: [],
      now: NOW,
    });
    if (out.status !== "done") throw new Error("expected done");
    // the whole pair as read (every field), not an id: the store compares before it removes
    expect(store.removals).toEqual([[overridePair]]);
    expect(store.removals[0]?.[0]).toBe(overridePair);
    expect(out.removed).toBe(0);
    expect(store.get(OVERRIDDEN)).toMatchObject({ method: "match", gsis_id: G_OTHER });
  });

  it("never calls removeRejected when the run rejects nothing", () => {
    const store = storeModel();
    const out = rebuild(store, idRows(), [byId]);
    expect(out.removed).toBe(0);
    expect(store.removals).toEqual([]);
  });

  it("a removal failure propagates, after the run's new pairs are written (a required write)", () => {
    const store = storeModel([
      pair({ espn_id: BY_NAME, gsis_id: G, method: "match", confidence: 0.8 }),
    ]);
    const failing = {
      ...store,
      removeRejected: () => {
        throw new Error("store: disk I/O error");
      },
    };
    expect(() =>
      rebuildCrosswalk({
        season: 2026,
        roster: rosterReader(idRows()),
        universe: universeReader([byName, byId]),
        nflPlayers: null,
        repository: failing,
        overrides: [],
        now: NOW,
      }),
    ).toThrow("disk I/O error");
    expect(store.get(BY_ID)).toMatchObject({ gsis_id: G, method: "id" });
  });
});

// --- properties ------------------------------------------------------------------------------------

describe("properties: the store holds exactly what the run decided", () => {
  const NAMES = ["Orrin Vexley", "Bastian Quell", "Cassius Thornby", "Lone Name"];
  const TEAMS = [
    [12, "KC"],
    [2, "BUF"],
  ] as const;
  const GSIS = (i: number): string => `00-00996${String(i).padStart(2, "0")}`;
  const ESPN = (i: number): number => 9000600 + i;
  const METHODS = ["id", "match", "override"] as const;
  const SOURCES: readonly CrosswalkSource[] = [
    "nflverse:roster_weekly",
    "nflverse:players",
    "matcher",
    "overrides",
  ];

  const rowArb = fc.record({
    g: fc.integer({ min: 0, max: 9 }),
    name: fc.constantFrom(...NAMES),
    team: fc.constantFrom("KC", "BUF"),
    pos: fc.constantFrom("WR", "RB"),
    espn: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
  });
  const playerArb = fc.record({
    e: fc.integer({ min: 0, max: 9 }),
    name: fc.constantFrom(...NAMES),
    team: fc.integer({ min: 0, max: 1 }),
    pos: fc.constantFrom(2, 3, 16),
  });
  const storedArb = fc.record({
    e: fc.integer({ min: 0, max: 12 }),
    g: fc.integer({ min: 0, max: 9 }),
    method: fc.constantFrom(...METHODS),
    source: fc.constantFrom(...SOURCES),
    confidence: fc.constantFrom(1, 0.8, 0.75),
    // a corrupt row: a bad gsis, an unknown method or an out-of-range confidence
    corrupt: fc.constantFrom(null, "gsis", "method", "confidence"),
  });
  const overrideArb = fc.record({
    e: fc.integer({ min: 0, max: 9 }),
    g: fc.integer({ min: 0, max: 9 }),
  });

  type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;

  function world(
    rIn: readonly ValueOf<typeof rowArb>[],
    pIn: readonly ValueOf<typeof playerArb>[],
    sIn: readonly ValueOf<typeof storedArb>[],
    oIn: readonly ValueOf<typeof overrideArb>[],
  ) {
    const rows = rIn.map((r) =>
      synthRow({
        gsis_id: GSIS(r.g),
        full_name: r.name,
        team: r.team,
        position: r.pos,
        espn_id: r.espn === null ? null : ESPN(r.espn),
      }),
    );
    const players = pIn.map((p) => {
      const [teamId, abbr] = TEAMS[p.team] ?? TEAMS[0];
      return synthIdentity({
        espn_id: ESPN(p.e),
        full_name: p.name,
        position_id: p.pos,
        pro_team_id: teamId,
        pro_team: abbr,
      });
    });
    const stored = new Map<number, CrosswalkPair>();
    for (const s of sIn) {
      const base = pair({
        espn_id: ESPN(s.e),
        gsis_id: GSIS(s.g),
        method: s.method,
        source: s.source,
        confidence: s.confidence,
      });
      const row =
        s.corrupt === "gsis"
          ? { ...base, gsis_id: "00-1" }
          : s.corrupt === "method"
            ? ({ ...base, method: "guess" } as unknown as CrosswalkPair)
            : s.corrupt === "confidence"
              ? { ...base, confidence: 1.5 }
              : base;
      if (!stored.has(row.espn_id)) stored.set(row.espn_id, row);
    }
    const overrides: CrosswalkOverride[] = oIn.map((o) => ({
      espn_id: ESPN(o.e),
      gsis_id: GSIS(o.g),
      note: null,
    }));
    return { rows, players, stored: [...stored.values()], overrides };
  }

  it("after a run is applied, a resolved player's row is his pair or nothing, others are untouched, and a second run changes and rejects nothing", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 14 }),
        fc.array(playerArb, { maxLength: 10 }),
        fc.array(storedArb, { maxLength: 10 }),
        fc.array(overrideArb, { maxLength: 3 }),
        (rIn, pIn, sIn, oIn) => {
          const w = world(rIn, pIn, sIn, oIn);
          const store = storeModel(w.stored);
          const before = new Map(store.rows().map((p) => [p.espn_id, p]));
          const opts = { rows: w.rows, records: [], overrides: w.overrides };
          const first = run(w.players, { ...opts, persisted: store });
          // rejected ⊆ what the run read for players it did not match; never one of its own pairs
          const matchedIds = new Set(first.pairs.map((p) => p.espn_id));
          for (const p of first.rejected) {
            expect(matchedIds.has(p.espn_id)).toBe(false);
            expect(before.get(p.espn_id)).toBe(p);
          }
          apply(store, first);
          const resolved = new Set(first.resolved.map((x) => x.espn_id));
          for (const x of first.resolved) {
            const row = store.get(x.espn_id);
            if (x.resolution.status === "matched") {
              expect(row !== null && samePair(row, x.resolution.pair)).toBe(true);
            } else {
              expect(row).toBeNull();
            }
          }
          for (const [id, p] of before) if (!resolved.has(id)) expect(store.get(id)).toBe(p);
          const second = run(w.players, { ...opts, persisted: store, now: LATER });
          expect(second.changed).toEqual([]);
          expect(second.rejected).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });
});
