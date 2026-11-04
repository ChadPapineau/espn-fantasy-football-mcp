// activity-rejected-private.test.ts — changelog §R10, R10-11 through the composition root
// (src/services/index.ts buildServices with the REAL credential authority, NOT fixture mode): on a
// PRIVATE league whose stored session ESPN rejects, espn_analyze_league_activity answers from the
// persisted history, `partial: true`, with the fixed feed_rejected warning and `eff setup` — also
// once the standings and rosters it reads beside the feed have gone stale, when they refuse with no
// request as the feed does (the round-3 review's R3B-CS-1: the feed's degradation was reachable only
// while the standings, 15 min, and the rosters, 5 min, were both still cached, so in practice the
// call failed ESPN_AUTH_REJECTED from those reads). A private stand-in of league-a: keyless league
// reads answer 401, cookie-bearing ones the recordings until the session is rejected, then 401.
// The session file is a run-time fake in the world's temp config dir. No network.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { fingerprintOf } from "../../src/auth/format.js";
import { CREDENTIAL_FORMAT_VERSION } from "../../src/auth/types.js";
import { SESSION_READ_WARNINGS, activityLeagueReadsWarning } from "../../src/mcp/tools/common.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import { fakeCookies } from "../auth/helpers.js";
import { ROOT, call, connect, fixtureFetchPlus, makeWorld, type World } from "./helpers/world.js";

const STORED_AT = "2026-10-01T11:00:00.000Z";
let world: World;
let wiring: Wiring;
let client: Awaited<ReturnType<typeof connect>>;
let rejectNow = false;
const sent: { views: string; cookie: boolean; status: number }[] = [];
const cookies = fakeCookies("r10-11-private");

beforeAll(async () => {
  world = await makeWorld({ env: { EFF_TOOLSET: "full" } });
  writeFileSync(
    world.config.credentialFile,
    sessionFileBody(cookies, {
      storedAt: STORED_AT,
      format_version: CREDENTIAL_FORMAT_VERSION,
      fingerprint: fingerprintOf(cookies.espn_s2),
    }),
    { mode: 0o600 },
  );
  const inner = fixtureFetchPlus("league-a", []);
  const refused = (views: string, cookie: boolean): Response => {
    sent.push({ views, cookie, status: 401 });
    return new Response(JSON.stringify({ messages: ["not authorized"] }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  wiring = buildServices({
    config: world.config,
    store: world.store,
    clock: world.clock,
    logger: world.logger,
    packageRoot: ROOT,
    home: path.join(world.root, "home"),
    fetch: async (url, init) => {
      const u = new URL(url);
      const headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
      const cookie = headers.cookie !== undefined;
      const views = u.searchParams.getAll("view").join("&");
      const league = u.pathname.includes("/leagues/");
      if (league && (!cookie || rejectNow)) return refused(views, cookie);
      delete headers.cookie;
      const r = await inner(url, { ...init, headers });
      sent.push({ views, cookie, status: r.status });
      if (!league || !views.includes("mSettings")) return r;
      // the private stand-in: its settings say so
      const b = (await r.json()) as { settings?: Record<string, unknown> };
      if (b.settings !== undefined) b.settings.isPublic = false;
      return new Response(JSON.stringify(b), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
  });
  client = await connect({
    services: { ...wiring.services, newSeed: () => 7 },
    options: { ...wiring.options, toolset: "full" },
  });
}, 120_000);

afterAll(async () => {
  await client.close();
  wiring.close();
  world.cleanup();
});

const codeOf = (b: Record<string, unknown>): unknown =>
  (b as { error?: { code?: unknown } }).error?.code ?? (b as { code?: unknown }).code;

describe("R10-11 on a private league under a rejected session (R3B-CS-1)", () => {
  it("with a working session the digest answers, and its feed rows are kept as history", async () => {
    const lg = await call(client.client, "espn_get_league");
    expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
    expect((lg.body.data as { league: { is_public: boolean | null } }).league.is_public).toBe(
      false,
    );
    const feed = await call(client.client, "espn_list_transactions", { count: 50 });
    expect(feed.isError).toBe(false);
    world.store.repos.transactionsSeen.appendNew(
      (feed.body.data as { transactions: never[] }).transactions,
      world.clock.nowIso(),
    );
    const r = await call(client.client, "espn_analyze_league_activity", { since_days: 30 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
  });

  it("ESPN rejects the session (a cookie-bearing 401)", async () => {
    rejectNow = true;
    const r = await call(client.client, "espn_get_roster", { week: 3, force_refresh: true });
    expect(codeOf(r.body)).toBe("ESPN_AUTH_REJECTED");
    const st = await call(client.client, "espn_get_status");
    expect((st.body.data as { credential: { state: string } }).credential.state).toBe("rejected");
  });

  it.each([
    // the feed (10 min) and the rosters (5 min) stale, the standings (15 min) still cached
    [11, ["rosters", "free-agent pool"]],
    // every one of them stale: the standings refuse too (the pool is then past the call's
    // 3-request budget — each refused read was counted against it — and said so on its own line)
    [20, ["standings", "rosters"]],
  ] as const)(
    "%i minutes on: partial from the persisted history, with the reason, and no request",
    async (minutes, refusedReads) => {
      // the clock runs on from the rejection: 11 minutes, then 9 more
      world.clock.advance((minutes === 11 ? 11 : 9) * 60 * 1000);
      const n = sent.length;
      const r = await call(client.client, "espn_analyze_league_activity", { since_days: 30 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
      const body = r.body as { partial: boolean; warnings: string[]; data: unknown };
      expect(body.partial).toBe(true);
      expect(body.warnings).toContain(SESSION_READ_WARNINGS.feed_rejected);
      // one line naming the reads that refused (the pool E11 reads is its own page, not cached by
      // the first call's reads)
      const line = body.warnings.find((w) => w.includes("need one on a league not known"));
      expect(line).toBe(activityLeagueReadsWarning("rejected", refusedReads));
      const totals = (body.data as { transactions: { adds: number } }).transactions;
      expect(totals.adds).toBeGreaterThan(0);
      // the short-circuit: nothing was sent, least of all the rejected cookie
      expect(sent.slice(n)).toEqual([]);
    },
  );
});
