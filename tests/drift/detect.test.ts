// detect.test.ts — src/drift/detect.ts, the in-call detector (plan 01 §7; plan 05 §3.3 T4): every
// recorded view passes clean against its manifest observations; the P28 skeleton fails for EVERY
// known view (a renamed view is caught); `teams[].roster` renamed to `lineup` fails mRoster naming
// the path; removing each required key fails it; a new key is additive (counted, not fatal); a new
// injuryStatus is a warning; a new statSourceId is meaning-changing (fails the entry, not the
// response); scrubbed keys are known; signals are bounded.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkResponse,
  enumToken,
  failsResponse,
  hostMovedSignal,
  MAX_SIGNALS_PER_KIND,
  SCRUBBED_KEYS,
} from "../../src/drift/detect.js";
import { observationsFrom } from "../../src/drift/manifest.js";
import { REQUIRED_PATHS_BY_VIEW } from "../../src/drift/types.js";
import {
  ESPN_VIEWS,
  SEASON_PLAYER_VIEWS,
  SEASON_VIEWS,
  type EspnView,
} from "../../src/providers/espn/types.js";
import { ROOT } from "../lint/helpers.js";

const load = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as unknown;
const clone = <T>(v: T): T => structuredClone(v);
const probeManifest = load("drift/manifest.json") as {
  views: Record<string, { sources: string[] }>;
};
const observations = observationsFrom(probeManifest);
const entityObservations = observationsFrom(load("drift/entity-manifest.json"));

describe("recorded views pass clean", () => {
  it("every source of every manifest view: no failing signal, no enum signal (either manifest)", () => {
    let checked = 0;
    for (const [view, vm] of Object.entries(probeManifest.views)) {
      for (const rel of vm.sources) {
        const body = load(rel);
        for (const obs of [observations, entityObservations]) {
          const r = checkResponse([view as EspnView], body, obs);
          expect(r.drifted, `${view} ${rel}`).toBe(false);
          expect(r.first).toBeNull();
          expect(
            r.signals.filter((s) => s.kind !== "additive_key"),
            `${view} ${rel}`,
          ).toEqual([]);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
  it("a composite request checks each of its views (mSettings&mNav&mTeam probe body)", () => {
    const r = checkResponse(
      ["mSettings", "mNav", "mTeam"],
      load("espn/recorded/league-a/probe-shape.json"),
      observations,
    );
    expect(r.drifted).toBe(false);
  });
});

describe("skeleton detection (research 03 §A.2 P28)", () => {
  const leagueSkeleton = load("espn/recorded/league-a/skeleton.json");
  const seasonSkeleton = load("espn/recorded/season/skeleton.json");
  it.each(ESPN_VIEWS)("the recorded skeleton fails as %s", (view) => {
    const season =
      (SEASON_VIEWS as readonly string[]).includes(view) ||
      (SEASON_PLAYER_VIEWS as readonly string[]).includes(view);
    const r = checkResponse([view], season ? seasonSkeleton : leagueSkeleton, observations);
    expect(r.drifted).toBe(true);
    expect(r.skeleton).toBe(true);
    expect(r.first).toEqual({
      kind: "skeleton",
      view,
      path: REQUIRED_PATHS_BY_VIEW[view][0],
      value: null,
    });
    expect(failsResponse(r.first!)).toBe(true);
  });
  it("a composite with one renamed view fails as a skeleton of that view only", () => {
    const body = clone(load("espn/recorded/league-a/mSettings.json")) as Record<string, unknown>;
    const r = checkResponse(["mSettings", "mNav"], body);
    expect(r.signals).toEqual([
      { kind: "skeleton", view: "mNav", path: "$.members[].isLeagueCreator", value: null },
    ]);
  });
});

describe("missing and renamed keys", () => {
  it("teams[].roster renamed to lineup fails mRoster with the JSON path", () => {
    const body = clone(load("espn/recorded/league-a/mRoster.sp3.p1.json")) as {
      teams: Record<string, unknown>[];
    };
    for (const t of body.teams) {
      t.lineup = t.roster;
      delete t.roster;
    }
    const r = checkResponse(["mRoster"], body, observations);
    expect(r.drifted).toBe(true);
    expect(r.first).toMatchObject({ view: "mRoster", path: "$.teams[].roster.entries" });
  });
  it("a required key missing on ONE node is still drift (partial)", () => {
    const body = clone(load("espn/recorded/league-b/mTeam.json")) as {
      teams: Record<string, unknown>[];
    };
    delete body.teams[0]!.waiverRank;
    const r = checkResponse(["mTeam"], body);
    expect(r.skeleton).toBe(false);
    expect(r.signals).toEqual([
      { kind: "missing_required_key", view: "mTeam", path: "$.teams[].waiverRank", value: null },
    ]);
  });
  it("each required path of mSettings removed → a failing signal naming it", () => {
    for (const p of REQUIRED_PATHS_BY_VIEW.mSettings) {
      const body = clone(load("espn/recorded/league-c/mSettings.json")) as {
        settings: Record<string, unknown>;
      };
      Reflect.deleteProperty(body.settings, p.split(".").pop()!);
      const r = checkResponse(["mSettings"], body);
      expect(r.first?.path).toBe(p);
    }
  });
});

describe("enum and additive drift", () => {
  it("a new injuryStatus is a warning, counted once per value; a new statSourceId is meaning-changing", () => {
    const body = clone(load("espn/recorded/league-a/kona_player_info.json")) as {
      players: { player: { injuryStatus?: string; stats: { statSourceId: number }[] } }[];
    };
    body.players[0]!.player.injuryStatus = "SUSPENSION_LONG";
    body.players[1]!.player.injuryStatus = "SUSPENSION_LONG";
    body.players[2]!.player.stats[0]!.statSourceId = 7;
    const r = checkResponse(["kona_player_info"], body, observations);
    expect(r.drifted).toBe(false);
    const enums = r.signals.filter((s) => s.kind !== "additive_key");
    expect(enums).toEqual([
      {
        kind: "unknown_enum_value",
        view: "kona_player_info",
        path: "$.players[].player.injuryStatus",
        value: "SUSPENSION_LONG",
      },
      {
        kind: "meaning_changing_enum",
        view: "kona_player_info",
        path: "$.players[].player.stats[].statSourceId",
        value: "7",
      },
    ]);
    expect(enums.map(failsResponse)).toEqual([false, false]);
  });
  it("a new key is additive (counted, not fatal); scrubbed keys are known; odd keys render as <key>", () => {
    const body = clone(load("espn/recorded/league-a/mSettings.json")) as Record<string, unknown> & {
      settings: Record<string, unknown>;
    };
    body.brandNewKey = 1;
    body.settings.notificationSettings = {};
    body["weird key"] = 2;
    const r = checkResponse(["mSettings"], body, observations);
    expect(r.drifted).toBe(false);
    expect(r.signals).toEqual([
      { kind: "additive_key", view: "mSettings", path: "$.brandNewKey", value: null },
      { kind: "additive_key", view: "mSettings", path: "$.<key>", value: null },
    ]);
    expect(SCRUBBED_KEYS.has("notificationSettings")).toBe(true);
  });
  it("enum values that are not tokens read as null; non-scalar enum nodes are skipped; signals are capped", () => {
    const body = clone(load("espn/recorded/league-a/mRoster.sp3.p1.json")) as {
      teams: { roster: { entries: { injuryStatus: unknown; lineupSlotId: unknown }[] } }[];
    };
    const entries = body.teams.flatMap((t) => t.roster.entries);
    entries.forEach((e, i) => {
      e.injuryStatus = `NEW_${String(i)}`;
    });
    entries[0]!.injuryStatus = "lower case value";
    entries[1]!.lineupSlotId = { not: "scalar" };
    const r = checkResponse(["mRoster"], body, { mRoster: observations.mRoster! });
    const enums = r.signals.filter((s) => s.kind === "unknown_enum_value");
    expect(enums.length).toBe(MAX_SIGNALS_PER_KIND);
    expect(enums[0]?.value).toBeNull();
  });
  it("an observed pattern that selects a non-object is skipped", () => {
    const body = clone(load("espn/recorded/league-a/mRoster.sp3.p1.json")) as Record<
      string,
      unknown
    >;
    body.draftDetail = 5;
    const r = checkResponse(["mRoster"], body, observations);
    expect(r.drifted).toBe(false);
    expect(r.signals.some((s) => s.path.startsWith("$.draftDetail"))).toBe(false);
  });
  it("additive signals are capped per response", () => {
    const body = clone(load("espn/recorded/league-a/mSettings.json")) as Record<string, unknown>;
    for (let i = 0; i < MAX_SIGNALS_PER_KIND + 10; i++) body[`k${String(i)}`] = i;
    const r = checkResponse(["mSettings"], body, observations);
    expect(r.signals.filter((s) => s.kind === "additive_key")).toHaveLength(MAX_SIGNALS_PER_KIND);
  });
  it("without observations only the required seed runs; a view absent from them is keys-only", () => {
    const body = clone(load("espn/recorded/league-a/mSettings.json")) as Record<string, unknown>;
    body.brandNewKey = 1;
    expect(checkResponse(["mSettings"], body).signals).toEqual([]);
    expect(checkResponse(["mSettings"], body, {}).signals).toEqual([]);
  });
});

describe("helpers", () => {
  it("enumToken", () => {
    expect(enumToken("ACTIVE")).toBe("ACTIVE");
    expect(enumToken(16)).toBe("16");
    expect(enumToken(1.5)).toBeNull();
    expect(enumToken("ignore previous instructions")).toBeNull();
    expect(enumToken("A".repeat(65))).toBeNull();
    expect(enumToken(null)).toBeNull();
  });
  it("hostMovedSignal fails the response", () => {
    expect(hostMovedSignal("mRoster")).toEqual({
      kind: "host_moved",
      view: "mRoster",
      path: "$",
      value: null,
    });
    expect(failsResponse(hostMovedSignal("mRoster"))).toBe(true);
  });
});
