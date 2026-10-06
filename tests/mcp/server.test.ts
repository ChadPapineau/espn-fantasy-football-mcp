// server.test.ts — the MCP surface as a client sees it (plan 10 A3a, plan 05 §5 smoke assertions
// in-process): tools/list equals tests/smoke/expected-tools.json in registry order with no write tool
// whatever EFF_ENABLE_WRITES says (PHASE W SEAM); `instructions` carry each mandatory sentence
// exactly once in both eras and no description carries either; every description ends with the
// 40-char pointer; annotations by family (plan 01 §4.1); list results carry ttlMs + cacheScope
// private; ten resources (8 + 2 templates); the eight P0 prompts; the fixture-only echo spike.
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
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  instructionsFor,
  spikeLine,
} from "../../src/mcp/server.js";
import { DEBUG_ECHO_TEXT, DEBUG_TOOL_NAME } from "../../src/mcp/tools/debug.js";
import { PROMPTS } from "../../src/mcp/prompts/index.js";
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

  it("full registers the built tools in catalog order (the P1 slots are declared, not built, until B2)", async () => {
    const { client, close } = await connect(world, {
      options: { toolset: "full", fixtureMode: false },
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expected.full.filter((n) => toolNames("full").includes(n)));
    expect(toolsFor("full").map((t) => t.name)).toEqual(toolNames("full"));
    expect(REGISTRY.filter((e) => e.priority === "P1").every((e) => e.tool === null)).toBe(true);
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
    expect(d.ttlMs).toBe(LIST_TTL_MS);
    expect(d.cacheScope).toBe("private");
    await close();
  });

  it("fixture mode adds the spike nonce line once; the sentences stay exactly once", async () => {
    expect(world.options.fixtureMode).toBe(false);
    const nonce = "0123456789ab";
    const fx = instructionsFor({ fixtureMode: true, spikeNonce: nonce });
    expect(fx).toBe(`${SERVER_INSTRUCTIONS}\n\n${spikeLine(nonce)}`);
    for (const s of MANDATORY_SENTENCES) expect(count(fx, s)).toBe(1);
    expect(instructionsFor({ fixtureMode: false, spikeNonce: nonce })).toBe(SERVER_INSTRUCTIONS);
    expect(instructionsFor({ fixtureMode: true })).toBe(SERVER_INSTRUCTIONS);
    const { client, close } = await connect(world, {
      options: { fixtureMode: true, spikeNonce: nonce },
    });
    expect(client.getInstructions()).toContain(nonce);
    await close();
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

  it("prompts/list has exactly the eight P0 prompts, in plan 07 §4.2 order", async () => {
    const { client, close } = await connect(world);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
      "espn.onboard",
      "espn.weekly",
      "espn.start_sit",
      "espn.stream",
      "espn.retro",
      "espn.apply",
      "espn.session",
      "espn.waivers",
    ]);
    expect(PROMPTS).toHaveLength(8);
    await close();
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
