// smoke-lib.test.ts — the A3a smoke assertions (tests/smoke/smoke-lib.mjs) are pinned to the code
// they check (the mandatory sentences, the pointer, the resource and prompt sets, the debug tool, the
// expected tool lists) and each check fails on the defect it names — hostile and malformed inputs
// included — so a green smoke means something. Ported from sibling @0a0c7a5, adapted.
import { describe, expect, it } from "vitest";
import {
  DEBUG_TOOL,
  EXPECTED_P1_PROMPTS,
  EXPECTED_PROMPTS,
  EXPECTED_RESOURCES,
  EXPECTED_TEMPLATES,
  MANDATORY_SENTENCES,
  POINTER,
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
} from "./smoke-lib.mjs";
import {
  MANDATORY_SENTENCES as SRC_SENTENCES,
  RESOURCE_TTL_MS,
  UNTRUSTED_POINTER,
} from "../../src/mcp/envelope.js";
import { ALL_PROMPTS, P1_PROMPTS, PROMPTS } from "../../src/mcp/prompts/index.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { DEBUG_TOOL_NAME } from "../../src/mcp/tools/debug.js";
import { rmSync } from "node:fs";

describe("pinned to src", () => {
  it("the sentences, the pointer and the debug tool", () => {
    expect(MANDATORY_SENTENCES).toEqual(SRC_SENTENCES);
    expect(POINTER).toBe(UNTRUSTED_POINTER);
    expect(DEBUG_TOOL).toBe(DEBUG_TOOL_NAME);
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
  const ok = `${MANDATORY_SENTENCES.join("\n\n")}\n\nGuide.`;
  it("passes each sentence exactly once", () => {
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
