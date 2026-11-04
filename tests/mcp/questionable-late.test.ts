// questionable-late.test.ts — the round-3b Skills verifier's V-6 on the committed variant (plan 07 E2;
// the reading at source is tests/domain/analytics/lineup-late-questionable.test.ts): on fx-10h's
// questionable-late a Team 02 starter in the week's latest game (Monday night) is QUESTIONABLE, and
// the only chain that could replace him (the FLEX RB into his seat, a bench WR into FLEX) locks on
// Sunday. When his status is decided (90 min before his kickoff) nothing that could take his seat
// is still open, so espn_analyze_lineup answers no conditional for him — the specified answer — and
// a swap involving him (a compare pair) carries the Monday option worth 0 — its verdict says the
// swap loses points and nothing opens after his status is known (the round-4 F7 / R4VS-5) — while
// the default swap (two Sunday receivers, neither questionable) carries no option (null). The pair is
// a direct settable swap, a bench RB for his seat (changelog §R10, R10-24): the FLEX RB (already
// starting) and a bench WR (cannot play RB), the pairs round 4's SS-3 read a number from, are
// warned and never scored. Fixture mode, the schedule dataset seeded, committed files only, no
// network.
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
  lineup_locked: boolean;
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
    // a direct settable swap for his seat (changelog §R10, R10-24): a bench player eligible for
    // RB, whose game is Sunday — the option exists and is worth nothing, and its verdict says so
    const benchRb = all.find(
      (r) =>
        r.slot === "BE" &&
        r.eligible_slots.includes(q.slot) &&
        r.kickoff !== null &&
        !r.lineup_locked,
    );
    expect(
      benchRb,
      JSON.stringify(all.map((r) => [r.player_id, r.slot, r.position])),
    ).toBeDefined();
    const cmp = await call(client, "espn_analyze_lineup", {
      week: 5,
      compare: [{ out: q.player_id, in: benchRb!.player_id }],
    });
    expect(cmp.isError, JSON.stringify(cmp.body).slice(0, 300)).toBe(false);
    const swap = (cmp.body.data as LineupData).swaps.find(
      (s) => s.out === q.player_id && s.in === benchRb!.player_id,
    );
    expect(swap?.option_value).toMatchObject({ kind: "monday", value: 0 });
    // the round-4 F7 / R4VS-5: never "the gain does not cover the option value" with an option
    // worth 0 — the swap loses points, and nothing opens after his Monday status is known
    expect(swap?.option_value?.verdict).toBe(
      "hold: the swap loses expected points; waiting has no option value (nothing opens after his status is known)",
    );
    expect((cmp.body.warnings as string[]).filter((w) => w.startsWith("compare pair "))).toEqual(
      [],
    );
  });

  it("R10-24: the pairs SS-3 read are warned and never scored — the FLEX RB (already starts), a bench WR (cannot play RB)", async () => {
    const all = await rows();
    const q = all.find((r) => starter(r) && r.injury_status === "QUESTIONABLE")!;
    const flexRb = all.find((r) => r.slot === "FLEX" && r.position === "RB")!;
    const benchWr = all.find((r) => r.slot === "BE" && r.position === "WR")!;
    const ir = all.find((r) => r.slot === "IR");
    const benchAny = all.find((r) => r.slot === "BE")!;
    const cells: { out: number; in: number; reason: string }[] = [
      {
        out: q.player_id,
        in: flexRb.player_id,
        reason: `player ${String(flexRb.player_id)} already starts`,
      },
      {
        out: q.player_id,
        in: benchWr.player_id,
        reason: `player ${String(benchWr.player_id)} cannot play ${q.slot}`,
      },
      {
        out: benchAny.player_id,
        in: benchWr.player_id,
        reason: `player ${String(benchAny.player_id)} is not starting`,
      },
      ...(ir === undefined
        ? []
        : [
            {
              out: q.player_id,
              in: ir.player_id,
              reason: `player ${String(ir.player_id)} is on IR (the lineup never starts a player from IR)`,
            },
          ]),
    ].filter((c) => c.out !== c.in);
    const plain = await call(client, "espn_analyze_lineup", { week: 5 });
    const flow = (plain.body.data as LineupData).swaps;
    const r = await call(client, "espn_analyze_lineup", {
      week: 5,
      compare: cells.map(({ out, in: inn }) => ({ out, in: inn })),
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    const warned = (r.body.warnings as string[]).filter((w) => w.startsWith("compare pair "));
    expect(warned).toEqual(
      cells.map(
        (c) => `compare pair out ${String(c.out)} / in ${String(c.in)} not evaluated: ${c.reason}`,
      ),
    );
    // none is scored: a row for the pair exists only when it is the optimizer's own flow pair
    for (const c of cells) {
      const scored = (r.body.data as LineupData).swaps.some(
        (s) => s.out === c.out && s.in === c.in,
      );
      const own = flow.some((s) => s.out === c.out && s.in === c.in);
      expect(scored, `${String(c.out)}→${String(c.in)}`).toBe(own);
    }
  });
});
