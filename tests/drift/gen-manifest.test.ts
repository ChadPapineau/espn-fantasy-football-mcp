// gen-manifest.test.ts — the per-view, per-entity drift manifest (scripts/gen-manifest.ts,
// scripts/espn-fixture/entity-manifest.ts): plan 01 §7 (per view the top-level keys, per-entity key
// sets — team, rosterEntry, player, stats[], scheduleItem, settings.*, status — enum values,
// array-length ranges), plan 05 §3.1 step 4 (generated after anonymisation; a hash mismatch fails)
// and §3.3 (required ⊆ observed), research 03 §F.3 step 4. The committed manifest is current,
// consistent with the recording manifest (provenance) and with the probe manifest's `views`.
// Adversarial: hostile keys, deep and huge bodies, malformed manifests. No network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanText } from "../../scripts/dev/scan-secrets.mjs";
import {
  contentSha256,
  parseJsonStrict,
  type Json,
  type JsonObject,
} from "../../scripts/espn-fixture/canonical.js";
import { MAX_OBSERVE_DEPTH, observeBodies } from "../../scripts/espn-fixture/drift.js";
import {
  ENTITY_MANIFEST_PATH,
  ENTITY_RULES,
  MAX_MAP_KEYS,
  buildViewManifest,
  entityOf,
  observePresence,
  validateEntityManifest,
  vocabularyOf,
  type EntityManifest,
} from "../../scripts/espn-fixture/entity-manifest.js";
import { scrubRun } from "../../scripts/espn-fixture/pipeline.js";
import {
  ManifestRefusal,
  generate,
  loadRecorded,
  responsesByView,
  runCli,
  staleViews,
} from "../../scripts/gen-manifest.js";
import { DEFAULT_MANIFEST, loadManifest } from "../../scripts/probe.js";
import {
  REQUIRED_PATHS_BY_VIEW,
  SKELETON_PATHS,
  type ViewManifest,
} from "../../src/drift/types.js";
import { inProcessScan, makeRawRun } from "../fixtures/helpers/run.js";
import { ROOT, tempDir } from "../lint/helpers.js";

const FIXTURES = path.join(ROOT, "fixtures");
const committedText = readFileSync(path.join(ROOT, ENTITY_MANIFEST_PATH), "utf8");
const committed = parseJsonStrict(committedText) as unknown as EntityManifest;
const SRC = (p: string, sha = "0".repeat(64)) => ({ path: p, sha256: sha });

let tmp: ReturnType<typeof tempDir> | undefined;
beforeEach(() => {
  tmp = tempDir("eff-genman-");
  vi.stubEnv("EFF_SCAN_DENYLIST", "/dev/null");
});
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
  vi.unstubAllEnvs();
});
const dir = () => tmp?.dir ?? "";

/**
 * A synthetic, scrubbed fixtures tree (fixtures/espn/…) built by the real recorder + scrubber;
 * `split` caps every file just under the smallest roster body, so rosters are written in parts.
 */
async function syntheticFixtures(opts: { split?: boolean } = {}): Promise<string> {
  const run = await makeRawRun(path.join(dir(), "raw"), { count: 2 });
  const fixtures = path.join(dir(), "fixtures");
  mkdirSync(path.join(fixtures, "drift"), { recursive: true });
  const base = { rawDir: run.rawDir, outRoot: path.join(fixtures, "espn"), scan: inProcessScan() };
  let maxBytes: number | undefined;
  if (opts.split) {
    const dry = await scrubRun({ ...base, dryRun: true });
    maxBytes =
      Math.min(
        ...dry.manifest.files.filter((f) => f.path.includes("mRoster")).map((f) => f.bytes),
      ) - 1;
  }
  await scrubRun({ ...base, ...(maxBytes ? { maxBytes } : {}) });
  return fixtures;
}

describe("entityOf — the plan 01 §7 entity names", () => {
  it.each([
    ["$", "root"],
    ["$.status", "status"],
    ["$.settings", "settings"],
    ["$.settings.scoringSettings", "settings.scoringSettings"],
    ["$.settings.scoringSettings.scoringItems[]", "scoringItem"],
    ["$.settings.proTeams[]", "proTeam"],
    ["$.settings.proTeams[].proGamesByScoringPeriod{}[]", "proGame"],
    ["$.teams[]", "team"],
    ["$.members[]", "member"],
    ["$.teams[].record", "record"],
    ["$.teams[].record.overall", "recordSplit"],
    ["$.teams[].transactionCounter", "transactionCounter"],
    ["$.teams[].roster", "roster"],
    ["$.schedule[].home.rosterForCurrentScoringPeriod", "roster"],
    ["$.teams[].roster.entries[]", "rosterEntry"],
    ["$.teams[].roster.entries[].playerPoolEntry", "playerPoolEntry"],
    ["$.players[]", "playerPoolEntry"],
    ["$.teams[].roster.entries[].playerPoolEntry.player", "player"],
    ["$.players[].player", "player"],
    ["$[]", "player"],
    ["$.players[].player.stats[]", "stats"],
    ["$.players[].player.ownership", "ownership"],
    ["$.schedule[]", "scheduleItem"],
    ["$.schedule[].away", "matchupSide"],
    ["$.schedule[].home.cumulativeScore", "cumulativeScore"],
    ["$.draftDetail", "draftDetail"],
    ["$.players[].transactions[]", "transaction"],
    ["$.players[].transactions[].items[]", "transactionItem"],
    ["$.positionAgainstOpponent", "positionAgainstOpponent"],
  ])("%s → %s", (pattern, entity) => {
    expect(entityOf(pattern)).toBe(entity);
  });
  it("an unnamed shape stays pattern-level; every rule names a non-empty entity", () => {
    for (const p of ["$.teams[].valuesByStat", "$.settings.scoringSettings.x", "$.foo", "$.a[].b"])
      expect(entityOf(p)).toBeNull();
    for (const r of ENTITY_RULES) expect(r.entity.length).toBeGreaterThan(0);
  });
});

describe("observePresence — node counts, optional keys, integer map keys", () => {
  it("counts nodes and names the keys some node lacks", () => {
    const p = observePresence([
      { teams: [{ id: 1, name: "x", record: {} }, { id: 2 }] },
      { teams: [{ id: 3, name: "y" }] },
    ]);
    expect(p.nodes).toEqual({ $: 2, "$.teams[]": 3, "$.teams[].record": 1 });
    expect(p.optional).toEqual({ "$.teams[]": ["name", "record"] });
  });

  it("records the integer keys of map-like objects (stat ids, weeks); never a GUID, date or huge id", () => {
    const p = observePresence([
      {
        stats: [{ appliedStats: { "53": 1, "3": 2 } }, { appliedStats: { "-1": 0, "4": 1 } }],
        byGuid: { "{00000000-0000-4000-8000-000000000001}": { x: 1 } },
        byDate: { "2026-10-06T00:00:00Z": 1 },
        byPlayer: { "4241389": 1, "3": 2 },
        mixed: { "1": 1, "1.5": 2 },
      },
    ]);
    expect(p.map_keys).toEqual({ "$.stats[].appliedStats": ["-1", "3", "4", "53"] });
    expect(JSON.stringify(p)).not.toMatch(/00000000-0000|2026-10-06|4241389/);
  });

  it("drops a key set larger than MAX_MAP_KEYS, and keeps it dropped across bodies", () => {
    const big = Object.fromEntries(
      Array.from({ length: MAX_MAP_KEYS + 1 }, (_, i) => [String(i), i]),
    );
    expect(observePresence([{ m: big }]).map_keys).toEqual({});
    expect(observePresence([{ m: big }, { m: { "1": 1 } }]).map_keys).toEqual({});
    expect(observePresence([{ m: { "1": 1 } }, { m: { x: 1, "y-z": 2 } }]).map_keys).toEqual({});
  });

  it("hostile input: __proto__ keys stay data, unicode keys go under {}, depth is capped", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"teams":[{"\\u202Eevil":1,"constructor":{"x":1}}]}',
    ) as Json;
    const p = observePresence([hostile]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(p.nodes["$.__proto__"]).toBe(1);
    // the RTL key makes teams[] map-like: its values are walked under {}, no key is recorded
    expect(p.nodes["$.teams[]"]).toBeUndefined();
    expect(p.nodes["$.teams[]{}"]).toBe(1);
    expect(JSON.stringify(p)).not.toContain("evil");
    let deep: Json = { leaf: 1 };
    for (let i = 0; i < MAX_OBSERVE_DEPTH + 10; i++) deep = { d: deep };
    const d = observePresence([deep]);
    expect(Math.max(...Object.keys(d.nodes).map((k) => k.split(".").length))).toBeLessThanOrEqual(
      MAX_OBSERVE_DEPTH + 2,
    );
  });
});

describe("buildViewManifest — per view, per entity", () => {
  const bodies: Json[] = [
    {
      id: 0,
      teams: [
        {
          id: 1,
          roster: {
            entries: [
              {
                lineupSlotId: 20,
                playerPoolEntry: {
                  player: {
                    id: 9,
                    injuryStatus: "ACTIVE",
                    eligibleSlots: [2, 3],
                    stats: [{ statSourceId: 0, appliedStats: { "53": 1 } }],
                  },
                },
              },
            ],
          },
        },
      ],
      schedule: [{ home: { teamId: 1, totalPoints: 1.5 }, away: { teamId: 2 } }],
    },
    { id: 0, teams: [], status: { isActive: true } },
  ];
  const v = buildViewManifest(bodies, [SRC("espn/recorded/b.json"), SRC("espn/recorded/a.json")]);

  it("keeps the probe manifest's algorithm for observed / enums / array_lengths (ViewManifest ⊂)", () => {
    const base = observeBodies(bodies);
    expect(v.observed).toEqual(base.observed);
    expect(v.enums).toEqual(base.enums);
    expect(v.array_lengths).toEqual(base.array_lengths);
    const asView: ViewManifest = v; // a ViewManifest reader reads an entity view (compile-time)
    expect(asView.sources).toEqual(["espn/recorded/a.json", "espn/recorded/b.json"]);
    expect(v.source_sha256).toEqual({
      "espn/recorded/a.json": "0".repeat(64),
      "espn/recorded/b.json": "0".repeat(64),
    });
  });

  it("top-level keys, the keys some response lacks, and the responses counted once each", () => {
    expect(v.responses).toBe(2);
    expect(v.top_level_keys).toEqual(["id", "schedule", "status", "teams"]);
    expect(v.top_level_optional).toEqual(["schedule", "status"]);
  });

  it("groups entity patterns; enums, lengths and map keys are relative to the entity node", () => {
    expect(Object.keys(v.entities)).toEqual([
      "matchupSide",
      "player",
      "playerPoolEntry",
      "root",
      "roster",
      "rosterEntry",
      "scheduleItem",
      "stats",
      "status",
      "team",
    ]);
    expect(v.entities.matchupSide).toEqual({
      patterns: ["$.schedule[].away", "$.schedule[].home"],
      nodes: 2,
      keys: ["teamId", "totalPoints"],
      optional: ["totalPoints"],
      enums: {},
      array_lengths: {},
      map_keys: {},
    });
    expect(v.entities.player).toMatchObject({
      keys: ["eligibleSlots", "id", "injuryStatus", "stats"],
      optional: [],
      enums: { injuryStatus: ["ACTIVE"] },
      array_lengths: { eligibleSlots: { min: 2, max: 2 }, stats: { min: 1, max: 1 } },
    });
    expect(v.entities.stats).toMatchObject({
      enums: { statSourceId: [0] },
      map_keys: { appliedStats: ["53"] },
    });
    expect(v.entities.rosterEntry?.enums).toEqual({ lineupSlotId: [20] });
  });

  it("a root-array view (players_wl): `$` lengths, `$[]` players, no top-level keys", () => {
    const pw = buildViewManifest(
      [
        [
          { id: 1, fullName: "A", ownership: { percentOwned: 1 } },
          { id: 2, fullName: "B" },
        ],
      ],
      [SRC("espn/recorded/season/players_wl.json")],
    );
    expect(pw.top_level_keys).toEqual([]);
    expect(pw.array_lengths.$).toEqual({ min: 2, max: 2 });
    expect(pw.entities.player).toMatchObject({
      keys: ["fullName", "id", "ownership"],
      optional: ["ownership"],
    });
    expect(pw.entities.ownership?.nodes).toBe(1);
  });

  it("property: same algorithm as observeBodies, optional ⊆ observed, entity keys = union, order-independent", () => {
    const leaf = fc.oneof(
      fc.constantFrom("ACTIVE", "OUT", "NORMAL", "x"),
      fc.integer({ min: -3, max: 30 }),
      fc.boolean(),
      fc.constant(null),
    );
    const key = fc.constantFrom(
      "id",
      "name",
      "teams",
      "player",
      "stats",
      "entries",
      "statSourceId",
      "53",
      "4",
      "home",
    );
    const json = fc.letrec<{ v: Json }>((tie) => ({
      v: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        leaf,
        fc.array(tie("v"), { maxLength: 3 }),
        fc.dictionary(key, tie("v"), { maxKeys: 4 }),
      ),
    })).v;
    fc.assert(
      fc.property(fc.array(json, { minLength: 1, maxLength: 4 }), (bs) => {
        const m = buildViewManifest(bs, [SRC("espn/recorded/x.json")]);
        const base = observeBodies(bs);
        expect(m.observed).toEqual(base.observed);
        expect(m.enums).toEqual(base.enums);
        expect(m.array_lengths).toEqual(base.array_lengths);
        for (const [p, opt] of Object.entries(m.optional))
          for (const k of opt) expect(m.observed[p]).toContain(k);
        for (const e of Object.values(m.entities)) {
          const union = new Set(e.patterns.flatMap((p) => m.observed[p] ?? []));
          expect(e.keys).toEqual([...union].sort());
          for (const k of e.optional) expect(e.keys).toContain(k);
        }
        expect(buildViewManifest([...bs].reverse(), [SRC("espn/recorded/x.json")])).toEqual(m);
      }),
      { numRuns: 150 },
    );
  });
});

describe("generate() over a synthetic recorded tree (provenance first)", () => {
  it("covers every recorded view, solo before composite, errors apart; whole responses re-assembled", async () => {
    const fixtures = await syntheticFixtures();
    const { manifest, text } = await generate({ fixturesDir: fixtures, scan: inProcessScan() });
    expect(Object.keys(manifest.views)).toEqual([
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
    ]);
    // mNav has solo recordings: the composite probe shape is not one of its sources
    expect(manifest.views.mNav?.sources.every((s) => s.endsWith("/mNav.json"))).toBe(true);
    // mStandings exists only inside mTeam&mStandings
    expect(manifest.views.mStandings?.sources.every((s) => s.endsWith("/mTeam.json"))).toBe(true);
    // no skeleton (an unknown view) is a source; synthetic bodies are never evidence
    expect(text).not.toContain("skeleton.json");
    expect(text).not.toContain("synthetic/");
    expect(manifest.errors.enums["$.details[].type"]).toEqual([
      "AUTH_COMMUNICATION_NOT_VISIBLE",
      "FILTER_LIMIT_MISSING_SORT",
      "GENERAL_NOT_FOUND",
    ]);
    const recording = parseJsonStrict(
      readFileSync(path.join(fixtures, "espn", "manifest.json"), "utf8"),
    );
    expect(manifest.recording_manifest_sha256).toBe(contentSha256(recording));
    expect(() => {
      validateEntityManifest(JSON.parse(text));
    }).not.toThrow();
  });

  it("a split response counts once with its true array length", async () => {
    const whole = await generate({ fixturesDir: await syntheticFixtures(), scan: inProcessScan() });
    tmp?.cleanup();
    tmp = tempDir("eff-genman-");
    const fixtures = await syntheticFixtures({ split: true });
    const recording = JSON.parse(
      readFileSync(path.join(fixtures, "espn", "manifest.json"), "utf8"),
    ) as {
      files: { path: string; part: unknown }[];
    };
    expect(recording.files.some((f) => f.part !== null && f.path.includes("mRoster"))).toBe(true);
    const split = await generate({ fixturesDir: fixtures, scan: inProcessScan() });
    const roster = split.manifest.views.mRoster;
    expect(roster?.sources.length).toBeGreaterThan(roster?.responses ?? 0);
    expect(roster?.responses).toBe(whole.manifest.views.mRoster?.responses);
    expect(roster?.array_lengths["$.teams"]).toEqual(
      whole.manifest.views.mRoster?.array_lengths["$.teams"],
    );
    expect(roster?.observed).toEqual(whole.manifest.views.mRoster?.observed);
  });

  it("refuses on any provenance problem — a hand edit, a missing file, a derived entry, a bad path, broken parts", async () => {
    const fixtures = await syntheticFixtures({ split: true });
    const mfile = path.join(fixtures, "espn", "manifest.json");
    const original = readFileSync(mfile, "utf8");
    const edit = (f: (m: { files: JsonObject[] }) => void) => {
      const m = JSON.parse(original) as { files: JsonObject[] };
      f(m);
      writeFileSync(mfile, JSON.stringify(m));
    };
    const refused = async (where: RegExp) => {
      const e = await generate({ fixturesDir: fixtures, scan: inProcessScan() }).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ManifestRefusal);
      expect((e as ManifestRefusal).where.join("\n")).toMatch(where);
    };
    // a hand-edited fixture no longer hashes to the manifest
    const target = path.join(fixtures, "espn", "recorded", "league-a", "mSettings.json");
    const body = readFileSync(target, "utf8");
    writeFileSync(target, body.replace('"size": 4', '"size": 5'));
    await refused(/league-a\/mSettings\.json: its content no longer hashes/);
    writeFileSync(target, body);
    edit((m) => {
      m.files[0]!.path = "recorded/league-a/ghost.json";
    });
    await refused(/ghost\.json: listed but missing/);
    edit((m) => {
      m.files[0]!.derived = true;
    });
    await refused(/not recorded evidence/);
    edit((m) => {
      m.files[0]!.path = "../../etc/passwd.json";
    });
    await refused(/not a recorded fixture path/);
    edit((m) => {
      const p = m.files.find((f) => f.part !== null);
      if (p) (p.part as JsonObject).index = 9;
    });
    await refused(/not contiguous/);
    edit((m) => {
      m.files.push({ nonsense: true });
    });
    await refused(/malformed/);
    writeFileSync(mfile, JSON.stringify({ version: 2 }));
    await expect(generate({ fixturesDir: fixtures, scan: inProcessScan() })).rejects.toThrow(
      /recording manifest is malformed/,
    );
  });

  it("refuses to emit text the repo scanner refuses, and a tree without a recorded error body", async () => {
    const fixtures = await syntheticFixtures();
    await expect(
      generate({ fixturesDir: fixtures, scan: () => ({ clean: false, findings: ["x:1"] }) }),
    ).rejects.toThrow(/scanner refused/);
    const mfile = path.join(fixtures, "espn", "manifest.json");
    const m = JSON.parse(readFileSync(mfile, "utf8")) as { files: { status: number }[] };
    m.files = m.files.filter((f) => f.status < 400);
    writeFileSync(mfile, JSON.stringify(m));
    await expect(generate({ fixturesDir: fixtures, scan: inProcessScan() })).rejects.toThrow(
      /no recorded error body/,
    );
  });

  it("the CLI writes, then --check passes; a stale file fails --check naming the view; usage errors exit 2", async () => {
    const fixtures = await syntheticFixtures();
    const out = path.join(fixtures, "drift", "entity-manifest.json");
    expect((await runCli(["--check", "--fixtures", fixtures], inProcessScan())).exit).toBe(1);
    const w = await runCli(["--fixtures", fixtures], inProcessScan());
    expect(w.exit).toBe(0);
    expect(await runCli(["--check", "--fixtures", fixtures], inProcessScan())).toEqual({
      exit: 0,
      message: "the entity manifest is current",
    });
    const m = JSON.parse(readFileSync(out, "utf8")) as { views: Record<string, JsonObject> };
    m.views.mNav!.responses = 99;
    writeFileSync(out, JSON.stringify(m));
    const stale = await runCli(["--check", "--fixtures", fixtures], inProcessScan());
    expect(stale.exit).toBe(1);
    expect(stale.message).toMatch(/stale \(mNav\)/);
    const other = path.join(dir(), "other.json");
    expect((await runCli(["--fixtures", fixtures, "--out", other], inProcessScan())).exit).toBe(0);
    expect(readFileSync(other, "utf8")).toBe(
      (await generate({ fixturesDir: fixtures, scan: inProcessScan() })).text,
    );
    expect((await runCli(["--bogus"])).exit).toBe(2);
    expect((await runCli(["--out"])).exit).toBe(2);
    expect((await runCli(["--fixtures", "--check"])).exit).toBe(2);
    const bad = await runCli(["--fixtures", path.join(dir(), "nowhere")], inProcessScan());
    expect(bad.exit).toBe(1);
  });

  it("staleViews names differing views and top-level fields, tolerating garbage", () => {
    const a = JSON.stringify({ views: { mNav: { x: 1 }, mTeam: { y: 1 } }, errors: {}, season: 1 });
    const b = JSON.stringify({
      views: { mNav: { x: 2 }, mTeam: { y: 1 }, mRoster: {} },
      errors: { z: 1 },
      season: 2,
    });
    expect(staleViews(a, b)).toEqual(["mNav", "mRoster", "(errors)", "(season)"]);
    expect(staleViews("not json", b)).toContain("mNav");
    expect(staleViews(a, a)).toEqual([]);
  });

  it("responsesByView ignores skeletons, error bodies and non-whitelisted views", () => {
    const r = (views: string[], status = 200) => ({ views, status, parts: [], body: {} });
    const m = responsesByView([
      r(["mBogusViewName"]),
      r(["mSettings"], 404),
      r(["mSettings", "mNav"]),
      r(["mSettings"]),
      r(["mStatus"]),
    ]);
    expect([...m.keys()]).toEqual(["mNav", "mSettings"]);
    expect(m.get("mSettings")?.length).toBe(1); // solo wins over the composite
    expect(m.get("mNav")?.length).toBe(1); // composite serves a view with no solo recording
  });
});

describe("the committed entity manifest", () => {
  it("is exactly what the committed fixtures generate (never hand-edited)", async () => {
    const { text } = await generate({ fixturesDir: FIXTURES, scan: inProcessScan() });
    expect(committedText).toBe(text);
  });

  it("validates, and binds the recording manifest it was generated from (provenance)", () => {
    expect(() => {
      validateEntityManifest(committed);
    }).not.toThrow();
    const recording = parseJsonStrict(
      readFileSync(path.join(FIXTURES, "espn", "manifest.json"), "utf8"),
    ) as JsonObject;
    expect(committed.recording_manifest_sha256).toBe(contentSha256(recording));
    expect(committed.host).toBe(recording.host);
    expect(committed.season).toBe(recording.season);
    expect(committed.captured_at).toBe(recording.captured_at);
    const files = new Map(
      (recording.files as JsonObject[]).map((f) => [`espn/${f.path as string}`, f]),
    );
    for (const v of [...Object.values(committed.views), committed.errors])
      for (const s of v.sources) {
        const f = files.get(s);
        expect(f, s).toBeDefined();
        expect(f?.derived, s).toBe(false);
        expect(v.source_sha256[s], s).toBe(f?.sha256);
      }
    for (const v of Object.values(committed.views))
      for (const s of v.sources) expect(files.get(s)?.status, s).toBe(200);
    for (const s of committed.errors.sources)
      expect(Number(files.get(s)?.status), s).toBeGreaterThanOrEqual(400);
    // loadRecorded re-verifies every hash itself
    expect(loadRecorded(FIXTURES).responses.length).toBeGreaterThan(40);
  });

  it("agrees with the probe manifest's `views` (same sources, keys and enums)", () => {
    const { manifest: drift } = loadManifest(DEFAULT_MANIFEST);
    expect(Object.keys(committed.views).sort()).toEqual(Object.keys(drift.views).sort());
    for (const [name, v] of Object.entries(committed.views)) {
      const d = drift.views[name as keyof typeof drift.views];
      expect(d, name).toBeDefined();
      expect(v.sources, name).toEqual(d?.sources);
      expect(v.observed, name).toEqual(d?.observed);
      expect(v.enums, name).toEqual(d?.enums);
      // lengths agree wherever no response was split (the probe manifest reads parts)
      if (v.sources.length === v.responses) expect(v.array_lengths, name).toEqual(d?.array_lengths);
    }
  });

  it("carries the plan 01 §7 entities for the views that have them", () => {
    const has = (view: string, ...entities: string[]) => {
      for (const e of entities)
        expect(committed.views[view]?.entities[e], `${view}.${e}`).toBeDefined();
    };
    has("mRoster", "team", "rosterEntry", "playerPoolEntry", "player", "stats", "status");
    has("mBoxscore", "scheduleItem", "matchupSide", "rosterEntry", "player", "stats");
    has("mMatchupScore", "scheduleItem", "matchupSide", "rosterEntry", "stats");
    has(
      "mSettings",
      "settings",
      "settings.scoringSettings",
      "settings.rosterSettings",
      "scoringItem",
      "status",
    );
    has("mTeam", "team", "member", "record", "transactionCounter");
    has("mNav", "member", "team");
    has("kona_player_info", "playerPoolEntry", "player", "stats", "ownership");
    has("kona_playercard", "playerPoolEntry", "player", "stats", "transaction");
    has("players_wl", "player");
    has("proTeamSchedules_wl", "proTeam", "proGame");
    // the meaning-changing stat split ids are enumerated where the engine reads them
    expect(committed.views.mBoxscore?.entities.stats?.enums.statSourceId).toEqual([0, 1]);
    expect(
      committed.views.mBoxscore?.entities.stats?.map_keys.appliedStats?.length,
    ).toBeGreaterThan(20);
  });

  it("every view's required paths are observed on EVERY node (required ⊆ observed; ready to verify)", () => {
    for (const [view, v] of Object.entries(committed.views)) {
      for (const p of REQUIRED_PATHS_BY_VIEW[view as keyof typeof REQUIRED_PATHS_BY_VIEW]) {
        if (p.endsWith("[]")) {
          const arr = p.slice(0, -2) || "$";
          expect(v.array_lengths[arr]?.min ?? 0, `${view}: ${p}`).toBeGreaterThan(0);
          continue;
        }
        const dot = p.lastIndexOf(".");
        const parent = p.slice(0, dot);
        const key = p.slice(dot + 1);
        expect(v.observed[parent] ?? [], `${view}: ${p}`).toContain(key);
        expect(v.optional[parent] ?? [], `${view}: ${p} is on every node`).not.toContain(key);
      }
    }
    // and no skeleton path is required anywhere
    for (const paths of Object.values(REQUIRED_PATHS_BY_VIEW))
      for (const s of SKELETON_PATHS) expect(paths).not.toContain(s);
  });

  it("names no league, team, member or id: vocabulary only, scanner-clean", () => {
    expect(scanText(ENTITY_MANIFEST_PATH, committedText, [])).toEqual([]);
    expect(committedText).not.toMatch(
      /Team [A-Z]{1,3}\b|Example League|Member \d|00000000-0000-4000-8000/,
    );
    for (const word of vocabularyOf(committed))
      expect(word, word).toMatch(/^(?:[A-Za-z_$][\w$]*|-?\d{1,6}|true|false|null)$/);
    for (const v of [...Object.values(committed.views), committed.errors])
      for (const keys of Object.values(v.map_keys))
        for (const k of keys) expect(Math.abs(Number(k))).toBeLessThanOrEqual(9999);
  });
});

describe("validateEntityManifest rejects malformed manifests (never 'no drift')", () => {
  const clone = (): JsonObject => JSON.parse(committedText) as JsonObject;
  const view = (m: JsonObject, v = "mNav") => (m.views as JsonObject)[v] as JsonObject;
  const cases: [string, (m: JsonObject) => void, RegExp][] = [
    ["not an object", () => undefined, /not an object/],
    ["version", (m) => (m.version = 2), /version/],
    ["comment", (m) => (m.$comment = ""), /\$comment/],
    ["generator", (m) => (m.generator = "hand"), /generator/],
    ["host", (m) => (m.host = "evil host"), /host/],
    ["season", (m) => (m.season = "2026"), /season/],
    ["captured_at", (m) => (m.captured_at = "yesterday"), /captured_at/],
    ["recording hash", (m) => (m.recording_manifest_sha256 = "x"), /recording_manifest_sha256/],
    ["no views", (m) => (m.views = {}), /views missing/],
    ["view name", (m) => ((m.views as JsonObject)["m&x"] = view(m)), /bad view name/],
    ["sources empty", (m) => (view(m).sources = []), /sources invalid/],
    [
      "sources unsorted",
      (m) => (view(m).sources = ["espn/recorded/b.json", "espn/recorded/a.json"]),
      /sources invalid/,
    ],
    [
      "source outside recorded",
      (m) => (view(m).sources = ["espn/synthetic/errors/x.json"]),
      /recorded fixtures/,
    ],
    [
      "source traversal",
      (m) => (view(m).sources = ["espn/recorded/../x.json"]),
      /recorded fixtures/,
    ],
    ["sha keys", (m) => (view(m).source_sha256 = {}), /source_sha256/],
    ["responses", (m) => (view(m).responses = 0), /responses/],
    ["top keys", (m) => (view(m).top_level_keys = "x"), /top_level_keys/],
    ["top optional ⊄", (m) => (view(m).top_level_optional = ["zzz"]), /top_level_optional/],
    ["observed pattern", (m) => (view(m).observed = { bad: [] }), /pattern/],
    ["observed unsorted", (m) => (view(m).observed = { $: ["b", "a"] }), /observed/],
    [
      "enum huge",
      (m) => (view(m).enums = { "$.x": Array.from({ length: 65 }, (_, i) => i) }),
      /enums/,
    ],
    ["enum object", (m) => (view(m).enums = { "$.x": [{}] }), /enums/],
    [
      "length range",
      (m) => (view(m).array_lengths = { "$.x": { min: 3, max: 1 } }),
      /array_lengths/,
    ],
    ["nodes", (m) => (view(m).nodes = { $: 0 }), /nodes/],
    ["optional empty", (m) => (view(m).optional = { $: [] }), /optional/],
    ["optional ⊄ observed", (m) => (view(m).optional = { $: ["nope"] }), /optional/],
    ["map keys", (m) => (view(m).map_keys = { "$.x": ["abc"] }), /map_keys/],
    ["entities", (m) => (view(m).entities = []), /entities/],
    ["entity name", (m) => ((view(m).entities as JsonObject)["../x"] = {}), /invalid/],
    [
      "entity patterns",
      (m) => (((view(m).entities as JsonObject).member as JsonObject).patterns = []),
      /patterns/,
    ],
    [
      "entity pattern of another entity",
      (m) => (((view(m).entities as JsonObject).member as JsonObject).patterns = ["$.teams[]"]),
      /is not member/,
    ],
    [
      "entity nodes",
      (m) => (((view(m).entities as JsonObject).member as JsonObject).nodes = 0),
      /nodes/,
    ],
    [
      "entity optional ⊄ keys",
      (m) => (((view(m).entities as JsonObject).member as JsonObject).optional = ["zzz"]),
      /optional ⊄ keys/,
    ],
    [
      "entity enum key outside keys",
      (m) => (((view(m).entities as JsonObject).member as JsonObject).enums = { zzz: ["A"] }),
      /outside keys/,
    ],
    ["errors missing", (m) => delete m.errors, /errors invalid/],
  ];
  it.each(cases)("%s", (_n, mutate, msg) => {
    const m = clone();
    mutate(m);
    expect(() => {
      validateEntityManifest(_n === "not an object" ? 7 : m);
    }).toThrow(msg);
  });
});
