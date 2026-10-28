// status-crosswalk-alert.test.ts — espn_get_status.crosswalk counts the unmatched players as the
// rebuild's alert does (plan 07 G1: "so status and the alert agree"; research 04 §C step 5; plan 06
// §1.3): over the player index the rebuild resolves, a player without a confidence-1.0 pair counts as
// rostered when he is on ANY league roster, else as top-owned when ≥ 1 % owned; a set G1 cannot read
// without a request is null with a warning, never a hard 0. Stage C finding
// status-crosswalk-counts-disagree-alert: cold, status read 0 and 0 (no cached rosters; the top-owned
// count read the free-agent pool snapshot, absent here); warm, it counted every roster while the
// rebuild alerted on the owner's team only. The alert here is the domain rebuild itself run over the
// same store with every league roster as its rostered set, and — last — `eff crosswalk rebuild`'s
// own run (src/cli/crosswalk.ts), whose rostered set must be every league roster too. League-a
// (team 1), `full`, the nflverse excerpts published through the real runner (most of the index stays
// unpaired); no network.
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownRosteredIds, rosteredIds, runCrosswalkRebuild } from "../../src/cli/crosswalk.js";
import type { CliIo } from "../../src/cli/io.js";
import { CHECKED_IN_OVERRIDES } from "../../src/domain/crosswalk/overrides.js";
import { rebuildCrosswalk } from "../../src/domain/crosswalk/rebuild.js";
import type { Roster } from "../../src/domain/league/types.js";
import { faulty } from "./helpers/faults.js";
import { SEASON, call, connect, makeWorld, type World } from "./helpers/world.js";

let world: World;
let client: Client;
let close: () => Promise<void>;

interface Counts {
  matched: number;
  matched_by_name: number;
  unmatched_rostered: number | null;
  unmatched_top_owned: number | null;
}

async function status(c: Client = client): Promise<{ counts: Counts; warnings: string[] }> {
  const r = await call(c, "espn_get_status", {});
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  return {
    counts: (r.body.data as { crosswalk: Counts }).crosswalk,
    warnings: r.body.warnings as string[],
  };
}

/** The rebuild's alert over the same store with `rostered`, split as G1 splits it. */
function alertSplit(rostered: ReadonlySet<number>): { rostered: number; top_owned: number } {
  const r = rebuildCrosswalk({
    season: SEASON,
    roster: world.store.rosterWeekly,
    universe: world.store.playerUniverse,
    nflPlayers: world.store.nflPlayers,
    repository: world.store.repos.crosswalk,
    overrides: CHECKED_IN_OVERRIDES,
    now: world.clock.nowIso(),
    rostered,
  });
  if (r.status !== "done") throw new Error(`rebuild skipped: ${r.reason}`);
  const ids = r.run.alert.espn_ids;
  return {
    rostered: ids.filter((id) => rostered.has(id)).length,
    top_owned: ids.filter((id) => !rostered.has(id)).length,
  };
}

/** Every team's roster this week, as the platform reads it. */
async function allRosters(): Promise<readonly Roster[]> {
  const lg = (await world.services.platform.getLeague(world.services.league)).value;
  return (
    await world.services.platform.getRosters(world.services.league, lg.clock.current_scoring_period)
  ).value;
}

beforeAll(async () => {
  world = await makeWorld({ publishNflverse: true });
  ({ client, close } = await connect(world, { options: { toolset: "full" } }));
}, 180_000);
afterAll(async () => {
  await close();
  world.cleanup();
});

describe("G1's crosswalk counts agree with the rebuild's alert (Stage C status-crosswalk-counts-disagree-alert)", () => {
  it("cold — no league read yet, no roster snapshot: unmatched_rostered null and said, never a hard 0", async () => {
    const got = await status();
    expect(got.counts.unmatched_rostered).toBeNull();
    expect(got.warnings.some((w) => w.includes("unmatched_rostered is null"))).toBe(true);
    // the top-owned count reads the player index the rebuild resolves: every ≥ 1 %-owned unpaired
    // player (nobody is known rostered) — the alert with no rostered set
    expect(got.counts.unmatched_top_owned).toBe(alertSplit(new Set()).top_owned);
    expect(got.counts.unmatched_top_owned).toBeGreaterThan(0);
  });

  it("warm — every league roster cached: both counts are the alert's over every roster", async () => {
    await call(client, "espn_get_league");
    const r = await call(client, "espn_get_roster", { all: true });
    expect(r.isError).toBe(false);
    const rostered = new Set(
      (await allRosters()).flatMap((x) => x.entries.map((e) => e.player.ref.id)),
    );
    const want = alertSplit(rostered);
    expect(want.rostered).toBeGreaterThan(0);
    const got = await status();
    expect(got.counts.unmatched_rostered).toBe(want.rostered);
    expect(got.counts.unmatched_top_owned).toBe(want.top_owned);
    expect(got.warnings.some((w) => w.startsWith("crosswalk:"))).toBe(false);
  });

  it("no cached rosters but the nightly snapshots: the newest snapshot run of every team", async () => {
    const rosters = await allRosters();
    const takenAt = world.clock.nowIso();
    for (const x of rosters)
      world.store.repos.rosterSnapshots.put({
        team_id: x.team.team_id,
        week: x.week,
        taken_at: takenAt,
        roster: x,
      });
    // the cached rosters are unreadable this call: only the snapshots remain
    const s = faulty(world.services, {
      getRosters: () => Promise.reject(new Error("no cache")),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    try {
      const want = alertSplit(
        new Set(rosters.flatMap((x) => x.entries.map((e) => e.player.ref.id))),
      );
      const got = await status(c.client);
      expect(got.counts.unmatched_rostered).toBe(want.rostered);
      expect(got.counts.unmatched_top_owned).toBe(want.top_owned);
    } finally {
      await c.close();
    }
  });

  it("`eff crosswalk rebuild` itself alerts on every league roster and reports G1's counts on the same store", async () => {
    const rosters = await allRosters();
    world.clock.advance(60_000);
    const takenAt = world.clock.nowIso();
    for (const x of rosters)
      world.store.repos.rosterSnapshots.put({
        team_id: x.team.team_id,
        week: x.week,
        taken_at: takenAt,
        roster: x,
      });
    const league = new Set(rosters.flatMap((x) => x.entries.map((e) => e.player.ref.id)));
    const mine = new Set(
      rosters
        .filter((x) => x.team.team_id === 1)
        .flatMap((x) => x.entries.map((e) => e.player.ref.id)),
    );
    // the rebuild's rostered set is the league's, not the owner's team
    expect(rosteredIds(world.store)).toEqual(league);
    expect(ownRosteredIds(world.store, 1)).toEqual(mine);
    expect(league.size).toBeGreaterThan(mine.size);
    // G1 with only the snapshots readable (a new session), then the CLI's own run
    const s = faulty(world.services, {
      getRosters: () => Promise.reject(new Error("no cache")),
    });
    const c = await connect(world, { options: { toolset: "full" }, services: s });
    let got: Counts;
    try {
      got = (await status(c.client)).counts;
    } finally {
      await c.close();
    }
    const run = await runCrosswalkRebuild(
      { clock: world.clock } as unknown as CliIo,
      { season: SEASON, teamId: 1 },
      world.store,
      world.logger,
      null,
      { all: true },
    );
    expect(run.code).toBe(0);
    const m = /, (\d+) rostered and (\d+) top-owned unmatched$/.exec(run.lines[0] ?? "");
    expect(m, run.lines[0]).not.toBeNull();
    expect(Number(m?.[1])).toBe(got.unmatched_rostered);
    expect(Number(m?.[2])).toBe(got.unmatched_top_owned);
    // a rival's rostered player without a pair is alerted as rostered, the owner's own listed first
    const listed = run.lines.filter((l) => l.startsWith("    espn "));
    const idOf = (l: string): number => Number(/^ {4}espn (\d+) /.exec(l)?.[1]);
    const rival = listed.filter((l) => l.includes("(rostered)") && !mine.has(idOf(l)));
    expect(rival.length).toBeGreaterThan(0);
    for (const l of rival) expect(league.has(idOf(l))).toBe(true);
    const firstOther = listed.findIndex((l) => !mine.has(idOf(l)));
    const lastMine = listed.reduce((at, l, i) => (mine.has(idOf(l)) ? i : at), -1);
    expect(lastMine).toBeLessThan(firstOther === -1 ? Infinity : firstOther);
  });
});
