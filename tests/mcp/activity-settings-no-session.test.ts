// activity-settings-no-session.test.ts — changelog §R10, R10-18 with nothing stored, through the
// composition root (src/services/index.ts buildServices with the REAL credential authority, NOT
// fixture mode): on a PRIVATE league whose session was removed (the stored value and its row gone,
// as `eff setup --reset` leaves them) once its settings are past their 24 h TTL,
// espn_analyze_league_activity fails as every tool does — ESPN_REQUIRES_COOKIES with the fix —
// and never answers from the stale settings it holds: a session refusal is no DEGRADED_CODES
// outage. With nothing stored an `auto` league read is the one keyless read the pipeline makes
// (plan 02 §2.1; auth-gate.ts `keyless`): it carries no cookie, and ESPN's 401 is the refusal.
// While the settings are fresh, the feed, standings, rosters and pool refusals still degrade the
// digest as R10-11 says (partial, the persisted history, the reason and `eff setup`). A private
// stand-in of league-a; the session file is a run-time fake in the world's temp config dir.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { fingerprintOf } from "../../src/auth/format.js";
import { CREDENTIAL_FORMAT_VERSION } from "../../src/auth/types.js";
import { SESSION_READ_WARNINGS } from "../../src/mcp/tools/common.js";
import { buildServices, type Wiring } from "../../src/services/index.js";
import { fakeCookies } from "../auth/helpers.js";
import { ROOT, call, connect, fixtureFetchPlus, makeWorld, type World } from "./helpers/world.js";

const STORED_AT = "2026-10-01T11:00:00.000Z";
let world: World;
let wiring: Wiring;
let client: Awaited<ReturnType<typeof connect>>;
const sent: { views: string; cookie: boolean; status: number }[] = [];
const cookies = fakeCookies("r10-18-no-session");

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
      // the private stand-in: a keyless league read is ESPN's 401
      if (league && !cookie) {
        sent.push({ views, cookie, status: 401 });
        return new Response(JSON.stringify({ messages: ["not authorized"] }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      delete headers.cookie;
      const r = await inner(url, { ...init, headers });
      sent.push({ views, cookie, status: r.status });
      if (!league || !views.includes("mSettings")) return r;
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

describe("R10-18 on a private league with nothing stored", () => {
  it("with the session the digest answers, and its feed rows are kept as history", async () => {
    const feed = await call(client.client, "espn_list_transactions", { count: 50 });
    expect(feed.isError, JSON.stringify(feed.body).slice(0, 300)).toBe(false);
    world.store.repos.transactionsSeen.appendNew(
      (feed.body.data as { transactions: never[] }).transactions,
      world.clock.nowIso(),
    );
    const r = await call(client.client, "espn_analyze_league_activity", { since_days: 30 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
  });

  it("the session removed, the settings still fresh: the session reads degrade per R10-11", async () => {
    // the stored value and its row gone, as `eff setup --reset` leaves them
    rmSync(world.config.credentialFile, { force: true });
    world.store.repos.credentialState.clear();
    world.clock.advance(20 * 60 * 1000);
    const n = sent.length;
    const r = await call(client.client, "espn_analyze_league_activity", { since_days: 30 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 400)).toBe(false);
    const body = r.body as { partial: boolean; warnings: string[] };
    expect(body.partial).toBe(true);
    expect(body.warnings).toContain(SESSION_READ_WARNINGS.feed_no_session);
    expect(body.warnings.some((w) => w.includes("and none is stored: they were not read"))).toBe(
      true,
    );
    // no cookie can be sent with nothing stored
    expect(sent.slice(n).filter((s) => s.cookie)).toEqual([]);
  });

  it("the settings past their TTL: ESPN_REQUIRES_COOKIES with the fix, never the stale settings", async () => {
    world.clock.advance(25 * 60 * 60 * 1000);
    for (const args of [{ since_days: 30 }, { since_days: 30, allow_stale: true }]) {
      const n = sent.length;
      const r = await call(client.client, "espn_analyze_league_activity", args);
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
      const err = (r.body as { error: { code: string; hint: string } }).error;
      expect(err.code).toBe("ESPN_REQUIRES_COOKIES");
      expect(err.hint).toContain("eff setup");
      // at most the pipeline's one keyless settings read (ESPN's 401), never a cookie
      const after = sent.slice(n);
      expect(after.filter((s) => s.cookie)).toEqual([]);
      expect(after.every((s) => s.status === 401 && s.views.includes("mSettings"))).toBe(true);
      expect(after.length).toBeLessThanOrEqual(1);
    }
    // the league tool fails the same way: one rule for every tool
    const lg = await call(client.client, "espn_get_league");
    expect(codeOf(lg.body)).toBe("ESPN_REQUIRES_COOKIES");
  });
});
