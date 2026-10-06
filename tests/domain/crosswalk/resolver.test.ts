// resolver.test.ts — src/domain/crosswalk/resolver.ts over the fixture roster and synthetic hostile
// cases: plan 10 A6a (fixture roster resolves; a rookie without an id by name + team + position; a
// name-only candidate rejected; a persisted pair survives a team change; the alert count is 0), plan
// 05 §2 precedence and the WSH/LAR traps, research 04 §C (lookup, players fallback, 0.8, overrides,
// the alert rule), plan 07 C1/G1. Ported from sibling @8db206f (matcher.test.ts), adapted.
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EVIDENCE_WEIGHTS,
  MATCH_CONFIDENCE,
  MAX_REPORTED_CANDIDATES,
  buildNflPlayersIndex,
  buildRosterIndex,
  crosswalkStatus,
  crosswalkStatusOfPair,
  decisionOf,
  gsisOf,
  identityOf,
  identityOfPlatformPlayer,
  isTeamUnitIdentity,
  jerseyNumber,
  resolveCrosswalk,
  rosteredIdsOf,
  statusCounts,
  type CrosswalkReport,
  type CrosswalkResolution,
  type CrosswalkRun,
} from "../../../src/domain/crosswalk/resolver.js";
import type {
  EspnPlayerIdentity,
  NflRosterPlayer,
  UnmatchedReport,
} from "../../../src/domain/crosswalk/types.js";
import { asSlotId, bareUntrusted, type PlatformPlayer } from "../../../src/domain/league/types.js";
import { asPositionId } from "../../../src/domain/scoring/types.js";
import {
  EARLIER,
  FIXTURE,
  LATER,
  NOW,
  NO_PERSISTED,
  decoyRow,
  fixtureRosterRows,
  fx,
  fxUnit,
  identity,
  pair,
  persistedOf,
  playersRecord,
  rosterRow,
  run,
  synthIdentity,
  synthRow,
} from "./helpers.js";

type Resolved = CrosswalkRun<EspnPlayerIdentity>["resolved"][number];

function resolutionOf(r: CrosswalkRun<EspnPlayerIdentity>, espnId: number): CrosswalkResolution {
  const hit = r.resolved.find((x: Resolved) => x.espn_id === espnId);
  if (hit === undefined) throw new Error(`no resolution for ${String(espnId)}`);
  return hit.resolution;
}

function matchedPair(r: CrosswalkRun<EspnPlayerIdentity>, espnId: number) {
  const res = resolutionOf(r, espnId);
  if (res.status !== "matched") throw new Error(`${String(espnId)} is ${res.status}`);
  return res;
}

function codes(r: CrosswalkRun<EspnPlayerIdentity>): string[] {
  return r.diagnostics.map((d) => d.code);
}

/** The fixture's roster rows with every ESPN id blanked (the matcher-only world). */
function idlessRows(): NflRosterPlayer[] {
  return fixtureRosterRows().map((row) => ({ ...row, espn_id: null }));
}

const ALL_PLAYERS = (): EspnPlayerIdentity[] => FIXTURE.players.map((p) => identity(p));

// --- A6a ------------------------------------------------------------------------------------------

describe("A6a — the fixture roster", () => {
  it("every fixture player resolves by id with confidence 1 (roster_weekly, else nflverse players)", () => {
    const r = run(ALL_PLAYERS());
    for (const p of FIXTURE.players) {
      const m = matchedPair(r, p.espn_id);
      expect(m.pair.gsis_id, p.espn_name).toBe(p.gsis_id);
      expect(m.pair).toMatchObject({ method: "id", confidence: 1, source: p.id_source });
      expect(m.evidence).toEqual(["id"]);
      expect(m.changed).toBe(true);
      expect(crosswalkStatus(m)).toEqual({ method: "id", confidence: 1 });
    }
    expect(r.pairs).toHaveLength(FIXTURE.players.length);
    expect(r.changed).toHaveLength(FIXTURE.players.length);
    expect(r.diagnostics).toEqual([]);
    expect(r.pairs.map((x) => x.gsis_id)).not.toContain(FIXTURE.decoys[0]?.gsis_id);
  });

  it("every team unit resolves by its team (LAR → LA, WSH → WAS, the TQB too), never as a pair", () => {
    const r = run(FIXTURE.team_units.map((u) => identity(u)));
    expect(r.pairs).toEqual([]);
    expect(r.team_units).toEqual(
      FIXTURE.team_units.map((u) => ({ espn_id: u.espn_id, nfl_team: u.team })),
    );
    expect(r.team_units.find((t) => t.espn_id === -16014)?.nfl_team).toBe("LA");
    expect(r.team_units.find((t) => t.espn_id === -16028)?.nfl_team).toBe("WAS");
    expect(r.report).toEqual({ matched: 0, unmatched_rostered: [], unmatched_top_owned: [] });
    for (const u of FIXTURE.team_units) {
      expect(crosswalkStatus(resolutionOf(r, u.espn_id))).toEqual({ method: "id", confidence: 1 });
      expect(gsisOf(resolutionOf(r, u.espn_id))).toBeNull();
    }
  });

  it("a rookie without an nflverse id resolves by name + team + position at 0.8", () => {
    const rookies = FIXTURE.players.filter((p) => p.tags.includes("rookie_2026"));
    expect(rookies.length).toBeGreaterThanOrEqual(3);
    for (const rookie of rookies) {
      const rows = fixtureRosterRows().map((row) =>
        row.gsis_id === rookie.gsis_id ? { ...row, espn_id: null } : row,
      );
      const r = run([identity(rookie)], { rows });
      const m = matchedPair(r, rookie.espn_id);
      expect(m.pair).toMatchObject({
        gsis_id: rookie.gsis_id,
        method: "match",
        source: "matcher",
        confidence: MATCH_CONFIDENCE.nameTeamPosition,
      });
      expect(m.evidence).toEqual(["name", "team", "position"]);
      expect(crosswalkStatus(m)).toEqual({ method: "match", confidence: 0.8 });
    }
  });

  it("a name-only candidate is rejected and listed (the decoy shares the WR's full name)", () => {
    const jj = fx("Justin Jefferson");
    const decoy = FIXTURE.decoys[0];
    if (decoy === undefined) throw new Error("fixture decoy missing");
    const rows = fixtureRosterRows().filter((row) => row.gsis_id !== jj.gsis_id);
    const r = run([identity(jj)], { rows, rostered: new Set([jj.espn_id]) });
    const res = resolutionOf(r, jj.espn_id);
    expect(res).toMatchObject({ status: "unmatched", reason: "name_only" });
    if (res.status !== "unmatched") throw new Error("unreachable");
    expect(res.candidates.map((c) => c.gsis_id)).toEqual([decoy.gsis_id]);
    expect(res.candidates[0]?.evidence).toEqual(["name"]);
    expect(r.report.unmatched_rostered).toEqual([
      { player: identity(jj), reason: "name_only", candidates: res.candidates },
    ]);
    expect(r.alert).toEqual({ threshold: 1, count: 1, espn_ids: [jj.espn_id], triggered: true });
  });

  it("the collision pair: without ids the team and position pick the WR, never the LB decoy", () => {
    const jj = fx("Justin Jefferson");
    const r = run([identity(jj)], { rows: idlessRows() });
    const m = matchedPair(r, jj.espn_id);
    expect(m.pair.gsis_id).toBe(jj.gsis_id);
    expect(m.pair.confidence).toBe(0.8);
  });

  it("the decoy's own ESPN id refutes it as a name candidate for another ESPN player", () => {
    const jj = fx("Justin Jefferson");
    const decoy = FIXTURE.decoys[0];
    if (decoy === undefined) throw new Error("fixture decoy missing");
    // ESPN shows the WR as an LB at CLE (a wrong record): only the decoy agrees on team+position,
    // but nflverse says the decoy is ESPN player 5150249 — never this one.
    const r = run([identity(jj, { position_id: 11, pro_team_id: 5, pro_team: "CLE" })], {
      rows: [decoyRow(decoy)],
    });
    expect(resolutionOf(r, jj.espn_id).status).toBe("unmatched");
    const r2 = run([identity(jj, { position_id: 3, pro_team_id: 5, pro_team: "CLE" })], {
      rows: [decoyRow(decoy, { position: "WR" })],
    });
    expect(resolutionOf(r2, jj.espn_id)).toMatchObject({ status: "ambiguous" });
    expect(codes(r2)).toEqual(["candidate_id_conflict"]);
  });

  it("a persisted pair survives a team change (the pair is not re-matched)", () => {
    const lemon = fx("Makai Lemon");
    const rows = idlessRows();
    const first = run([identity(lemon)], { rows, now: EARLIER });
    const learned = matchedPair(first, lemon.espn_id).pair;
    expect(learned).toMatchObject({ method: "match", first_seen: EARLIER });
    // ESPN moves him to KC; nflverse still lists him at PHI.
    const traded = identity(lemon, { pro_team_id: 12, pro_team: "KC" });
    const r = run([traded], { rows, persisted: persistedOf([learned]), now: LATER });
    const m = matchedPair(r, lemon.espn_id);
    expect(m.pair).toEqual(learned);
    expect(m.changed).toBe(false);
    expect(m.evidence).toEqual(["name", "team", "position"]);
    expect(r.changed).toEqual([]);
    expect(r.unchanged_ids).toEqual([lemon.espn_id]);
  });

  it("without the persisted pair the same team change would NOT resolve (the persistence matters)", () => {
    const lemon = fx("Makai Lemon");
    const r = run([identity(lemon, { pro_team_id: 12, pro_team: "KC" })], { rows: idlessRows() });
    expect(resolutionOf(r, lemon.espn_id)).toMatchObject({
      status: "unmatched",
      reason: "name_only",
    });
  });

  it("an id pair resolves across a team change with no persistence at all", () => {
    const allen = fx("Josh Allen");
    const r = run([identity(allen, { pro_team_id: 12, pro_team: "KC" })]);
    expect(matchedPair(r, allen.espn_id).pair.gsis_id).toBe(allen.gsis_id);
  });

  it("the unmatched count of rostered or ≥ 1 %-owned fixture players is 0", () => {
    const r = run(ALL_PLAYERS(), { rostered: new Set(FIXTURE.players.map((p) => p.espn_id)) });
    expect(r.alert).toEqual({ threshold: 1, count: 0, espn_ids: [], triggered: false });
    expect(statusCounts(r.report)).toEqual({
      matched: FIXTURE.players.length,
      unmatched_rostered: 0,
      unmatched_top_owned: 0,
    });
  });
});

describe("the matcher-only world over the whole fixture (every nflverse ESPN id blanked)", () => {
  it("every player with a roster row and a team resolves by name + team + position", () => {
    const r = run(ALL_PLAYERS(), { rows: idlessRows(), records: [] });
    for (const p of FIXTURE.players) {
      const res = resolutionOf(r, p.espn_id);
      if (p.tags.includes("nickname_differs") || p.tags.includes("free_agent")) {
        expect(res.status, p.espn_name).toBe("unmatched");
        continue;
      }
      expect(res.status, p.espn_name).toBe("matched");
      if (res.status === "matched") {
        expect(res.pair.gsis_id, p.espn_name).toBe(p.gsis_id);
        expect(res.pair.confidence).toBe(0.8);
      }
    }
  });

  it("the suffix, apostrophe, hyphen and initials cases all match", () => {
    const tagged = FIXTURE.players.filter((p) =>
      p.tags.some((t) =>
        [
          "espn_name_suffix",
          "nflverse_name_suffix",
          "apostrophe_name",
          "hyphenated_name",
          "punctuated_name",
          "initials_name",
        ].includes(t),
      ),
    );
    expect(tagged.length).toBeGreaterThanOrEqual(8);
    const r = run(
      tagged.map((p) => identity(p)),
      { rows: idlessRows() },
    );
    for (const p of tagged)
      expect(matchedPair(r, p.espn_id).pair.gsis_id, p.espn_name).toBe(p.gsis_id);
  });

  it("a nickname nflverse does not share is unmatched, with a surname hint for the override", () => {
    const palmer = fx("Joshua Palmer");
    const r = run([identity(palmer)], { rows: idlessRows(), rostered: new Set([palmer.espn_id]) });
    const res = resolutionOf(r, palmer.espn_id);
    expect(res).toMatchObject({ status: "unmatched", reason: "no_candidate" });
    if (res.status !== "unmatched") throw new Error("unreachable");
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({
      gsis_id: palmer.gsis_id,
      evidence: ["team", "position"],
    });
    expect(r.alert.espn_ids).toEqual([palmer.espn_id]);
    // …and the override settles it.
    const settled = run([identity(palmer)], {
      rows: idlessRows(),
      overrides: [{ espn_id: palmer.espn_id, gsis_id: palmer.gsis_id, note: "nickname" }],
      rostered: new Set([palmer.espn_id]),
    });
    expect(matchedPair(settled, palmer.espn_id).pair).toMatchObject({
      gsis_id: palmer.gsis_id,
      method: "override",
      source: "overrides",
      confidence: 1,
    });
    expect(settled.alert.count).toBe(0);
  });

  it("a free agent never matches by name (no team), even when nflverse has exactly one such name", () => {
    const mixon = fx("Joe Mixon");
    const rows = [...idlessRows(), rosterRow(mixon, { espn_id: null })];
    const r = run([identity(mixon)], { rows, records: [] });
    expect(resolutionOf(r, mixon.espn_id)).toMatchObject({
      status: "unmatched",
      reason: "name_only",
    });
  });
});

// --- precedence ------------------------------------------------------------------------------------

describe("precedence: override → roster id → players id → persisted → match", () => {
  const allen = fx("Josh Allen");
  const love = fx("Jordan Love");

  it("an override wins over a conflicting id pair, and the conflict is reported", () => {
    const r = run([identity(allen)], {
      overrides: [{ espn_id: allen.espn_id, gsis_id: love.gsis_id, note: null }],
    });
    expect(matchedPair(r, allen.espn_id).pair).toMatchObject({
      gsis_id: love.gsis_id,
      method: "override",
      source: "overrides",
      confidence: 1,
      first_seen: NOW,
    });
    expect(r.diagnostics).toEqual([
      { code: "override_vs_id", espn_id: allen.espn_id, gsis_ids: [love.gsis_id, allen.gsis_id] },
    ]);
  });

  it("an override that agrees with the id pair is silent", () => {
    const r = run([identity(allen)], {
      overrides: [{ espn_id: allen.espn_id, gsis_id: allen.gsis_id, note: null }],
    });
    expect(matchedPair(r, allen.espn_id).pair.method).toBe("override");
    expect(r.diagnostics).toEqual([]);
  });

  it("an override resolves a player nflverse has never heard of (reported as unseen)", () => {
    const ghost = synthIdentity({ espn_id: 9000001, full_name: "Orrin Vexley" });
    const r = run([ghost], {
      overrides: [{ espn_id: 9000001, gsis_id: "00-0099001", note: null }],
    });
    expect(matchedPair(r, 9000001).pair.gsis_id).toBe("00-0099001");
    expect(codes(r)).toEqual(["override_gsis_unseen"]);
    // an empty roster (never loaded) cannot judge "unseen"
    const r2 = run([ghost], {
      rows: [],
      records: [],
      overrides: [{ espn_id: 9000001, gsis_id: "00-0099001", note: null }],
    });
    expect(r2.diagnostics).toEqual([]);
    // a gsis known only to nflverse players is not unseen
    const r3 = run([ghost], {
      records: [playersRecord(fx("Joe Mixon"), { gsis_id: "00-0099001", espn_id: null })],
      overrides: [{ espn_id: 9000001, gsis_id: "00-0099001", note: null }],
    });
    expect(r3.diagnostics).toEqual([]);
  });

  it("an override replaces a persisted pair (conflict reported, first_seen reset)", () => {
    const prev = pair({ espn_id: allen.espn_id, gsis_id: love.gsis_id });
    const r = run([identity(allen)], {
      persisted: persistedOf([prev]),
      overrides: [{ espn_id: allen.espn_id, gsis_id: allen.gsis_id, note: null }],
    });
    const m = matchedPair(r, allen.espn_id);
    expect(m.pair).toMatchObject({ gsis_id: allen.gsis_id, method: "override", first_seen: NOW });
    expect(m.changed).toBe(true);
    expect(codes(r)).toEqual(["override_vs_persisted"]);
  });

  it("an override on the persisted gsis keeps first_seen and changes only the method", () => {
    const prev = pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id });
    const r = run([identity(allen)], {
      persisted: persistedOf([prev]),
      overrides: [{ espn_id: allen.espn_id, gsis_id: allen.gsis_id, note: null }],
    });
    expect(matchedPair(r, allen.espn_id)).toMatchObject({
      pair: { first_seen: EARLIER, last_seen: EARLIER, method: "override" },
      changed: true,
    });
  });

  it("invalid override rows and duplicates are ignored with diagnostics; the first row wins", () => {
    const r = run([identity(allen)], {
      overrides: [
        { espn_id: -16021, gsis_id: allen.gsis_id, note: null },
        { espn_id: allen.espn_id, gsis_id: "nope", note: null },
        { espn_id: allen.espn_id, gsis_id: allen.gsis_id, note: null },
        { espn_id: allen.espn_id, gsis_id: love.gsis_id, note: null },
      ],
    });
    expect(codes(r)).toEqual(["invalid_override", "invalid_override", "duplicate_override"]);
    expect(matchedPair(r, allen.espn_id).pair.gsis_id).toBe(allen.gsis_id);
  });

  it("an id pair beats a persisted match that disagrees (changed, reported)", () => {
    const prev = pair({
      espn_id: allen.espn_id,
      gsis_id: love.gsis_id,
      method: "match",
      source: "matcher",
      confidence: 0.8,
    });
    const r = run([identity(allen)], { persisted: persistedOf([prev]) });
    expect(matchedPair(r, allen.espn_id)).toMatchObject({
      pair: { gsis_id: allen.gsis_id, method: "id", first_seen: NOW },
      changed: true,
    });
    expect(codes(r)).toEqual(["id_vs_persisted"]);
  });

  it("an id pair upgrades a persisted name match to the same player, keeping first_seen", () => {
    const prev = pair({
      espn_id: allen.espn_id,
      gsis_id: allen.gsis_id,
      method: "match",
      source: "matcher",
      confidence: 0.8,
    });
    const r = run([identity(allen)], { persisted: persistedOf([prev]) });
    expect(matchedPair(r, allen.espn_id)).toMatchObject({
      pair: { gsis_id: allen.gsis_id, method: "id", confidence: 1, first_seen: EARLIER },
      changed: true,
    });
    expect(r.diagnostics).toEqual([]);
  });

  it("an unchanged id pair is reported unchanged (touch, not upsert)", () => {
    const prev = pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id });
    const r = run([identity(allen)], { persisted: persistedOf([prev]) });
    expect(matchedPair(r, allen.espn_id)).toMatchObject({ pair: prev, changed: false });
    expect(r.changed).toEqual([]);
    expect(r.unchanged_ids).toEqual([allen.espn_id]);
  });

  it("a persisted id pair outlives its id disappearing from nflverse", () => {
    const prev = pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id });
    const r = run([identity(allen)], { rows: [], records: [], persisted: persistedOf([prev]) });
    expect(matchedPair(r, allen.espn_id)).toMatchObject({
      pair: prev,
      changed: false,
      evidence: ["id"],
    });
  });

  it("a persisted override whose override was removed is re-matched (stale, reported)", () => {
    const lemon = fx("Makai Lemon");
    const prev = pair({
      espn_id: lemon.espn_id,
      gsis_id: lemon.gsis_id,
      method: "override",
      source: "overrides",
    });
    const r = run([identity(lemon)], { rows: idlessRows(), persisted: persistedOf([prev]) });
    expect(matchedPair(r, lemon.espn_id)).toMatchObject({
      pair: { method: "match", confidence: 0.8, first_seen: EARLIER },
      changed: true,
    });
    expect(codes(r)).toEqual(["stale_override_pair"]);
  });

  it("a persisted pair contradicted by nflverse's own ESPN id for that gsis is dropped", () => {
    // nflverse says Allen's gsis is ESPN player 3918298; a persisted pair for another ESPN id is stale.
    const other = synthIdentity({ espn_id: 9000002, full_name: "Bastian Quell" });
    const prev = pair({
      espn_id: 9000002,
      gsis_id: allen.gsis_id,
      method: "match",
      source: "matcher",
      confidence: 0.8,
    });
    const r = run([other], { persisted: persistedOf([prev]) });
    expect(resolutionOf(r, 9000002).status).toBe("unmatched");
    expect(codes(r)).toEqual(["persisted_id_conflict"]);
  });

  it.each([
    ["wrong espn id", { espn_id: 1 }],
    ["bad gsis", { gsis_id: "00-1" }],
    ["unknown method", { method: "guess" }],
    ["method none", { method: "none" }],
    ["unknown source", { source: "dynastyprocess:ids" }],
    ["confidence > 1", { confidence: 1.5 }],
    ["confidence NaN", { confidence: Number.NaN }],
    ["confidence < 0", { confidence: -0.1 }],
    ["empty first_seen", { first_seen: "" }],
    ["non-string last_seen", { last_seen: 5 }],
  ])("an invalid persisted pair (%s) is ignored and reported", (_label, edit) => {
    const prev = { ...pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id }), ...edit } as never;
    const r = run([identity(allen)], { rows: [], records: [], persisted: { get: () => prev } });
    expect(resolutionOf(r, allen.espn_id).status).not.toBe("matched");
    expect(codes(r)).toContain("invalid_persisted_pair");
  });

  it("the nflverse players fallback resolves a free agent absent from roster_weekly", () => {
    const mixon = fx("Joe Mixon");
    const r = run([identity(mixon)]);
    expect(matchedPair(r, mixon.espn_id).pair).toMatchObject({
      gsis_id: mixon.gsis_id,
      method: "id",
      source: "nflverse:players",
      confidence: 1,
    });
  });

  it("roster_weekly wins over nflverse players when they give one gsis two ESPN ids", () => {
    // nflverse players claims ESPN 9000003 is Allen; roster_weekly says Allen is ESPN 3918298.
    const ghost = synthIdentity({ espn_id: 9000003, full_name: "Cassius Thornby" });
    const r = run([ghost, identity(allen)], {
      records: [playersRecord(allen, { espn_id: 9000003 })],
    });
    expect(resolutionOf(r, 9000003).status).toBe("unmatched");
    expect(matchedPair(r, allen.espn_id).pair.gsis_id).toBe(allen.gsis_id);
    expect(codes(r)).toEqual(["players_id_conflict"]);
  });

  it("an ESPN id carried by two nflverse players rows is never used (reported)", () => {
    const mixon = fx("Joe Mixon");
    const r = run([identity(mixon)], {
      records: [playersRecord(mixon), playersRecord(mixon, { gsis_id: "00-0099004" })],
    });
    expect(resolutionOf(r, mixon.espn_id).status).toBe("unmatched");
    expect(r.diagnostics).toEqual([
      {
        code: "ambiguous_players_id",
        espn_id: mixon.espn_id,
        gsis_ids: ["00-0033897", "00-0099004"],
      },
    ]);
  });

  it("an ESPN id carried by two roster_weekly gsis ids is never used; the matcher decides", () => {
    const rows = [
      ...fixtureRosterRows(),
      synthRow({ gsis_id: "00-0099005", full_name: "Thaddeus Wren", espn_id: allen.espn_id }),
    ];
    const r = run([identity(allen)], { rows });
    // the matcher still finds him by name + team + position
    expect(matchedPair(r, allen.espn_id).pair).toMatchObject({
      gsis_id: allen.gsis_id,
      method: "match",
    });
    expect(r.diagnostics[0]).toEqual({
      code: "ambiguous_espn_id",
      espn_id: allen.espn_id,
      gsis_ids: [allen.gsis_id, "00-0099005"].sort(),
    });
  });

  it("an ESPN id from any week counts, not only the latest row's", () => {
    const rows = [rosterRow(allen, { week: 1 }), rosterRow(allen, { week: 4, espn_id: null })];
    const r = run([identity(allen)], { rows });
    expect(matchedPair(r, allen.espn_id).pair.method).toBe("id");
  });
});

// --- adversarial names and teams (deterministic match, fictional people) ----------------------------

describe("the deterministic fallback", () => {
  it("matches a diacritic name from its ASCII spelling and vice versa", () => {
    const r = run(
      [
        synthIdentity({ espn_id: 9000010, full_name: "Zephyrin Moreau" }),
        synthIdentity({ espn_id: 9000011, full_name: "Anaïs Lefèvre" }),
      ],
      {
        rows: [
          synthRow({ gsis_id: "00-0099010", full_name: "Zéphyrin Moreau" }),
          synthRow({ gsis_id: "00-0099011", full_name: "Anais Lefevre" }),
        ],
      },
    );
    expect(matchedPair(r, 9000010).pair.gsis_id).toBe("00-0099010");
    expect(matchedPair(r, 9000011).pair.gsis_id).toBe("00-0099011");
  });

  it("same name, different teams: the team decides", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099020", full_name: "Orrin Vexley", team: "KC" }),
      synthRow({ gsis_id: "00-0099021", full_name: "Orrin Vexley", team: "BUF" }),
    ];
    const r = run(
      [
        synthIdentity({
          espn_id: 9000020,
          full_name: "Orrin Vexley",
          pro_team_id: 2,
          pro_team: "BUF",
        }),
      ],
      { rows },
    );
    expect(matchedPair(r, 9000020).pair.gsis_id).toBe("00-0099021");
  });

  it("same name, same team, different positions: the position decides", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099030", full_name: "Orrin Vexley", position: "WR" }),
      synthRow({ gsis_id: "00-0099031", full_name: "Orrin Vexley", position: "TE" }),
    ];
    const r = run(
      [synthIdentity({ espn_id: 9000030, full_name: "Orrin Vexley", position_id: 4 })],
      { rows },
    );
    expect(matchedPair(r, 9000030).pair.gsis_id).toBe("00-0099031");
  });

  it("a fullback nflverse lists as FB matches ESPN's RB (FB → RB family)", () => {
    const rows = [synthRow({ gsis_id: "00-0099040", full_name: "Orrin Vexley", position: "FB" })];
    const r = run(
      [synthIdentity({ espn_id: 9000040, full_name: "Orrin Vexley", position_id: 2 })],
      { rows },
    );
    expect(matchedPair(r, 9000040).pair.gsis_id).toBe("00-0099040");
  });

  it("same name, team and position: the jersey breaks the tie (0.75), else ambiguous", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099050", full_name: "Orrin Vexley", jersey_number: 11 }),
      synthRow({ gsis_id: "00-0099051", full_name: "Orrin Vexley", jersey_number: 81 }),
    ];
    const tie = run(
      [synthIdentity({ espn_id: 9000050, full_name: "Orrin Vexley", jersey: "81" })],
      { rows },
    );
    expect(matchedPair(tie, 9000050)).toMatchObject({
      pair: { gsis_id: "00-0099051", confidence: MATCH_CONFIDENCE.jerseyTieBreak },
      evidence: ["name", "team", "position", "jersey"],
    });
    const open = run([synthIdentity({ espn_id: 9000050, full_name: "Orrin Vexley" })], { rows });
    const res = resolutionOf(open, 9000050);
    expect(res.status).toBe("ambiguous");
    if (res.status === "ambiguous")
      expect(res.candidates.map((c) => c.gsis_id)).toEqual(["00-0099050", "00-0099051"]);
    const neither = run(
      [synthIdentity({ espn_id: 9000050, full_name: "Orrin Vexley", jersey: "7" })],
      { rows },
    );
    expect(resolutionOf(neither, 9000050).status).toBe("ambiguous");
  });

  it("a single candidate's jersey never blocks the match", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099060", full_name: "Orrin Vexley", jersey_number: 11 }),
    ];
    const r = run([synthIdentity({ espn_id: 9000060, full_name: "Orrin Vexley", jersey: "12" })], {
      rows,
    });
    expect(matchedPair(r, 9000060).pair.confidence).toBe(0.8);
    const agrees = run(
      [synthIdentity({ espn_id: 9000060, full_name: "Orrin Vexley", jersey: "11" })],
      { rows },
    );
    expect(matchedPair(agrees, 9000060)).toMatchObject({
      pair: { confidence: 0.8 },
      evidence: ["name", "team", "position", "jersey"],
    });
  });

  it("the abbreviation traps: ESPN LAR ↔ nflverse LA, WSH ↔ WAS; LAC never matches LA", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099070", full_name: "Orrin Vexley", team: "LA" }),
      synthRow({ gsis_id: "00-0099071", full_name: "Bastian Quell", team: "WAS" }),
    ];
    const r = run(
      [
        synthIdentity({
          espn_id: 9000070,
          full_name: "Orrin Vexley",
          pro_team_id: 14,
          pro_team: "LAR",
        }),
        synthIdentity({
          espn_id: 9000071,
          full_name: "Bastian Quell",
          pro_team_id: 28,
          pro_team: "WSH",
        }),
        synthIdentity({
          espn_id: 9000072,
          full_name: "Orrin Vexley",
          pro_team_id: 24,
          pro_team: "LAC",
        }),
      ],
      { rows },
    );
    expect(matchedPair(r, 9000070).pair.gsis_id).toBe("00-0099070");
    expect(matchedPair(r, 9000071).pair.gsis_id).toBe("00-0099071");
    expect(resolutionOf(r, 9000072)).toMatchObject({ status: "unmatched", reason: "name_only" });
  });

  it("the pro-team id alone is enough when the abbreviation is absent", () => {
    const rows = [synthRow({ gsis_id: "00-0099075", full_name: "Orrin Vexley", team: "LA" })];
    const r = run(
      [
        synthIdentity({
          espn_id: 9000075,
          full_name: "Orrin Vexley",
          pro_team_id: 14,
          pro_team: null,
        }),
      ],
      { rows },
    );
    expect(matchedPair(r, 9000075).pair.gsis_id).toBe("00-0099075");
  });

  it("an unknown team fails loudly (unknown_team); a contradictory one too", () => {
    const rows = [synthRow({ gsis_id: "00-0099080", full_name: "Orrin Vexley" })];
    const unknown = run(
      [
        synthIdentity({
          espn_id: 9000080,
          full_name: "Orrin Vexley",
          pro_team_id: 31,
          pro_team: "XYZ",
        }),
      ],
      { rows },
    );
    expect(resolutionOf(unknown, 9000080)).toMatchObject({
      status: "unmatched",
      reason: "unknown_team",
    });
    expect(codes(unknown)).toEqual(["unknown_team"]);
    const conflict = run(
      [
        synthIdentity({
          espn_id: 9000080,
          full_name: "Orrin Vexley",
          pro_team_id: 12,
          pro_team: "BUF",
        }),
      ],
      { rows },
    );
    expect(resolutionOf(conflict, 9000080)).toMatchObject({
      status: "unmatched",
      reason: "unknown_team",
    });
    expect(codes(conflict)).toEqual(["team_conflict"]);
  });

  it("a position outside ESPN ids 1–5 never matches by name + team alone", () => {
    const rows = [synthRow({ gsis_id: "00-0099090", full_name: "Orrin Vexley", position: "P" })];
    const r = run(
      [synthIdentity({ espn_id: 9000090, full_name: "Orrin Vexley", position_id: 7 })],
      { rows },
    );
    expect(resolutionOf(r, 9000090)).toMatchObject({ status: "unmatched", reason: "name_only" });
  });

  it.each([
    ["Cyrillic homoglyph", "Оrrin Vexley"],
    ["zero-width space", "Orrin​Vexley"],
    ["bidi override", "‮Orrin Vexley"],
    ["too long", `Orrin ${"x".repeat(200)}`],
    ["empty", ""],
  ])("an unnormalisable name (%s) has no candidate", (_label, name) => {
    const rows = [synthRow({ gsis_id: "00-0099100", full_name: "Orrin Vexley" })];
    const r = run([synthIdentity({ espn_id: 9000100, full_name: name })], { rows });
    expect(resolutionOf(r, 9000100)).toMatchObject({
      status: "unmatched",
      reason: "no_candidate",
      candidates: [],
    });
  });

  it("a one-word name with no exact candidate gets no surname hints", () => {
    const rows = [synthRow({ gsis_id: "00-0099106", full_name: "Some Vexley" })];
    const r = run([synthIdentity({ espn_id: 9000106, full_name: "Vexley" })], { rows });
    expect(resolutionOf(r, 9000106)).toEqual({
      status: "unmatched",
      reason: "no_candidate",
      candidates: [],
    });
  });

  it("a homoglyph name in nflverse never merges with the real spelling", () => {
    const rows = [synthRow({ gsis_id: "00-0099105", full_name: "Оrrin Vexley" })];
    const r = run([synthIdentity({ espn_id: 9000105, full_name: "Orrin Vexley" })], { rows });
    expect(resolutionOf(r, 9000105)).toMatchObject({ status: "unmatched", reason: "no_candidate" });
  });

  it("caps reported candidates and orders them by score, then gsis id", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      synthRow({
        gsis_id: `00-00991${String(i).padStart(2, "0")}`,
        full_name: "Orrin Vexley",
        team: i % 2 === 0 ? "KC" : "BUF",
        position: "LB",
      }),
    );
    const r = run([synthIdentity({ espn_id: 9000110, full_name: "Orrin Vexley" })], { rows });
    const res = resolutionOf(r, 9000110);
    expect(res.status).toBe("unmatched");
    if (res.status !== "unmatched") throw new Error("unreachable");
    expect(res.candidates).toHaveLength(MAX_REPORTED_CANDIDATES);
    expect(res.candidates[0]?.evidence).toEqual(["name", "team"]);
    expect(res.candidates[0]?.gsis_id).toBe("00-0099100");
    const scores = res.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("hostile nflverse team / position text never reaches a candidate", () => {
    const rows = [
      synthRow({
        gsis_id: "00-0099120",
        full_name: "Orrin Vexley",
        team: "<b>KC</b>" as never,
        position: "WR<script>",
      }),
    ];
    const r = run([synthIdentity({ espn_id: 9000120, full_name: "Orrin Vexley" })], { rows });
    const res = resolutionOf(r, 9000120);
    expect(res).toMatchObject({ status: "unmatched", reason: "name_only" });
    if (res.status === "unmatched")
      expect(res.candidates[0]).toMatchObject({ team: "", position: "" });
  });

  it("candidates carry no names and the evidence weights sum to the score", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099130", full_name: "Orrin Vexley", team: "BUF", jersey_number: 9 }),
    ];
    const r = run([synthIdentity({ espn_id: 9000130, full_name: "Orrin Vexley", jersey: "9" })], {
      rows,
    });
    const res = resolutionOf(r, 9000130);
    if (res.status !== "unmatched") throw new Error("expected unmatched");
    const c = res.candidates[0];
    expect(Object.keys(c ?? {}).sort()).toEqual([
      "evidence",
      "gsis_id",
      "jersey_number",
      "position",
      "score",
      "team",
    ]);
    expect(c?.score).toBeCloseTo(
      EVIDENCE_WEIGHTS.name + EVIDENCE_WEIGHTS.position + EVIDENCE_WEIGHTS.jersey,
      10,
    );
    expect(c?.score).toBe(0.7);
  });
});

// --- uniqueness -----------------------------------------------------------------------------------

describe("one gsis per run", () => {
  it("two ESPN ids matching one nflverse player by name are both demoted to ambiguous", () => {
    const rows = [synthRow({ gsis_id: "00-0099140", full_name: "Orrin Vexley" })];
    const r = run(
      [
        synthIdentity({ espn_id: 9000140, full_name: "Orrin Vexley" }),
        synthIdentity({ espn_id: 9000141, full_name: "Orrin Vexley" }),
      ],
      { rows },
    );
    expect(resolutionOf(r, 9000140).status).toBe("ambiguous");
    expect(resolutionOf(r, 9000141).status).toBe("ambiguous");
    expect(r.pairs).toEqual([]);
  });

  it("a name match loses to an id pair on the same gsis", () => {
    const allen = fx("Josh Allen");
    // Allen's pair comes from nflverse players (his roster row carries no ESPN id), so a second ESPN
    // record named like him is not refuted by id evidence — only the uniqueness rule stops it.
    const r = run([identity(allen), identity(allen, { espn_id: 9000150 })], {
      rows: [rosterRow(allen, { espn_id: null })],
      records: [playersRecord(allen)],
    });
    expect(matchedPair(r, allen.espn_id).pair.source).toBe("nflverse:players");
    expect(resolutionOf(r, 9000150)).toEqual({
      status: "ambiguous",
      candidates: [expect.objectContaining({ gsis_id: allen.gsis_id })],
    });
    expect(r.diagnostics).toEqual([]);
    const r2 = run([identity(allen), identity(allen, { espn_id: 9000150 })], {
      overrides: [{ espn_id: allen.espn_id, gsis_id: allen.gsis_id, note: null }],
      rows: [rosterRow(allen, { espn_id: null })],
    });
    expect(matchedPair(r2, allen.espn_id).pair.method).toBe("override");
    expect(resolutionOf(r2, 9000150)).toMatchObject({ status: "ambiguous" });
    expect(r2.diagnostics).toEqual([]);
  });

  it("two strong claims on one gsis are kept and reported", () => {
    const allen = fx("Josh Allen");
    const r = run(
      [identity(allen), synthIdentity({ espn_id: 9000160, full_name: "Thaddeus Wren" })],
      {
        overrides: [{ espn_id: 9000160, gsis_id: allen.gsis_id, note: "duplicate ESPN record" }],
      },
    );
    expect(matchedPair(r, allen.espn_id).pair.gsis_id).toBe(allen.gsis_id);
    expect(matchedPair(r, 9000160).pair.gsis_id).toBe(allen.gsis_id);
    expect(r.diagnostics).toEqual([
      { code: "duplicate_gsis", espn_id: allen.espn_id, gsis_ids: [allen.gsis_id] },
      { code: "duplicate_gsis", espn_id: 9000160, gsis_ids: [allen.gsis_id] },
    ]);
  });
});

// --- team units -------------------------------------------------------------------------------------

describe("team units (D/ST, TQB, HC)", () => {
  const eagles = fxUnit(-16021);

  it("resolve from the id alone when no pro team is given", () => {
    const r = run([identity(eagles, { pro_team_id: null as never, pro_team: null })]);
    expect(r.team_units).toEqual([{ espn_id: -16021, nfl_team: "PHI" }]);
  });

  it("a positive id with a team-unit position resolves by its pro team", () => {
    const r = run([
      synthIdentity({
        espn_id: 9000170,
        full_name: "Head Coach",
        position_id: 14,
        pro_team_id: 28,
        pro_team: "WSH",
      }),
    ]);
    expect(r.team_units).toEqual([{ espn_id: 9000170, nfl_team: "WAS" }]);
  });

  it("an HC unit id resolves like a D/ST", () => {
    const r = run([
      synthIdentity({
        espn_id: -14012,
        full_name: "Chiefs HC",
        position_id: 14,
        pro_team_id: 12,
        pro_team: "KC",
      }),
    ]);
    expect(r.team_units).toEqual([{ espn_id: -14012, nfl_team: "KC" }]);
  });

  it.each([
    ["team contradicts the id", { pro_team_id: 8, pro_team: "DET" }, "team_conflict"],
    ["abbreviation contradicts id", { pro_team_id: 21, pro_team: "DET" }, "team_conflict"],
    ["unknown abbreviation", { pro_team_id: null as never, pro_team: "XYZ" }, "unknown_team"],
  ])("is unresolved (never unmatched) when the %s", (_label, edit, code) => {
    const r = run([identity(eagles, edit)], { rostered: new Set([-16021]) });
    expect(r.team_units).toEqual([]);
    expect(r.unresolved_team_units).toHaveLength(1);
    expect(resolutionOf(r, -16021)).toEqual({ status: "team_unit", nfl_team: null });
    expect(crosswalkStatus(resolutionOf(r, -16021))).toEqual({ method: "none", confidence: 0 });
    expect(r.report.unmatched_rostered).toEqual([]);
    expect(r.alert.count).toBe(0);
    expect(codes(r)).toEqual([code]);
  });

  it("a unit with no team and an id that encodes none is unresolved", () => {
    const r = run([
      synthIdentity({
        espn_id: 9000175,
        full_name: "Ghost D/ST",
        position_id: 16,
        pro_team_id: 0,
        pro_team: "FA",
      }),
    ]);
    expect(r.unresolved_team_units).toHaveLength(1);
    expect(codes(r)).toEqual(["unknown_team"]);
  });

  it("is never matched to an nflverse row named like the unit", () => {
    const rows = [
      synthRow({ gsis_id: "00-0099180", full_name: "Eagles D/ST", team: "PHI", position: "WR" }),
    ];
    const r = run([identity(eagles)], { rows });
    expect(r.pairs).toEqual([]);
    expect(r.team_units).toEqual([{ espn_id: -16021, nfl_team: "PHI" }]);
  });

  it("isTeamUnitIdentity reads the id range or the position id", () => {
    expect(isTeamUnitIdentity({ espn_id: -16021, position_id: 2 })).toBe(true);
    expect(isTeamUnitIdentity({ espn_id: -15024, position_id: 15 })).toBe(true);
    expect(isTeamUnitIdentity({ espn_id: 5, position_id: 16 })).toBe(true);
    expect(isTeamUnitIdentity({ espn_id: 5, position_id: 2 })).toBe(false);
    expect(isTeamUnitIdentity({ espn_id: -5, position_id: 2 })).toBe(false);
  });
});

// --- input checks -----------------------------------------------------------------------------------

describe("inputs", () => {
  it.each([0, -5, -13999, 1.5, Number.NaN, 100_000_000, Number.POSITIVE_INFINITY])(
    "an identity with ESPN id %s is not a player: dropped and reported",
    (id) => {
      const r = run([synthIdentity({ espn_id: id, full_name: "Orrin Vexley" })]);
      expect(r.resolved).toEqual([]);
      expect(r.diagnostics).toEqual([{ code: "invalid_player", espn_id: null, gsis_ids: [] }]);
    },
  );

  it("a duplicate ESPN id is resolved once (first occurrence) and reported", () => {
    const allen = fx("Josh Allen");
    const r = run([identity(allen), identity(allen, { full_name: "Somebody Else" })]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]?.player.full_name).toBe("Josh Allen");
    expect(codes(r)).toEqual(["duplicate_player"]);
  });

  it.each(["", "not a date", "x".repeat(65), 5 as never])("refuses now = %j", (now) => {
    expect(() => run([], { now })).toThrow(TypeError);
  });

  it.each([Number.NaN, -1, 101])("refuses topOwnedPercent %s", (v) => {
    expect(() => run([], { extra: { topOwnedPercent: v } })).toThrow(RangeError);
  });

  it.each([0, 1.5, Number.NaN])("refuses alertThreshold %s", (v) => {
    expect(() => run([], { extra: { alertThreshold: v } })).toThrow(RangeError);
  });

  it("an empty run is empty", () => {
    expect(run([])).toEqual({
      resolved: [],
      pairs: [],
      changed: [],
      unchanged_ids: [],
      team_units: [],
      unresolved_team_units: [],
      report: { matched: 0, unmatched_rostered: [], unmatched_top_owned: [] },
      alert: { threshold: 1, count: 0, espn_ids: [], triggered: false },
      diagnostics: [],
    });
  });

  it("works without an nflverse players index", () => {
    const allen = fx("Josh Allen");
    const r = resolveCrosswalk({
      players: [identity(allen)],
      identify: identityOf,
      roster: buildRosterIndex(fixtureRosterRows()),
      overrides: [],
      persisted: NO_PERSISTED,
      now: NOW,
    });
    expect(matchedPair(r, allen.espn_id).pair.gsis_id).toBe(allen.gsis_id);
  });
});

// --- report and alert ---------------------------------------------------------------------------

describe("the unmatched report and the alert", () => {
  const rows = [synthRow({ gsis_id: "00-0099190", full_name: "Lone Name", team: "BUF" })];
  const ids = {
    rosteredNameOnly: 9000193,
    topOwned: 9000191,
    longTail: 9000192,
    rosteredMatch: 9000194,
  };
  const players = [
    synthIdentity({ espn_id: ids.topOwned, full_name: "Lone Name", percent_owned: 1 }),
    synthIdentity({ espn_id: ids.longTail, full_name: "Nobody Atall", percent_owned: 0.99 }),
    synthIdentity({ espn_id: ids.rosteredNameOnly, full_name: "Lone Name", percent_owned: 0 }),
    synthIdentity({
      espn_id: ids.rosteredMatch,
      full_name: "Lone Name",
      pro_team_id: 2,
      pro_team: "BUF",
    }),
  ];

  it("splits rostered from ≥ 1 %-owned, ignores the long tail, sorts by ESPN id", () => {
    const r = run(players, { rows, rostered: new Set([ids.rosteredNameOnly, ids.rosteredMatch]) });
    expect(r.report.matched).toBe(1);
    expect(r.report.unmatched_rostered.map((e) => e.player.espn_id)).toEqual([
      ids.rosteredNameOnly,
    ]);
    expect(r.report.unmatched_top_owned.map((e) => e.player.espn_id)).toEqual([ids.topOwned]);
    expect(r.report.unmatched_top_owned[0]?.reason).toBe("name_only");
    // the alert also counts the rostered player matched only by name (no confidence-1.0 pair)
    expect(r.alert).toEqual({
      threshold: 1,
      count: 3,
      espn_ids: [ids.topOwned, ids.rosteredNameOnly, ids.rosteredMatch],
      triggered: true,
    });
  });

  it("honours an explicit top-owned percent and alert threshold", () => {
    const r = run(players, {
      rows,
      rostered: new Set([ids.rosteredNameOnly]),
      extra: { topOwnedPercent: 0.5, alertThreshold: 5 },
    });
    expect(r.report.unmatched_top_owned.map((e) => e.player.espn_id)).toEqual([
      ids.topOwned,
      ids.longTail,
    ]);
    expect(r.alert.triggered).toBe(false);
    expect(r.alert.threshold).toBe(5);
  });

  it("an ambiguous player is reported as ambiguous with its candidates", () => {
    const twin = [
      synthRow({ gsis_id: "00-0099195", full_name: "Twin Name" }),
      synthRow({ gsis_id: "00-0099196", full_name: "Twin Name" }),
    ];
    const r = run([synthIdentity({ espn_id: 9000195, full_name: "Twin Name" })], {
      rows: twin,
      rostered: new Set([9000195]),
    });
    expect(r.report.unmatched_rostered[0]).toMatchObject({ reason: "ambiguous" });
    expect(r.report.unmatched_rostered[0]?.candidates).toHaveLength(2);
  });

  it("a non-finite percent owned is never top-owned", () => {
    const r = run([
      synthIdentity({ espn_id: 9000197, full_name: "Nobody Atall", percent_owned: Number.NaN }),
    ]);
    expect(r.report.unmatched_top_owned).toEqual([]);
    expect(r.alert.count).toBe(0);
  });
});

// --- what tools show ------------------------------------------------------------------------------

describe("tool helpers", () => {
  const allen = fx("Josh Allen");
  const allenPair = pair({ espn_id: allen.espn_id, gsis_id: allen.gsis_id });

  it("crosswalkStatusOfPair: team unit exact, pair as stored, absent or foreign pair = none", () => {
    expect(crosswalkStatusOfPair({ espn_id: -16021, position_id: 16 }, null)).toEqual({
      method: "id",
      confidence: 1,
    });
    expect(crosswalkStatusOfPair({ espn_id: allen.espn_id, position_id: 1 }, allenPair)).toEqual({
      method: "id",
      confidence: 1,
    });
    expect(
      crosswalkStatusOfPair(
        { espn_id: allen.espn_id, position_id: 1 },
        { ...allenPair, method: "match", confidence: 0.8 },
      ),
    ).toEqual({
      method: "match",
      confidence: 0.8,
    });
    expect(crosswalkStatusOfPair({ espn_id: allen.espn_id, position_id: 1 }, null)).toEqual({
      method: "none",
      confidence: 0,
    });
    expect(crosswalkStatusOfPair({ espn_id: 9000200, position_id: 1 }, allenPair)).toEqual({
      method: "none",
      confidence: 0,
    });
  });

  it("decisionOf maps onto the contract's MatchDecision", () => {
    const r = run([
      identity(allen),
      identity(fxUnit(-16021)),
      synthIdentity({ espn_id: 9000201, full_name: "Nobody Atall" }),
    ]);
    expect(decisionOf(resolutionOf(r, allen.espn_id))).toEqual({
      status: "matched",
      pair: matchedPair(r, allen.espn_id).pair,
    });
    expect(decisionOf(resolutionOf(r, -16021))).toEqual({
      status: "unmatched",
      reason: "team_unit",
    });
    expect(decisionOf(resolutionOf(r, 9000201))).toEqual({
      status: "unmatched",
      reason: "no_candidate",
    });
    expect(decisionOf({ status: "ambiguous", candidates: [] })).toEqual({
      status: "ambiguous",
      candidates: [],
    });
    expect(crosswalkStatus({ status: "ambiguous", candidates: [] })).toEqual({
      method: "none",
      confidence: 0,
    });
    expect(gsisOf(resolutionOf(r, 9000201))).toBeNull();
    expect(gsisOf(resolutionOf(r, allen.espn_id))).toBe(allen.gsis_id);
  });

  it("jerseyNumber reads ESPN text and nflverse numbers, 0..99 only", () => {
    expect(jerseyNumber("17")).toBe(17);
    expect(jerseyNumber(" 0 ")).toBe(0);
    expect(jerseyNumber(85)).toBe(85);
    for (const bad of ["100", "-1", "1.5", "", "17a", 100, -1, 1.5, null, undefined]) {
      expect(jerseyNumber(bad)).toBeNull();
    }
  });

  it("reads a PlatformPlayer as an identity and resolves it; rostered = ONTEAM", () => {
    const pp: PlatformPlayer = {
      ref: { platform: "espn", id: allen.espn_id },
      name: bareUntrusted("Josh Allen", "player_name"),
      position_id: asPositionId(1),
      position: "QB",
      eligible_slot_ids: [asSlotId(0)],
      eligible_slots: ["QB"],
      pro_team_id: 2,
      pro_team: "BUF",
      jersey: "17",
      bye_week: 7,
      injury_status: null,
      injured: false,
      droppable: false,
      status: "ONTEAM",
      on_team_id: 1,
      waiver_process_date: null,
      ownership: {
        percent_owned: 99.9,
        percent_started: 90,
        percent_change: 0,
        average_draft_position: null,
        auction_value_average: null,
        as_of: null,
      },
      projection_week_espn: null,
      projection_ros_espn: null,
      rank_week_espn: null,
      draft_rank_espn: null,
      last_news_at: null,
      has_outlook: false,
    };
    const free: PlatformPlayer = {
      ...pp,
      ref: { platform: "espn", id: 9000210 },
      status: "FREEAGENT",
      ownership: null,
    };
    expect(identityOfPlatformPlayer(pp)).toEqual({
      espn_id: allen.espn_id,
      full_name: "Josh Allen",
      position_id: 1,
      pro_team_id: 2,
      pro_team: "BUF",
      percent_owned: 99.9,
      jersey: "17",
    });
    expect(identityOfPlatformPlayer(free).percent_owned).toBeNull();
    expect([...rosteredIdsOf([pp, free])]).toEqual([allen.espn_id]);
    const r = resolveCrosswalk({
      players: [pp, free],
      identify: identityOfPlatformPlayer,
      roster: buildRosterIndex(fixtureRosterRows()),
      overrides: [],
      persisted: NO_PERSISTED,
      now: NOW,
      rostered: rosteredIdsOf([pp, free]),
    });
    expect(r.resolved[0]?.player).toBe(pp);
    const report: UnmatchedReport = r.report;
    expect(report.matched).toBe(1);
  });

  it("the PlatformPlayer report IS the contract's UnmatchedReport", () => {
    expectTypeOf<CrosswalkReport<PlatformPlayer>>().toExtend<UnmatchedReport>();
  });
});

// --- indexes ----------------------------------------------------------------------------------------

describe("buildRosterIndex / buildNflPlayersIndex", () => {
  it("keeps the latest row per gsis id, trims gsis ids, drops invalid ones", () => {
    const idx = buildRosterIndex([
      synthRow({ gsis_id: "00-0099220", full_name: "Old Name", week: 2, team: "BUF" }),
      synthRow({ gsis_id: " 00-0099220", full_name: "New Name", week: 3, team: "KC" }),
      synthRow({ gsis_id: "00-0099220", full_name: "Tie Name", week: 3, team: "NE" }),
      synthRow({ gsis_id: "00-0099220", full_name: "Older Season", season: 2025, week: 18 }),
      synthRow({ gsis_id: "ABC123456", full_name: "Legacy Id" }),
      synthRow({ gsis_id: "NA", full_name: "No Id" }),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.byGsis("00-0099220")).toMatchObject({
      gsis_id: "00-0099220",
      full_name: "New Name",
      team: "KC",
    });
    expect(idx.byNameKey("newname")).toHaveLength(1);
    expect(idx.byNameKey("oldname")).toEqual([]);
    expect(idx.byNameKey("legacyid")).toEqual([]);
    expect(idx.byGsis("ABC123456")).toBeNull();
  });

  it("collects ESPN ids from every row; junk ids never match", () => {
    const idx = buildRosterIndex([
      synthRow({ gsis_id: "00-0099230", full_name: "A Person", espn_id: 9000230, week: 1 }),
      synthRow({ gsis_id: "00-0099230", full_name: "A Person", espn_id: 9000231, week: 2 }),
      synthRow({ gsis_id: "00-0099231", full_name: "B Person", espn_id: 0 }),
      synthRow({ gsis_id: "00-0099232", full_name: "C Person", espn_id: -16021 }),
      synthRow({ gsis_id: "00-0099233", full_name: "D Person", espn_id: "9000233" as never }),
    ]);
    expect(idx.espnIdsOf("00-0099230")).toEqual([9000230, 9000231]);
    expect(idx.byEspnId(9000231)).toEqual(["00-0099230"]);
    expect(idx.byEspnId(0)).toEqual([]);
    expect(idx.byEspnId(-16021)).toEqual([]);
    expect(idx.byEspnId(9000233)).toEqual(["00-0099233"]);
    expect(idx.espnIdsOf("00-0099231")).toEqual([]);
  });

  it("is safe against prototype-named keys", () => {
    const idx = buildRosterIndex([
      synthRow({ gsis_id: "00-0099240", full_name: "Constructor Proto" }),
    ]);
    expect(idx.byNameKey("__proto__")).toEqual([]);
    expect(idx.byNameKey("constructor")).toEqual([]);
    expect(idx.bySurname("toString")).toEqual([]);
    expect(idx.byGsis("__proto__")).toBeNull();
  });

  it("the players index drops invalid rows and dedupes per (ESPN id, gsis)", () => {
    const mixon = fx("Joe Mixon");
    const idx = buildNflPlayersIndex([
      playersRecord(mixon),
      playersRecord(mixon, { display_name: "Second Copy" }),
      playersRecord(mixon, { gsis_id: " 00-0099250" }),
      playersRecord(mixon, { gsis_id: "ABC123456", espn_id: 9000251 }),
      playersRecord(mixon, { gsis_id: "00-0099252", espn_id: null }),
    ]);
    expect(idx.size).toBe(3);
    expect(idx.byEspnId(mixon.espn_id).map((r) => [r.gsis_id, r.display_name])).toEqual([
      ["00-0033897", "Joe Mixon"],
      ["00-0099250", "Joe Mixon"],
    ]);
    expect(idx.byEspnId(9000251)).toEqual([]);
    expect(idx.hasGsis("00-0099252")).toBe(true);
    expect(idx.hasGsis("ABC123456")).toBe(false);
  });
});

// --- scale --------------------------------------------------------------------------------------------

describe("scale", () => {
  it("resolves 5 000 ESPN players against 20 000 roster rows deterministically and quickly", () => {
    const rows: NflRosterPlayer[] = [];
    for (let i = 0; i < 5000; i += 1) {
      for (let w = 1; w <= 4; w += 1) {
        rows.push(
          synthRow({
            gsis_id: `00-01${String(i).padStart(5, "0")}`,
            full_name: `Player Number${String(i)}`,
            week: w,
            espn_id: i % 2 === 0 ? 10_000_000 + i : null,
          }),
        );
      }
    }
    const players = Array.from({ length: 5000 }, (_, i) =>
      synthIdentity({
        espn_id: 10_000_000 + i,
        full_name: `Player Number${String(i)}`,
        percent_owned: 5,
      }),
    );
    const t0 = performance.now();
    const a = run(players, { rows, records: [] });
    const elapsed = performance.now() - t0;
    const b = run([...players].reverse(), { rows: [...rows].reverse(), records: [] });
    expect(a.report.matched).toBe(5000);
    expect(a.pairs.filter((p) => p.method === "id")).toHaveLength(2500);
    expect(a.alert.count).toBe(2500);
    const key = (r: typeof a) =>
      new Map(r.pairs.map((p) => [p.espn_id, [p.gsis_id, p.method, p.confidence]]));
    expect(key(b)).toEqual(key(a));
    expect(elapsed).toBeLessThan(5000);
  });
});

// --- properties -------------------------------------------------------------------------------------

describe("properties", () => {
  const TEAMS = [
    [12, "KC", "KC"],
    [2, "BUF", "BUF"],
    [14, "LAR", "LA"],
    [28, "WSH", "WAS"],
    [0, "FA", null],
  ] as const;
  const NAMES = [
    "Orrin Vexley",
    "Orrin Vexley Jr.",
    "Bastian Quell",
    "Bástian Quell",
    "Cassius Thornby",
  ];
  const POS = [
    [1, "QB"],
    [2, "RB"],
    [3, "WR"],
    [4, "TE"],
    [5, "K"],
    [11, "LB"],
  ] as const;

  interface RowSpec {
    readonly i: number;
    readonly name: string;
    readonly team: string;
    readonly pos: string;
    readonly jersey: number | null;
    readonly espn: number | null;
  }
  interface PlayerSpec {
    readonly espn: number;
    readonly name: string;
    readonly team: number;
    readonly pos: number;
    readonly jersey: string | null;
  }
  const rowArb: fc.Arbitrary<RowSpec> = fc.record({
    i: fc.integer({ min: 0, max: 30 }),
    name: fc.constantFrom(...NAMES),
    team: fc.constantFrom(...TEAMS.flatMap(([, , t]) => (t === null ? [] : [t]))),
    pos: fc.constantFrom(...POS.map(([, p]) => p), "FB"),
    jersey: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
    espn: fc.option(fc.integer({ min: 9000300, max: 9000310 }), { nil: null }),
  });
  const playerArb: fc.Arbitrary<PlayerSpec> = fc.record({
    espn: fc.integer({ min: 9000300, max: 9000315 }),
    name: fc.constantFrom(...NAMES),
    team: fc.integer({ min: 0, max: TEAMS.length - 1 }),
    pos: fc.integer({ min: 0, max: POS.length - 1 }),
    jersey: fc.option(fc.integer({ min: 0, max: 3 }).map(String), { nil: null }),
  });

  function build(rowsIn: readonly RowSpec[], playersIn: readonly PlayerSpec[]) {
    const rows = rowsIn.map((r) =>
      synthRow({
        gsis_id: `00-00994${String(r.i).padStart(2, "0")}`,
        full_name: r.name,
        team: r.team as NflRosterPlayer["team"],
        position: r.pos,
        jersey_number: r.jersey,
        espn_id: r.espn,
      }),
    );
    const players = playersIn.map((p) => {
      const [teamId, abbr] = TEAMS[p.team] ?? TEAMS[0];
      const [posId] = POS[p.pos] ?? POS[0];
      return synthIdentity({
        espn_id: p.espn,
        full_name: p.name,
        pro_team_id: teamId,
        pro_team: abbr,
        position_id: posId,
        jersey: p.jersey,
      });
    });
    return { rows, players };
  }

  it("a deterministic match always has name, team and position agreement (never name alone)", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 25 }),
        fc.array(playerArb, { maxLength: 12 }),
        (rIn, pIn) => {
          const { rows, players } = build(rIn, pIn);
          const r = run(players, { rows, records: [] });
          const idx = buildRosterIndex(rows);
          for (const x of r.resolved) {
            if (x.resolution.status !== "matched" || x.resolution.pair.method !== "match") continue;
            const ev = x.resolution.evidence;
            expect(ev).toEqual(expect.arrayContaining(["name", "team", "position"]));
            const row = idx.byGsis(x.resolution.pair.gsis_id);
            expect(row).not.toBeNull();
            // nflverse never gives the accepted gsis another ESPN id
            const ids = idx.espnIdsOf(x.resolution.pair.gsis_id);
            expect(ids.length === 0 || ids.includes(x.espn_id)).toBe(true);
            expect(x.resolution.pair.confidence).toBeLessThan(1);
          }
          // two ESPN ids never share a gsis on name evidence
          const byGsis = new Map<string, number>();
          for (const p of r.pairs)
            if (p.method === "match") byGsis.set(p.gsis_id, (byGsis.get(p.gsis_id) ?? 0) + 1);
          for (const n of byGsis.values()) expect(n).toBe(1);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("every accepted gsis is one nflverse (or an override) actually names", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 25 }),
        fc.array(playerArb, { maxLength: 12 }),
        (rIn, pIn) => {
          const { rows, players } = build(rIn, pIn);
          const gsis = new Set(rows.map((x) => x.gsis_id));
          for (const p of run(players, { rows, records: [] }).pairs)
            expect(gsis.has(p.gsis_id)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("each player's resolution does not depend on input order", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 20 }),
        fc.uniqueArray(playerArb, { maxLength: 10, selector: (p) => p.espn }),
        fc.integer(),
        (rIn, pIn, seed) => {
          const { rows, players } = build(rIn, pIn);
          const shuffled = [...players].sort(
            (a, b) => ((a.espn_id * 31 + seed) % 97) - ((b.espn_id * 31 + seed) % 97),
          );
          const norm = (r: CrosswalkRun<EspnPlayerIdentity>) =>
            new Map(
              r.resolved.map((x) => [
                x.espn_id,
                x.resolution.status === "matched"
                  ? `m:${x.resolution.pair.gsis_id}:${String(x.resolution.pair.confidence)}`
                  : x.resolution.status,
              ]),
            );
          expect(norm(run(shuffled, { rows, records: [] }))).toEqual(
            norm(run(players, { rows, records: [] })),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
