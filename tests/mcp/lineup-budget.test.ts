// lineup-budget.test.ts — espn_analyze_lineup stays inside plan 07 C8's 10 000-character analytics
// budget BY CONSTRUCTION when `exclude`, `force_start` or `compare` change lineup slots (plan 07 C8,
// §5.1; plan 01 §4.2: an over-budget result is a bug, never an INTERNAL the user sees). Stage C
// finding `lineup-exclude-over-budget-internal`: on the seeded fx-10h league (the owner's exact
// format: QB/2RB/2WR/TE/FLEX/DST/K + 5 BE + 2 IR, half-PPR) excluding three starters answered
// INTERNAL under core and excluding one did under full, because the untrimmable parts (both lineups
// with full Dists, the rec, data.inputs, meta) passed the cap. The steps now remove every repeat and
// then halve, each with one fixed warning; the domain test below holds the cap on a synthetic
// worst-case answer, the tool test on the real one (both toolsets, in process, the seeded cache
// `eff refresh all` leaves — tests/integration/helpers/seed.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { datasetDir, storePath } from "../../src/config/paths.js";
import { outputSchemaOf } from "../../src/mcp/define.js";
import {
  ANALYTICS_BUDGET_CHARS,
  buildEnvelope,
  fitToBudget,
  serializeEnvelope,
} from "../../src/mcp/envelope.js";
import { analyzeLineupTool, lineupTrims, movedPlayers } from "../../src/mcp/tools/analytics.js";
import { seedDatasets } from "../integration/helpers/seed.js";
import { envelopeViolations } from "./helpers/walk.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

type J = Record<string, unknown>;
const FX = path.join(ESPN_FIXTURES, "fx-10h");
const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};

// --- the cap on a synthetic worst-case answer (no I/O) ---------------------------------------------

const dist = (m: number): J => ({
  mean: m,
  p10: m - 7.123,
  p25: m - 3.456,
  p50: m,
  p75: m + 3.456,
  p90: m + 7.123,
  p_zero: 0.012,
  basis: "position_cv",
});
const STARTER_SLOTS = ["QB", "QB", "RB", "RB", "RB", "WR", "WR", "WR", "TE", "TE"]
  .concat(["FLEX", "FLEX", "FLEX", "OP", "D/ST", "K"])
  .map((s) => s);

/**
 * A 25-player roster (16 starter slots, 7 BE, 2 IR — larger than any recorded league) where EVERY
 * starter is excluded, so every starter slot changes hands: the most moved rows E2 can produce.
 */
function worstCase(): J {
  const ids = Array.from({ length: 25 }, (_, i) => 4_000_000 + i * 1_111);
  const row = (slot: string, id: number): J => ({
    slot,
    player_id: id,
    name: `Player Number ${String(id)}`,
    points: dist(10 + (id % 17)),
    lock_at: "2026-10-11T17:00:00.000Z",
    percent_started: 54.321,
  });
  const benchSlots = [...Array.from({ length: 7 }, () => "BE"), "IR", "IR"];
  const current = ids.map((id, i) => row(STARTER_SLOTS[i] ?? benchSlots[i - 16] ?? "BE", id));
  // the 7 bench players start, the 16 starters sit (9 slots stay empty — the rows still change)
  const recommended = ids.map((id, i) =>
    row(i >= 16 && i < 23 ? (STARTER_SLOTS[i - 16] ?? "BE") : i >= 23 ? "IR" : "BE", id),
  );
  const swaps = Array.from({ length: 16 }, (_, i) => ({
    out: ids[i] ?? 0,
    in: ids[16 + (i % 7)] ?? 0,
    slot: STARTER_SLOTS[i] ?? "FLEX",
    delta_e: -3.214,
    delta_pwin: { sign: "-", band: "large" },
    delta_pf: -3.214,
    interval: [-12.345, 6.789],
    coin_flip: false,
    option_value: null,
  }));
  return {
    objective_used: "mean",
    objective_reason:
      "auto: espn_rule with position_cv spreads — the mean, with PF awareness through the exchange rate",
    seeding_mode_used: "espn_rule",
    seeding: { mode_used: "espn_rule", confirmed: false },
    current_lineup: current,
    recommended_lineup: recommended,
    mode: "chase",
    mode_basis: {
      mu_m: 113.715,
      mu_o: 122.949,
      sigma_m: 22.986,
      sigma_o: 23.703,
      rho_lineup: 0.041,
      pf_exchange_rate: { pf_per_win: 240, source: "season_sim" },
      pf_context: { season_pf_rank: 5, pf_gap_to_cutoff: 79.66, tiebreak_in_play: false },
    },
    e_points_before: 113.707,
    e_points_after: 61.715,
    p_win_before: 0.389,
    p_win_after: 0.012,
    p_win_interval: [0.002, 0.04],
    conditionals: Array.from({ length: 6 }, (_, i) => ({
      if: {
        player_id: ids[16 + i] ?? 0,
        event: "inactive",
        decided_by: "2026-10-11T15:30:00.000Z",
      },
      then: { slot: "FLEX", in: ids[i] ?? 0 },
    })),
    stack_flags: Array.from({ length: 4 }, (_, i) => ({
      players: [ids[16 + i] ?? 0, ids[17 + i] ?? 0],
      effect: "ceiling+",
      advice_under_reading:
        "a same-team stack raises the ceiling: fine while chasing under espn_rule",
    })),
    espn_cross_check: {
      starter_disagreements: Array.from({ length: 7 }, (_, i) => ({
        player_id: ids[16 + i] ?? 0,
        ours: 9.876,
        espn: 12.345,
        pct: -0.2,
      })),
    },
    lock_schedule: Array.from({ length: 6 }, (_, i) => ({
      lock_at: `2026-10-1${String(1 + (i % 3))}T17:00:00.000Z`,
      player_ids: ids.slice(i * 4, i * 4 + 4),
    })),
    latest_execution_time: "2026-10-11T13:30:00.000Z",
    no_move: false,
    rec: {
      action: "make 16 lineup changes",
      subjects: [
        ...ids.slice(16, 23).map((id) => ({
          player_id: id,
          gsis_id: "00-0039424",
          role: "start",
          slot: "FLEX",
        })),
        ...ids.slice(0, 13).map((id) => ({
          player_id: id,
          gsis_id: "00-0037545",
          role: "sit",
          slot: "BE",
        })),
      ],
      lineup: ids
        .slice(16, 23)
        .map((id, i) => ({ slot: STARTER_SLOTS[i] ?? "FLEX", player_id: id })),
      point_estimate: 61.715,
      distribution: dist(61.715),
      delta_vs_next: { value: -51.992, p10: -70.123, p90: -33.456 },
      decision_metric: "expected_points",
      drivers: ids
        .slice(0, 16)
        .map((id) => ({ name: `swap:FLEX:${String(id)}`, contribution: -3.2 })),
      assumptions: [
        {
          text: "each player's spread is read from his p10–p90 (normal approximation); same-team correlations from research 05 §3.2",
          revisit_trigger: "basis player_sim carries per-player variance",
        },
        { text: "locked players are never moved", revisit_trigger: "never" },
        {
          text: "the opponent starts his highest-projected legal lineup",
          revisit_trigger: "the opponent's set lineup differs",
        },
      ],
      confidence: {
        role_games: 3,
        inputs: Array.from({ length: 12 }, (_, i) => ({
          source: `nflverse:source_${String(i)}`,
          as_of: "2026-10-06T04:35:03.000Z",
          age_s: 7,
          freshness: "fresh",
        })),
      },
      as_of: "2026-10-07T01:00:05.740Z",
      latest_execution_time: "2026-10-11T17:00:00.000Z",
      no_move: false,
      log_id: null,
    },
    inputs: Array.from({ length: 12 }, (_, i) => ({
      source: `nflverse:source_${String(i)}`,
      as_of: "2026-10-06T04:35:03.000Z",
      age_s: 7,
      freshness: "fresh",
    })),
    basis: "position_cv",
    p_win_reporting: "sign_and_band",
    swaps,
  };
}

describe("E2's budget steps cap a worst-case answer (plan 07 C8)", () => {
  it("every moved player is found from the untrimmed answer", () => {
    const d = worstCase();
    // 16 starters sit and 7 bench players start (the 2 IR rows stay)
    expect(movedPlayers(d).size).toBe(23);
  });

  it("the synthetic answer is schema-valid and far over the cap before trimming", () => {
    const d = worstCase();
    const env = buildEnvelope({
      data: d,
      requestId: "r-000000000001",
      nowMs: Date.parse("2026-10-07T01:00:10.000Z"),
      inputs: [],
      warnings: Array.from({ length: 5 }, (_, i) => `compare pair ${String(i)} not evaluated`),
    });
    expect(serializeEnvelope(env).length).toBeGreaterThan(1.5 * ANALYTICS_BUDGET_CHARS);
    expect(outputSchemaOf(analyzeLineupTool).safeParse(env).success).toBe(true);
  });

  it("fits 10 000 chars after the steps, every step said once, and still validates", () => {
    const d = worstCase();
    const env = buildEnvelope({
      data: d,
      requestId: "r-000000000001",
      nowMs: Date.parse("2026-10-07T01:00:10.000Z"),
      inputs: [],
      warnings: Array.from({ length: 5 }, (_, i) => `compare pair ${String(i)} not evaluated`),
    });
    const fit = fitToBudget(env, ANALYTICS_BUDGET_CHARS, "swaps", {
      pageable: false,
      hint: "narrow the request",
      trims: lineupTrims(d),
    });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    const text = serializeEnvelope(fit.envelope);
    expect(text.length).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
    expect(fit.envelope.truncated).toBe(true);
    expect(outputSchemaOf(analyzeLineupTool).safeParse(JSON.parse(text)).success).toBe(true);
    // a step is said once (a key's later step replaces its earlier note)
    const w = fit.envelope.warnings;
    expect(new Set(w).size).toBe(w.length);
    const data = fit.envelope.data;
    // rec.lineup is never cut: the whole recommended lineup is always named
    expect(((data.rec as J).lineup as unknown[]).length).toBe(7);
  });

  it("a no-move answer trims only repeats (nothing a decision needs is cut first)", () => {
    const d = worstCase();
    const same = {
      ...d,
      recommended_lineup: d.current_lineup,
      swaps: [],
      rec: { ...(d.rec as J), subjects: [], drivers: [] },
    };
    expect(movedPlayers(same).size).toBe(0);
    const trims = lineupTrims(same);
    // step 1 leaves current_lineup empty: every slot equals recommended_lineup
    const first = trims[0]?.(same);
    expect((first?.data as J).current_lineup).toEqual([]);
  });
});

// --- the real answer on the seeded owner-format league -----------------------------------------------

let world: World;
const clients: Partial<Record<"core" | "full", { client: Client; close: () => Promise<void> }>> =
  {};

beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: "full" },
    teamId: manifest.my_team_id,
    clock: manifest.clock,
    publishEspn: false,
  });
  await seedDatasets(world.store, {
    storePath: storePath(world.cache),
    datasetDir: datasetDir(world.cache),
    cache: world.cache,
    clock: world.clock,
    season: 2026,
  });
  world.store.reopenChangedDatasets();
  clients.core = await connect(world, { options: { toolset: "core" } });
  clients.full = await connect(world, { options: { toolset: "full" } });
}, 300_000);
afterAll(async () => {
  await clients.core?.close();
  await clients.full?.close();
  world.cleanup();
});

interface Lineup {
  starters: number[];
  bench: number[];
}

async function lineupOf(client: Client): Promise<Lineup> {
  const r = await call(client, "espn_analyze_lineup", { week: 5 });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const roster = await call(client, "espn_get_roster", { week: 5 });
  const players = (roster.body.data as { players: { player_id: number; slot_class: string }[] })
    .players;
  const rows = (r.body.data as { rec: { lineup: { player_id: number }[] } }).rec.lineup;
  return {
    starters: rows.map((x) => x.player_id),
    bench: players.filter((p) => p.slot_class === "bench").map((p) => p.player_id),
  };
}

async function expectFits(client: Client, args: J): Promise<J> {
  const before = world.logLines.length;
  const r = await call(client, "espn_analyze_lineup", args);
  const logs = world.logLines.slice(before).join("\n");
  expect(logs).not.toContain("tool.over_budget");
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const text = (r.raw as { content: { text: string }[] }).content[0]?.text ?? "";
  expect(text.length).toBeLessThanOrEqual(ANALYTICS_BUDGET_CHARS);
  expect(envelopeViolations(r.body as never)).toEqual([]);
  return r.body;
}

describe.each(["core", "full"] as const)(
  "E2 with exclude / force_start / compare on seeded fx-10h (%s)",
  (toolset) => {
    let lu: Lineup;
    beforeAll(async () => {
      const c = clients[toolset];
      if (c === undefined) throw new Error("no client");
      lu = await lineupOf(c.client);
      expect(lu.starters.length).toBe(9);
      expect(lu.bench.length).toBeGreaterThanOrEqual(3);
    }, 120_000);
    const client = (): Client => {
      const c = clients[toolset];
      if (c === undefined) throw new Error("no client");
      return c.client;
    };

    for (const n of [1, 2, 3, 4]) {
      it(`exclude ${String(n)} starter(s) → a coded success within the budget, trimmed and said`, async () => {
        const body = await expectFits(client(), { week: 5, exclude: lu.starters.slice(0, n) });
        const data = body.data as { recommended_lineup: { player_id: number }[]; rec: J };
        // no excluded player starts, and the whole recommended lineup is still named
        const starting = (data.rec.lineup as { player_id: number }[]).map((x) => x.player_id);
        for (const id of lu.starters.slice(0, n)) expect(starting).not.toContain(id);
        expect(starting.length).toBeGreaterThan(0);
        if (body.truncated === true)
          expect((body.warnings as string[]).some((w) => /omit|only|truncated/.test(w))).toBe(true);
      });
    }

    it("force_start 3 bench players → within the budget", async () => {
      await expectFits(client(), { week: 5, force_start: lu.bench.slice(0, 3) });
    });

    it("exclude 3 starters + force_start 3 bench players → within the budget", async () => {
      await expectFits(client(), {
        week: 5,
        exclude: lu.starters.slice(0, 3),
        force_start: lu.bench.slice(0, 3),
      });
    });

    it("objective mean + exclude 3 → within the budget", async () => {
      await expectFits(client(), { week: 5, objective: "mean", exclude: lu.starters.slice(0, 3) });
    });

    it("five off-roster compare pairs → within the budget, each pair warned", async () => {
      const off = Array.from({ length: 5 }, (_, i) => ({
        out: 90_000_001 + i,
        in: 90_000_101 + i,
      }));
      const body = await expectFits(client(), { week: 5, compare: off });
      expect((body.warnings as string[]).filter((w) => w.startsWith("compare pair ")).length).toBe(
        5,
      );
    });
  },
);
