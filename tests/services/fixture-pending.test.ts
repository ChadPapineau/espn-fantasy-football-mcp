// fixture-pending.test.ts — changelog §R10, R10-21 (amends R9-3): in fixture mode the cookie gate gets
// a value-free label of the scripted credential state for the caller's own pending claims
// (`own`, mPendingTransactions) only, read from the same `harness.credential_state` espn_get_status
// reports (src/services/fixture-credential.ts; auth-gate.ts fixtureOwnLabel). Through the real
// composition root and the production stdio entry (serveStdio over an in-memory transport), on
// each committed variant: base (not_configured) answers `pending: null` with pending_no_session;
// auth-rejected (rejected) with pending_rejected, the reason espn_get_status gives; public-league
// (stored) serves the variant's recorded mPendingTransactions, as a session read would. A scripted
// probe moves the label and the pending answer follows it (validated: served; rejected: refused).
// Zero network everywhere (the injected transport is never called; the derived fixture fetch
// refuses any Cookie header, so no read carried one), no value anywhere, and every `auto` and feed
// read is unchanged (keyless, served). Nothing outside fixture mode reaches the label: a provider
// built without fixture mode, or beside a credential authority, never reads it. The fixture guard
// (fixture-credential.test.ts) runs first and is unchanged. Temp directories only.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { SESSION_READ_WARNINGS } from "../../src/mcp/tools/common.js";
import { createEspnProvider } from "../../src/providers/espn/index.js";
import { translateScoringInput } from "../../src/domain/scoring/index.js";
import { fixedClock } from "../../src/domain/clock.js";
import {
  FakeAuthority,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
} from "../providers/espn/helpers.js";
import { ROOT, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";

const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const CLOCK_AT = "2026-10-07T01:00:00.000Z";
/** Words that would mean a credential value or its carrier left the seam. */
const COOKIE_WORDS = /espn_s2|swid=|cookie:|fingerprint/i;

let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-fxpending-")));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A derived variant scripting `harness` — public-league's manifest (its views, its clock) with the
 * root made absolute, written to a fresh temp directory, so a probe verdict the committed variants
 * do not script (accepted true; a stored session the probe rejects) can be run.
 */
function scriptedVariant(harness: unknown): string {
  const m = JSON.parse(
    readFileSync(path.join(FX, "public-league", "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const dir = mkdtempSync(path.join(tmp, "v-"));
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      ...m,
      root: path.resolve(FX, "public-league", String(m.root)),
      harness,
    }),
  );
  return dir;
}

interface Server {
  readonly world: World;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

/** A fixture-mode server on `dir` through the production stdio entry. */
async function server(dir: string): Promise<Server> {
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir },
    teamId: 2,
    clock: CLOCK_AT,
    publishEspn: false,
  });
  const c = await connect(world, { modern: true });
  return { world, client: c.client, close: c.close };
}

interface PendingAnswer {
  readonly state: string;
  readonly pending: unknown[] | null;
  readonly feed: number;
  readonly warnings: string[];
}

/** espn_get_status's credential state and espn_list_transactions(pending: true)'s answer. */
async function pendingOf(s: Server): Promise<PendingAnswer> {
  const st = await call(s.client, "espn_get_status", {});
  expect(st.isError, JSON.stringify(st.body).slice(0, 300)).toBe(false);
  const state = (st.body.data as { credential: { state: string } }).credential.state;
  const r = await call(s.client, "espn_list_transactions", { pending: true, week: 2 });
  expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
  const data = r.body.data as { pending: unknown[] | null; transactions: unknown[] };
  const body = JSON.stringify(r.body);
  expect(COOKIE_WORDS.test(body), body.slice(0, 200)).toBe(false);
  return {
    state,
    pending: data.pending,
    feed: data.transactions.length,
    warnings: (r.body as { warnings: string[] }).warnings,
  };
}

const PENDING_WARNINGS = [
  SESSION_READ_WARNINGS.pending_no_session,
  SESSION_READ_WARNINGS.pending_rejected,
];
const pendingWarnings = (a: PendingAnswer): string[] =>
  a.warnings.filter((w) => w.startsWith("pending:"));

describe("R10-21: pending claims follow the scripted session (fixture mode, over stdio)", () => {
  it.each([
    ["base", FX, "not_configured", SESSION_READ_WARNINGS.pending_no_session],
    [
      "auth-rejected",
      path.join(FX, "auth-rejected"),
      "rejected",
      SESSION_READ_WARNINGS.pending_rejected,
    ],
    ["public-league", path.join(FX, "public-league"), "stored", null],
  ] as const)(
    "%s: espn_get_status and the pending answer tell one story",
    async (_name, dir, state, warning) => {
      const s = await server(dir);
      try {
        const a = await pendingOf(s);
        expect(a.state).toBe(state);
        if (warning === null) {
          // the variant's recorded mPendingTransactions, served as a session read would be
          expect(a.pending).toEqual([]);
          expect(pendingWarnings(a)).toEqual([]);
        } else {
          expect(a.pending).toBeNull();
          expect(pendingWarnings(a)).toEqual([warning]);
        }
        expect(
          a.warnings.filter((w) => PENDING_WARNINGS.includes(w as never)).length,
        ).toBeLessThanOrEqual(1);
        // the feed part is unaffected: the transactions of week 2 are served keyless
        expect(a.feed).toBeGreaterThan(0);
        // zero network: fixture mode never calls the injected transport
        expect(s.world.requests).toEqual([]);
        expect(s.world.logLines.join("\n")).not.toMatch(/espn_s2|swid=/i);
      } finally {
        await s.close();
        s.world.cleanup();
      }
    },
    120_000,
  );

  it("a probe that accepts moves the label to validated, and pending claims stay served", async () => {
    const s = await server(
      scriptedVariant({
        credential_state: "stored",
        probe: { accepted: true, reason: null, probe: "settings" },
      }),
    );
    try {
      expect((await pendingOf(s)).pending).toEqual([]);
      const probe = await call(s.client, "espn_check_auth", {});
      expect(probe.body.data).toMatchObject({
        accepted: true,
        state: "validated",
        upstream_status: null,
      });
      const a = await pendingOf(s);
      expect(a.state).toBe("validated");
      expect(a.pending).toEqual([]);
      expect(pendingWarnings(a)).toEqual([]);
      expect(s.world.requests).toEqual([]);
    } finally {
      await s.close();
      s.world.cleanup();
    }
  }, 120_000);

  it("a probe that rejects a stored session moves the label to rejected, and pending claims are refused with its reason", async () => {
    const s = await server(
      scriptedVariant({
        credential_state: "stored",
        probe: { accepted: false, reason: null, probe: "board" },
      }),
    );
    try {
      const before = await pendingOf(s);
      expect(before.state).toBe("stored");
      expect(before.pending).toEqual([]);
      const probe = await call(s.client, "espn_check_auth", {});
      expect(probe.body.data).toMatchObject({ accepted: false, state: "rejected" });
      const after = await pendingOf(s);
      expect(after.state).toBe("rejected");
      expect(after.pending).toBeNull();
      expect(pendingWarnings(after)).toEqual([SESSION_READ_WARNINGS.pending_rejected]);
      // every other read is unchanged: the feed and the league reads still keyless and served
      expect(after.feed).toBeGreaterThan(0);
      for (const tool of ["espn_get_league", "espn_get_roster", "espn_get_standings"]) {
        const r = await call(s.client, tool, {});
        expect(r.isError, `${tool}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(false);
      }
      expect(s.world.requests).toEqual([]);
    } finally {
      await s.close();
      s.world.cleanup();
    }
  }, 120_000);
});

describe("R10-21: nothing outside fixture mode reaches the label", () => {
  const deps = (credentials: FakeAuthority | null, fixtureDir: string | null) => {
    const sent: string[] = [];
    let asked = 0;
    const clock = fixedClock(CLOCK_AT);
    const provider = createEspnProvider({
      config: {
        leagueId: "0",
        season: 2026,
        teamId: 2,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir,
      },
      repos: {
        limiter: new MemoryLimiterRepo(),
        espnCache: new MemoryCache(),
        driftState: new MemoryDrift(),
      },
      credentials,
      clock,
      // the limiter's 1/s window waited in fake time
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
      scoring: translateScoringInput,
      fetch: (url) => {
        sent.push(url);
        return Promise.reject(new Error("no network in tests"));
      },
      fixtureCredentialLabel: () => {
        asked++;
        return "stored";
      },
    });
    const ref = { platform: "espn", league_id: "0", season: 2026 } as const;
    return { provider, ref, sent, asked: () => asked };
  };

  it("a provider built without fixture mode ignores the label: pending claims refused, nothing sent, the label never read", async () => {
    const w = deps(null, null);
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    expect(w.sent).toEqual([]);
    expect(w.asked()).toBe(0);
  });

  it("beside a credential authority the label is never read: the authority decides", async () => {
    const w = deps(new FakeAuthority("rejected", { ok: false, reason: "rejected" }), null);
    await expect(w.provider.listPendingTransactions(w.ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    expect(w.sent).toEqual([]);
    expect(w.asked()).toBe(0);
  });

  it("in fixture mode the label is read for pending claims only: the league reads never ask it", async () => {
    const w = deps(null, path.join(FX, "public-league"));
    await w.provider.getLeague(w.ref);
    await w.provider.listTransactions(w.ref, {
      types: ["WAIVER", "FREEAGENT"],
      week: 2,
      since: null,
      count: 10,
      team_id: null,
    });
    expect(w.asked()).toBe(0);
    const pending = await w.provider.listPendingTransactions(w.ref);
    expect(pending.value).toEqual([]);
    expect(w.asked()).toBeGreaterThan(0);
    // fixture mode reads the committed files: the injected transport is never called
    expect(w.sent).toEqual([]);
  });
});
