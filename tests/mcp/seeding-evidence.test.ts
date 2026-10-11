// seeding-evidence.test.ts — A1 `espn_get_league(include: ["seeding_evidence"])` (plan 07 A1 / C12,
// ADV OBJ-13; Stage C, docs/evals/phase3-summary.md "Open"): `onboard`'s one-time evidence is now the
// previous season's exact reproduction with the simulator's tiebreak chain, read entirely through the
// provider (its standings, schedule, playoff rules and bracket-edit flag — the settings read
// tolerating a season recorded with `mSettings` alone), with the standings-only comparison only as a
// said fallback when that season's schedule cannot be read, and null when even its standings cannot.
// The fixture world serves the current season from the recorded league and the previous season from
// fixtures/espn/recorded/history (placeholders only; keyless; no network).
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/providers/espn/transport.js";
import { historyFixtureFetch } from "../fixtures/helpers/history-fixtures.js";
import { envelopeViolations, identifierLeaks } from "./helpers/walk.js";
import { call, connect, makeWorld, SEASON, type World } from "./helpers/world.js";

let world: World | null = null;
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  world?.cleanup();
  world = null;
  close = null;
});

/** The current season from the recorded league; the previous one from its recorded history. */
function withHistory(block?: (url: URL) => boolean): (inner: FetchLike) => FetchLike {
  const history = historyFixtureFetch("league-b");
  return (inner) => (url, init) => {
    const u = new URL(url);
    if (!u.pathname.includes(`/seasons/${String(SEASON - 1)}/`)) return inner(url, init);
    if (block?.(u) === true)
      return Promise.reject(
        Object.assign(new Error("fixture mode: fixture_missing"), { effCode: "INTERNAL" }),
      );
    return history(url, init);
  };
}

interface Evidence {
  season: number;
  method: string;
  suggests: string;
  seed_order_matches_record: boolean;
  seed_order_matches_pf: boolean;
  playoff_edited: boolean | null;
  findings: string[];
  table: {
    team_id: number;
    seed: number | null;
    record_rank: number | null;
    pf_rank: number | null;
  }[];
}

async function evidence(
  wrap: (inner: FetchLike) => FetchLike,
): Promise<{ ev: Evidence | null; warnings: string[] }> {
  world = await makeWorld({ league: "league-b", wrapFetch: wrap });
  const c: { client: Client; close: () => Promise<void> } = await connect(world);
  close = c.close;
  // onboard's order (plan 09): the league digest first (this season's settings, cached), then the
  // one-time evidence — last season's settings, standings and schedule: three requests, the budget
  await call(c.client, "espn_get_league", {});
  const r = await call(c.client, "espn_get_league", { include: ["seeding_evidence"] });
  expect(r.isError).toBe(false);
  expect(envelopeViolations(r.body as Parameters<typeof envelopeViolations>[0])).toEqual([]);
  expect(identifierLeaks(JSON.stringify(r.body))).toEqual([]);
  const data = r.body.data as { seeding: { evidence: Evidence | null } };
  return { ev: data.seeding.evidence, warnings: r.body.warnings as string[] };
}

describe("A1 seeding_evidence — the previous season's reproduction", () => {
  it("reproduces last season through the provider: reading (a), every chain place its seed, the bracket edit said", async () => {
    const { ev, warnings } = await evidence(withHistory());
    expect(ev).not.toBeNull();
    if (ev === null) return;
    expect(ev.season).toBe(SEASON - 1);
    expect(ev.method).toBe("reproduction");
    expect(ev.suggests).toBe("espn_rule");
    expect(ev.seed_order_matches_record).toBe(true);
    expect(ev.seed_order_matches_pf).toBe(false);
    // the recorded league's last season carries isPlayoffMatchupEdited (C4: the seeds still follow)
    expect(ev.playoff_edited).toBe(true);
    expect(ev.findings).toEqual(["playoff_edited"]);
    expect(ev.table.length).toBe(10);
    for (const t of ev.table) expect(t.record_rank).toBe(t.seed);
    expect(warnings.some((w) => w.includes("standings-only"))).toBe(false);
  });

  it("falls back to the standings-only comparison, said, when last season's schedule cannot be read", async () => {
    const { ev, warnings } = await evidence(
      withHistory((u) => u.searchParams.getAll("view").includes("mMatchup")),
    );
    expect(ev).not.toBeNull();
    expect(ev?.method).toBe("standings");
    expect(ev?.findings).toEqual([]);
    expect(ev?.playoff_edited).toBeNull();
    expect(warnings.some((w) => w.includes("the standings-only comparison is shown"))).toBe(true);
  });

  it("is null, said, when last season's standings cannot be read", async () => {
    const { ev, warnings } = await evidence(withHistory(() => true));
    expect(ev).toBeNull();
    expect(warnings.some((w) => w.startsWith("seeding evidence unavailable"))).toBe(true);
  });
});
