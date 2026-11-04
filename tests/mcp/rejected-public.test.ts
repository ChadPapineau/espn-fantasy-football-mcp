// rejected-public.test.ts — changelog §R10, R10-7, the server side through the composition root
// (src/services/index.ts buildServices, NOT fixture mode): a stored session the `credential_state`
// row records as rejected, on a public league (league-a's recorded settings: isPublic true), read
// through the MCP tools. What a Skill sees at Step 0 and mid-procedure: espn_get_status says
// `rejected`; espn_get_league answers with `is_public: true` after one anonymous settings read; the
// roster, standings and waiver reads answer keylessly; so does the league's feed
// (espn_list_transactions, espn_analyze_league_activity — changelog §R10, R10-10: ESPN serves it to
// anyone on a public league), while pending claims, the user's own, answer `pending: null` with a
// fixed warning naming the rejection and `eff setup`, with no request of their own. No request
// carries a cookie (plan 02 §2.1 "Short-circuit"). The session file is a run-time fake in the
// world's temp config dir; the fetch is the recorded fixtures.
import { writeFileSync } from "node:fs";
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
const REJECTED_AT = "2026-10-05T09:00:00.000Z";

let world: World;
let wiring: Wiring;
let client: Awaited<ReturnType<typeof connect>>;
/** Every request the provider sent: its views and whether it carried a Cookie header. */
const sent: { views: string; cookie: boolean }[] = [];
const cookies = fakeCookies("r10-7-mcp");

beforeAll(async () => {
  world = await makeWorld();
  // what `eff setup` left (the value) and what a later 401 recorded (the row): rejected
  writeFileSync(
    world.config.credentialFile,
    sessionFileBody(cookies, {
      storedAt: STORED_AT,
      format_version: CREDENTIAL_FORMAT_VERSION,
      fingerprint: fingerprintOf(cookies.espn_s2),
    }),
    { mode: 0o600 },
  );
  world.store.repos.credentialState.put({
    league_id: "0",
    state: "rejected",
    store: "file",
    stored_at: STORED_AT,
    last_accepted_at: null,
    last_rejected_at: REJECTED_AT,
    rejected_since: REJECTED_AT,
    next_probe_at: null,
    rejected_view: "mRoster",
    board_probe_discriminates: null,
    updated_at: REJECTED_AT,
    updated_by: "server",
  });
  const inner = fixtureFetchPlus("league-a", []);
  wiring = buildServices({
    config: world.config,
    store: world.store,
    clock: world.clock,
    logger: world.logger,
    packageRoot: ROOT,
    home: path.join(world.root, "home"),
    fetch: (url, init) => {
      sent.push({
        views: new URL(url).searchParams.getAll("view").join("&"),
        cookie: (init.headers as Record<string, string> | undefined)?.cookie !== undefined,
      });
      return inner(url, init);
    },
    loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
  });
  client = await connect({
    services: { ...wiring.services, newSeed: () => 7 },
    options: wiring.options,
  });
}, 120_000);

afterAll(async () => {
  await client.close();
  wiring.close();
  world.cleanup();
});

describe("R10-7: a rejected session on a public league, through the tools", () => {
  it("status says rejected; the league answers is_public true after one anonymous read", async () => {
    expect(world.options.fixtureMode).toBe(false);
    const st = await call(client.client, "espn_get_status");
    expect(st.isError).toBe(false);
    const cred = (st.body.data as { credential: { state: string } }).credential;
    expect(cred.state).toBe("rejected");
    // zero requests by construction: nothing is known yet
    expect(sent).toEqual([]);
    const lg = await call(client.client, "espn_get_league");
    expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
    expect((lg.body.data as { league: { is_public: boolean | null } }).league.is_public).toBe(true);
    expect(sent[0]).toEqual({ views: "mSettings&mNav", cookie: false });
    // and status now reads the league's publicity from the cache (still no request of its own)
    const n = sent.length;
    const st2 = await call(client.client, "espn_get_status");
    expect((st2.body.data as { league: { is_public: boolean | null } }).league.is_public).toBe(
      true,
    );
    expect(sent.length).toBe(n);
  });

  it("the roster, standings and waiver reads answer keylessly (WV-7-E's question carries on)", async () => {
    for (const [name, args] of [
      ["espn_get_roster", { week: 3 }],
      ["espn_get_standings", {}],
      // league-a bids FAAB: under core the K/D-ST slice is the waiver analysis in phase
      ["espn_analyze_waivers", { positions: ["K"] }],
    ] as const) {
      const r = await call(client.client, name, args);
      expect(r.isError, `${name} ${JSON.stringify(r.body).slice(0, 300)}`).toBe(false);
    }
  });

  it("changelog §R10, R10-10: the league's feed answers keylessly; pending claims are null with the reason", async () => {
    const n = sent.length;
    const r = await call(client.client, "espn_list_transactions", { pending: true, count: 50 });
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    const body = r.body as {
      data: { transactions: unknown[]; pending: unknown[] | null };
      warnings: string[];
      partial: boolean;
    };
    expect(body.data.transactions.length).toBeGreaterThan(0);
    expect(body.partial).toBe(false);
    expect(body.data.pending).toBeNull();
    expect(body.warnings).toContain(SESSION_READ_WARNINGS.pending_rejected);
    const mine = sent.slice(n);
    expect(mine.filter((s) => s.views === "mTransactions2")).toEqual([
      { views: "mTransactions2", cookie: false },
    ]);
    expect(mine.some((s) => s.views.includes("mPendingTransactions"))).toBe(false);
  });

  it("changelog §R10, R10-10: espn_analyze_league_activity answers on the public league from the feed", async () => {
    const full = await connect({
      services: { ...wiring.services, newSeed: () => 7 },
      options: { ...wiring.options, toolset: "full" },
    });
    try {
      const n = sent.length;
      const r = await call(full.client, "espn_analyze_league_activity", { since_days: 7 });
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
      const body = r.body as { warnings: string[] };
      expect(body.warnings).not.toContain(SESSION_READ_WARNINGS.feed_rejected);
      expect(body.warnings.some((w) => w.includes("mTransactions2 unavailable"))).toBe(false);
      // its feed reads: cached from the call above, or keyless
      expect(sent.slice(n).every((s) => !s.cookie)).toBe(true);
    } finally {
      await full.close();
    }
  });

  it("no request ever carried a cookie; the session's value appears nowhere in the log", () => {
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((s) => !s.cookie)).toBe(true);
    const log = world.logLines.join("\n");
    expect(log).not.toContain(cookies.espn_s2.slice(0, 24));
    expect(log).not.toContain(cookies.swid);
  });
});
