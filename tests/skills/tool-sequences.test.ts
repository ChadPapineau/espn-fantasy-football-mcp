// tool-sequences.test.ts — scripts/skills/tool-sequences.mjs (plan 09 §5.1 item 7; plan 10 A14a):
// the loader the fixture dry run uses refuses anything check-skills would reject, and the argument
// resolver turns every template form ($ref, $source_calls, $opponent, $player, $ids) into concrete tool
// arguments from earlier results — failing loudly, never silently, on a result without the field; one
// toolset's sequences are loaded at a time (core: the P0 paths; full: the P1 Skills and branches).
import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOAD_TOOLSETS,
  idsOf,
  loadToolSequences,
  opponentOf,
  outcomeAllowed,
  playerOf,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import { P0_SKILLS, P1_SKILLS, ROOT, SKILLS, tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const envelope = (data: unknown, requestId = "r-0123456789ab") => ({
  data,
  meta: { request_id: requestId, as_of: "2026-10-06T21:00:00-04:00" },
});

describe("loadToolSequences", () => {
  it("loads the eight P0 Skills' core sequences by default, with their fixture environment", () => {
    const all = loadToolSequences(ROOT);
    expect(all.map((s) => s.skill)).toEqual([...P0_SKILLS]);
    expect(loadToolSequences(ROOT, { toolset: "core" })).toEqual(all);
    for (const s of all) {
      expect(s.toolset).toBe("core");
      for (const q of s.sequences) expect(q.toolset, `${s.skill}/${q.id}`).toBe("core");
      expect(s.env).toEqual({
        EFF_FIXTURE_DIR: "fixtures/espn/fx-10h",
        ESPN_LEAGUE_ID: "0",
        EFF_TOOLSET: "core",
      });
      for (const q of s.sequences) {
        expect(q.steps[0]?.tool).toBe("espn_get_status");
        expect(q.when.length).toBeGreaterThan(0);
      }
    }
    const gameDay = all
      .find((s) => s.skill === "start-sit")
      ?.sequences.find((q) => q.id === "game_day");
    expect(gameDay?.fixture_variant).toBe("sunday-live");
    expect(all.find((s) => s.skill === "retro")?.sequences[0]?.fixture_variant).toBeNull();
    // a P0 Skill's P1 branch never reaches a core server
    expect(all.find((s) => s.skill === "start-sit")?.sequences.map((q) => q.id)).not.toContain(
      "game_day_live",
    );
  });

  it("loads the full toolset's sequences: the five P1 Skills and the P0 Skills' P1 branches", () => {
    const full = loadToolSequences(ROOT, { toolset: "full" });
    expect(full.map((s) => s.skill)).toEqual(
      [...P1_SKILLS, "start-sit", "stream-kdef", "waivers", "weekly"].sort(),
    );
    for (const s of full) {
      for (const q of s.sequences) expect(q.toolset, `${s.skill}/${q.id}`).toBe("full");
      expect(s.toolset).toBe(P1_SKILLS.includes(s.skill as never) ? "full" : "core");
    }
    expect(full.find((s) => s.skill === "start-sit")?.sequences.map((q) => q.id)).toEqual([
      "game_day_live",
    ]);
    expect(full.find((s) => s.skill === "waivers")?.sequences.map((q) => q.id)).toEqual([
      "usage_pre_run",
      "faab",
    ]);
    for (const s of full.filter((x) => P1_SKILLS.includes(x.skill as never)))
      expect(s.env.EFF_TOOLSET).toBe("full");
  });

  it("all = core ∪ full, every Skill once; an unknown toolset is refused", () => {
    const all = loadToolSequences(ROOT, { toolset: "all" });
    expect(all.map((s) => s.skill)).toEqual([...SKILLS]);
    const count = (xs: ReturnType<typeof loadToolSequences>) =>
      xs.reduce((n, s) => n + s.sequences.length, 0);
    expect(count(all)).toBe(
      count(loadToolSequences(ROOT)) + count(loadToolSequences(ROOT, { toolset: "full" })),
    );
    expect(LOAD_TOOLSETS).toEqual(["core", "full", "all"]);
    expect(() => loadToolSequences(ROOT, { toolset: "both" as never })).toThrow(
      /toolset must be one of core, full, all/,
    );
  });

  it("validates every file whatever the filter: a broken P1 file stops a core load too", () => {
    repo = tempRepo();
    repo.editJson("skills/trade/evals/tool_sequence.json", (j) => {
      (j.sequences as { steps: { tool: string }[] }[])[0]!.steps[1]!.tool = "espn_commit_trade";
    });
    expect(() => loadToolSequences(repo!.root)).toThrow(/espn_commit_trade is a write tool/);
  });

  it("refuses to load when any file is invalid, listing every problem", () => {
    repo = tempRepo();
    repo.editJson("skills/retro/evals/tool_sequence.json", (j) => {
      (j.sequences as { steps: { tool: string }[] }[])[0]!.steps[1]!.tool = "espn_get_nothing";
    });
    repo.write("skills/weekly/evals/tool_sequence.json", "{ broken");
    expect(() => loadToolSequences(repo!.root)).toThrow(
      /espn_get_nothing is not a registered tool[\s\S]*weekly\/evals\/tool_sequence\.json: invalid JSON/,
    );
  });

  it("refuses a missing file", () => {
    repo = tempRepo();
    rmSync(repo.p("skills/apply/evals/tool_sequence.json"));
    expect(() => loadToolSequences(repo!.root)).toThrow(
      /apply\/evals\/tool_sequence\.json: missing/,
    );
  });
});

describe("resolveArgs", () => {
  const scoreboard = envelope({
    matchups: [
      { home: { team_id: 3, is_mine: false }, away: { team_id: 4, is_mine: false } },
      { home: { team_id: 7, is_mine: false }, away: { team_id: 2, is_mine: true } },
    ],
  });
  const roster = envelope({
    players: [
      { player_id: 11, slot: "QB", eligible_slots: ["QB", "BE"], injury_status: "ACTIVE" },
      { player_id: 12, slot: "FLEX", eligible_slots: ["WR", "FLEX", "BE"] },
      { player_id: 13, slot: "BE", eligible_slots: ["QB", "BE"], injury_status: "QUESTIONABLE" },
      { player_id: 14, slot: "BE", eligible_slots: ["RB", "FLEX", "BE"], injury_status: "OUT" },
    ],
  });
  const results = new Map<string, { tool: string; result: unknown }>([
    [
      "league",
      {
        tool: "espn_get_league",
        result: envelope(
          { scoring: { settings_hash: "sh-1" }, clock: { current_matchup_period: 5 } },
          "r-aaaaaaaaaaaa",
        ),
      },
    ],
    ["scoreboard", { tool: "espn_get_scoreboard", result: scoreboard }],
    ["roster", { tool: "espn_get_roster", result: roster }],
    [
      "lineup",
      {
        tool: "espn_analyze_lineup",
        result: envelope({ rec: { action: "start A" }, list: [{ v: 1 }] }, "r-bbbbbbbbbbbb"),
      },
    ],
    [
      "cascade",
      {
        tool: "espn_analyze_injury_cascade",
        result: envelope({
          beneficiaries: [
            { player_id: 21 },
            { player_id: null, gsis_id: "00-0000001" },
            { player_id: 22 },
            { player_id: 21 },
            "junk",
            { player_id: 23.5 },
            { player_id: 24 },
          ],
          empty: [],
          none: [{ player_id: null }],
          scalar: 7,
        }),
      },
    ],
  ]);

  it("resolves $ref paths (with array indexes), $source_calls, $opponent and $player inside nested values", () => {
    const out = resolveArgs(
      {
        kind: "lineup",
        week: { $ref: "league.data.clock.current_matchup_period" },
        rec: { $ref: "lineup.data.rec" },
        first: { $ref: "lineup.data.list.0.v" },
        hash: { $ref: "league.data.scoring.settings_hash" },
        source_calls: { $source_calls: ["league", "lineup"] },
        players: { team_id: { $opponent: "scoreboard" } },
        compare: [
          {
            out: { $player: { step: "roster", slot: "FLEX" } },
            in: { $player: { step: "roster", slot: "BE", eligible: "FLEX" } },
          },
        ],
      },
      results,
    );
    expect(out).toEqual({
      kind: "lineup",
      week: 5,
      rec: { action: "start A" },
      first: 1,
      hash: "sh-1",
      source_calls: [
        { tool: "espn_get_league", request_id: "r-aaaaaaaaaaaa" },
        { tool: "espn_analyze_lineup", request_id: "r-bbbbbbbbbbbb" },
      ],
      players: { team_id: 7 },
      compare: [{ out: 12, in: 14 }],
    });
  });

  it("resolves $player's injury_status filter and $ids (distinct numeric ids, in order, capped)", () => {
    expect(
      resolveArgs(
        {
          out: { $player: { step: "roster", slot: "BE", injury_status: "OUT" } },
          q: { $player: { step: "roster", slot: "BE", injury_status: "QUESTIONABLE" } },
          candidates: { $ids: { from: "cascade.data.beneficiaries", key: "player_id" } },
          top2: { $ids: { from: "cascade.data.beneficiaries", key: "player_id", max: 2 } },
        },
        results,
      ),
    ).toEqual({ out: 14, q: 13, candidates: [21, 22, 24], top2: [21, 22] });
  });

  it("$ids where keeps only the rows whose field holds a listed value (the AVAILABLE beneficiaries)", () => {
    const r = new Map([
      [
        "c",
        {
          tool: "espn_analyze_injury_cascade",
          result: envelope({
            b: [
              { player_id: 1, status: "ONTEAM" },
              { player_id: 2, status: "FREEAGENT" },
              { player_id: 3, status: null },
              { player_id: 4, status: "WAIVERS" },
              { player_id: 5 },
              "junk",
              { player_id: 6, status: "WAIVERS", injured: true },
            ],
          }),
        },
      ],
    ]);
    const where = { status: ["FREEAGENT", "WAIVERS"] };
    expect(idsOf(r, { from: "c.data.b", key: "player_id", where })).toEqual([2, 4, 6]);
    expect(idsOf(r, { from: "c.data.b", key: "player_id", where, max: 2 })).toEqual([2, 4]);
    // every field must match; null is a value like any other
    expect(
      idsOf(r, {
        from: "c.data.b",
        key: "player_id",
        where: { status: ["WAIVERS"], injured: [true] },
      }),
    ).toEqual([6]);
    expect(idsOf(r, { from: "c.data.b", key: "player_id", where: { status: [null] } })).toEqual([
      3,
    ]);
    expect(() =>
      idsOf(r, { from: "c.data.b", key: "player_id", where: { status: ["SUSPENDED"] } }),
    ).toThrow(/no player_id in the list \(after where\)/);
    expect(resolveArgs({ c: { $ids: { from: "c.data.b", key: "player_id", where } } }, r)).toEqual({
      c: [2, 4, 6],
    });
  });

  it("idsOf refuses an unknown step, a non-array, and a list with no id left — never an empty id list", () => {
    expect(() => idsOf(results, { from: "nope.data.x", key: "player_id" })).toThrow(
      /step nope has no result/,
    );
    expect(() => idsOf(results, { from: "cascade.data.scalar", key: "player_id" })).toThrow(
      /not an array/,
    );
    expect(() => idsOf(results, { from: "cascade.data.empty", key: "player_id" })).toThrow(
      /no player_id in the list/,
    );
    expect(() => idsOf(results, { from: "cascade.data.none", key: "player_id" })).toThrow(
      /no player_id in the list/,
    );
  });

  it("$ids never returns more than its cap, nor a duplicate (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: 1, max: 30 }), fc.constant(null)), {
          minLength: 1,
          maxLength: 60,
        }),
        fc.integer({ min: 1, max: 25 }),
        (ids, max) => {
          fc.pre(ids.some((x) => x !== null));
          const r = new Map([
            [
              "c",
              {
                tool: "espn_analyze_injury_cascade",
                result: envelope({ b: ids.map((player_id) => ({ player_id })) }),
              },
            ],
          ]);
          const out = idsOf(r, { from: "c.data.b", key: "player_id", max });
          expect(out.length).toBeLessThanOrEqual(max);
          expect(new Set(out).size).toBe(out.length);
          const first = [...new Set(ids.filter((x): x is number => x !== null))].slice(0, max);
          expect(out).toEqual(first);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("deep-copies: mutating the output never touches an earlier result", () => {
    const out = resolveArgs({ rec: { $ref: "lineup.data.rec" } }, results) as {
      rec: { action: string };
    };
    out.rec.action = "changed";
    expect(resolveArgs({ rec: { $ref: "lineup.data.rec" } }, results)).toEqual({
      rec: { action: "start A" },
    });
  });

  it.each([
    [{ $ref: "nope.data.x" }, /step nope has no result/],
    [{ $ref: "lineup.data.missing" }, /no `missing` in the result/],
    [{ $ref: 3 }, /\$ref must be a string/],
    [{ $source_calls: "league" }, /must be an array/],
    [{ $source_calls: ["nope"] }, /step nope has no result/],
    [{ $opponent: 1 }, /must be a step id/],
    [{ $opponent: "nope" }, /step has no result/],
    [{ $player: "roster" }, /\$player must be/],
    [{ $player: { step: "nope", slot: "BE" } }, /step has no result/],
    [{ $player: { step: "roster", slot: "K" } }, /no player in K/],
    [
      { $player: { step: "roster", slot: "BE", eligible: "TE" } },
      /no player in BE eligible for TE/,
    ],
    [
      { $player: { step: "roster", slot: "BE", injury_status: "SUSPENSION" } },
      /no player in BE with status SUSPENSION/,
    ],
    [{ $ids: "cascade.data.beneficiaries" }, /\$ids must be \{ from, key, max\?, where\? \}/],
    [
      { $ids: { from: "cascade.data.beneficiaries", key: "player_id", where: { status: "X" } } },
      /\$ids where must be/,
    ],
    [
      {
        $ids: {
          from: "cascade.data.beneficiaries",
          key: "player_id",
          where: { status: ["ONTEAM"] },
        },
      },
      /no player_id in the list \(after where\)/,
    ],
    [{ $ids: { from: "cascade.data.beneficiaries" } }, /\$ids must be/],
  ])("throws on %j", (template, re) => {
    expect(() => resolveArgs(template, results)).toThrow(re);
  });

  it("$source_calls needs each step's meta.request_id", () => {
    const r = new Map([["x", { tool: "espn_get_status", result: { data: {} } }]]);
    expect(() => resolveArgs({ $source_calls: ["x"] }, r)).toThrow(/x\.meta\.request_id/);
  });

  it("keeps a __proto__ key as an own key, never as the prototype", () => {
    const template = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown;
    const out = resolveArgs(template, results) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("leaves plain values alone and round-trips any JSON value without templates (property)", () => {
    const noDollar = fc.jsonValue().filter((v) => !JSON.stringify(v).includes('"$'));
    fc.assert(
      fc.property(noDollar, (v) => {
        expect(resolveArgs(v, results)).toEqual(v);
      }),
      { numRuns: 300 },
    );
  });
});

describe("opponentOf and playerOf", () => {
  it("find the opponent whether the user is home or away, and refuse a bye or no matchup", () => {
    const sb = (home: unknown, away: unknown) => envelope({ matchups: [{ home, away }] });
    expect(opponentOf(sb({ team_id: 2, is_mine: true }, { team_id: 9 }), "s")).toBe(9);
    expect(opponentOf(sb({ team_id: 9 }, { team_id: 2, is_mine: true }), "s")).toBe(9);
    expect(() => opponentOf(sb({ team_id: 2, is_mine: true }, null), "s")).toThrow(/a bye/);
    expect(() => opponentOf(sb({ team_id: 3 }, { team_id: 4 }), "s")).toThrow(
      /no matchup is the user's/,
    );
    expect(() => opponentOf({ data: {} }, "s")).toThrow(/no data\.matchups/);
    expect(() => opponentOf(envelope({ matchups: [null, "x"] }), "s")).toThrow(
      /no matchup is the user's/,
    );
  });

  it("playerOf skips rows without a numeric id and refuses a result without players", () => {
    const r = envelope({
      players: [null, { slot: "BE", player_id: "12" }, { slot: "BE", player_id: 15 }],
    });
    expect(playerOf(r, { step: "r", slot: "BE" })).toBe(15);
    expect(() => playerOf({ data: {} }, { step: "r", slot: "BE" })).toThrow(/no data\.players/);
  });
});

describe("outcomeAllowed", () => {
  it("allows exactly the listed outcomes", () => {
    expect(outcomeAllowed({ expect: ["ok"] }, "ok")).toBe(true);
    expect(outcomeAllowed({ expect: ["ok"] }, "VALIDATION")).toBe(false);
    expect(
      outcomeAllowed({ expect: ["ok", "ESPN_REQUIRES_COOKIES"] }, "ESPN_REQUIRES_COOKIES"),
    ).toBe(true);
  });
});
