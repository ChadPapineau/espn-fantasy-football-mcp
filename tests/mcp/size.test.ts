// size.test.ts — the per-turn fixed cost and the result budgets, measured (plan 07 §5.1, C3, C8,
// C10; [A-4]: `core` tools/list ≤ 20 000 chars ≈ 5 k tokens, `full` ≤ 35 000, the Skills listing
// ≤ 4 600 chars — token-derived, downward-only ceilings; ADV OBJ-24: the ≤ 120-char short form of
// the rule must still fit if it ever returns to every description). Results: lists ≤ 20 000 chars,
// analytics ≤ 10 000 by construction. The measured numbers are printed for plan 10 §2's ledger.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANALYTICS_BUDGET_CHARS,
  RESULT_BUDGET_CHARS,
  UNTRUSTED_RULE_SHORT,
} from "../../src/mcp/envelope.js";
import { PROMPT_SKILLS } from "../../src/services/index.js";
import { ROOT, call, connect, makeWorld, type World } from "./helpers/world.js";

/** The ceilings (plan 07 §5.1 [A-4]) — lowered on measurement, never raised. */
const CEILINGS = Object.freeze({ core: 20_000, full: 35_000, skills: 4_600, coreTokens: 5_000 });
/** A conservative chars→tokens estimate for JSON (≈ 4 chars per token). */
const tokens = (chars: number): number => Math.ceil(chars / 4);

let world: World;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  world = await makeWorld();
  ({ client, close } = await connect(world, { options: { fixtureMode: false } }));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("the per-turn fixed cost (definitions)", () => {
  it("core tools/list fits 20 000 chars (≈ 5 k tokens), with room for the short-form fallback", async () => {
    const { tools } = await client.listTools();
    const chars = JSON.stringify(tools).length;
    console.log(
      `[size] core tools/list: ${String(chars)} chars ≈ ${String(tokens(chars))} tokens (${String(tools.length)} tools)`,
    );
    expect(tools).toHaveLength(18);
    expect(chars).toBeLessThanOrEqual(CEILINGS.core);
    expect(tokens(chars)).toBeLessThanOrEqual(CEILINGS.coreTokens);
    const fallback = chars + tools.length * (UNTRUSTED_RULE_SHORT.length + 1);
    console.log(
      `[size] core with the ≤ 120-char fallback in every description: ${String(fallback)} chars`,
    );
    expect(UNTRUSTED_RULE_SHORT.length).toBeLessThanOrEqual(120);
    expect(fallback).toBeLessThanOrEqual(CEILINGS.core);
  });

  it("full tools/list fits 35 000 chars", async () => {
    const c = await connect(world, { options: { toolset: "full", fixtureMode: false } });
    const chars = JSON.stringify((await c.client.listTools()).tools).length;
    console.log(`[size] full tools/list: ${String(chars)} chars (built tools only until B2)`);
    expect(chars).toBeLessThanOrEqual(CEILINGS.full);
    await c.close();
  });

  it("the Skills listing (P0 descriptions) fits 4 600 chars; prompts and resources lists are small", async () => {
    let total = 0;
    for (const s of PROMPT_SKILLS) {
      const text = readFileSync(path.join(ROOT, "skills", s, "SKILL.md"), "utf8");
      const m = /^description: (.*)$/m.exec(text);
      expect(m, s).not.toBeNull();
      total += (m?.[1] ?? "").length;
    }
    console.log(`[size] Skills listing: ${String(total)} chars (8 P0 Skills)`);
    expect(total).toBeLessThanOrEqual(CEILINGS.skills);
    const prompts = JSON.stringify((await client.listPrompts()).prompts).length;
    const resources = JSON.stringify((await client.listResources()).resources).length;
    const templates = JSON.stringify(
      (await client.listResourceTemplates()).resourceTemplates,
    ).length;
    console.log(
      `[size] prompts/list ${String(prompts)}, resources/list ${String(resources)}, templates ${String(templates)}`,
    );
    expect(prompts + resources + templates).toBeLessThanOrEqual(5_000);
  });
});

describe("result budgets (plan 01 §4.2; plan 07 C8)", () => {
  const listCalls: [string, Record<string, unknown>][] = [
    ["espn_get_league", {}],
    ["espn_get_standings", {}],
    ["espn_get_scoreboard", { week: 2 }],
    ["espn_get_live_scoreboard", { week: 3 }],
    ["espn_get_box_score", { week: 2 }],
    ["espn_get_roster", { week: 3 }],
    ["espn_list_players", {}],
    ["espn_list_players", { limit: 100 }],
    ["espn_get_schedule", { weeks: [4, 5, 6] }],
    ["espn_get_status", { include_checks: true }],
  ];
  const analyticsCalls: [string, Record<string, unknown>][] = [
    ["espn_project_players", { players: { team_id: 1 }, horizon: "week", week: 4 }],
    ["espn_project_players", { players: { team_id: 1 }, horizon: "ros", week: 4, detail: "full" }],
    ["espn_analyze_lineup", { week: 4 }],
    ["espn_analyze_waivers", { positions: ["K"] }],
    ["espn_analyze_retrospective", { week: 3 }],
  ];

  it("list and fact tools stay within 20 000 chars (truncating with a warning when they must)", async () => {
    for (const [name, args] of listCalls) {
      const r = await call(client, name, args);
      expect(r.isError, `${name} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(false);
      const chars = JSON.stringify(r.body).length;
      console.log(`[size] ${name} ${JSON.stringify(args)}: ${String(chars)} chars`);
      expect(chars).toBeLessThanOrEqual(RESULT_BUDGET_CHARS);
      if ((r.body as { truncated: boolean }).truncated)
        expect(
          (r.body as { warnings: string[] }).warnings.some((w) => w.includes("truncated")),
        ).toBe(true);
    }
  });

  it("analytics results stay within 10 000 chars by construction", async () => {
    for (const [name, args] of analyticsCalls) {
      const r = await call(client, name, args);
      expect(r.isError, `${name} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(false);
      const chars = JSON.stringify(r.body).length;
      console.log(`[size] ${name} ${JSON.stringify(args)}: ${String(chars)} chars`);
      expect(chars).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
    }
  });
});
