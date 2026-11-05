// derived-publicity.test.ts — the round-4b review's F3 of changelog §R10, R10-27's private-league
// variant. derivedLeaguePublicity kept its own copy of the fixture fetch's manifest path guards, none
// of them exercised, and every failure read as null, which createEspnProvider took as public: a
// malformed private variant then let its `auto` and feed reads past the scripted label, silently.
// Now one resolver (derivedFileText) serves the fetch and the publicity read; the publicity read is
// tri-state (known / no_settings / unreadable), and fixture mode refuses to start on `unreadable`.
// Each refused cell points the settings at a file OUTSIDE the manifest's root that says
// `isPublic: false`: an answer of false would mean that file was read. Temp directories only; no
// network, no credential.
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { translateScoringInput } from "../../../src/domain/scoring/index.js";
import {
  createDerivedLeagueFetch,
  createEspnProvider,
  derivedFileText,
  DerivedFileRefused,
  derivedLeaguePublicity,
  DERIVED_LEAGUE_KIND,
  FixtureError,
  readDerivedPublicity,
} from "../../../src/providers/espn/index.js";
import {
  DERIVED_FILE_MAX_BYTES,
  DERIVED_ROOT_MAX_UP,
  derivedRootDir,
} from "../../../src/providers/espn/fixture-league.js";
import { MemoryCache, MemoryDrift, MemoryLimiterRepo } from "./helpers.js";

const SEASON = 2026;
let tmp: string;
/** A file outside every manifest root that says the league is private. */
let outside: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-derived-publicity-")));
  outside = path.join(tmp, "outside-mSettings.json");
  writeFileSync(outside, JSON.stringify({ settings: { isPublic: false } }));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
/**
 * A derived manifest in a fresh directory whose root is its own `data/` folder (or `root`), with
 * `files` written under `data/`, and one league mSettings view at `settingsPath` (none when null),
 * `patch` its patch.
 */
function variant(opts: {
  readonly files?: Readonly<Record<string, string>>;
  readonly settingsPath: string | null;
  readonly patch?: string;
  readonly root?: string;
}): string {
  const dir = path.join(tmp, `v${String(++n)}`);
  const root = path.join(dir, "data");
  mkdirSync(root, { recursive: true });
  for (const [rel, text] of Object.entries(opts.files ?? {}))
    writeFileSync(path.join(root, rel), text);
  const views =
    opts.settingsPath === null
      ? []
      : [
          {
            route: "league",
            season: SEASON,
            views: ["mSettings"],
            scoringPeriodId: null,
            path: opts.settingsPath,
            ...(opts.patch === undefined ? {} : { patch: opts.patch }),
          },
        ];
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      kind: DERIVED_LEAGUE_KIND,
      league: "fx-test",
      season: SEASON,
      root: opts.root ?? "data",
      views,
    }),
  );
  return dir;
}

const settings = (isPublic: unknown): string => JSON.stringify({ settings: { isPublic } });

function providerOver(dir: string) {
  return createEspnProvider({
    config: {
      leagueId: "0",
      season: SEASON,
      teamId: 2,
      espnReadHost: "lm-api-reads.fantasy.espn.com",
      fixtureRecord: false,
      fixtureDir: dir,
    },
    repos: {
      limiter: new MemoryLimiterRepo(),
      espnCache: new MemoryCache(),
      driftState: new MemoryDrift(),
    },
    credentials: null,
    clock: fixedClock("2026-10-07T01:00:00.000Z"),
    scoring: translateScoringInput,
  });
}

describe("F3: the publicity read of a derived variant, over its manifest's path rules", () => {
  it.each([
    ["an absolute path (to a file that says private)", () => variant({ settingsPath: outside })],
    [
      "a `..` path (to a file that says private)",
      () => variant({ settingsPath: "../../outside-mSettings.json" }),
    ],
    ["a path that resolves to the root itself", () => variant({ settingsPath: "." })],
    ["a missing file", () => variant({ settingsPath: "absent.json" })],
    [
      "a body that is not JSON",
      () => variant({ files: { "s.json": "{" }, settingsPath: "s.json" }),
    ],
    [
      "a patch that removes the settings",
      () =>
        variant({
          files: {
            "s.json": settings(false),
            "p.json": JSON.stringify([{ op: "remove", path: "/settings" }]),
          },
          settingsPath: "s.json",
          patch: "p.json",
        }),
    ],
    [
      "a patch at an absolute path (to a file that says private)",
      () =>
        variant({ files: { "s.json": settings(true) }, settingsPath: "s.json", patch: outside }),
    ],
    [
      "isPublic a string",
      () => variant({ files: { "s.json": settings("false") }, settingsPath: "s.json" }),
    ],
    [
      "isPublic null",
      () => variant({ files: { "s.json": settings(null) }, settingsPath: "s.json" }),
    ],
    [
      "no settings object",
      () =>
        variant({ files: { "s.json": JSON.stringify({ status: {} }) }, settingsPath: "s.json" }),
    ],
  ])("%s → unreadable: never a value, and fixture mode refuses to start", (_label, make) => {
    const dir = make();
    expect(readDerivedPublicity(dir)).toEqual({ kind: "unreadable" });
    // null, never `false`: the file outside the root was not read, the malformed body not guessed
    expect(derivedLeaguePublicity(dir)).toBeNull();
    let thrown: unknown = null;
    try {
      providerOver(dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      effCode: "INTERNAL",
      effDetails: { reason: "fixture_settings_unreadable" },
    });
  });

  it("an oversized settings file is refused by its size, before its bytes are read", () => {
    const dir = variant({ settingsPath: "big.json" });
    const fd = openSync(path.join(dir, "data", "big.json"), "w");
    try {
      ftruncateSync(fd, DERIVED_FILE_MAX_BYTES + 1); // sparse: no bytes written
    } finally {
      closeSync(fd);
    }
    expect(readDerivedPublicity(dir)).toEqual({ kind: "unreadable" });
    expect(() => derivedFileText(path.join(dir, "data"), "big.json")).toThrow(DerivedFileRefused);
  });

  it("no settings view: no_settings (null), and the provider builds as before", () => {
    const dir = variant({ settingsPath: null });
    expect(readDerivedPublicity(dir)).toEqual({ kind: "no_settings" });
    expect(derivedLeaguePublicity(dir)).toBeNull();
    expect(() => providerOver(dir)).not.toThrow();
  });

  it.each([
    [false, "private"],
    [true, "public"],
  ])("isPublic %s → known (%s), patched or not", (value) => {
    expect(
      readDerivedPublicity(
        variant({ files: { "s.json": settings(value) }, settingsPath: "s.json" }),
      ),
    ).toEqual({ kind: "known", value });
    const patched = variant({
      files: {
        "s.json": settings(!value),
        "p.json": JSON.stringify([{ op: "replace", path: "/settings/isPublic", value }]),
      },
      settingsPath: "s.json",
      patch: "p.json",
    });
    expect(derivedLeaguePublicity(patched)).toBe(value);
    expect(() => providerOver(patched)).not.toThrow();
  });

  it("not a derived league, or a relative directory: null", () => {
    expect(readDerivedPublicity(tmp)).toBeNull();
    expect(readDerivedPublicity("relative/dir")).toBeNull();
  });
});

describe("F3: one resolver — the fetch refuses exactly what the publicity read refuses", () => {
  it.each([
    ["an absolute path", (dir: string) => path.join(dir, "data", "s.json")],
    ["a `..` path", () => "../s.json"],
    ["the root itself", () => "."],
    ["an empty path", () => ""],
  ])(
    "%s: derivedFileText throws DerivedFileRefused; the fetch answers fixture_missing",
    async (_l, rel) => {
      const dir = variant({ files: { "s.json": settings(true) }, settingsPath: "s.json" });
      const root = path.join(dir, "data");
      expect(() => derivedFileText(root, rel(dir))).toThrow(DerivedFileRefused);
      // the same rule through the fetch: a manifest whose settings view points there
      const bad = variant({ settingsPath: rel(dir) });
      const fx = createDerivedLeagueFetch({ dir: bad });
      const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${String(SEASON)}/segments/0/leagues/0?view=mSettings`;
      await expect(fx(url, {})).rejects.toBeInstanceOf(FixtureError);
      await expect(fx(url, {})).rejects.toMatchObject({
        message: expect.stringContaining("manifest path refused") as unknown,
      });
    },
  );

  it("a readable file under the root is served by both", async () => {
    const dir = variant({ files: { "s.json": settings(true) }, settingsPath: "s.json" });
    expect(JSON.parse(derivedFileText(path.join(dir, "data"), "s.json"))).toEqual({
      settings: { isPublic: true },
    });
    const fx = createDerivedLeagueFetch({ dir });
    const r = await fx(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${String(SEASON)}/segments/0/leagues/0?view=mSettings`,
      {},
    );
    expect(r.status).toBe(200);
  });
});

describe("CR-3 (the round-4c verifier): a manifest's root, or a symlink, cannot leave the fixture tree", () => {
  /** A directory outside every variant whose settings file says the league is private. */
  let away: string;
  beforeAll(() => {
    away = path.join(tmp, "away-root");
    mkdirSync(away, { recursive: true });
    writeFileSync(path.join(away, "secret.json"), settings(false));
  });
  const mSettingsUrl = () =>
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${String(SEASON)}/segments/0/leagues/0?view=mSettings`;

  it.each([
    [
      "a root that climbs, then turns sideways",
      () => variant({ root: "../away-root", settingsPath: "secret.json" }),
    ],
    [
      "a root that descends, then climbs out",
      () => variant({ root: "data/../../away-root", settingsPath: "secret.json" }),
    ],
    [
      "a symlink under the root that points out of it",
      () => {
        const dir = variant({ settingsPath: "s.json" });
        symlinkSync(path.join(away, "secret.json"), path.join(dir, "data", "s.json"));
        return dir;
      },
    ],
    [
      "an absolute root (CR-3's last escape)",
      () => variant({ root: away, settingsPath: "secret.json" }),
    ],
    [
      "a root that is a symlink out of the manifest's directory",
      () => {
        const dir = variant({ root: "linked", settingsPath: "secret.json" });
        symlinkSync(away, path.join(dir, "linked"));
        return dir;
      },
    ],
  ])("%s → unreadable, and the fetch answers fixture_missing", async (_label, make) => {
    const dir = make();
    // `known: false` would mean the file outside the tree was read
    expect(readDerivedPublicity(dir)).toEqual({ kind: "unreadable" });
    const fx = createDerivedLeagueFetch({ dir });
    await expect(fx(mSettingsUrl(), {})).rejects.toMatchObject({
      effDetails: { reason: "fixture_missing" },
      message: expect.stringMatching(/manifest (root|path) refused/) as unknown,
    });
  });

  it("the roots the generator writes, `.`, and a plain subdirectory are kept; a deeper climb is not", () => {
    const dir = path.join(tmp, "a", "b", "c");
    expect(derivedRootDir(dir, "..")).toBe(path.join(tmp, "a", "b"));
    expect(derivedRootDir(dir, "../..")).toBe(path.join(tmp, "a"));
    expect(derivedRootDir(dir, ".")).toBe(dir);
    expect(derivedRootDir(dir, "./")).toBe(dir);
    expect(derivedRootDir(dir, "data")).toBe(path.join(dir, "data"));
    expect(DERIVED_ROOT_MAX_UP).toBe(2);
    for (const bad of ["../../..", "../x", "x/..", "x/../..", "..\\..\\..", dir, "/", "C:\\x"])
      expect(() => derivedRootDir(dir, bad), bad).toThrow(DerivedFileRefused);
  });

  it("a symlink that stays inside the root is still served", async () => {
    const dir = variant({ files: { "real.json": settings(true) }, settingsPath: "s.json" });
    symlinkSync(path.join(dir, "data", "real.json"), path.join(dir, "data", "s.json"));
    expect(readDerivedPublicity(dir)).toEqual({ kind: "known", value: true });
    const r = await createDerivedLeagueFetch({ dir })(mSettingsUrl(), {});
    expect(r.status).toBe(200);
  });
});
