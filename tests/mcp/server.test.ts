// server.test.ts — the MCP surface as a client sees it (plan 10 A3a, plan 05 §5 smoke assertions
// in-process): tools/list equals tests/smoke/expected-tools.json in registry order with no write tool
// whatever EFF_ENABLE_WRITES says (PHASE W SEAM); `instructions` carry each mandatory sentence
// exactly once in both eras and no description carries either; every description ends with the
// 40-char pointer; annotations by family (plan 01 §4.1); list results carry ttlMs + cacheScope
// private; ten resources (8 + 2 templates); the eight P0 prompts; the fixture-only echo spike. The
// static guide after the two sentences is its fixed text, word for word (plan 07 §5.4), with
// changelog §R17, R17-2's two sentences, §R18, R18-1's sentence right after R17-2's pair and
// R18-11's right after R18-1's (the Skill rule's three parts), and the session-start reads scoped to
// a session that loads no Skill, each exactly once in every era, toolset and mode
// (tests/mcp/helpers/guide-pins.ts); the production instructions are R18-11's 1,477 characters.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_CONTRACT as CONTRACT_COPY } from "../../src/mcp/contract.js";
import {
  ESPN_ESTIMATE_RULE,
  MANDATORY_SENTENCES,
  RESOURCE_TTL_MS,
  TOOL_FAMILIES,
  TOOL_FAMILY_OF,
  UNTRUSTED_POINTER,
  UNTRUSTED_TEXT_RULE,
} from "../../src/mcp/envelope.js";
import {
  REGISTRY,
  TOOL_CONTRACT,
  WRITE_TOOL_NAMES,
  catalogNames,
  toolNames,
  toolsFor,
  writeToolsFor,
} from "../../src/mcp/registry.js";
import {
  LIST_TTL_MS,
  SERVER_GUIDE,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SKILL_FIRST_RULE,
  instructionsFor,
  spikeLine,
} from "../../src/mcp/server.js";
import { DEBUG_ECHO_TEXT, DEBUG_TOOL_NAME } from "../../src/mcp/tools/debug.js";
import { ALL_PROMPTS, PROMPTS } from "../../src/mcp/prompts/index.js";
import {
  GUIDE_PINS,
  NO_SKILL_START,
  R17_2_DATA_TIME,
  R17_2_SKILL_FIRST,
  R18_11_INSTRUCTIONS_CHARS,
  R18_11_OTHER_PLATFORM,
  R18_1_HEALTH_LOOKUP,
  guidePinProblems,
  withoutSpikeLine,
} from "./helpers/guide-pins.js";
import { ROOT, call, connect, makeWorld, type World } from "./helpers/world.js";

const expected = JSON.parse(
  readFileSync(path.join(ROOT, "tests", "smoke", "expected-tools.json"), "utf8"),
) as { core: string[]; full: string[] };
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "skills", "manifest.json"), "utf8"),
) as { tools: { core: string[]; p1: string[] }; tool_contract: number; write_tools: string[] };

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publishEspn: false });
}, 120_000);
afterAll(() => {
  world.cleanup();
});

describe("tools/list (A3a)", () => {
  it("core in production mode equals expected-tools.json, in registry order (18 names)", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expected.core);
    expect(names).toHaveLength(18);
    for (const n of names) expect(n).toMatch(/^espn_[a-z][a-z0-9_]{1,34}$/);
    await close();
  });

  it("expected-tools.json, the registry, the family table and the Skills manifest agree", () => {
    expect(expected.core).toEqual(manifest.tools.core);
    expect(expected.full).toEqual([...manifest.tools.core, ...expected.full.slice(18)]);
    expect([...expected.full.slice(18)].sort()).toEqual([...manifest.tools.p1].sort());
    expect(toolNames("core")).toEqual(expected.core);
    expect(catalogNames("core")).toEqual(expected.core);
    expect(catalogNames("full")).toEqual(expected.full);
    expect(REGISTRY.map((e) => e.name)).toEqual(expected.full);
    expect(Object.keys(TOOL_FAMILY_OF).sort()).toEqual([...expected.full].sort());
    for (const e of REGISTRY) expect(TOOL_FAMILY_OF[e.name]?.id).toBe(e.id);
    for (const e of REGISTRY)
      expect(e.tool === null ? e.priority : e.tool.name).toBe(e.tool === null ? "P1" : e.name);
    expect(new Set(expected.full).size).toBe(34);
  });

  it("full registers all 34 tools in catalog order: the 18, then the 16 P1 tools (plan 10 B10)", async () => {
    const { client, close } = await connect(world, {
      options: { toolset: "full", fixtureMode: false },
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expected.full);
    expect(names).toHaveLength(34);
    expect(names.slice(0, 18)).toEqual(expected.core);
    expect(toolsFor("full").map((t) => t.name)).toEqual(toolNames("full"));
    expect(REGISTRY.every((e) => e.tool !== null)).toBe(true);
    expect(REGISTRY.filter((e) => e.priority === "P1")).toHaveLength(16);
    await close();
  });

  it("PHASE W SEAM: no espn_prepare_*/espn_commit_*/cancel tool, even with EFF_ENABLE_WRITES=true", async () => {
    const w = await makeWorld({ publishEspn: false, env: { EFF_ENABLE_WRITES: "true" } });
    try {
      expect(w.config.writesRequested).toBe(true);
      expect(w.options.writesRequested).toBe(true);
      expect(w.options.writeGates.allHold).toBe(false);
      for (const toolset of ["core", "full"] as const) {
        const { client, close } = await connect(w, { options: { toolset } });
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names.filter((n) => /prepare|commit|cancel/.test(n))).toEqual([]);
        for (const wt of WRITE_TOOL_NAMES) expect(names).not.toContain(wt);
        await close();
      }
    } finally {
      w.cleanup();
    }
    expect(WRITE_TOOL_NAMES).toEqual(manifest.write_tools);
    expect(writeToolsFor({ allHold: false, firstFailing: "env" })).toEqual([]);
    expect(writeToolsFor({ allHold: true, firstFailing: null } as never)).toEqual([]);
    const reg = readFileSync(path.join(ROOT, "src", "mcp", "registry.ts"), "utf8");
    const srv = readFileSync(path.join(ROOT, "src", "mcp", "server.ts"), "utf8");
    expect(reg).toContain("PHASE W SEAM — NOT IMPLEMENTED");
    expect(srv).toContain("PHASE W SEAM — NOT IMPLEMENTED");
  });

  it("every description ends with the 40-char pointer and carries neither mandatory sentence", async () => {
    expect(UNTRUSTED_POINTER.length).toBeLessThanOrEqual(40);
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    for (const t of (await client.listTools()).tools) {
      const d = t.description ?? "";
      expect(d.endsWith(UNTRUSTED_POINTER)).toBe(true);
      expect(count(d, UNTRUSTED_POINTER)).toBe(1);
      for (const s of MANDATORY_SENTENCES) expect(d).not.toContain(s.slice(0, 50));
    }
    await close();
  });

  it("annotations follow the plan 01 §4.1 family table, per tool", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      const entry = TOOL_FAMILY_OF[t.name];
      expect(entry).toBeDefined();
      expect(t.annotations).toEqual({ ...TOOL_FAMILIES[entry!.family], ...entry!.override });
    }
    const by = new Map(tools.map((t) => [t.name, t]));
    expect(by.get("espn_record_recommendation")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const n of ["espn_get_injuries", "espn_get_schedule", "espn_check_auth"])
      expect(by.get(n)?.annotations?.openWorldHint).toBe(true);
    for (const n of [
      "espn_project_players",
      "espn_analyze_lineup",
      "espn_analyze_waivers",
      "espn_analyze_retrospective",
      "espn_get_status",
    ])
      expect(by.get(n)?.annotations?.openWorldHint).toBe(false);
    for (const t of tools)
      if (t.name !== "espn_record_recommendation") expect(t.annotations?.readOnlyHint).toBe(true);
    await close();
  });

  it("every tool advertises an outline outputSchema {data, meta} and a compact input schema", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      expect(t.outputSchema?.type).toBe("object");
      expect(t.outputSchema?.required).toEqual(["data", "meta"]);
      expect(t.inputSchema.type).toBe("object");
    }
    const text = JSON.stringify(tools);
    expect(text).not.toContain('"pattern"');
    expect(text).not.toContain("9007199254740991");
    const record = tools.find((t) => t.name === "espn_record_recommendation");
    expect(Object.keys(record?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["kind", "week", "rec", "alternatives", "source_calls", "client_ref"]),
    );
    expect(record?.inputSchema.required).toEqual(
      expect.arrayContaining(["kind", "week", "rec", "settings_hash"]),
    );
    expect(Object.keys(record?.inputSchema.properties ?? {})).not.toContain("league_id");
    for (const t of tools)
      expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain("league_id");
    await close();
  });

  it("the tool contract is one value: registry literal = contract copy = Skills manifest", () => {
    expect(TOOL_CONTRACT).toBe(CONTRACT_COPY);
    expect(TOOL_CONTRACT).toBe(manifest.tool_contract);
  });
});

describe("instructions: each mandatory sentence exactly once (plan 02 §6.3; plan 01 §4.1)", () => {
  it("legacy era (initialize result)", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    const i = client.getInstructions() ?? "";
    expect(i).toBe(SERVER_INSTRUCTIONS);
    expect(count(i, UNTRUSTED_TEXT_RULE)).toBe(1);
    expect(count(i, ESPN_ESTIMATE_RULE)).toBe(1);
    expect(guidePinProblems(i)).toEqual([]);
    expect(i).toHaveLength(R18_11_INSTRUCTIONS_CHARS);
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    await close();
  });

  it("2026-07-28 era (server/discover through serveStdio) with ttlMs/cacheScope on discovery", async () => {
    const { client, close } = await connect(world, {
      modern: true,
      options: { fixtureMode: false },
    });
    expect(client.getProtocolEra()).toBe("modern");
    const d = client.getDiscoverResult() as unknown as {
      instructions: string;
      ttlMs: number;
      cacheScope: string;
    };
    for (const s of MANDATORY_SENTENCES) expect(count(d.instructions, s)).toBe(1);
    expect(guidePinProblems(d.instructions)).toEqual([]);
    expect(d.instructions).toHaveLength(R18_11_INSTRUCTIONS_CHARS);
    expect(d.ttlMs).toBe(LIST_TTL_MS);
    expect(d.cacheScope).toBe("private");
    await close();
  });

  it("under full the same text in both eras: the static guide does not change with the toolset", async () => {
    for (const modern of [false, true]) {
      const { client, close } = await connect(world, {
        modern,
        options: { toolset: "full", fixtureMode: false },
      });
      expect(client.getProtocolEra()).toBe(modern ? "modern" : "legacy");
      expect((await client.listTools()).tools).toHaveLength(34);
      const i = modern
        ? (client.getDiscoverResult() as unknown as { instructions: string }).instructions
        : (client.getInstructions() ?? "");
      expect(i).toBe(SERVER_INSTRUCTIONS);
      for (const s of MANDATORY_SENTENCES) expect(count(i, s)).toBe(1);
      expect(guidePinProblems(i)).toEqual([]);
      expect(i).toHaveLength(R18_11_INSTRUCTIONS_CHARS);
      await close();
    }
  });

  it("fixture mode adds the spike nonce line once; the sentences stay exactly once", async () => {
    expect(world.options.fixtureMode).toBe(false);
    const nonce = "0123456789ab";
    const fx = instructionsFor({ fixtureMode: true, spikeNonce: nonce });
    expect(fx).toBe(`${SERVER_INSTRUCTIONS}\n\n${spikeLine(nonce)}`);
    for (const s of MANDATORY_SENTENCES) expect(count(fx, s)).toBe(1);
    expect(guidePinProblems(fx)).toEqual([]);
    expect(withoutSpikeLine(fx)).toBe(SERVER_INSTRUCTIONS);
    expect(withoutSpikeLine(fx)).toHaveLength(R18_11_INSTRUCTIONS_CHARS);
    expect(instructionsFor({ fixtureMode: false, spikeNonce: nonce })).toBe(SERVER_INSTRUCTIONS);
    expect(instructionsFor({ fixtureMode: true })).toBe(SERVER_INSTRUCTIONS);
    const { client, close } = await connect(world, {
      options: { fixtureMode: true, spikeNonce: nonce },
    });
    expect(client.getInstructions()).toContain(nonce);
    expect(guidePinProblems(client.getInstructions() ?? "")).toEqual([]);
    expect(withoutSpikeLine(client.getInstructions() ?? "")).toHaveLength(
      R18_11_INSTRUCTIONS_CHARS,
    );
    await close();
    // and in the 2026-07-28 era, fixture mode (server/discover through serveStdio)
    const modern = await connect(world, {
      modern: true,
      options: { fixtureMode: true, spikeNonce: nonce },
    });
    expect(modern.client.getProtocolEra()).toBe("modern");
    const d = modern.client.getDiscoverResult() as unknown as { instructions: string };
    expect(d.instructions).toBe(fx);
    expect(guidePinProblems(d.instructions)).toEqual([]);
    expect(withoutSpikeLine(d.instructions)).toHaveLength(R18_11_INSTRUCTIONS_CHARS);
    await modern.close();
  });
});

describe("the static guide (plan 07 §5.4; changelog §R17, R17-2; §R18, R18-1 and R18-11)", () => {
  it("is its fixed text, word for word: R17-2's two sentences, R18-1's and R18-11's after them, and the session-start reads for a session that loads no Skill", () => {
    // the Skill rule is R17-2's pair, then R18-1's sentence, then R18-11's, one space between each
    expect(SKILL_FIRST_RULE).toBe(
      [R17_2_SKILL_FIRST, R18_1_HEALTH_LOOKUP, R18_11_OTHER_PLATFORM].join(" "),
    );
    expect(SERVER_GUIDE).toBe(
      [
        "Fantasy-football analysis of the operator's own ESPN league, read-only: no tool changes the league.",
        R17_2_SKILL_FIRST,
        R18_1_HEALTH_LOOKUP,
        R18_11_OTHER_PLATFORM,
        NO_SKILL_START,
        "Every result is an envelope {data, meta, page, truncated, partial, warnings}; every Dist carries its basis.",
        R17_2_DATA_TIME,
        "Log a recommendation with espn_record_recommendation before presenting it.",
      ].join(" "),
    );
    expect(SERVER_INSTRUCTIONS).toBe(
      `${UNTRUSTED_TEXT_RULE}\n\n${ESPN_ESTIMATE_RULE}\n\n${SERVER_GUIDE}`,
    );
    expect(guidePinProblems(SERVER_INSTRUCTIONS)).toEqual([]);
    // R18-11 grows the instructions from 1,355 to 1,477 characters, as R18-1 grew them from 1,248
    // (changelog §R18): without R18-11's sentence and its space the text is R18-1's
    expect(SERVER_INSTRUCTIONS).toHaveLength(R18_11_INSTRUCTIONS_CHARS);
    const beforeR18_11 = SERVER_INSTRUCTIONS.replace(` ${R18_11_OTHER_PLATFORM}`, "");
    expect(beforeR18_11).toHaveLength(1_355);
    expect(beforeR18_11.replace(` ${R18_1_HEALTH_LOOKUP}`, "")).toHaveLength(1_248);
    // the guide never repeats a mandatory sentence (each lives once, before it)
    for (const s of MANDATORY_SENTENCES) expect(SERVER_GUIDE).not.toContain(s);
  });

  it("the pin check fails on a missing, doubled, reworded, reordered or unscoped sentence", () => {
    const ok = SERVER_INSTRUCTIONS;
    const health = R18_1_HEALTH_LOOKUP;
    const other = R18_11_OTHER_PLATFORM;
    const cases: readonly [string, string][] = [
      ["the Skill rule missing", ok.replace(R17_2_SKILL_FIRST, "")],
      ["the data-time sentence doubled", `${ok} ${R17_2_DATA_TIME}`],
      [
        "the data-time sentence without its field marks",
        ok.replace(R17_2_DATA_TIME, R17_2_DATA_TIME.replaceAll("`", "")),
      ],
      [
        "the Skill rule's plain-lookup half dropped",
        ok.replace(" A plain lookup (a status, a score, a setting) needs no Skill.", ""),
      ],
      // R18-1's sentence: cut, reworded, doubled, moved, or no longer one space after R17-2's pair
      ["R18-1's sentence cut", ok.replace(` ${health}`, "")],
      ["R18-1's sentence without 'only'", ok.replace(health, health.replace("only asks", "asks"))],
      [
        "R18-1's sentence on another health word",
        ok.replace(health, health.replace("is healthy", "is fine")),
      ],
      [
        "R18-1's sentence without its last clause",
        ok.replace(health, health.replace(", even when he turns out to be hurt.", ".")),
      ],
      ["R18-1's sentence without its period", ok.replace(health, health.slice(0, -1))],
      ["R18-1's sentence doubled", `${ok} ${health}`],
      [
        "R18-1's sentence moved after the session-start reads",
        ok.replace(` ${health}`, "").replace(NO_SKILL_START, `${NO_SKILL_START} ${health}`),
      ],
      [
        "R18-1's sentence moved before R17-2's pair",
        ok.replace(` ${health}`, "").replace(R17_2_SKILL_FIRST, `${health} ${R17_2_SKILL_FIRST}`),
      ],
      ["R18-1's sentence two spaces after the pair", ok.replace(` ${health}`, `  ${health}`)],
      ["R18-1's sentence on a line of its own", ok.replace(` ${health}`, `\n${health}`)],
      // R18-11's sentence: cut, reworded, doubled, moved, or no longer one space after R18-1's
      ["R18-11's sentence cut", ok.replace(` ${other}`, "")],
      [
        "R18-11's sentence without a platform it names",
        ok.replace(other, other.replace("(Sleeper, Yahoo and the like)", "(Sleeper and the like)")),
      ],
      [
        "R18-11's sentence without its examples",
        ok.replace(other, other.replace(" (Sleeper, Yahoo and the like)", "")),
      ],
      [
        "R18-11's sentence off R17-2's words",
        ok.replace(other, other.replace("is not about this league", "is not this league")),
      ],
      [
        "R18-11's sentence without its last clause",
        ok.replace(other, other.replace(": no Skill covers it.", ".")),
      ],
      [
        "R18-11's sentence on another verb",
        ok.replace(other, other.replace("no Skill covers it", "no Skill loads for it")),
      ],
      ["R18-11's sentence without its period", ok.replace(other, other.slice(0, -1))],
      ["R18-11's sentence doubled", `${ok} ${other}`],
      [
        "R18-11's sentence moved before R18-1's",
        ok.replace(` ${other}`, "").replace(health, `${other} ${health}`),
      ],
      [
        "R18-11's sentence moved before R17-2's pair",
        ok.replace(` ${other}`, "").replace(R17_2_SKILL_FIRST, `${other} ${R17_2_SKILL_FIRST}`),
      ],
      [
        "R18-11's sentence moved after the session-start reads",
        ok.replace(` ${other}`, "").replace(NO_SKILL_START, `${NO_SKILL_START} ${other}`),
      ],
      ["R18-11's sentence two spaces after R18-1's", ok.replace(` ${other}`, `  ${other}`)],
      ["R18-11's sentence on a line of its own", ok.replace(` ${other}`, `\n${other}`)],
      [
        "R18-11's sentence between R17-2's two sentences",
        ok
          .replace(` ${other}`, "")
          .replace("says what to ask. A plain lookup", `says what to ask. ${other} A plain lookup`),
      ],
      [
        "the session-start reads unscoped",
        ok.replace(
          NO_SKILL_START,
          NO_SKILL_START.replace("When no Skill is loaded, start", "Start"),
        ),
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
    ];
    for (const [label, text] of cases) {
      expect(text, `${label}: the mutation changes nothing`).not.toBe(ok);
      expect(guidePinProblems(text).length, label).toBeGreaterThan(0);
    }
    // each mutation is its own text: no case repeats another's
    expect(new Set(cases.map(([, text]) => text)).size).toBe(cases.length);
    expect(GUIDE_PINS).toEqual([
      R17_2_SKILL_FIRST,
      R18_1_HEALTH_LOOKUP,
      R18_11_OTHER_PLATFORM,
      NO_SKILL_START,
      R17_2_DATA_TIME,
    ]);
  });
});

describe("lists carry ttlMs + cacheScope private (plan 01 §3.1)", () => {
  it("tools/list, resources/list, templates, prompts/list, and resource reads", async () => {
    const { client, close } = await connect(world, { modern: true });
    for (const r of [
      await client.listTools(),
      await client.listResources(),
      await client.listResourceTemplates(),
      await client.listPrompts(),
    ]) {
      const c = r as unknown as { ttlMs: number; cacheScope: string };
      expect(c.ttlMs).toBe(LIST_TTL_MS);
      expect(c.cacheScope).toBe("private");
    }
    const read = (await client.readResource({ uri: "espn-ff://status/freshness" })) as unknown as {
      ttlMs: number;
      cacheScope: string;
    };
    expect(read.ttlMs).toBe(RESOURCE_TTL_MS["espn-ff://status/freshness"]);
    expect(read.cacheScope).toBe("private");
    const docs = (await client.readResource({ uri: "espn-ff://docs/tool-outputs" })) as unknown as {
      ttlMs: number;
    };
    expect(docs.ttlMs).toBe(RESOURCE_TTL_MS["espn-ff://docs/tool-outputs"]);
    await close();
  });

  it("resources: the eight static URIs and the two templates — ten (A3a)", async () => {
    const { client, close } = await connect(world);
    const statics = (await client.listResources()).resources.map((r) => r.uri).sort();
    const templates = (await client.listResourceTemplates()).resourceTemplates
      .map((t) => t.uriTemplate)
      .sort();
    expect([...statics, ...templates].sort()).toEqual(Object.keys(RESOURCE_TTL_MS).sort());
    expect(statics).toHaveLength(8);
    expect(templates).toEqual(["espn-ff://rec/week/{week}", "espn-ff://rec/{log_id}"]);
    await close();
  });

  it("prompts/list has exactly the eight P0 prompts under core, 13 under full, in plan 07 §4.2 order", async () => {
    const p0 = [
      "espn.onboard",
      "espn.weekly",
      "espn.start_sit",
      "espn.stream",
      "espn.retro",
      "espn.apply",
      "espn.session",
      "espn.waivers",
    ];
    const { client, close } = await connect(world);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(p0);
    await close();
    const f = await connect(world, { options: { toolset: "full" } });
    expect((await f.client.listPrompts()).prompts.map((p) => p.name)).toEqual([
      ...p0,
      "espn.trade",
      "espn.injury",
      "espn.schedule",
      "espn.roster_audit",
      "espn.check",
    ]);
    expect(PROMPTS).toHaveLength(8);
    expect(ALL_PROMPTS).toHaveLength(13);
    await f.close();
  });
});

describe("the echo spike (plan 10 A11b; fixture mode only)", () => {
  it("returns a nonce ONLY in structuredContent; the text block omits it", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: true } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...expected.core, DEBUG_TOOL_NAME]);
    const r = (await client.callTool({ name: DEBUG_TOOL_NAME, arguments: {} })) as {
      content: { type: string; text: string }[];
      structuredContent: { data: { nonce: string } };
    };
    const nonce = r.structuredContent.data.nonce;
    expect(nonce).toMatch(/^[0-9a-f]{12}$/);
    expect(r.content).toEqual([{ type: "text", text: DEBUG_ECHO_TEXT }]);
    expect(JSON.stringify(r.content)).not.toContain(nonce);
    const again = (await client.callTool({ name: DEBUG_TOOL_NAME, arguments: {} })) as {
      structuredContent: { data: { nonce: string } };
    };
    expect(again.structuredContent.data.nonce).not.toBe(nonce);
    const bad = await client.callTool({ name: DEBUG_TOOL_NAME, arguments: { x: 1 } });
    expect(bad.isError).toBe(true);
    expect(expected.core).not.toContain(DEBUG_TOOL_NAME);
    expect(expected.full).not.toContain(DEBUG_TOOL_NAME);
    await close();
  });

  it("is not listed or callable in production mode", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(DEBUG_TOOL_NAME);
    const r = await client
      .callTool({ name: DEBUG_TOOL_NAME, arguments: {} })
      .then((x) => ({ ok: true, x }))
      .catch((e: unknown) => ({ ok: false, x: e }));
    expect(!r.ok || (r.x as { isError?: boolean }).isError === true).toBe(true);
    await close();
  });
});

describe("a call before anything is cached answers without a request (G1 budget 0)", () => {
  it("espn_get_status on a cold store: credential not configured, writes false, zero requests", async () => {
    const before = world.requests.length;
    const { client, close } = await connect(world);
    const r = await call(client, "espn_get_status");
    expect(r.isError).toBe(false);
    const d = r.body.data as {
      credential: { present: boolean; state: string };
      capabilities: { write: { lineup: boolean }; writes: boolean };
    };
    expect(d.credential.present).toBe(false);
    expect(d.credential.state).toBe("not_configured");
    expect(d.capabilities.write.lineup).toBe(false);
    expect(d.capabilities.writes).toBe(false);
    expect(world.requests.length).toBe(before);
    await close();
  });
});
