// tool-sequences.test.ts — scripts/skills/tool-sequences.mjs (plan 09 §5.1 item 7; plan 10 A14a):
// the loader the fixture dry run uses refuses anything check-skills would reject, and the argument
// resolver turns every template form ($ref, $source_calls, $opponent, $player) into concrete tool
// arguments from earlier results — failing loudly, never silently, on a result without the field.
import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadToolSequences,
  opponentOf,
  outcomeAllowed,
  playerOf,
  resolveArgs,
} from "../../scripts/skills/tool-sequences.mjs";
import { ROOT, SKILLS, tempRepo, type TempRepo } from "./helpers.js";

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
  it("loads all eight Skills with their fixture environment, under EFF_TOOLSET=core", () => {
    const all = loadToolSequences(ROOT);
    expect(all.map((s) => s.skill)).toEqual([...SKILLS]);
    for (const s of all) {
      expect(s.toolset).toBe("core");
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
      { player_id: 11, slot: "QB", eligible_slots: ["QB", "BE"] },
      { player_id: 12, slot: "FLEX", eligible_slots: ["WR", "FLEX", "BE"] },
      { player_id: 13, slot: "BE", eligible_slots: ["QB", "BE"] },
      { player_id: 14, slot: "BE", eligible_slots: ["RB", "FLEX", "BE"] },
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
