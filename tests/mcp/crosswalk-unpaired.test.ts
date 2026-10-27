// crosswalk-unpaired.test.ts — a player with no crosswalk pair (a rookie or call-up nflverse does
// not list yet, a name it spells otherwise: the case the crosswalk alert treats as a data-quality
// event) has no nflverse row to join, and every tool that joins one says so, as D1 does in
// data_gaps ("no crosswalk pair: no nflverse usage"). Stage C finding crosswalk-unpaired-joins-silent:
// espn_analyze_evidence skipped the official report and the RSS news behind `gsis !== null` and
// answered as if both were checked; espn_get_injuries returned `official: null`, indistinguishable
// from "not on the report", with no warning; D6's part is held in news-filters.test.ts. League-a
// under EFF_TOOLSET=full with the nflverse excerpts published through the real runner — whose
// excerpt leaves most of the universe unpaired; fixture mode, no network.
// Attempt 2 (the verifier): E10 still named "the next official injury report" in what_would_confirm
// for an unpaired subject — a report it reads by gsis id and so can never join for him; an entry
// naming the official report or game status is now replaced by ESPN's status and the missing pair.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unpairedReportWarning } from "../../src/mcp/tools/datasets.js";
import {
  NO_PAIR_CONFIRM_ESPN,
  NO_PAIR_CONFIRM_PAIR,
  NO_PAIR_EVIDENCE_WARNING,
  confirmWithoutPair,
} from "../../src/mcp/tools/market-p1.js";
import { envelopeViolations } from "./helpers/walk.js";
import { call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;
let roster: {
  player_id: number;
  position: string;
  gsis_id: string | null;
  crosswalk: { method: string };
}[];

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true, env: { EFF_TOOLSET: "full" } });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
  await call(client, "espn_get_league");
  const r = await call(client, "espn_get_roster", { week: 4 });
  roster = (r.body.data as { players: typeof roster }).players;
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

/** My players the crosswalk has no pair for (a team unit — D/ST, TQB — is paired by its id). */
const unpaired = () => roster.filter((p) => p.crosswalk.method === "none").map((p) => p.player_id);
const paired = () =>
  roster.filter((p) => p.gsis_id !== null && p.player_id > 0).map((p) => p.player_id);
/** A rostered TE of league-a's pool with no pair (the finder's subject). */
const UNPAIRED_TE = 4361050;

describe("the nflverse joins of an unpaired player are said, never silent (Stage C crosswalk-unpaired-joins-silent)", () => {
  it("the fixture holds both kinds on my roster (the test's precondition)", () => {
    expect(unpaired().length).toBeGreaterThan(0);
    expect(paired().length).toBeGreaterThan(0);
  });

  it("espn_get_injuries: official null for an unpaired player is named as not read", async () => {
    const r = await call(client, "espn_get_injuries", { week: 4 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect(envelopeViolations(r.body as never)).toEqual([]);
    const rows = (
      r.body.data as { players: { player_id: number; gsis_id: string | null; official: unknown }[] }
    ).players;
    const ids = rows
      .filter((x) => unpaired().includes(x.player_id))
      .map((x) => x.player_id)
      .sort((a, b) => a - b);
    expect(ids.length).toBeGreaterThan(0);
    for (const x of rows.filter((y) => ids.includes(y.player_id))) expect(x.official).toBeNull();
    expect(r.body.warnings).toContain(unpairedReportWarning(ids));
  });

  it("espn_get_injuries: a D/ST (a team unit, never on the report) is no gap", async () => {
    const dst = roster.find((p) => p.position === "D/ST");
    if (dst === undefined) return;
    const r = await call(client, "espn_get_injuries", {
      week: 4,
      players: { player_ids: [dst.player_id] },
    });
    expect(r.isError).toBe(false);
    expect((r.body.warnings as string[]).some((w) => w.startsWith("no crosswalk pair"))).toBe(
      false,
    );
  });

  it("espn_analyze_evidence on an unpaired player says the report and usage were not read", async () => {
    const pair = world.services.crosswalk.get(UNPAIRED_TE);
    expect(pair?.espn_id === UNPAIRED_TE ? pair.gsis_id : null).toBeNull();
    const r = await call(client, "espn_analyze_evidence", {
      player: { player_ids: [UNPAIRED_TE] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect(envelopeViolations(r.body as never)).toEqual([]);
    expect(r.body.warnings).toContain(NO_PAIR_EVIDENCE_WARNING);
  });

  it("espn_analyze_evidence never names a confirmation through the official report it cannot join", async () => {
    const r = await call(client, "espn_analyze_evidence", {
      player: { player_ids: [UNPAIRED_TE] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    const confirm = (r.body.data as { what_would_confirm: string[] }).what_would_confirm;
    expect(confirm.length).toBeGreaterThan(0);
    const ours = [NO_PAIR_CONFIRM_ESPN, NO_PAIR_CONFIRM_PAIR];
    expect(confirm.filter((c) => /\bofficial\b/i.test(c) && !ours.includes(c))).toEqual([]);
    expect(confirm).not.toContain("the next official injury report");
    expect(confirm).toContain(NO_PAIR_CONFIRM_ESPN);
    expect(confirm).toContain(NO_PAIR_CONFIRM_PAIR);
  });

  it("confirmWithoutPair: official entries become ESPN's status, the rest is kept, the pair is named once", () => {
    expect(confirmWithoutPair(["the next official injury report"])).toEqual([
      NO_PAIR_CONFIRM_ESPN,
      NO_PAIR_CONFIRM_PAIR,
    ]);
    expect(
      confirmWithoutPair([
        "ESPN's injuryStatus or the official game status changes",
        "the inactives list about 90 minutes before kickoff",
      ]),
    ).toEqual([
      NO_PAIR_CONFIRM_ESPN,
      "the inactives list about 90 minutes before kickoff",
      NO_PAIR_CONFIRM_PAIR,
    ]);
    // nothing official to replace: kept as given, the pair added
    expect(confirmWithoutPair(["the depth chart's next update"])).toEqual([
      "the depth chart's next update",
      NO_PAIR_CONFIRM_PAIR,
    ]);
    expect(confirmWithoutPair([NO_PAIR_CONFIRM_PAIR])).toEqual([NO_PAIR_CONFIRM_PAIR]);
    for (const c of [NO_PAIR_CONFIRM_ESPN, NO_PAIR_CONFIRM_PAIR]) expect(c.length).toBeLessThan(400);
  });

  it("control: a paired player carries no such warning", async () => {
    // a paired player of the recorded pool page (E10 reads him by id through it)
    const pool = await call(client, "espn_list_players", { status: "ONTEAM", limit: 100 });
    const mate = (
      pool.body.data as { players: { player_id: number; gsis_id: string | null }[] }
    ).players.find((x) => x.gsis_id !== null && x.player_id > 0);
    if (mate === undefined) throw new Error("no paired pool player");
    const r = await call(client, "espn_analyze_evidence", {
      player: { player_ids: [mate.player_id] },
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect(r.body.warnings).not.toContain(NO_PAIR_EVIDENCE_WARNING);
    const confirm = (r.body.data as { what_would_confirm: string[] }).what_would_confirm;
    expect(confirm).not.toContain(NO_PAIR_CONFIRM_PAIR);
    expect(confirm).not.toContain(NO_PAIR_CONFIRM_ESPN);
    const inj = await call(client, "espn_get_injuries", {
      week: 4,
      players: { player_ids: paired().slice(0, 3) },
    });
    expect((inj.body.warnings as string[]).some((w) => w.startsWith("no crosswalk pair"))).toBe(
      false,
    );
  });

  it("unpairedReportWarning names at most ten ids, then counts, and fits a warning line", () => {
    const ids = Array.from({ length: 23 }, (_, i) => 4_000_000 + i);
    const w = unpairedReportWarning(ids);
    expect(w.startsWith("no crosswalk pair for 23 player(s) (4000000, 4000001,")).toBe(true);
    expect(w).toContain("4000009 and 13 more)");
    expect(w.length).toBeLessThanOrEqual(400);
  });
});
