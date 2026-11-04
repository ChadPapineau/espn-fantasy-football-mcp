// live-counts.test.ts — plan 07 A4 `matchups[].home/away.players { final, live, pending }`: each
// side's starters (every filled slot but the bench and IR, FLEX included) counted by their game's
// state at the call's clock — final; in progress (live); not started or not yet scheduled
// (pending) — from the same pro schedule the game window reads (league.ts starterGameCounts).
// Before, normalizeLiveMatchups left the field to the tool and the A4 handler never filled it, so
// it was always null. A starter on bye counts as final (no game: his points are settled at 0, the
// live matchup engine's reading); an empty slot holds no player and is not counted. Held here on
// fx-10h's base (before the week's first kickoff), sunday-live (a Sunday afternoon: games final, in
// progress and not started — with the schedule dataset seeded and without it) and all-locked (every
// game kicked off): every side's counts equal its starters' espn_get_roster `game_state` split. A
// roster read that fails leaves the counts null, said. Fixture mode, committed files, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, describe, expect, it } from "vitest";
import { coded, faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const FX = path.join(ESPN_FIXTURES, "fx-10h");

interface Counts {
  final: number;
  live: number;
  pending: number;
}
interface Side {
  team_id: number;
  players: Counts | null;
}
interface LiveData {
  week: number;
  game_window: { open: boolean; games_in_progress: number[] };
  matchups: { home: Side; away: Side | null }[];
}
interface RosterRow {
  slot_class: string;
  game_state: string;
}

const open: { world: World; close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const o of open) {
    await o.close();
    o.world.cleanup();
  }
});

async function server(
  variant: string,
  seeded: boolean,
  wrap?: (w: World) => Partial<World["services"]>,
) {
  const dir = variant === "" ? FX : path.join(FX, variant);
  const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
  };
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
    publishEspn: seeded,
  });
  const c = await connect(world, {
    options: { toolset: "full" },
    ...(wrap === undefined ? {} : { services: wrap(world) }),
  });
  open.push({ world, close: c.close });
  return { client: c.client, world };
}

/** espn_get_roster's game_state split of one team's starters, as A4 counts it. */
async function rosterSplit(c: Client, teamId: number, week: number): Promise<Counts> {
  const r = await call(c, "espn_get_roster", { team_id: teamId, week });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const rows = (r.body.data as { players: RosterRow[] }).players.filter(
    (p) => p.slot_class === "starter" || p.slot_class === "flex",
  );
  const out: Counts = { final: 0, live: 0, pending: 0 };
  for (const p of rows) {
    if (p.game_state === "in") out.live++;
    else if (p.game_state === "pre" || p.game_state === "tbd") out.pending++;
    else {
      // final, or a bye (no game: settled at 0)
      expect(["final", "bye"]).toContain(p.game_state);
      out.final++;
    }
  }
  return out;
}

async function liveOf(
  c: Client,
): Promise<{ data: LiveData; warnings: string[]; partial: boolean }> {
  const r = await call(c, "espn_get_live_scoreboard", {});
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return r.body as unknown as { data: LiveData; warnings: string[]; partial: boolean };
}

/** Every side of every matchup, its counts and its roster's split. */
async function sides(c: Client) {
  const live = await liveOf(c);
  const out: { team: number; counts: Counts | null; roster: Counts }[] = [];
  for (const m of live.data.matchups)
    for (const s of [m.home, m.away])
      if (s !== null)
        out.push({
          team: s.team_id,
          counts: s.players,
          roster: await rosterSplit(c, s.team_id, live.data.week),
        });
  return { live, sides: out };
}

const total = (x: Counts): number => x.final + x.live + x.pending;

/**
 * The first call of a server with no schedule dataset: the settings, the live view and the keyless
 * schedule spend the call's three requests, so the rosters the counts need are not requested — the
 * counts are null and the answer is partial, said with the budget line (plan 01 §5.6); the next call
 * reads them (the others are cached). A server whose `eff refresh` stored the schedule reads the
 * counts on its first call.
 */
async function coldCall(c: Client): Promise<void> {
  const first = await liveOf(c);
  expect(first.partial).toBe(true);
  expect(first.warnings).toContain(
    "partial: espn:mRoster was not requested (the 3-request budget of this call was used); ask a narrower question for it",
  );
  for (const m of first.data.matchups) expect(m.home.players).toBeNull();
}

describe("A4 players { final, live, pending } (plan 07 A4)", () => {
  it("base (before the week's first kickoff): every side counted, the starters not yet played pending", async () => {
    const { client } = await server("", true);
    const { live, sides: all } = await sides(client);
    expect(live.data.game_window.open).toBe(false);
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const s of all) {
      expect(s.counts, `team ${String(s.team)}`).toEqual(s.roster);
      expect(s.counts?.live).toBe(0);
      // nine filled starting slots in the owner's format (QB/2RB/2WR/TE/FLEX/DST/K)
      expect(total(s.counts!)).toBeLessThanOrEqual(9);
      expect(s.counts!.pending).toBeGreaterThan(0);
    }
  }, 120_000);

  it.each([true, false])(
    "sunday-live (schedule dataset seeded: %s): final, live and pending, each side equal to its roster's game states",
    async (seeded) => {
      const { client } = await server("sunday-live", seeded);
      if (!seeded) await coldCall(client);
      const { live, sides: all } = await sides(client);
      expect(live.data.game_window.open).toBe(true);
      for (const s of all) expect(s.counts, `team ${String(s.team)}`).toEqual(s.roster);
      const sum = (k: keyof Counts) => all.reduce((a, s) => a + (s.counts?.[k] ?? 0), 0);
      // a Sunday afternoon: games over (the London game), under way (13:00 ET) and to come
      expect(sum("final")).toBeGreaterThan(0);
      expect(sum("live")).toBeGreaterThan(0);
      expect(sum("pending")).toBeGreaterThan(0);
    },
    120_000,
  );

  it("sunday-live: the seeded and the unseeded server count the same", async () => {
    const a = (await sides((await server("sunday-live", true)).client)).sides;
    const unseeded = (await server("sunday-live", false)).client;
    await coldCall(unseeded);
    const b = (await sides(unseeded)).sides;
    expect(a.map((s) => [s.team, s.counts])).toEqual(b.map((s) => [s.team, s.counts]));
  }, 120_000);

  it("all-locked (every game kicked off): nothing pending, each side equal to its roster", async () => {
    const { client } = await server("all-locked", true);
    const { sides: all } = await sides(client);
    for (const s of all) {
      expect(s.counts, `team ${String(s.team)}`).toEqual(s.roster);
      expect(s.counts?.pending).toBe(0);
    }
  }, 120_000);

  it("a roster read that fails leaves the counts null, said; the live numbers still answer", async () => {
    const { client } = await server("sunday-live", true, (w) =>
      faulty(w.services, { getRosters: coded("ESPN_DRIFT_DETECTED", { view: "mRoster" }) }),
    );
    const live = await liveOf(client);
    expect(live.warnings).toContain(
      "espn:mRoster unavailable: players { final, live, pending } is null",
    );
    for (const m of live.data.matchups) expect(m.home.players).toBeNull();
  }, 120_000);
});
