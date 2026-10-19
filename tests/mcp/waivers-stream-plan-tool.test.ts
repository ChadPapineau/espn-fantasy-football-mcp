// waivers-stream-plan-tool.test.ts — two Stage C round 2 findings in espn_analyze_waivers through the
// real composition root in fixture mode on the derived league fx-10h (plan 07 E5; the stream-kdef
// Skill's step 4: `positions` one streaming slot, `look_ahead: 2`):
// * waivers-kdst-no-line-flattens — with no nflverse games file published there is no betting line,
//   and the K/D-ST slice valued every kicker at the league-average implied total: one stream value
//   for all, ESPN's per-player projections lost, ties broken by player id. Each kicker's week value
//   is ESPN's projection again (the one espn_list_players shows), and the result says why.
// * waivers-postrun-adds-unbounded-same-drop — after the waiver run (the `post-run` variant: the pool
//   is FREEAGENT) every kicker worth adding was listed with the same drop: more than ten overflowed
//   the Rec's 20 subjects and the tool answered INTERNAL; below that "add N free agents now" repeated
//   one drop N times. The Rec now carries one kicker, dropping mine, and every drop once.
// No network, no cookie.
import path from "node:path";
import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, connect, ESPN_FIXTURES, makeWorld, type World } from "./helpers/world.js";

type J = Record<string, unknown>;
const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };

interface Candidate {
  readonly player_id: number;
  readonly position: string;
  readonly verdict: string;
  readonly signals: readonly { readonly kind: string; readonly value: number }[];
  readonly conditional_drop: { readonly player_id: number } | null;
}
interface Subject {
  readonly player_id: number;
  readonly role: string;
}
interface Waivers {
  readonly candidates: readonly Candidate[];
  readonly rec: {
    readonly action: string;
    readonly subjects: readonly Subject[];
    readonly assumptions: readonly { readonly text: string }[];
  };
}

async function openWorld(
  dir: string,
): Promise<{ world: World; client: Client; close: () => Promise<void> }> {
  const m = manifestOf(dir);
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: false,
  });
  expect(world.options.fixtureMode).toBe(true);
  const c = await connect(world);
  return { world, ...c };
}

async function ok(client: Client, name: string, args: J): Promise<J> {
  const r = await call(client, name, args);
  expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
  return r.body;
}

describe("fx-10h (Tuesday of week 5, no betting line): each kicker keeps ESPN's projection", () => {
  let w: Awaited<ReturnType<typeof openWorld>>;
  beforeAll(async () => {
    w = await openWorld(FX);
  }, 120_000);
  afterAll(async () => {
    await w.close();
    w.world.cleanup();
  });

  it("the stream values are ESPN's week projections, not one league-average number", async () => {
    const list = await ok(w.client, "espn_list_players", { position: "K", week: 5, limit: 50 });
    const espn = new Map<number, number | null>();
    for (const p of ((list.data as J).players ?? []) as {
      player_id: number;
      projection_week_espn: number | null;
    }[])
      espn.set(p.player_id, p.projection_week_espn);
    const body = await ok(w.client, "espn_analyze_waivers", {
      mode: "priority",
      positions: ["K"],
      detail: "full",
    });
    const d = body.data as Waivers;
    const streams = d.candidates.map((c) => ({
      id: c.player_id,
      v: c.signals.find((s) => s.kind === "stream")?.value ?? null,
    }));
    // regression: every kicker streamed at one value (the league-average total's)
    expect(new Set(streams.map((s) => s.v)).size).toBeGreaterThan(1);
    let matched = 0;
    for (const s of streams) {
      const e = espn.get(s.id);
      if (e === undefined || e === null) continue;
      expect(s.v, String(s.id)).toBeCloseTo(e, 2);
      matched += 1;
    }
    expect(matched).toBeGreaterThanOrEqual(3);
    // and the result says the bracket model could not run
    expect(
      d.rec.assumptions.some(
        (a) => a.text.startsWith("K and D/ST:") && a.text.includes("ESPN's projection where not"),
      ),
    ).toBe(true);
  }, 120_000);
});

describe("fx-10h post-run (Wednesday 06:00 ET, the scramble): a plan that can be carried out", () => {
  const DIR = path.join(FX, "post-run");
  let w: Awaited<ReturnType<typeof openWorld>>;
  let myK: number[] = [];
  beforeAll(async () => {
    w = await openWorld(DIR);
    const roster = await ok(w.client, "espn_get_roster", {});
    myK = ((roster.data as J).players as { player_id: number; position: string }[])
      .filter((p) => p.position === "K")
      .map((p) => p.player_id);
  }, 120_000);
  afterAll(async () => {
    await w.close();
    w.world.cleanup();
  });

  it("the stream-kdef kicker call answers (twice): one kicker added, mine dropped, never past 20 subjects", async () => {
    expect(myK).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      // regression: the second call answered INTERNAL (tool.output_invalid data.rec.subjects too_big)
      const body = await ok(w.client, "espn_analyze_waivers", { positions: ["K"], look_ahead: 2 });
      const d = body.data as Waivers;
      const adds = d.candidates.filter((c) => c.verdict === "fa_add_now");
      expect(adds.length).toBeGreaterThan(1);
      expect(d.rec.subjects.length).toBeLessThanOrEqual(20);
      const moves = d.rec.subjects.filter((s) => s.role === "add" || s.role === "claim");
      expect(moves).toHaveLength(1);
      expect(d.rec.subjects.filter((s) => s.role === "drop").map((s) => s.player_id)).toEqual(myK);
      expect(d.rec.action).toMatch(
        /^add 1 free agent now; \d+ more free agents? after these moves/,
      );
    }
  }, 240_000);

  it("the RB/WR scramble: every add on its own drop, each drop once", async () => {
    const body = await ok(w.client, "espn_analyze_waivers", {
      mode: "auto",
      phase: "auto",
      positions: ["RB", "WR"],
      detail: "full",
    });
    const d = body.data as Waivers;
    const drops = d.rec.subjects.filter((s) => s.role === "drop").map((s) => s.player_id);
    const adds = d.rec.subjects.filter((s) => s.role === "add").map((s) => s.player_id);
    expect(d.rec.subjects.length).toBeLessThanOrEqual(20);
    expect(new Set(drops).size).toBe(drops.length);
    expect(new Set(adds).size).toBe(adds.length);
    expect(adds.length).toBeGreaterThan(0);
    expect(drops.length).toBeLessThanOrEqual(adds.length);
  }, 240_000);
});
