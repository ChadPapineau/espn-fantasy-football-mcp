// waivers-history-tool.test.ts — changelog R6-3 through the real composition root (fixture mode,
// keyless, no network): `espn_analyze_waivers` reads the league's previous-season transactions from
// the store (`transactions_seen` — where a backfill of mTransactions2 lands; no request is spent in
// the call) and answers `premium_basis: "league_fitted"` on its first call after they exist, with the
// seasons and n in its own assumptions and p_clears_to_fa on the league's curve; with no history it
// serves the cold start and says so with the measured miss. The previous seasons are league-b's
// recorded 2024 and 2025 seasons read through the provider in fixture mode, their roster changes
// written as transactions (tests/domain/analytics/waiver-fit/helpers/history-moves.ts), placed under
// the derived league fx-10h (season 2026, ten teams) — a wiring test: the numbers are evaluated in
// tests/backtest/waivers-history.test.ts. Both toolsets (P0 and the P1 layer).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLD_START_REVISIT, coldStartNote } from "../../src/domain/analytics/waiver-fit/index.js";
import type { Transaction } from "../../src/domain/league/types.js";
import { call, connect, ESPN_FIXTURES, makeWorld, type World } from "../mcp/helpers/world.js";
import {
  movesFromRosters,
  readPreviousSeason,
} from "../domain/analytics/waiver-fit/helpers/history-moves.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");
const MANIFEST = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
  season: number;
};

interface WaiversOut {
  premium_basis: string;
  premium: number;
  candidates: { status: string; p_clears_to_fa: { basis: string } | null }[];
  rec: { assumptions: { text: string; revisit_trigger: string }[] };
}

let history: Transaction[] = [];
beforeAll(async () => {
  for (const season of [2024, 2025])
    history = [...history, ...movesFromRosters(await readPreviousSeason("league-b", season))];
}, 120_000);

async function open(
  toolset: "core" | "full",
): Promise<{ world: World; client: Client; close: () => Promise<void> }> {
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: FX, EFF_TOOLSET: toolset },
    teamId: MANIFEST.my_team_id,
    clock: MANIFEST.clock,
    publishEspn: false,
  });
  const { client, close } = await connect(world);
  return { world, client, close };
}

async function waivers(client: Client): Promise<{ data: WaiversOut; warnings: string[] }> {
  // the Skills' call order: the facts first, so the analytics answer inside their request budget
  for (const [name, args] of [
    ["espn_get_standings", {}],
    ["espn_get_roster", { week: 5 }],
    ["espn_list_players", { status: "WAIVERS", sort: "percOwned", week: 5, limit: 25 }],
  ] as const) {
    const r = await call(client, name, args);
    expect(r.isError, name).toBe(false);
  }
  const r = await call(client, "espn_analyze_waivers", { mode: "priority", detail: "full" });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return {
    data: r.body.data as WaiversOut,
    warnings: (r.body.warnings as string[] | undefined) ?? [],
  };
}

const statements = (d: WaiversOut): string[] =>
  d.rec.assumptions.filter((a) => a.revisit_trigger === COLD_START_REVISIT).map((a) => a.text);

describe("R6-3 through the composition root (fx-10h, core)", () => {
  let w: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    w = await open("core");
  }, 120_000);
  afterAll(async () => {
    await w.close();
    w.world.cleanup();
  });

  it("no history stored: the cold start, said with its measured miss", async () => {
    expect(MANIFEST.season).toBe(2026);
    const { data } = await waivers(w.client);
    expect(data.premium_basis).toBe("cold_start_table");
    expect(statements(data)).toEqual([coldStartNote(true, true)]);
    for (const c of data.candidates)
      if (c.p_clears_to_fa !== null) expect(c.p_clears_to_fa.basis).toBe("cold_start");
  });

  it("the previous seasons stored: league_fitted on the next call, seasons and n in the answer", async () => {
    const added = w.world.store.repos.transactionsSeen.appendNew(history, w.world.clock.nowIso());
    expect(added).toBe(history.length);
    const { data, warnings } = await waivers(w.client);
    expect(data.premium_basis).toBe("league_fitted");
    const summary = data.rec.assumptions.find((a) =>
      a.text.startsWith("premium re-solved from seasons"),
    );
    expect(summary?.text).toContain("seasons 2025, 2024");
    expect(summary?.text).toMatch(/on \d{2,} drops/);
    expect(summary?.text).toContain("value-free");
    // only the slope is still the cold start's in this feed (R6-3): said, with its miss
    expect(statements(data)).toEqual([coldStartNote(false, false, true)]);
    expect(
      warnings.some((x) => x.startsWith("premium and demand stay on the cold-start tables")),
    ).toBe(false);
    const onWaivers = data.candidates.filter((c) => c.status === "WAIVERS");
    expect(onWaivers.length).toBeGreaterThan(0);
    for (const c of onWaivers) expect(c.p_clears_to_fa?.basis).toBe("league_fitted");
  });
});

describe("R6-3 through the composition root (fx-10h, full)", () => {
  let w: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    w = await open("full");
    w.world.store.repos.transactionsSeen.appendNew(history, w.world.clock.nowIso());
  }, 120_000);
  afterAll(async () => {
    await w.close();
    w.world.cleanup();
  });

  it("league_fitted from the very first call under the P1 layer too", async () => {
    const { data } = await waivers(w.client);
    expect(data.premium_basis).toBe("league_fitted");
    expect(data.rec.assumptions.some((a) => a.text.includes("seasons 2025, 2024"))).toBe(true);
    expect(data.rec.assumptions.length).toBeLessThanOrEqual(20);
    const notes = statements(data);
    expect(notes.length).toBeLessThanOrEqual(1);
    expect(notes.every((t) => !t.startsWith("cold-start premium"))).toBe(true);
  });
});
