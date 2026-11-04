// questionable-late.test.ts — the round-3b Skills verifier's V-6 on the committed variant (plan 07 E2;
// the reading at source is tests/domain/analytics/lineup-late-questionable.test.ts): on fx-10h's
// questionable-late a Team 02 starter in the week's latest game (Monday night) is QUESTIONABLE, and
// the only chain that could replace him (the FLEX RB into his seat, a bench WR into FLEX) locks on
// Sunday. When his status is decided (90 min before his kickoff) nothing that could take his seat
// is still open, so espn_analyze_lineup answers no conditional for him — the specified answer — and
// a swap involving him (a compare pair) carries the Monday option worth 0, while the default swap
// (two Sunday receivers, neither questionable) carries no option (null). Fixture mode, the schedule
// dataset seeded, committed files only, no network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const DIR = path.join(ESPN_FIXTURES, "fx-10h", "questionable-late");
const m = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as {
  clock: string;
  my_team_id: number;
};

interface Row {
  player_id: number;
  position: string;
  slot: string;
  slot_class: string;
  kickoff: string | null;
  injury_status: string | null;
  eligible_slots: string[];
}
interface Swap {
  out: number | null;
  in: number;
  option_value: { kind: string; value: number; verdict: string } | null;
}
interface LineupData {
  swaps: Swap[];
  conditionals: { if: { player_id: number } }[];
}

let world: World;
let client: Client;
let close: () => Promise<void>;
beforeAll(async () => {
  world = await makeWorld({
    env: { EFF_FIXTURE_DIR: DIR, EFF_TOOLSET: "full" },
    teamId: m.my_team_id,
    clock: m.clock,
  });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
}, 120_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

async function rows(): Promise<Row[]> {
  const r = await call(client, "espn_get_roster", { week: 5 });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return (r.body.data as { players: Row[] }).players;
}

const starter = (r: Row): boolean => r.slot_class === "starter" || r.slot_class === "flex";
const dayOf = (iso: string): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(
    new Date(iso),
  );

describe("V-6 on questionable-late: the Monday-night QUESTIONABLE starter", () => {
  it("is the variant's case: Monday night, and every other RB-eligible player plays Sunday", async () => {
    const all = await rows();
    const q = all.filter((r) => starter(r) && r.injury_status === "QUESTIONABLE");
    expect(q).toHaveLength(1);
    expect(dayOf(q[0]!.kickoff!)).toBe("Monday");
    for (const r of all.filter((x) => x.player_id !== q[0]!.player_id && x.position === "RB"))
      expect(r.kickoff === null ? "bye" : dayOf(r.kickoff), String(r.player_id)).not.toBe("Monday");
  });

  it("no conditional for him; a swap involving him carries the Monday option worth 0; the default swap none", async () => {
    const all = await rows();
    const q = all.find((r) => starter(r) && r.injury_status === "QUESTIONABLE")!;
    const plain = await call(client, "espn_analyze_lineup", { week: 5 });
    expect(plain.isError, JSON.stringify(plain.body).slice(0, 300)).toBe(false);
    const d = plain.body.data as LineupData;
    expect(d.conditionals.filter((c) => c.if.player_id === q.player_id)).toEqual([]);
    for (const s of d.swaps.filter((x) => x.out !== q.player_id && x.in !== q.player_id))
      expect(s.option_value).toBeNull();
    // the FLEX RB (Sunday's first game) for his seat: the option exists and is worth nothing
    const flexRb = all.find((r) => r.slot === "FLEX" && r.position === "RB")!;
    const cmp = await call(client, "espn_analyze_lineup", {
      week: 5,
      compare: [{ out: q.player_id, in: flexRb.player_id }],
    });
    expect(cmp.isError, JSON.stringify(cmp.body).slice(0, 300)).toBe(false);
    const swap = (cmp.body.data as LineupData).swaps.find(
      (s) => s.out === q.player_id && s.in === flexRb.player_id,
    );
    expect(swap?.option_value).toMatchObject({ kind: "monday", value: 0 });
  });
});
