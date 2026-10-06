// drift-composite.test.ts — two in-call drift defects found by the end-to-end run (plan 01 §7; plan
// 05 §3.3; plan 10 A4a): (1) a COMPOSITE request (mSettings+mNav, mTeam+mStandings — research 03
// §A.2: views compose additively) reported every key of one view as "additive" under the other, so
// the first settings read of any session turned drift_state additive; (2) map-like objects (stats by
// stat id, games by period, acquisitions by matchup) had their data keys reported as additive,
// although the manifest generator walks them by value and records no keys. The recorded bodies, as
// recorded, must now raise no signal; genuine additions still do.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkResponse, compositeObservations, isMapLike } from "../../src/drift/detect.js";
import { loadObservations } from "../../src/drift/index.js";
import { MANIFEST_PATH, type DriftObservations } from "../../src/drift/types.js";
import { composeBodies } from "../../src/providers/espn/fixture.js";
import type { EspnView } from "../../src/providers/espn/types.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OBS = loadObservations(path.join(ROOT, MANIFEST_PATH));
const rec = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, "fixtures/espn/recorded", rel), "utf8")) as unknown;
const kinds = (views: readonly EspnView[], body: unknown, obs: DriftObservations = OBS) =>
  checkResponse(views, body, obs).signals.map((s) => `${s.kind}:${s.view}:${s.path}`);

describe("recorded bodies, as recorded, raise no drift signal", () => {
  it.each<[string, EspnView[], () => unknown]>([
    [
      "mSettings+mNav (the provider's settings read)",
      ["mSettings", "mNav"],
      () => composeBodies(rec("league-b/mSettings.json"), rec("league-b/mNav.json")),
    ],
    ["mTeam+mStandings", ["mTeam", "mStandings"], () => rec("league-b/mTeam.json")],
    ["mRoster (stats maps)", ["mRoster"], () => rec("league-b/mRoster.sp3.p1.json")],
    ["mBoxscore (appliedStats maps)", ["mBoxscore"], () => rec("league-b/mBoxscore.sp3.json")],
    ["mMatchupScore", ["mMatchupScore"], () => rec("league-b/mMatchupScore.sp4.json")],
    ["kona_player_info", ["kona_player_info"], () => rec("league-b/kona_player_info.json")],
    [
      "proTeamSchedules_wl (games by period)",
      ["proTeamSchedules_wl"],
      () => rec("season/proTeamSchedules_wl.json"),
    ],
  ])("%s", (_, views, body) => {
    expect(kinds(views, body())).toEqual([]);
  });
});

describe("genuine changes are still reported", () => {
  it("a new key on a composite response is additive, attributed to the view owning the pattern", () => {
    const body = composeBodies(rec("league-b/mSettings.json"), rec("league-b/mNav.json")) as {
      settings: Record<string, unknown>;
    };
    body.settings.brandNewSetting = 1;
    const k = kinds(["mSettings", "mNav"], body);
    expect(k).toContain("additive_key:mSettings:$.settings.brandNewSetting");
    expect(k.every((x) => x.startsWith("additive_key:"))).toBe(true);
  });

  it("a new enum value on a composite response is still unknown", () => {
    const body = composeBodies(rec("league-b/mSettings.json"), rec("league-b/mNav.json")) as {
      settings: { scheduleSettings: { playoffSeedingRule: string } };
    };
    body.settings.scheduleSettings.playoffSeedingRule = "BRAND_NEW_RULE";
    expect(
      kinds(["mSettings", "mNav"], body).some((x) => x.startsWith("unknown_enum_value:")),
    ).toBe(true);
  });

  it("an ordinary (non-map) object still reports an unknown identifier key", () => {
    const body = rec("league-b/mRoster.sp3.p1.json") as {
      teams: { roster: Record<string, unknown> }[];
    };
    const first = body.teams[0];
    if (first === undefined) throw new Error("no team");
    first.roster.brandNewRosterKey = true;
    expect(kinds(["mRoster"], body)).toContain(
      "additive_key:mRoster:$.teams[].roster.brandNewRosterKey",
    );
  });

  it("a missing required key on one team of a composite read still fails the response", () => {
    const body = rec("league-b/mTeam.json") as { teams: Record<string, unknown>[] };
    const first = body.teams[0];
    if (first === undefined) throw new Error("no team");
    delete first.record;
    const r = checkResponse(["mTeam", "mStandings"], body, OBS);
    expect(r.drifted).toBe(true);
    expect(r.first?.kind).toBe("missing_required_key");
  });
});

describe("isMapLike — all-integer id maps only", () => {
  it.each<[Record<string, unknown>, boolean]>([
    [{}, false],
    [{ "1": 1, "23": 2, "-16034": 3 }, true],
    [{ a: 1, b: 2 }, false],
    // one odd or identifier key keeps the object ordinary: an addition can never hide behind it
    [{ a: 1, "2": 2 }, false],
    [{ "a-b": 1 }, false],
    [{ $ok: 1, _also: 2, camelCase: 3 }, false],
    [{ "1.5": 1 }, false],
    [{ "007": 1, "0": 2 }, true],
  ])("%j → %s", (o, want) => {
    expect(isMapLike(o)).toBe(want);
  });
});

describe("compositeObservations", () => {
  const obs: DriftObservations = {
    mSettings: {
      observed: { $: ["settings", "status"], "$.settings": ["name"] },
      enums: { "$.x": ["A"] },
    },
    mNav: {
      observed: { $: ["members", "settings"], "$.members[]": ["id"] },
      enums: { "$.x": ["B"] },
    },
  };

  it("unions the keys and enum values of the patterns the views share; each keeps its own patterns", () => {
    const m = compositeObservations(["mSettings", "mNav", "mTeam"], obs);
    expect([...(m.mSettings?.observed.$ ?? [])].sort()).toEqual(["members", "settings", "status"]);
    expect(m.mSettings?.observed["$.settings"]).toEqual(["name"]);
    expect(Object.keys(m.mNav?.observed ?? {}).sort()).toEqual(["$", "$.members[]"]);
    expect(m.mNav?.enums["$.x"]).toEqual(["A", "B"]);
    // a view with no observations stays unobserved (checked for required keys only)
    expect(m.mTeam).toBeUndefined();
  });

  it("a single-view request uses the view's own observations unchanged", () => {
    const body = composeBodies(rec("league-b/mSettings.json"), rec("league-b/mNav.json"));
    // asked as mSettings alone, mNav's `members` is not one of mSettings' keys → additive
    expect(kinds(["mSettings"], body)).toContain("additive_key:mSettings:$.members");
    // asked as the composite it is known
    expect(kinds(["mSettings", "mNav"], body)).toEqual([]);
  });
});
