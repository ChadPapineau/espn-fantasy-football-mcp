// waivers-claim-timing-tool.test.ts — E5 places a WAIVERS claim's run against the week's games
// through the tool (Stage C finding waivers-lock-state-drop-candidates, the tool half; research 05
// §1.5: a claim executes at the next waiver run, after the scoring period rolls over; plan 07 E5).
// The engine has a scheduled path — this week's kickoffs and the run time decide which players a
// claim can still drop and whether it reaches this week — but espn_analyze_waivers handed it the pro
// schedule only in the K/D-ST slice, so every other call fell back to the call-time lock state: on a
// game day the locked players left the drop list (the one unlocked bench player became every
// candidate's forced drop) and on a quiet day the played week was credited to WAIVERS candidates.
// Here league-a at T0 (the Tuesday after week 4's games; ESPN states the next run on Thursday) is
// asked twice with the same league state, once with its roster locked as on a Sunday (every player
// but one bench player) and once unlocked: the claim timing comes from the schedule, so both
// answers are the same, and both say the run is after this week's last kickoff. No network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/providers/espn/index.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

interface RosterBody {
  teams?: {
    id?: number;
    roster?: {
      entries?: {
        playerId?: number;
        lineupSlotId?: number;
        playerPoolEntry?: { lineupLocked?: boolean; player?: { id?: number } };
        lineupLocked?: boolean;
      }[];
    };
  }[];
}

/** Rewrites every mRoster answer's lock flags: `locked(teamId, playerId, slotId)`. */
function withLocks(locked: (team: number, player: number, slot: number) => boolean) {
  return (inner: FetchLike): FetchLike =>
    async (url, init) => {
      const res = await inner(url, init);
      const views = new URL(url).searchParams.getAll("view");
      if (!views.includes("mRoster") || res.status !== 200) return res;
      const body = (await res.json()) as RosterBody;
      for (const t of body.teams ?? [])
        for (const e of t.roster?.entries ?? []) {
          const id = e.playerId ?? e.playerPoolEntry?.player?.id ?? 0;
          const flag = locked(t.id ?? 0, id, e.lineupSlotId ?? -1);
          if (e.playerPoolEntry !== undefined) e.playerPoolEntry.lineupLocked = flag;
          if (e.lineupLocked !== undefined) e.lineupLocked = flag;
        }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8" },
      });
    };
}

interface Candidate {
  readonly player_id: number;
  readonly status: string;
  readonly s: number;
  readonly verdict: string;
  readonly conditional_drop: { readonly player_id: number } | null;
}
interface Waivers {
  readonly candidates: readonly Candidate[];
  readonly W: number;
  readonly rec: { readonly assumptions: readonly { readonly text: string }[] };
}

const BENCH = 20;
let quiet: World | undefined;
let sunday: World | undefined;
let qc: { client: Client; close: () => Promise<void> } | undefined;
let sc: { client: Client; close: () => Promise<void> } | undefined;
/** The bench player left unlocked on "Sunday": team 1's best bench player by ESPN's ROS total. */
let keptOpen = 0;

beforeAll(async () => {
  const q = await makeWorld({ league: "league-a", wrapFetch: withLocks(() => false) });
  quiet = q;
  const ref = q.services.league;
  const mine = (await q.wiring.provider.getRosters(ref, 3)).value.find((r) => r.team.team_id === 1);
  const bench = (mine?.entries ?? [])
    .filter(
      (e) =>
        e.slot_id === BENCH &&
        e.player.droppable !== false &&
        e.player.ref.id > 0 &&
        ["QB", "RB", "WR", "TE"].includes(e.player.position),
    )
    .sort((a, b) => (b.player.projection_ros_espn ?? 0) - (a.player.projection_ros_espn ?? 0));
  keptOpen = bench[0]?.player.ref.id ?? 0;
  expect(keptOpen).toBeGreaterThan(0);
  const s = await makeWorld({
    league: "league-a",
    wrapFetch: withLocks((team, player) => !(team === 1 && player === keptOpen)),
  });
  sunday = s;
  qc = await connect(q);
  sc = await connect(s);
}, 120_000);
afterAll(async () => {
  await qc?.close();
  await sc?.close();
  quiet?.cleanup();
  sunday?.cleanup();
});

async function waivers(client: Client): Promise<Waivers> {
  const r = await call(client, "espn_analyze_waivers", {
    mode: "priority",
    phase: "auto",
    detail: "full",
  });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return r.body.data as Waivers;
}

describe("E5 reads the claim's run against the week's games (waivers-lock-state-drop-candidates)", () => {
  it("a game-day lock state and a quiet one give every WAIVERS claim the same s, verdict and drop", async () => {
    if (qc === undefined || sc === undefined) throw new Error("not connected");
    const a = await waivers(qc.client);
    const b = await waivers(sc.client);
    // a FREEAGENT add executes now, so its drop must be unlocked now — the lock state rightly binds
    // it; a WAIVERS claim executes at the run, after this week's games, when nobody is locked
    const claims = (d: Waivers) =>
      new Map(
        d.candidates
          .filter((c) => c.status === "WAIVERS")
          .map((c) => [
            c.player_id,
            { s: c.s, verdict: c.verdict, drop: c.conditional_drop?.player_id ?? null },
          ]),
      );
    const qa = claims(a);
    const qb = claims(b);
    const both = [...qa.keys()].filter((id) => qb.has(id));
    expect(both.length).toBeGreaterThanOrEqual(2);
    for (const id of both) expect(qb.get(id), String(id)).toEqual(qa.get(id));
    expect(b.W).toBe(a.W);
    // the one bench player open on "Sunday" is not every claim's forced drop
    expect(both.every((id) => qb.get(id)?.drop === keptOpen)).toBe(false);
  });

  it("the run is placed by the pro schedule: after this week's last kickoff, never 'no pro schedule'", async () => {
    if (qc === undefined || sc === undefined) throw new Error("not connected");
    for (const d of [await waivers(qc.client), await waivers(sc.client)]) {
      const texts = d.rec.assumptions.map((x) => x.text);
      expect(texts.some((t) => t.includes("no pro schedule"))).toBe(false);
      expect(
        texts.some((t) => t.startsWith("the next waiver run is after this week's last kickoff")),
      ).toBe(true);
    }
  });
});
