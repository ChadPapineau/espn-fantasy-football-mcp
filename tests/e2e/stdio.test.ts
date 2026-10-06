// stdio.test.ts — the product end to end over REAL stdio (plan 10 A3a, A4a, A7a, A15a; plan 05
// §4.2): `npm run build`, then `node dist/cli.js serve` spawned in fixture mode on the derived league
// fx-10h with a temp config/cache, no network (a preload exits 98 on any socket) and EFF_TEST_STUBS.
// A real MCP client lists exactly the 18 P0 tools (+ the fixture-mode-only espn_debug_echo), calls
// every one with arguments its own zod schema accepts, validates every envelope against the tool's
// full output schema, then closes stdin and asserts a clean exit inside the drain deadline. The
// drift variant proves A4a end to end; the public stdout carries JSON-RPC frames only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANDATORY_SENTENCES, TOOL_FAMILY_OF } from "../../src/mcp/envelope.js";
import { outputSchemaOf } from "../../src/mcp/define.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { resolveArgs } from "../../scripts/skills/tool-sequences.mjs";
import {
  bodyOf,
  DRAIN_DEADLINE_MS,
  FX,
  logRecords,
  makeHome,
  requireDist,
  ROOT,
  serve,
  type E2eHome,
} from "./helpers.js";

const EXPECTED = JSON.parse(
  readFileSync(path.join(ROOT, "tests", "smoke", "expected-tools.json"), "utf8"),
) as { core: string[] };
const DEBUG_TOOL = "espn_debug_echo";

/** Arguments for every P0 tool, in registry order; `$ref`/`$source_calls` resolve from earlier calls. */
const CALLS: readonly [string, Record<string, unknown>][] = [
  ["espn_get_league", { include: ["league", "clock", "scoring", "roster", "rules", "seeding"] }],
  ["espn_get_standings", {}],
  ["espn_get_scoreboard", { week: 4 }],
  ["espn_get_live_scoreboard", {}],
  ["espn_get_box_score", { week: 4, team_id: 2 }],
  ["espn_list_transactions", { count: 40 }],
  ["espn_get_roster", { week: 5 }],
  ["espn_search_players", { query: "Robinson" }],
  ["espn_list_players", { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 }],
  ["espn_get_injuries", { players: { team_id: 2 } }],
  ["espn_get_schedule", { weeks: [5, 6] }],
  ["espn_project_players", { players: { team_id: 2 }, horizon: "week", week: 5, seed: 20261006 }],
  ["espn_analyze_lineup", { week: 5, objective: "auto" }],
  ["espn_analyze_waivers", { mode: "auto", phase: "auto" }],
  [
    "espn_record_recommendation",
    {
      kind: "lineup",
      week: 5,
      rec: { $ref: "espn_analyze_lineup.data.rec" },
      alternatives: [],
      source_calls: {
        $source_calls: ["espn_get_roster", "espn_project_players", "espn_analyze_lineup"],
      },
      settings_hash: { $ref: "espn_get_league.data.scoring.settings_hash" },
      seeding_mode_used: { $ref: "espn_analyze_lineup.data.seeding_mode_used" },
      followed_hint: "unknown",
      client_ref: "e2e-2026-w5-lineup",
    },
  ],
  ["espn_analyze_retrospective", { week: 4 }],
  ["espn_get_status", { include_checks: true }],
  ["espn_check_auth", {}],
];

const entryOf = (name: string) => {
  const e = REGISTRY.find((x) => x.name === name)?.tool;
  if (e === undefined || e === null) throw new Error(`${name} is not built`);
  return e;
};

let home: E2eHome;
beforeAll(() => {
  requireDist();
  home = makeHome();
});
afterAll(() => {
  home.cleanup();
});

describe(
  "eff serve over real stdio on fx-10h (fixture mode, no network)",
  { timeout: 240_000 },
  () => {
    it("lists exactly the 18 P0 tools, answers every one with a valid envelope, and exits 0 on stdin EOF", async () => {
      const s = await serve(home);
      const { client, transport } = s;

      // tools/list: the 18 P0 names in registry order, then the fixture-mode spike tool; no write tool
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name)).toEqual([...EXPECTED.core, DEBUG_TOOL]);
      expect(tools.every((t) => t.name.startsWith("espn_"))).toBe(true);
      expect(tools.some((t) => /^espn_(prepare|commit)_/.test(t.name))).toBe(false);
      // the two mandatory sentences: in the server instructions exactly once each, in no description
      const instructions = client.getInstructions() ?? "";
      for (const sentence of MANDATORY_SENTENCES) {
        expect(instructions.split(sentence).length - 1).toBe(1);
        for (const t of tools) expect(t.description ?? "").not.toContain(sentence);
      }
      // resources (8 static + 2 templates = plan 07 §4.1's ten) and the eight P0 prompts
      const resources = (await client.listResources()).resources.map((r) => r.uri);
      const templates = (await client.listResourceTemplates()).resourceTemplates.map(
        (r) => r.uriTemplate,
      );
      expect(resources.length + templates.length).toBe(10);
      expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual([
        "espn.apply",
        "espn.onboard",
        "espn.retro",
        "espn.session",
        "espn.start_sit",
        "espn.stream",
        "espn.waivers",
        "espn.weekly",
      ]);

      // every P0 tool: arguments its own schema accepts → a valid envelope (the full output schema)
      const results = new Map<string, { tool: string; result: unknown }>();
      for (const [name, template] of CALLS) {
        const def = entryOf(name);
        const args = resolveArgs(template, results) as Record<string, unknown>;
        expect(def.input.safeParse(args).success, `${name}: arguments fail its input schema`).toBe(
          true,
        );
        const r = await client.callTool({ name, arguments: args });
        const b = bodyOf(r);
        expect(r.isError, `${name}: ${JSON.stringify(b).slice(0, 400)}`).not.toBe(true);
        const parsed = outputSchemaOf(def).safeParse(b);
        expect(parsed.success, `${name}: the envelope fails its output schema`).toBe(true);
        // structuredContent, when present, is the same envelope as the text block
        if (r.structuredContent !== undefined) expect(r.structuredContent).toEqual(b);
        const meta = b.meta as { estimate: boolean; source: string[]; attribution: unknown[] };
        const family = TOOL_FAMILY_OF[name]?.family;
        if (family === "analytics")
          expect(meta.estimate, `${name}: an analytics result is an estimate`).toBe(true);
        if (family === "espn_fact")
          expect(meta.estimate, `${name}: an ESPN fact is not an estimate`).toBe(false);
        if (meta.source.some((x) => x.startsWith("espn:") || x.startsWith("nflverse:")))
          expect(meta.attribution.length, `${name}: attribution`).toBeGreaterThan(0);
        results.set(name, { tool: name, result: b });
      }

      // A3a's named facts
      const league = results.get("espn_get_league")?.result as {
        data: { league: { name: unknown } };
        meta: { source: string[] };
      };
      expect(league.data.league.name).toMatchObject({
        untrusted_text: { value: "Example League", truncated: false },
      });
      expect(league.meta.source[0]).toBe("espn:mSettings");
      const status = results.get("espn_get_status")?.result as {
        data: { credential: { present: boolean }; capabilities: { write: { lineup: boolean } } };
      };
      expect(status.data.credential.present).toBe(false);
      expect(status.data.capabilities.write.lineup).toBe(false);
      const box = results.get("espn_get_box_score")?.result as {
        data: {
          matchups: {
            home: { players: { match: boolean }[] };
            away?: { players: { match: boolean }[] } | null;
          }[];
        };
      };
      const players = box.data.matchups.flatMap((m) => [
        ...m.home.players,
        ...(m.away?.players ?? []),
      ]);
      expect(players.length).toBeGreaterThan(0);
      expect(players.every((p) => p.match)).toBe(true);

      // the fixture-mode spike: the nonce only in structuredContent (plan 07 G3)
      const echo = await client.callTool({ name: DEBUG_TOOL, arguments: {} });
      expect(echo.isError).not.toBe(true);

      // clean shutdown: stdin EOF → exit 0 within the drain deadline; stdout carried frames only
      const { exit, ms } = await s.stop();
      expect(exit).toMatchObject({ code: 0, signal: null });
      expect(ms).toBeLessThan(DRAIN_DEADLINE_MS);
      for (const line of transport.stdoutText.split("\n").filter(Boolean))
        expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
      const logs = logRecords(transport.stderr);
      expect(
        logs.some(
          (l) =>
            l.event === "serve.ready" &&
            l.fixture_mode === true &&
            l.fixture_clock === "2026-10-07T01:00:00.000Z",
        ),
      ).toBe(true);
      expect(logs.some((l) => l.event === "serve.shutdown" && l.reason === "stdin")).toBe(true);
      expect(logs.filter((l) => l.level === "error" || l.level === "fatal" || "raw" in l)).toEqual(
        [],
      );
      expect(transport.stderr.join("\n")).not.toContain("EFF-E2E");
    });

    it("drift end to end (A4a): a drifted mRoster fails espn_get_roster naming the path; standings still work; status shows the diff", async () => {
      const h = makeHome({ fixtureDir: path.join(FX, "drift-mRoster") });
      try {
        const s = await serve(h);
        const roster = await s.client.callTool({ name: "espn_get_roster", arguments: { week: 5 } });
        expect(roster.isError).toBe(true);
        const err = bodyOf(roster).error as { code: string; path?: string };
        expect(err.code).toBe("ESPN_DRIFT_DETECTED");
        expect(err.path).toBe("teams[].roster.entries");
        const standings = await s.client.callTool({ name: "espn_get_standings", arguments: {} });
        expect(standings.isError).not.toBe(true);
        const status = bodyOf(await s.client.callTool({ name: "espn_get_status", arguments: {} }));
        const drift = (status.data as { drift: { status: string; diff: unknown[] } }).drift;
        expect(drift.status).toBe("red");
        expect(JSON.stringify(drift.diff)).toContain("$.teams[].roster.entries");
        const { exit } = await s.stop();
        expect(exit.code).toBe(0);
      } finally {
        h.cleanup();
      }
    });

    it("the 2026-07-28 protocol era lists the same tools and shuts down cleanly", async () => {
      const h = makeHome();
      try {
        const s = await serve(h, { modern: true });
        expect((await s.client.listTools()).tools.map((t) => t.name)).toEqual([
          ...EXPECTED.core,
          DEBUG_TOOL,
        ]);
        const st = await s.client.callTool({ name: "espn_get_status", arguments: {} });
        expect(st.isError).not.toBe(true);
        const { exit } = await s.stop();
        expect(exit.code).toBe(0);
      } finally {
        h.cleanup();
      }
    });
  },
);
