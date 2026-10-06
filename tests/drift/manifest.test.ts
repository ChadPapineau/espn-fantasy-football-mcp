// manifest.test.ts — src/drift/manifest.ts (plan 01 §7; plan 05 §3.3): both committed manifests load
// (the probe manifest's `views` and the entity manifest's whole-response views), the entity
// manifest's shape equals the mirror type in src/drift/types.ts (the generator's, held equal), and a
// malformed manifest throws — it never reads as "no drift". 100 % (plan 05 §7).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENTITY_MANIFEST_PATH as GENERATOR_PATH,
  ENTITY_MANIFEST_VERSION as GENERATOR_VERSION,
} from "../../scripts/espn-fixture/entity-manifest.js";
import {
  loadObservations,
  MAX_MANIFEST_BYTES,
  observationsFrom,
  parseViewObservations,
} from "../../src/drift/manifest.js";
import {
  ENTITY_MANIFEST_PATH,
  ENTITY_MANIFEST_VERSION,
  MANIFEST_PATH,
  type EntityManifest,
} from "../../src/drift/types.js";
import { ROOT, tempDir } from "../lint/helpers.js";

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe("the committed manifests load", () => {
  it("the probe manifest: every recorded view, patterns parsed", () => {
    const obs = loadObservations(path.join(ROOT, MANIFEST_PATH));
    expect(Object.keys(obs).sort()).toEqual(
      [
        "kona_player_info",
        "kona_playercard",
        "mBoxscore",
        "mMatchup",
        "mMatchupScore",
        "mNav",
        "mRoster",
        "mSettings",
        "mStandings",
        "mTeam",
        "players_wl",
        "proTeamSchedules_wl",
      ].sort(),
    );
    expect(obs.mRoster?.observed["$.teams[]"]).toContain("roster");
    expect(Object.isFrozen(obs)).toBe(true);
  });
  it("the entity manifest: its constants and shape mirror the generator's", () => {
    expect(ENTITY_MANIFEST_PATH).toBe(GENERATOR_PATH);
    expect(ENTITY_MANIFEST_VERSION).toBe(GENERATOR_VERSION);
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, ENTITY_MANIFEST_PATH), "utf8"),
    ) as EntityManifest;
    expect(raw.version).toBe(ENTITY_MANIFEST_VERSION);
    const v = raw.views.mRoster!;
    for (const k of [
      "sources",
      "source_sha256",
      "responses",
      "top_level_keys",
      "top_level_optional",
      "observed",
      "enums",
      "array_lengths",
      "nodes",
      "optional",
      "map_keys",
      "entities",
    ])
      expect(v, k).toHaveProperty(k);
    const obs = loadObservations(path.join(ROOT, ENTITY_MANIFEST_PATH));
    expect(obs.mBoxscore?.enums).toBeDefined();
  });
});

describe("malformed manifests throw", () => {
  it.each([
    ["not an object", 5],
    ["wrong version", { version: 2, views: {} }],
    ["no views", { version: 1 }],
  ])("%s", (_name, m) => {
    expect(() => observationsFrom(m)).toThrow(/drift manifest/);
  });
  it("a view without observed/enums, a bad pattern, a non-string key, a non-scalar enum", () => {
    expect(() => parseViewObservations("mRoster", { observed: {} })).toThrow(/malformed/);
    expect(() => parseViewObservations("mRoster", { observed: { teams: [] }, enums: {} })).toThrow(
      /pattern/,
    );
    expect(() => parseViewObservations("mRoster", { observed: { $: [1] }, enums: {} })).toThrow(
      /string list/,
    );
    expect(() => parseViewObservations("mRoster", { observed: { $: "x" }, enums: {} })).toThrow(
      /string list/,
    );
    expect(() =>
      parseViewObservations("mRoster", { observed: {}, enums: { "$.a": [{}] } }),
    ).toThrow(/enum list/);
    expect(() => parseViewObservations("mRoster", { observed: {}, enums: { "$.a": "x" } })).toThrow(
      /enum list/,
    );
    expect(
      parseViewObservations("mRoster", {
        observed: { $: ["a"] },
        enums: { "$.a": ["X", 1, true, null] },
      }),
    ).toEqual({
      observed: { $: ["a"] },
      enums: { "$.a": ["X", 1, true, null] },
    });
  });
  it("views not on the whitelist are ignored (the detector never requests them)", () => {
    expect(
      observationsFrom({ version: 1, views: { mBogus: { observed: {}, enums: {} } } }),
    ).toEqual({});
  });
  it("a file over the size bound is refused; bad JSON throws", () => {
    tmp = tempDir("eff-drift-");
    const big = path.join(tmp.dir, "big.json");
    writeFileSync(big, `{"version":1,"views":{},"pad":"${"x".repeat(MAX_MANIFEST_BYTES)}"}`);
    expect(() => loadObservations(big)).toThrow(/too large/);
    const bad = path.join(tmp.dir, "bad.json");
    writeFileSync(bad, "{");
    expect(() => loadObservations(bad)).toThrow(SyntaxError);
  });
});
