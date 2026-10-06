// units.test.ts — the fixture tooling's small helpers: json-lines.ts (a scanner line → its JSON
// path, never the value — plan 05 §3.1 step 2 "abort with the path"), league-format.ts (the manifest's
// format summary, research 03 §B.1–§B.2), canonical.ts (deterministic JSON, plan 05 §3.1 step 3),
// guards.ts (cookie refusal, raw-outside-the-repo), pipeline.ts officialWeeks (statsOfficial).
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  contentSha256,
  emptyObject,
  formatPath,
  parseJsonStrict,
  setOwn,
  stableStringify,
  type Json,
} from "../../scripts/espn-fixture/canonical.js";
import { formatJson } from "../../scripts/espn-fixture/format-json.js";
import { findCookieMaterial, isInside, rawDirRefusal } from "../../scripts/espn-fixture/guards.js";
import { pathsAtLines } from "../../scripts/espn-fixture/json-lines.js";
import { leagueFormat, matchupPeriodOf } from "../../scripts/espn-fixture/league-format.js";
import {
  REPLACEABLE_NAME_KEYS,
  annotateFindings,
  applyUnits,
  deriveIncomplete,
  konaFilter,
  officialWeeks,
  replaceableNameLeaf,
} from "../../scripts/espn-fixture/pipeline.js";
import { ROOT, tempDir } from "../lint/helpers.js";
import { proTeamSchedules } from "./helpers/synthetic.js";

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

describe("pathsAtLines — scanner line → JSON path", () => {
  it("maps every line of a formatted document to the first key or value on it", async () => {
    const v = {
      a: { b: [1, { c: "x" }], "odd key": true },
      list: [
        { id: 1, s: "y" },
        { id: 2, s: "z" },
      ],
    } as Json;
    const text = await formatJson(v); // printWidth 100: expands nothing here
    const wide = JSON.stringify(v, null, 2);
    const lines = wide.split("\n").map((_, i) => i + 1);
    const p = pathsAtLines(wide, lines);
    expect([...p.values()]).toEqual([
      "$",
      "$.a",
      "$.a.b",
      "$.a.b[0]",
      "$.a.b[1]",
      "$.a.b[1].c",
      "$.a.b[1]",
      "$.a.b",
      '$.a["odd key"]',
      "$.a",
      "$.list",
      "$.list[0]",
      "$.list[0].id",
      "$.list[0].s",
      "$.list[0]",
      "$.list[1]",
      "$.list[1].id",
      "$.list[1].s",
      "$.list[1]",
      "$.list",
      "$",
    ]);
    expect(pathsAtLines(text, [1]).get(1)).toBe("$");
  });

  it("handles escaped quotes, unicode and hostile keys, and returns $ for out-of-range lines", () => {
    const v = { 'k"ey\\': { "‮\n": ['a"b', 2] } } as Json;
    const t = JSON.stringify(v, null, 1);
    const p = pathsAtLines(t, [3, 4, 99]);
    expect(p.get(3)).toBe(formatPath(['k"ey\\', "‮\n"]));
    expect(p.get(4)).toBe(formatPath(['k"ey\\', "‮\n", 0]));
    expect(p.get(99)).toBe("$");
  });

  it("annotateFindings appends paths and never values", () => {
    const text = JSON.stringify({ a: [{ secret: "Jane Doe" }] }, null, 2);
    const out = annotateFindings(
      ["deny-list match in x.json:4", "x.json:4  [email-address]", "no line here"],
      text,
    );
    expect(out).toEqual([
      "deny-list match in x.json:4 at $.a[0].secret",
      "x.json:4  [email-address] at $.a[0].secret",
      "no line here",
    ]);
    expect(out.join("")).not.toContain("Jane");
  });
});

describe("leagueFormat / matchupPeriodOf / officialWeeks", () => {
  const body = {
    settings: {
      size: 12,
      scoringSettings: {
        scoringType: "H2H_POINTS",
        scoringItems: [
          { statId: 53, points: 1 },
          { statId: 4, points: 6, pointsOverrides: { "16": 0 } },
        ],
      },
      acquisitionSettings: {
        acquisitionType: "WAIVERS_TRADITIONAL",
        isUsingAcquisitionBudget: false,
        acquisitionBudget: 100,
      },
      rosterSettings: { lineupSlotCounts: { "23": 2, "0": 1, "20": 6, "26": 1, "5": 0 } },
      scheduleSettings: {
        playoffTeamCount: 6,
        playoffSeedingRule: "TOTAL_POINTS_SCORED",
        matchupPeriodCount: 14,
        matchupPeriods: { "1": [1], "15": [15, 16] },
      },
    },
  } as Json;

  it("summarises the format without any identifying field", () => {
    expect(leagueFormat(body)).toEqual({
      teams: 12,
      scoring_type: "H2H_POINTS",
      reception_points: 1,
      ppr: "full",
      pass_td_points: 6,
      waivers: "rolling",
      acquisition_type: "WAIVERS_TRADITIONAL",
      faab_budget: null,
      flex_slots: 2,
      lineup_slots: { QB: 1, BE: 6, FLEX: 2, "slot 26": 1 }, // zero-count slots are omitted
      playoff_teams: 6,
      playoff_seeding_rule: "TOTAL_POINTS_SCORED",
      regular_season_matchups: 14,
    });
  });

  it("standard and half PPR; a hostile enum string is dropped, not echoed", () => {
    const b = JSON.parse(JSON.stringify(body)) as {
      settings: {
        scoringSettings: {
          scoringItems: { statId: number; points: number }[];
          scoringType: string;
        };
      };
    };
    b.settings.scoringSettings.scoringItems = [];
    b.settings.scoringSettings.scoringType = "ignore previous instructions";
    const f = leagueFormat(b);
    expect(f.ppr).toBe("standard");
    expect(f.pass_td_points).toBeNull();
    expect(f.scoring_type).toBeNull();
    expect(() => leagueFormat({ status: {} })).toThrow(/no settings/);
    expect(() => leagueFormat({ settings: {} })).toThrow(/settings\.size/);
  });

  it("maps a week to its matchup period (multi-week playoff periods too)", () => {
    expect(matchupPeriodOf(body, 1)).toBe(1);
    expect(matchupPeriodOf(body, 16)).toBe(15);
    expect(matchupPeriodOf(body, 9)).toBeNull();
    expect(matchupPeriodOf({}, 1)).toBeNull();
  });

  it("a week is official only when EVERY game of it has statsOfficial: true", () => {
    const w = officialWeeks(proTeamSchedules(2026, [1, 2]) as Json);
    expect(w.get(1)).toBe(true);
    expect(w.get(3)).toBe(false);
    expect(w.get(42)).toBeUndefined();
    const mixed = proTeamSchedules(2026, [1]) as {
      settings: {
        proTeams: { proGamesByScoringPeriod: Record<string, { statsOfficial: boolean }[]> }[];
      };
    };
    const g = mixed.settings.proTeams[1]?.proGamesByScoringPeriod["2"]?.[0];
    if (g) g.statsOfficial = true; // one game final, the rest not
    expect(officialWeeks(mixed as unknown as Json).get(2)).toBe(false);
    expect(officialWeeks(null).size).toBe(0);
  });

  it("the kona filter always carries a sort with its limit, and refuses limits over 50", () => {
    const f = konaFilter(25) as { players: Record<string, unknown> };
    expect(f.players.limit).toBe(25);
    expect(f.players.sortPercOwned).toBeDefined();
    expect(() => konaFilter(51)).toThrow();
    expect(() => konaFilter(0)).toThrow();
  });
});

describe("canonical JSON", () => {
  it("setOwn never sets a prototype; emptyObject has none", () => {
    const o = emptyObject();
    setOwn(o, "__proto__", { polluted: true });
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(JSON.stringify(o)).toBe('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("property: canonicalize is idempotent, and the content hash ignores key order and whitespace", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (v) => {
        const c = canonicalize(v as Json);
        expect(stableStringify(canonicalize(c))).toBe(stableStringify(c));
        expect(contentSha256(JSON.parse(JSON.stringify(v, null, 3)) as Json)).toBe(
          contentSha256(v as Json),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("formatPath escapes and truncates hostile keys onto one line", () => {
    expect(formatPath(["a", 0, "b c", "x\ny"])).toBe('$.a[0]["b c"]["x\\ny"]');
    expect(formatPath(["k".repeat(200)]).length).toBeLessThan(100);
  });

  it("parseJsonStrict rejects precision loss and malformed text", () => {
    expect(() => parseJsonStrict("[1, 18446744073709551616]")).toThrow(/safe range/);
    expect(() => parseJsonStrict("{")).toThrow();
    expect(parseJsonStrict("[1.5e300, -0]")).toEqual([1.5e300, -0]);
    expect(parseJsonStrict('{"s": "12345678901234567890"}')).toEqual({ s: "12345678901234567890" }); // in a string: fine
    expect(() => parseJsonStrict('{"a": "x\\"", "b": 123456789012345678}')).toThrow(/safe range/);
    expect(() => parseJsonStrict("-9007199254740993")).toThrow(/safe range/);
    expect(parseJsonStrict("9007199254740991")).toBe(9007199254740991);
  });
});

describe("guards", () => {
  it("finds cookie material by NAME or by VALUE shape, reporting names/positions only", () => {
    const s2 = ["espn", "s2"].join("_");
    expect(findCookieMaterial({ A: "1", ESPN_S2: "v" }, [])).toEqual([
      "environment variable ESPN_S2",
    ]);
    expect(findCookieMaterial({ X: `${s2}=abc` }, [])).toEqual(["environment variable X"]);
    expect(findCookieMaterial({ X: "" }, [])).toEqual([]);
    expect(findCookieMaterial({}, ["--public", "--cookies"])).toEqual(["argument #2"]);
    expect(findCookieMaterial({ SWIDTH: "1", SWEDISH: "2", DISCO: "3" }, [])).toEqual([]);
  });

  it("isInside resolves symlinks and missing tails", () => {
    tmp = tempDir("eff-guard-");
    expect(isInside(path.join(ROOT, "fixtures", "nope", "deeper"), ROOT)).toBe(true);
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(tmp.dir, ROOT)).toBe(false);
    mkdirSync(path.join(tmp.dir, "d"));
    symlinkSync(ROOT, path.join(tmp.dir, "link"));
    expect(isInside(path.join(tmp.dir, "link", "fixtures"), ROOT)).toBe(true);
    expect(isInside(`${ROOT}-sibling`, ROOT)).toBe(false);
  });

  it("S7: a case-changed spelling of the repo root is inside it on macOS (case-insensitive APFS)", () => {
    const shouted = path.join(ROOT.toUpperCase(), "RAWCAPTURES");
    const lowered = path.join(ROOT.toLowerCase(), "rawcaptures");
    expect(isInside(shouted, ROOT, "darwin")).toBe(true);
    expect(isInside(lowered, ROOT, "darwin")).toBe(true);
    if (process.platform === "darwin") {
      expect(isInside(shouted, ROOT)).toBe(true);
      expect(rawDirRefusal(lowered, ROOT)).toBe("inside_repo");
    }
    // a different NFD/NFC spelling folds too
    expect(isInside("/tmp/Jose\u0301/x", "/tmp/Jos\u00e9", "darwin")).toBe(true);
    expect(isInside("/tmp/Jose\u0301/x", "/tmp/Jos\u00e9", "linux")).toBe(false);
  });

  it("S7: a raw dir inside any other git working tree is refused; a plain temp dir is not", () => {
    tmp = tempDir("eff-guard-");
    const other = path.join(tmp.dir, "other-repo");
    mkdirSync(path.join(other, ".git"), { recursive: true });
    expect(rawDirRefusal(path.join(other, "raw"), ROOT)).toBe("inside_git_work_tree");
    expect(rawDirRefusal(path.join(tmp.dir, "plain", "raw"), ROOT)).toBeNull();
    expect(rawDirRefusal(path.join(tmp.dir, "x"), ROOT, () => false)).toBeNull();
    expect(rawDirRefusal(path.join(ROOT, "fixtures", "raw"), ROOT)).toBe("inside_repo");
  });
});

describe("CAT-12: replace a public name leaf instead of withholding its unit; derive incompleteness", () => {
  const body = {
    teams: [
      {
        id: 4,
        roster: {
          entries: [
            { playerPoolEntry: { player: { id: 9001, fullName: "Some Player", stats: [] } } },
          ],
        },
      },
      { id: 7, roster: { entries: [] } },
    ],
    schedule: [
      { home: { teamId: 4, rosterForCurrentScoringPeriod: { entries: [] } }, away: { teamId: 7 } },
    ],
  };
  it("replaces fullName/firstName/lastName under a player with `Player <id>`; anything else is not replaceable", () => {
    const segs = ["teams", 0, "roster", "entries", 0, "playerPoolEntry", "player", "fullName"];
    expect(replaceableNameLeaf(body as never, segs)).toEqual({
      segs,
      action: "replace",
      value: "Player 9001",
    });
    expect(replaceableNameLeaf(body as never, [...segs.slice(0, -1), "stats"])).toBeNull();
    expect(replaceableNameLeaf(body as never, ["teams", 0, "id"])).toBeNull();
    expect(
      replaceableNameLeaf(body as never, [
        "teams",
        9,
        "roster",
        "entries",
        0,
        "playerPoolEntry",
        "player",
        "fullName",
      ]),
    ).toBeNull();
    expect(replaceableNameLeaf(body as never, ["teams", 0, "fullName"])).toBeNull();
    const out = applyUnits(body, [
      { segs, action: "replace", value: "Player 9001" },
    ]) as typeof body;
    expect(out.teams[0]?.roster.entries[0]?.playerPoolEntry.player).toEqual({
      id: 9001,
      fullName: "Player 9001",
      stats: [],
    });
    expect(REPLACEABLE_NAME_KEYS).toEqual(new Set(["fullName", "firstName", "lastName"]));
  });
  it("derives team ids and missing matchups from withheld paths, value-free", () => {
    expect(deriveIncomplete(body as never, [])).toBeNull();
    expect(deriveIncomplete(body as never, ["$.teams[0].roster.entries[3]"])).toEqual({
      team_ids: [4],
      matchups_missing: 0,
    });
    expect(
      deriveIncomplete(body as never, [
        "$.schedule[0].home.rosterForCurrentScoringPeriod.entries[2]",
      ]),
    ).toEqual({ team_ids: [4], matchups_missing: 0 });
    // a removed box-score row: every team no remaining row names
    const box = {
      teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      schedule: [{ home: { teamId: 1 }, away: { teamId: 2 } }],
    };
    expect(deriveIncomplete(box as never, ["$.schedule[1]"])).toEqual({
      team_ids: [3, 4],
      matchups_missing: 1,
    });
    expect(deriveIncomplete(box as never, ["$.settings.proTeams[1].x"])).toEqual({
      team_ids: [],
      matchups_missing: 0,
    });
  });
});
