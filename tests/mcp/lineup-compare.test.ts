// lineup-compare.test.ts — espn_analyze_lineup names every `compare` pair it cannot evaluate in the
// envelope's warnings[] (changelog R5; plan 07 E2 `compare`): a player not on the roster, a locked
// player (a locked player never moves — plan 10 A11a) or the same player out and in is warned with
// the player id, never dropped silently, and no swap is computed for it. The domain rule (every
// pair evaluated XOR warned) is a property in tests/domain/analytics/lineup.test.ts. Recorded
// league-a at the recording instant: week 4's games are final, so every rostered player is locked.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({});
  ({ client, close } = await connect(world));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

interface Env {
  data: { swaps: { out: number | null; in: number }[] };
  warnings: string[];
}
async function lineup(compare: { out: number; in: number }[]): Promise<Env> {
  const r = await call(client, "espn_analyze_lineup", { week: 4, compare });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return r.body as unknown as Env;
}

describe("E2 compare pairs it cannot evaluate are warned by player id (R5)", () => {
  let locked: number[] = [];
  let offRoster = 0;
  beforeAll(async () => {
    const r = await call(client, "espn_get_roster", { week: 4 });
    const players = (r.body.data as { players: { player_id: number; lineup_locked: boolean }[] })
      .players;
    locked = players.filter((p) => p.lineup_locked).map((p) => p.player_id);
    const ids = new Set(players.map((p) => p.player_id));
    offRoster = 1;
    while (ids.has(offRoster)) offRoster++;
  });

  it("locked players and an off-roster player are named; no swap is computed for them", async () => {
    expect(locked.length).toBeGreaterThanOrEqual(2);
    const [a = 0, b = 0] = locked;
    const e = await lineup([
      { out: a, in: b },
      { out: a, in: offRoster },
      { out: b, in: b },
    ]);
    const mine = e.warnings.filter((w) => w.startsWith("compare pair "));
    expect(mine).toEqual([
      `compare pair out ${String(a)} / in ${String(b)} not evaluated: player ${String(a)} is locked; player ${String(b)} is locked`,
      `compare pair out ${String(a)} / in ${String(offRoster)} not evaluated: player ${String(a)} is locked; player ${String(offRoster)} is not on the roster`,
      `compare pair out ${String(b)} / in ${String(b)} not evaluated: out and in are the same player ${String(b)}`,
    ]);
    for (const s of e.data.swaps) {
      expect([a, b]).not.toContain(s.out);
      expect(s.in).not.toBe(offRoster);
    }
    // ids only: no player name or other third-party text in these warnings
    for (const w of mine) expect(w).toMatch(/^[a-z0-9 /:;]+$/);
  });

  it("no compare argument → no compare warning", async () => {
    const r = await call(client, "espn_analyze_lineup", { week: 4 });
    expect(r.isError).toBe(false);
    const e = r.body as unknown as Env;
    expect(e.warnings.some((w) => w.startsWith("compare pair "))).toBe(false);
  });
});
