// transactions-absent.test.ts — espn_list_transactions on the answer of finding
// transactions-absent-key-red (plan 07 A6; plan 01 §7): ESPN answers a period nobody has moved in
// yet with the recognised view's bare base and no `transactions` key (the owner's cookie, live). The
// tool's current-week read failed ESPN_DRIFT_DETECTED and fell back to persisted history with a
// "stale" warning, and drift turned red. Now: an empty ESPN page, no fallback, no drift warning, and
// drift_state untouched. The unrecognised-view answer is still drift (the fallback says so). Fixture
// world over league-a, the mTransactions2 answer replaced; no network.
import type { Client } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/providers/espn/transport.js";
import { coded, faulty } from "./helpers/faults.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "./helpers/world.js";

const read = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(ESPN_FIXTURES, rel), "utf8")) as Record<string, unknown>;

/** The recognised view's bare base without its list (research 03 P11 / P17 / P18). */
function bareBase(): Record<string, unknown> {
  const b = read("fx-10h/league/mTransactions2.json");
  delete b.transactions;
  return b;
}

/** The URLs of the mTransactions2 requests the replaced answer served. */
const asked: string[] = [];
const answering =
  (body: () => unknown, headers: Record<string, string> = {}) =>
  (inner: FetchLike): FetchLike =>
  (url, init) => {
    if (new URL(url).searchParams.getAll("view").join("&") !== "mTransactions2")
      return inner(url, init);
    asked.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(body()), {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8", ...headers },
      }),
    );
  };

let world: World | null = null;
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  asked.length = 0;
  await close?.();
  world?.cleanup();
  world = null;
  close = null;
});

async function open(wrap: (inner: FetchLike) => FetchLike): Promise<Client> {
  world = await makeWorld({ league: "league-a", publishEspn: false, wrapFetch: wrap });
  const c = await connect(world);
  close = c.close;
  return c.client;
}

interface Env {
  data: { transactions: unknown[]; history_coverage: { gap_suspected: boolean } };
  meta: { drift?: unknown };
  page: { count: number; total: number | null; has_more: boolean };
  partial: boolean;
  warnings: string[];
}

describe("espn_list_transactions on a period nobody has moved in (transactions-absent-key-red)", () => {
  it("an empty ESPN page: no fallback to history, no drift warning, drift_state untouched", async () => {
    const client = await open(answering(bareBase, { "x-fantasy-filter-transaction-count": "0" }));
    const before = world?.store.repos.driftState.get() ?? null;
    const r = await call(client, "espn_list_transactions", { week: 4, count: 25 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    const env = r.body as unknown as Env;
    expect(env.data.transactions).toEqual([]);
    expect(env.partial).toBe(false);
    expect(env.page).toMatchObject({ count: 0, total: 0, has_more: false });
    expect(env.warnings.join(" | ")).not.toMatch(/mTransactions2 unavailable|drift/i);
    expect(env.meta.drift ?? null).toBeNull();
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0] ?? "x:").searchParams.get("scoringPeriodId")).toBe("4");
    expect(world?.store.repos.driftState.get() ?? null).toEqual(before);
  });

  it("the unrecognised-view answer is still drift: the tool falls back to history and says so", async () => {
    const client = await open(answering(() => read("recorded/league-a/skeleton.json")));
    const r = await call(client, "espn_list_transactions", { week: 4, count: 25 });
    expect(r.isError).toBe(false);
    const env = r.body as unknown as Env;
    expect(env.partial).toBe(true);
    expect(env.warnings.join(" | ")).toContain("espn:mTransactions2 unavailable");
    expect(world?.store.repos.driftState.get()?.status).toBe("red");
  });
});

// verifier finding F2 on ec68d08 (espn_analyze_league_activity): on a cold cache the feed loop could
// spend the call's 3 requests, so neither standings nor rosters were read and the tool answered
// NOT_FOUND. An empty current week that answered drift used to stop the loop first; read as an
// empty week, it no longer does. Now the standings are read before the feeds, and a call that still
// names no team answers its totals, partial, said.
describe("espn_analyze_league_activity in a period nobody has moved in, cold cache (F2)", () => {
  /** league-a's own base (its settings' status): reading it never outdates the cached settings. */
  function leagueBase(): Record<string, unknown> {
    const { settings: _s, ...base } = read("recorded/league-a/mSettings.json");
    return base;
  }
  const seen: string[] = [];
  const recording =
    (wrap: (inner: FetchLike) => FetchLike) =>
    (inner: FetchLike): FetchLike => {
      const next = wrap(inner);
      return (url, init) => {
        const u = new URL(url);
        seen.push(
          `${u.searchParams.getAll("view").join("&")}@${u.searchParams.get("scoringPeriodId") ?? "-"}`,
        );
        return next(url, init);
      };
    };
  afterEach(() => {
    seen.length = 0;
  });

  async function activity(body: () => unknown, faults: Parameters<typeof faulty>[1] = {}) {
    world = await makeWorld({
      league: "league-a",
      publishEspn: false,
      wrapFetch: recording(answering(body, { "x-fantasy-filter-transaction-count": "0" })),
    });
    const c = await connect(world, {
      options: { toolset: "full" },
      services: faulty(world.services, faults),
    });
    close = c.close;
    return call(c.client, "espn_analyze_league_activity", {
      since_days: 14,
      include_rival_needs: false,
    });
  }

  for (const [name, body] of [
    ["league-a's own base", leagueBase],
    ["a base whose status outdates the cached settings", bareBase],
  ] as const)
    it(`the standings are read before the feeds: the teams are named, the feeds past the budget said (${name})`, async () => {
      const r = await activity(body);
      expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
      const env = r.body as unknown as {
        data: { transactions: { by_team: unknown[] } };
        partial: boolean;
        warnings: string[];
      };
      expect(env.data.transactions.by_team.length).toBeGreaterThan(0);
      const standingsAt = seen.indexOf("mTeam&mStandings@-");
      const feedAt = seen.indexOf("mTransactions2@4");
      expect(standingsAt).toBeGreaterThan(-1);
      expect(feedAt).toBeGreaterThan(standingsAt);
      expect(env.partial).toBe(true);
      expect(env.warnings.some((w) => w.startsWith("partial: espn:mTransactions2"))).toBe(true);
    });

  it("no read named a team (standings and rosters unavailable): the totals, partial and said — never NOT_FOUND", async () => {
    const r = await activity(bareBase, {
      getStandings: coded("ESPN_UPSTREAM_UNAVAILABLE"),
      getRosters: coded("ESPN_UPSTREAM_UNAVAILABLE"),
    });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    const env = r.body as unknown as {
      data: { transactions: { by_team: unknown[]; adds: number } };
      partial: boolean;
      warnings: string[];
    };
    expect(env.partial).toBe(true);
    expect(env.data.transactions.by_team).toEqual([]);
    expect(env.warnings).toContain(
      "partial: the league's teams were not read (standings and rosters unavailable): by-team activity, waiver-order movement and rival needs are omitted",
    );
  });
});
