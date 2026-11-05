// fixture-private.test.ts — changelog §R10, R10-27 (extends R10-21): fixture mode's one private-league
// variant (fixtures/espn/fx-10h/private-league, `settings.isPublic: false` in its recorded bodies).
// On it the scripted credential label also governs every `auto` and `feed` league read, as R10-21
// has it govern `own`: `stored` or `validated` serves the recording, `not_configured` answers
// ESPN_REQUIRES_COOKIES, `rejected` the ESPN_AUTH_REJECTED short-circuit — each with zero requests
// (the store's limiter records none) and none of the call's budget, a fresh cache entry served
// first, as the real pipeline serves it before the gate. Over the production stdio entry
// (serveStdio over an in-memory transport) for each label: espn_get_status, espn_get_league,
// espn_list_transactions (the feed and pending claims), espn_analyze_league_activity (the
// session-refusal partial lines over fresh settings: a first server whose one espn_check_auth
// accepts reads the settings, a second one starts again on the rejected label over the same
// store) and a P1 analytics tool. Every public variant is unchanged: the label is never asked for
// an `auto` or feed read there. No value and no Cookie header exist anywhere (the derived fixture
// fetch refuses one); the fixture guard runs first and is unchanged; nothing outside fixture mode
// reaches the label or the flag. Temp directories only, no network.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import { translateScoringInput } from "../../src/domain/scoring/index.js";
import { SESSION_READ_WARNINGS, activityLeagueReadsWarning } from "../../src/mcp/tools/common.js";
import {
  createEspnProvider,
  derivedLeaguePublicity,
  EspnProvider,
} from "../../src/providers/espn/index.js";
import { buildServices } from "../../src/services/index.js";
import {
  FakeAuthority,
  jsonResponse,
  MemoryCache,
  MemoryDrift,
  MemoryLimiterRepo,
  testCookieHeader,
} from "../providers/espn/helpers.js";
import { ROOT, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";

const FX = path.join(ROOT, "fixtures", "espn", "fx-10h");
const PRIVATE = path.join(FX, "private-league");
/**
 * The committed private variants (changelog §R10, R10-27 allows more than one, R10-28): private-league
 * (rejected), private-league-none (not_configured) and private-expiring (a session rejected
 * mid-procedure — fixture-expiring.test.ts).
 */
const PRIVATE_VARIANTS = ["private-league", "private-league-none", "private-expiring"] as const;
const CLOCK_AT = "2026-10-07T01:00:00.000Z";
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Words that would mean a credential value or its carrier left the seam. */
const COOKIE_WORDS = /espn_s2=|swid=|cookie:|fingerprint/i;

let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-fxprivate-")));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** private-league's manifest with its harness replaced, the root made absolute, in a temp dir. */
function scripted(harness: unknown): string {
  const m = JSON.parse(readFileSync(path.join(PRIVATE, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const dir = mkdtempSync(path.join(tmp, "v-"));
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ ...m, root: path.resolve(PRIVATE, String(m.root)), harness }),
  );
  return dir;
}

const LABELS = {
  not_configured: () => scripted({ credential_state: "not_configured" }),
  stored: () =>
    scripted({
      credential_state: "stored",
      probe: { accepted: true, reason: null, probe: "settings" },
    }),
  rejected: () => PRIVATE,
} as const;

interface Server {
  readonly world: World;
  readonly client: Awaited<ReturnType<typeof connect>>["client"];
  readonly close: () => Promise<void>;
  /** Requests the store's limiter recorded (every fixture read passes it). */
  readonly requests: () => number;
}

async function server(dir: string): Promise<Server> {
  const world = await makeWorld({
    env: { EFF_FIXTURE_DIR: dir, EFF_TOOLSET: "full" },
    teamId: 2,
    clock: CLOCK_AT,
    publishEspn: false,
  });
  const c = await connect(world, { modern: true, options: { toolset: "full" } });
  return {
    world,
    client: c.client,
    close: async () => {
      await c.close();
      world.cleanup();
    },
    requests: () => world.store.repos.limiter.countSince(EPOCH),
  };
}

const codeOf = (b: Record<string, unknown>): unknown =>
  (b as { error?: { code?: unknown } }).error?.code ?? (b as { code?: unknown }).code;

type Body = Record<string, unknown> & { data?: unknown; warnings?: string[]; partial?: boolean };

describe("derivedLeaguePublicity: read from the variant's recorded settings before any request", () => {
  it("the committed private variants are private; the base and every other committed variant public; anything else unknown", () => {
    expect(derivedLeaguePublicity(PRIVATE)).toBe(false);
    expect(derivedLeaguePublicity(FX)).toBe(true);
    const variants = readdirSync(FX, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && readdirSync(path.join(FX, d.name)).includes("manifest.json"),
      )
      .map((d) => d.name);
    expect(variants.length).toBeGreaterThan(20);
    for (const v of PRIVATE_VARIANTS) expect(variants, v).toContain(v);
    for (const v of variants)
      expect(derivedLeaguePublicity(path.join(FX, v)), v).toBe(
        !(PRIVATE_VARIANTS as readonly string[]).includes(v),
      );
    expect(derivedLeaguePublicity(path.join(ROOT, "fixtures", "espn"))).toBeNull();
    expect(derivedLeaguePublicity("fixtures/espn/fx-10h/private-league")).toBeNull();
    expect(derivedLeaguePublicity(tmp)).toBeNull();
  });
});

describe.each([
  ["not_configured", "ESPN_REQUIRES_COOKIES"],
  ["rejected", "ESPN_AUTH_REJECTED"],
] as const)(
  "private-league, label %s: every league read refused with zero requests",
  (label, code) => {
    let s: Server;
    beforeAll(async () => {
      s = await server(LABELS[label]());
    }, 120_000);
    afterAll(async () => {
      await s.close();
    });

    it("espn_get_status reports the label; the league's publicity stays unknown (nothing read)", async () => {
      const r = await call(s.client, "espn_get_status", {});
      expect(r.isError).toBe(false);
      const d = r.body.data as { credential: { state: string }; league: { is_public: unknown } };
      expect(d.credential.state).toBe(label);
      expect(d.league.is_public).toBeNull();
      expect(s.requests()).toBe(0);
    });

    it.each([
      ["espn_get_league", {}],
      ["espn_list_transactions", { count: 20 }],
      ["espn_list_transactions", { pending: true }],
      ["espn_analyze_league_activity", {}],
      ["espn_analyze_schedule", {}],
      ["espn_get_roster", { week: 5 }],
    ] as const)(`%s %j → ${code}, no request`, async (tool, args) => {
      const r = await call(s.client, tool, args);
      expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(true);
      expect(codeOf(r.body)).toBe(code);
      expect(s.requests()).toBe(0);
      expect(JSON.stringify(r.body)).not.toMatch(COOKIE_WORDS);
    });
  },
);

describe("private-league, label stored: the recording is served, as a session read would be", () => {
  let s: Server;
  beforeAll(async () => {
    s = await server(LABELS.stored());
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it("espn_get_league answers, and says the league is private", async () => {
    const r = await call(s.client, "espn_get_league", {});
    expect(r.isError, JSON.stringify(r.body).slice(0, 300)).toBe(false);
    expect((r.body.data as { league: { is_public: unknown } }).league.is_public).toBe(false);
    expect(s.requests()).toBeGreaterThan(0);
    const st = await call(s.client, "espn_get_status", {});
    const d = st.body.data as { credential: { state: string }; league: { is_public: unknown } };
    expect(d.credential.state).toBe("stored");
    expect(d.league.is_public).toBe(false);
  });

  it("the feed, pending claims, E11 and a P1 analytics tool answer", async () => {
    const feed = await call(s.client, "espn_list_transactions", { count: 20, week: 2 });
    expect(feed.isError, JSON.stringify(feed.body).slice(0, 300)).toBe(false);
    expect((feed.body.data as { transactions: unknown[] }).transactions.length).toBeGreaterThan(0);
    const pending = await call(s.client, "espn_list_transactions", { pending: true });
    expect(pending.isError, JSON.stringify(pending.body).slice(0, 300)).toBe(false);
    expect((pending.body.data as { pending: unknown }).pending).toEqual([]);
    const act = await call(s.client, "espn_analyze_league_activity", {});
    expect(act.isError, JSON.stringify(act.body).slice(0, 300)).toBe(false);
    const warnings = (act.body as Body).warnings ?? [];
    expect(warnings.filter((w) => w.includes("ESPN session"))).toEqual([]);
    const sched = await call(s.client, "espn_analyze_schedule", {});
    expect(sched.isError, JSON.stringify(sched.body).slice(0, 300)).toBe(false);
  });
});

describe("private-league as committed: rejected, its one espn_check_auth accepts (validated), then E11 over fresh settings", () => {
  let s: Server;
  beforeAll(async () => {
    s = await server(PRIVATE);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it("validated after the probe: the recording is served", async () => {
    expect(codeOf((await call(s.client, "espn_get_league", {})).body)).toBe("ESPN_AUTH_REJECTED");
    const probe = await call(s.client, "espn_check_auth", {});
    expect(probe.isError, JSON.stringify(probe.body).slice(0, 300)).toBe(false);
    expect(probe.body.data).toMatchObject({
      accepted: true,
      probe: "settings",
      upstream_status: null,
    });
    expect(s.requests()).toBe(0);
    const st = await call(s.client, "espn_get_status", {});
    expect((st.body.data as { credential: { state: string } }).credential.state).toBe("validated");
    const lg = await call(s.client, "espn_get_league", {});
    expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
    expect((lg.body.data as { league: { is_public: unknown } }).league.is_public).toBe(false);
  });

  it("a second server on the same store starts again on the rejected label: fresh settings are served first, E11 answers its session-refusal partial lines, nothing is sent", async () => {
    // the seed's server above read the settings under `validated`; this one is a new process
    const again = buildServices({
      config: s.world.config,
      store: s.world.store,
      clock: s.world.clock,
      logger: s.world.logger,
      packageRoot: ROOT,
      home: path.join(s.world.root, "home"),
      fetch: () => Promise.reject(new Error("no network in tests")),
      loadKeyring: () => Promise.reject(new Error("no keychain in tests")),
    });
    const c = await connect(
      { services: { ...again.services, newSeed: () => 7 }, options: again.options },
      { modern: true, options: { toolset: "full" } },
    );
    try {
      const n = s.requests();
      const st = await call(c.client, "espn_get_status", {});
      const d = st.body.data as { credential: { state: string }; league: { is_public: unknown } };
      expect(d.credential.state).toBe("rejected");
      expect(d.league.is_public).toBe(false);
      // the settings are fresh in the store: served before the gate is asked (R10-27)
      const lg = await call(c.client, "espn_get_league", {});
      expect(lg.isError, JSON.stringify(lg.body).slice(0, 300)).toBe(false);
      // E11: the basics from the fresh settings, the feed and the league reads refused
      const act = await call(c.client, "espn_analyze_league_activity", {});
      expect(act.isError, JSON.stringify(act.body).slice(0, 400)).toBe(false);
      const body = act.body as Body;
      expect(body.partial).toBe(true);
      expect(body.warnings).toContain(SESSION_READ_WARNINGS.feed_rejected);
      expect(body.warnings).toContain(
        activityLeagueReadsWarning("rejected", ["standings", "rosters", "free-agent pool"]),
      );
      expect((body.warnings ?? []).filter((w) => w.includes("budget"))).toEqual([]);
      // the feed and pending claims refused the same way; a P1 analytics tool fails as every tool
      const feed = await call(c.client, "espn_list_transactions", { count: 20 });
      expect(codeOf(feed.body)).toBe("ESPN_AUTH_REJECTED");
      const sched = await call(c.client, "espn_analyze_schedule", {});
      expect(codeOf(sched.body)).toBe("ESPN_AUTH_REJECTED");
      // zero requests from the rejected server: everything it answered came from the store
      expect(s.requests()).toBe(n);
      expect(JSON.stringify(body)).not.toMatch(COOKIE_WORDS);
    } finally {
      await c.close();
      again.close();
    }
  });
});

describe("every public variant is unchanged: the label never governs an auto or feed read there", () => {
  const publicVariants = readdirSync(FX, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !(PRIVATE_VARIANTS as readonly string[]).includes(d.name) &&
        readdirSync(path.join(FX, d.name)).includes("manifest.json"),
    )
    .map((d) => d.name);

  it.each([FX, ...publicVariants.map((v) => path.join(FX, v))])(
    "%s: a rejected label is never asked for the settings or the feed; both are served",
    async (dir) => {
      const clock = fixedClock(CLOCK_AT);
      let asked = 0;
      const limiter = new MemoryLimiterRepo();
      const provider = createEspnProvider({
        config: {
          leagueId: "0",
          season: 2026,
          teamId: 2,
          espnReadHost: "lm-api-reads.fantasy.espn.com",
          fixtureRecord: false,
          fixtureDir: dir,
        },
        repos: { limiter, espnCache: new MemoryCache(), driftState: new MemoryDrift() },
        credentials: null,
        clock,
        sleep: (ms) => {
          clock.advance(ms);
          return Promise.resolve();
        },
        scoring: translateScoringInput,
        fixtureCredentialLabel: () => {
          asked++;
          return "rejected";
        },
      });
      const ref = { platform: "espn", league_id: "0", season: 2026 } as const;
      await provider.getLeague(ref);
      await provider.listTransactions(ref, {
        types: ["WAIVER", "FREEAGENT"],
        week: 2,
        since: null,
        count: 10,
        team_id: null,
      });
      expect(asked, dir).toBe(0);
      expect(limiter.rows.length).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("nothing outside fixture mode reaches the flag or the label", () => {
  const deps = (credentials: FakeAuthority | null) => {
    const clock = fixedClock(CLOCK_AT);
    const sent: string[] = [];
    let asked = 0;
    const provider = new EspnProvider({
      config: {
        leagueId: "0",
        season: 2026,
        teamId: 2,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
      },
      fetch: (url) => {
        sent.push(url);
        return Promise.resolve(jsonResponse({ messages: ["not authorized"] }, 401));
      },
      credentials,
      repos: {
        limiter: new MemoryLimiterRepo(),
        cache: new MemoryCache(),
        driftState: new MemoryDrift(),
      },
      clock,
      scoring: translateScoringInput,
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
      fixturePrivateLeague: true,
      fixtureCredentialLabel: () => {
        asked++;
        return "stored";
      },
    });
    return { provider, sent, asked: () => asked };
  };
  const ref = { platform: "espn", league_id: "0", season: 2026 } as const;

  it("createEspnProvider outside fixture mode never sets the flag: the league read is the keyless learning read", async () => {
    const clock = fixedClock(CLOCK_AT);
    const sent: string[] = [];
    const provider = createEspnProvider({
      config: {
        leagueId: "0",
        season: 2026,
        teamId: 2,
        espnReadHost: "lm-api-reads.fantasy.espn.com",
        fixtureRecord: false,
        fixtureDir: null,
      },
      repos: {
        limiter: new MemoryLimiterRepo(),
        espnCache: new MemoryCache(),
        driftState: new MemoryDrift(),
      },
      credentials: null,
      clock,
      fetch: (url) => {
        sent.push(url);
        return Promise.resolve(jsonResponse({ messages: ["not authorized"] }, 401));
      },
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
      scoring: translateScoringInput,
      fixtureCredentialLabel: () => "stored",
    });
    await expect(provider.getLeague(ref)).rejects.toMatchObject({
      effCode: "ESPN_REQUIRES_COOKIES",
    });
    // the label "stored" would have served it: it was never read; one keyless request learned it
    expect(sent).toHaveLength(1);
  });

  it("beside a credential authority the flag and the label are dropped: the authority decides", async () => {
    // a rejected session on a league of unknown publicity: plan 02 §2.1's one anonymous read
    // learns it is private (its 401), then the short-circuit — never the label's "stored"
    const w = deps(new FakeAuthority("rejected", { ok: false, reason: "rejected" }));
    await expect(w.provider.getLeague(ref)).rejects.toMatchObject({
      effCode: "ESPN_AUTH_REJECTED",
    });
    expect(w.sent).toHaveLength(1);
    expect(w.asked()).toBe(0);
    const ok = deps(
      new FakeAuthority("validated", {
        ok: true,
        header: testCookieHeader("{00000000-0000-4000-8000-000000000042}"),
      }),
    );
    await ok.provider.getLeague(ref).catch(() => undefined);
    // the stored cookie's own read went out (and was refused by this fake): never the label's
    expect(ok.sent.length).toBeGreaterThan(0);
    expect(ok.asked()).toBe(0);
  });
});
