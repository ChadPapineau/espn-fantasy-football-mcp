// smoke-lib.test.ts — the A3a smoke assertions (tests/smoke/smoke-lib.mjs) are pinned to the code
// they check (the mandatory sentences, the pointer, the resource and prompt sets, the debug tool, the
// expected tool lists) and each check fails on the defect it names — hostile and malformed inputs
// included — so a green smoke means something. The static guide's pinned sentences (changelog §R17,
// R17-2; §R18, R18-1 and R18-11) and the production length are pinned to the guide pins the unit
// server test and both stdio suites hold (tests/mcp/helpers/guide-pins.ts); the guide check passes
// the text src serves and fails on the mutations those pins refuse (a sentence cut, reworded,
// doubled, moved or respaced; the session-start reads unscoped or first) and on a wrong length.
// Ported from sibling @0a0c7a5, adapted.
import { describe, expect, it } from "vitest";
import {
  DEBUG_TOOL,
  EXPECTED_P1_PROMPTS,
  EXPECTED_PROMPTS,
  EXPECTED_RESOURCES,
  EXPECTED_TEMPLATES,
  GUIDE_SENTENCES,
  INSTRUCTIONS_CHARS,
  MANDATORY_SENTENCES,
  NO_SKILL_START,
  POINTER,
  R17_2_DATA_TIME,
  R17_2_SKILL_FIRST,
  R18_11_OTHER_PLATFORM,
  R18_1_HEALTH_LOOKUP,
  checkDescriptions,
  checkInstructions,
  checkPrompts,
  checkResources,
  checkToolNames,
  expectedPrompts,
  fixtureEnv,
  inspectorResult,
  readExpectedTools,
  SMOKE_TOOLSETS,
  toolsetArg,
  withoutSpikeLine,
} from "./smoke-lib.mjs";
import {
  MANDATORY_SENTENCES as SRC_SENTENCES,
  RESOURCE_TTL_MS,
  UNTRUSTED_POINTER,
} from "../../src/mcp/envelope.js";
import { ALL_PROMPTS, P1_PROMPTS, PROMPTS } from "../../src/mcp/prompts/index.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { SERVER_INSTRUCTIONS, instructionsFor, spikeLine } from "../../src/mcp/server.js";
import { DEBUG_TOOL_NAME } from "../../src/mcp/tools/debug.js";
import * as pins from "../mcp/helpers/guide-pins.js";
import { rmSync } from "node:fs";

describe("pinned to src", () => {
  it("the sentences, the pointer and the debug tool", () => {
    expect(MANDATORY_SENTENCES).toEqual(SRC_SENTENCES);
    expect(POINTER).toBe(UNTRUSTED_POINTER);
    expect(DEBUG_TOOL).toBe(DEBUG_TOOL_NAME);
  });

  it("the guide's pinned sentences and the production length: the guide pins', written out again (changelog §R17, R17-2; §R18, R18-1 and R18-11)", () => {
    // each sentence, verbatim, and the five in the order the guide gives them
    expect(R17_2_SKILL_FIRST).toBe(pins.R17_2_SKILL_FIRST);
    expect(R18_1_HEALTH_LOOKUP).toBe(pins.R18_1_HEALTH_LOOKUP);
    expect(R18_11_OTHER_PLATFORM).toBe(pins.R18_11_OTHER_PLATFORM);
    expect(NO_SKILL_START).toBe(pins.NO_SKILL_START);
    expect(R17_2_DATA_TIME).toBe(pins.R17_2_DATA_TIME);
    expect(GUIDE_SENTENCES).toEqual(pins.GUIDE_PINS);
    expect(GUIDE_SENTENCES).toEqual([
      R17_2_SKILL_FIRST,
      R18_1_HEALTH_LOOKUP,
      R18_11_OTHER_PLATFORM,
      NO_SKILL_START,
      R17_2_DATA_TIME,
    ]);
    expect(Object.isFrozen(GUIDE_SENTENCES)).toBe(true);
    // R18-11's 1,477 characters (1,355 before R18-11, 1,248 before R18-1)
    expect(INSTRUCTIONS_CHARS).toBe(pins.R18_11_INSTRUCTIONS_CHARS);
    expect(INSTRUCTIONS_CHARS).toBe(1_477);
  });

  it("checkInstructions passes the text src serves: the production text, and fixture mode's with its spike line", () => {
    expect(checkInstructions(SERVER_INSTRUCTIONS)).toEqual([]);
    const fx = instructionsFor({ fixtureMode: true, spikeNonce: "0123456789ab" });
    expect(fx).not.toBe(SERVER_INSTRUCTIONS);
    expect(checkInstructions(fx)).toEqual([]);
    // the spike line comes off as the guide pins take it off; a text without one is left as it is
    expect(withoutSpikeLine(fx)).toBe(SERVER_INSTRUCTIONS);
    expect(withoutSpikeLine(fx)).toBe(pins.withoutSpikeLine(fx));
    expect(withoutSpikeLine(SERVER_INSTRUCTIONS)).toBe(SERVER_INSTRUCTIONS);
    expect(withoutSpikeLine(SERVER_INSTRUCTIONS)).toHaveLength(INSTRUCTIONS_CHARS);
  });

  it("the ten resources and the eight prompts", () => {
    const keys = Object.keys(RESOURCE_TTL_MS);
    expect([...EXPECTED_RESOURCES, ...EXPECTED_TEMPLATES].sort()).toEqual([...keys].sort());
    expect([...EXPECTED_PROMPTS].sort()).toEqual(PROMPTS.map((p) => p.name).sort());
    // the five P1 prompts, listed under full only (13 there — plan 10 B10)
    expect([...EXPECTED_P1_PROMPTS].sort()).toEqual(P1_PROMPTS.map((p) => p.name).sort());
    expect([...expectedPrompts("full")].sort()).toEqual(ALL_PROMPTS.map((p) => p.name).sort());
    expect(expectedPrompts("full")).toHaveLength(13);
    expect(expectedPrompts("core")).toEqual(EXPECTED_PROMPTS);
    expect(SMOKE_TOOLSETS).toEqual(["core", "full"]);
  });

  it("toolsetArg: absent → core; core | full as given; anything else null", () => {
    expect(toolsetArg(undefined)).toBe("core");
    expect(toolsetArg("core")).toBe("core");
    expect(toolsetArg("full")).toBe("full");
    for (const bad of ["", "FULL", "--method", "full ", null, 1])
      expect(toolsetArg(bad)).toBeNull();
  });

  it("expected-tools.json: core is the registry's P0 rows in order, full every row", () => {
    const t = readExpectedTools();
    expect(t.core).toEqual(REGISTRY.filter((r) => r.priority === "P0").map((r) => r.name));
    expect(t.full).toEqual(REGISTRY.map((r) => r.name));
  });

  it("fixtureEnv: a private temp home on fx-10h, Team 02, stubs on, no real directories", () => {
    const { root, env } = fixtureEnv();
    try {
      expect(env.EFF_FIXTURE_DIR?.endsWith("/fixtures/espn/fx-10h")).toBe(true);
      expect(env).toMatchObject({
        ESPN_LEAGUE_ID: "0",
        ESPN_TEAM_ID: "2",
        EFF_TOOLSET: "core",
        EFF_TEST_STUBS: "1",
      });
      for (const k of ["HOME", "EFF_CONFIG_DIR", "EFF_CACHE_DIR"])
        expect(env[k]?.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const full = fixtureEnv({ toolset: "full" });
    try {
      expect(full.env.EFF_TOOLSET).toBe("full");
    } finally {
      rmSync(full.root, { recursive: true, force: true });
    }
  });
});

const core = readExpectedTools().core;
const desc = (name: string, extra = ""): { name: string; description: string } => ({
  name,
  description: `Does a thing.${extra} ${POINTER}`,
});

describe("checkToolNames", () => {
  it("passes the core list plus the debug tool last, in fixture mode", () => {
    expect(checkToolNames([...core, DEBUG_TOOL], core, { fixtureMode: true })).toEqual([]);
  });
  it.each<[string, unknown, boolean]>([
    ["a write tool", [...core, "espn_prepare_lineup", DEBUG_TOOL], true],
    ["a commit tool", [...core, "espn_commit_lineup", DEBUG_TOOL], true],
    ["a non-espn name", [...core, "ff_get_league", DEBUG_TOOL], true],
    ["a duplicate", [...core, core[0], DEBUG_TOOL], true],
    ["the debug tool not last", [DEBUG_TOOL, ...core], true],
    ["the debug tool missing in fixture mode", [...core], true],
    ["the debug tool outside fixture mode", [...core, DEBUG_TOOL], false],
    ["a reordered list", [...core].reverse().concat(DEBUG_TOOL), true],
    ["not an array", "espn_get_league", true],
    ["a non-string name", [...core, 7], true],
  ])("fails on %s", (_, names, fixtureMode) => {
    expect(checkToolNames(names, core, { fixtureMode }).length).toBeGreaterThan(0);
  });
});

describe("checkDescriptions", () => {
  it("passes descriptions ending with the pointer once", () => {
    expect(checkDescriptions(core.map((n) => desc(n)))).toEqual([]);
  });
  it.each<[string, unknown]>([
    ["a missing pointer", [{ name: "x", description: "Does a thing." }]],
    ["a doubled pointer", [{ name: "x", description: `${POINTER} ${POINTER}` }]],
    ["a mandatory sentence in a description", [desc("x", ` ${MANDATORY_SENTENCES[0] ?? ""}`)]],
    ["no description", [{ name: "x" }]],
    ["not an array", { tools: [] }],
  ])("fails on %s", (_, tools) => {
    expect(checkDescriptions(tools).length).toBeGreaterThan(0);
  });
});

describe("checkInstructions", () => {
  const ok = SERVER_INSTRUCTIONS;
  it("passes each mandatory sentence exactly once, then the guide's pinned sentences in order at 1,477 characters", () => {
    expect(checkInstructions(ok)).toEqual([]);
  });
  it.each<[string, unknown]>([
    ["no instructions", undefined],
    ["a missing sentence", MANDATORY_SENTENCES[0]],
    ["a doubled sentence", `${ok}\n${MANDATORY_SENTENCES[1] ?? ""}`],
    ["a non-string", 42],
  ])("fails on %s", (_, ins) => {
    expect(checkInstructions(ins).length).toBeGreaterThan(0);
  });

  // The static guide (changelog §R17, R17-2; §R18, R18-1 and R18-11), as the built server serves it
  // in both eras under both toolsets (run-smoke.mjs): every mutation the guide pins refuse, the
  // texts before R18-11 and R18-1 among them, and a wrong length with every sentence intact.
  const health = R18_1_HEALTH_LOOKUP;
  const other = R18_11_OTHER_PLATFORM;
  const guideCases: readonly [string, string][] = [
    ["R18-11's sentence cut (b563c1a's text)", ok.replace(` ${other}`, "")],
    ["R18-1's and R18-11's sentences cut (8f1c406's text)", ok.replace(` ${health} ${other}`, "")],
    ["the Skill rule's first pair missing", ok.replace(R17_2_SKILL_FIRST, "")],
    ["the Skill rule's first pair reworded", ok.replace("needs no Skill.", "needs none.")],
    ["the data-time sentence cut", ok.replace(` ${R17_2_DATA_TIME}`, "")],
    ["the data-time sentence doubled", `${ok} ${R17_2_DATA_TIME}`],
    ["R18-1's sentence reworded", ok.replace(health, health.replace("only asks", "asks"))],
    [
      "R18-1's sentence moved before R17-2's pair",
      ok.replace(` ${health}`, "").replace(R17_2_SKILL_FIRST, `${health} ${R17_2_SKILL_FIRST}`),
    ],
    ["R18-1's sentence on a line of its own", ok.replace(` ${health}`, `\n${health}`)],
    [
      "R18-11's sentence without a platform it names",
      ok.replace(other, other.replace("(Sleeper, Yahoo and the like)", "(Sleeper and the like)")),
    ],
    [
      "R18-11's sentence off R17-2's words",
      ok.replace(other, other.replace("is not about this league", "is not this league")),
    ],
    ["R18-11's sentence doubled", `${ok} ${other}`],
    [
      "R18-11's sentence moved before R18-1's",
      ok.replace(` ${other}`, "").replace(health, `${other} ${health}`),
    ],
    [
      "R18-11's sentence moved after the session-start reads",
      ok.replace(` ${other}`, "").replace(NO_SKILL_START, `${NO_SKILL_START} ${other}`),
    ],
    ["R18-11's sentence two spaces after R18-1's", ok.replace(` ${other}`, `  ${other}`)],
    ["R18-11's sentence on a line of its own", ok.replace(` ${other}`, `\n${other}`)],
    [
      "the session-start reads unscoped",
      ok.replace(NO_SKILL_START, NO_SKILL_START.replace("When no Skill is loaded, start", "Start")),
    ],
    [
      "the session-start reads also given unscoped",
      `${ok} Start with espn_get_status and espn_get_league once per session.`,
    ],
    [
      "the session-start reads before the Skill rule",
      ok
        .replace(R17_2_SKILL_FIRST, "\u0000")
        .replace(NO_SKILL_START, R17_2_SKILL_FIRST)
        .replace("\u0000", NO_SKILL_START),
    ],
    [
      "another word in the guide, every pinned sentence intact (the length)",
      ok.replace("no tool changes the league", "no tool ever changes the league"),
    ],
  ];

  it.each(guideCases)("fails on %s, with or without fixture mode's spike line", (label, text) => {
    expect(text, `${label}: the mutation changes nothing`).not.toBe(ok);
    expect(checkInstructions(text).length).toBeGreaterThan(0);
    expect(checkInstructions(`${text}\n\n${spikeLine("0123456789ab")}`).length).toBeGreaterThan(0);
  });

  it("each guide case is its own text, and the guide pins or the production length refuse it too", () => {
    expect(new Set(guideCases.map(([, text]) => text)).size).toBe(guideCases.length);
    for (const [label, text] of guideCases)
      expect(
        pins.guidePinProblems(text).length > 0 ||
          pins.withoutSpikeLine(text).length !== pins.R18_11_INSTRUCTIONS_CHARS,
        label,
      ).toBe(true);
  });

  it("names what it refuses, each check on a text only it (or it first) refuses", () => {
    const r18_1After = "R18-1's sentence follows R17-2's pair directly, one space between, 0 times";
    const r18_11After = "R18-11's sentence follows R18-1's directly, one space between, 0 times";
    // b563c1a's text: R18-11's sentence missing, its place after R18-1's empty, 1,355 characters
    expect(checkInstructions(ok.replace(` ${other}`, ""))).toEqual([
      expect.stringContaining(
        "guide sentence 3 appears 0 times (exactly 1 required): A question about",
      ),
      expect.stringContaining(r18_11After),
      expect.stringContaining("the production instructions are 1355 characters (1477 required)"),
    ]);
    // a newline before a sentence keeps every sentence and the length: only its place tells
    expect(checkInstructions(ok.replace(` ${other}`, `\n${other}`))).toEqual([
      expect.stringContaining(r18_11After),
    ]);
    expect(checkInstructions(ok.replace(` ${health}`, `\n${health}`))).toEqual([
      expect.stringContaining(r18_1After),
    ]);
    // a word changed elsewhere keeps every pin: only the length tells
    expect(
      checkInstructions(
        ok.replace("no tool changes the league", "no tool ever changes the league"),
      ),
    ).toEqual([expect.stringContaining("the production instructions are 1482 characters")]);
    // the session-start reads given a second time, unscoped
    expect(
      checkInstructions(`${ok} Start with espn_get_status and espn_get_league once per session.`),
    ).toEqual([
      expect.stringContaining("the session-start reads appear 2 times"),
      expect.stringContaining("the production instructions are 1542 characters"),
    ]);
    // the session-start sentence and R17-2's pair swapped: the pair loses R18-1, the reads lead
    const swapped = ok
      .replace(R17_2_SKILL_FIRST, "\u0000")
      .replace(NO_SKILL_START, R17_2_SKILL_FIRST)
      .replace("\u0000", NO_SKILL_START);
    expect(checkInstructions(swapped)).toEqual([
      expect.stringContaining(r18_1After),
      expect.stringContaining("the session-start reads come before the Skill rule"),
    ]);
  });
});

describe("checkResources and checkPrompts", () => {
  const list = {
    resources: EXPECTED_RESOURCES.map((uri) => ({ uri })),
    ttlMs: 60_000,
    cacheScope: "private",
  };
  const tpl = {
    resourceTemplates: EXPECTED_TEMPLATES.map((uriTemplate) => ({ uriTemplate })),
    ttlMs: 60_000,
    cacheScope: "private",
  };
  it("passes the 1a sets, with and without cache hints", () => {
    expect(checkResources(list, tpl, { requireCacheHints: true })).toEqual([]);
    expect(
      checkResources(
        { resources: list.resources },
        { resourceTemplates: tpl.resourceTemplates },
        { requireCacheHints: false },
      ),
    ).toEqual([]);
    expect(checkPrompts({ prompts: EXPECTED_PROMPTS.map((name) => ({ name })) })).toEqual([]);
  });
  it.each<[string, unknown, unknown, boolean]>([
    ["a missing resource", { resources: list.resources.slice(1) }, tpl, false],
    ["an extra resource", { resources: [...list.resources, { uri: "espn-ff://x" }] }, tpl, false],
    ["no resources array", {}, tpl, false],
    ["no templates array", list, {}, false],
    ["a missing template", list, { resourceTemplates: [] }, false],
    ["no ttlMs in the modern era", { resources: list.resources, cacheScope: "private" }, tpl, true],
    ["a shared cache scope", { ...list, cacheScope: "public" }, tpl, true],
  ])("fails on %s", (_, l, t, hints) => {
    expect(checkResources(l, t, { requireCacheHints: hints }).length).toBeGreaterThan(0);
  });
  it("fails on a missing, extra or malformed prompt list", () => {
    expect(
      checkPrompts({ prompts: EXPECTED_PROMPTS.slice(1).map((name) => ({ name })) }).length,
    ).toBe(1);
    expect(
      checkPrompts({ prompts: [...EXPECTED_PROMPTS, "espn.extra"].map((name) => ({ name })) })
        .length,
    ).toBe(1);
    expect(checkPrompts({}).length).toBe(1);
  });
  it("under full: the 13 pass, the eight alone fail; under core the 13 fail", () => {
    const all = expectedPrompts("full").map((name) => ({ name }));
    expect(checkPrompts({ prompts: all }, "full")).toEqual([]);
    expect(
      checkPrompts({ prompts: EXPECTED_PROMPTS.map((name) => ({ name })) }, "full"),
    ).toHaveLength(1);
    expect(checkPrompts({ prompts: all }, "core")).toHaveLength(1);
  });
});

describe("inspectorResult", () => {
  it("unwraps v2 { result }, passes a bare v1 result through, refuses anything else", () => {
    expect(inspectorResult({ result: { tools: [] } })).toEqual({ tools: [] });
    expect(inspectorResult({ tools: [] })).toEqual({ tools: [] });
    expect(inspectorResult([1])).toBeNull();
    expect(inspectorResult("x")).toBeNull();
  });
});
