// helpers.ts — in-memory ports for the ESPN provider tests (plan 05 §2, §4.1: injected fetch, no
// network, no cookie ever sent to ESPN): a limiter repository that runs the store's pure
// `limiterDecision` over an in-memory row list, an ESPN cache map, a drift_state row, a scripted
// CredentialAuthority, a stub scoring translator, a scripted fetch, and the recorded fixtures.
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CookieHeader,
  CookieHeaderResult,
  CredentialAuthority,
  CredentialObservation,
  CredentialState,
} from "../../../src/auth/types.js";
import type { RequestOutcome } from "../../../src/config/schema.js";
import { fixedClock, type FixedClock } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import { createFixtureFetch } from "../../../src/providers/espn/fixture.js";
import { EspnProvider, type EspnProviderDeps } from "../../../src/providers/espn/provider.js";
import type { FetchLike } from "../../../src/providers/espn/transport.js";
import type { EspnScoringInput } from "../../../src/providers/espn/types.js";
import {
  limiterDecision,
  type DriftStateRepository,
  type DriftStateRow,
  type EspnCacheEntry,
  type EspnCacheRepository,
  type LimiterRepository,
  type LimiterRequest,
  type LimiterVerdict,
  type RequestCounts,
} from "../../../src/store/types.js";
import { ROOT } from "../../lint/helpers.js";

export const FIXTURES = path.join(ROOT, "fixtures", "espn");
export const RECORDED = path.join(FIXTURES, "recorded");
export const LEAGUES = ["league-a", "league-b", "league-c"] as const;
export type LeagueSlot = (typeof LEAGUES)[number];
/** The recorded season (fixtures/espn/manifest.json `season`). */
export const SEASON = 2026;
/** The fixture league id (CLAUDE.md: fixtures use league id 0). */
export const LEAGUE_ID = "0";
/** A moment inside the recorded week (the recording was 2026-10-06). */
export const NOW_ISO = "2026-10-06T12:00:00.000Z";

/** Reads one recorded fixture body. */
export function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, rel), "utf8")) as unknown;
}

/** A recorded body, re-assembled when it was split (`mRoster.spN.p1.json` + `.p2.json` …). */
export function loadRoster(slot: LeagueSlot, week: number): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  for (let i = 1; i <= 4; i++) {
    try {
      parts.push(
        loadFixture(`recorded/${slot}/mRoster.sp${String(week)}.p${String(i)}.json`) as Record<
          string,
          unknown
        >,
      );
    } catch {
      break;
    }
  }
  const first = parts[0] ?? {};
  return { ...first, teams: parts.flatMap((p) => p.teams as unknown[]) };
}

/** An in-memory LimiterRepository running the store's pure decision (the cross-process contract). */
export class MemoryLimiterRepo implements LimiterRepository {
  rows: { id: number; at: number; keyless: boolean; origin: string; outcome: RequestOutcome }[] =
    [];
  private next = 1;
  failWrites = false;
  tryRecord(req: LimiterRequest): LimiterVerdict {
    if (this.failWrites) throw new Error("store busy");
    const now = Date.parse(req.at);
    const windowRows = req.windows.map((w) =>
      this.rows.filter((r) => r.at > Date.parse(w.start) && r.at <= now).map((r) => r.at),
    );
    const cap = req.dailyCap;
    const decision = limiterDecision({
      nowMs: now,
      windows: req.windows.map((w) => ({ startMs: Date.parse(w.start), max: w.max })),
      windowRows,
      dailyCap:
        cap === null
          ? null
          : {
              max: cap.max,
              used: this.rows.filter(
                (r) =>
                  r.origin === "job" &&
                  r.keyless === req.keyless &&
                  r.at >= Date.parse(cap.dayStart),
              ).length,
              nextDayStartMs: Date.parse(cap.dayStart) + 86_400_000,
            },
    });
    if (!decision.ok) return decision;
    const id = this.next++;
    this.rows.push({ id, at: now, keyless: req.keyless, origin: req.origin, outcome: "pending" });
    return { ok: true, id };
  }
  recordOutcome(id: number, outcome: RequestOutcome): void {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.outcome = outcome;
  }
  countSince(since: string): number {
    return this.rows.filter((r) => r.at >= Date.parse(since)).length;
  }
  countToday(dayStart: string): RequestCounts {
    const t = this.rows.filter((r) => r.at >= Date.parse(dayStart));
    const c = (o: string, k: boolean) => t.filter((r) => r.origin === o && r.keyless === k).length;
    return {
      server: { cookie: c("server", false), keyless: c("server", true) },
      job: { cookie: c("job", false), keyless: c("job", true) },
    };
  }
  recentOutcomes(limit: number) {
    return [...this.rows]
      .sort((a, b) => b.at - a.at || b.id - a.id)
      .slice(0, limit)
      .map((r) => ({ at: new Date(r.at).toISOString(), outcome: r.outcome }));
  }
  count304Since(since: string): number {
    return this.rows.filter((r) => r.at >= Date.parse(since) && r.outcome === "not_modified")
      .length;
  }
  prune(before: string): number {
    const n = this.rows.length;
    this.rows = this.rows.filter((r) => r.at >= Date.parse(before));
    return n - this.rows.length;
  }
}

/** An in-memory espn_cache. */
export class MemoryCache implements EspnCacheRepository {
  readonly map = new Map<string, EspnCacheEntry>();
  puts = 0;
  get(key: string): EspnCacheEntry | null {
    return this.map.get(key) ?? null;
  }
  put(entry: EspnCacheEntry) {
    this.puts++;
    this.map.set(entry.key, entry);
    return { written: true as const };
  }
  prune(): number {
    return 0;
  }
}

/** The one drift_state row. */
export class MemoryDrift implements DriftStateRepository {
  row: DriftStateRow | null = null;
  puts = 0;
  get(): DriftStateRow | null {
    return this.row;
  }
  put(row: DriftStateRow): void {
    this.puts++;
    this.row = row;
  }
}

/** A built header for tests (synthetic, never a real cookie: the secret part is a fixed filler). */
export function testCookieHeader(swid: string): CookieHeader {
  return `espn_s2=${"A".repeat(16)}TESTONLY${"z".repeat(16)}; SWID=${swid}` as CookieHeader;
}

/** A scripted CredentialAuthority: a state, a header result, and the observations it received. */
export class FakeAuthority implements CredentialAuthority {
  observations: CredentialObservation[] = [];
  headerCalls = 0;
  constructor(
    public current: CredentialState,
    public header: CookieHeaderResult,
  ) {}
  state(): CredentialState {
    return this.current;
  }
  getCookieHeader(): Promise<CookieHeaderResult> {
    this.headerCalls++;
    if (this.current === "rejected") return Promise.resolve({ ok: false, reason: "rejected" });
    if (this.current === "not_configured")
      return Promise.resolve({ ok: false, reason: "not_configured" });
    return Promise.resolve(this.header);
  }
  observe(o: CredentialObservation): Promise<CredentialState> {
    this.observations.push(o);
    if (o.kind === "rejected") this.current = "rejected";
    else if (o.kind === "accepted") this.current = "validated";
    return Promise.resolve(this.current);
  }
}

/** A probe-capable authority (the short-circuit-exempt access of plan 02 §2.1). */
export class FakeProbeAuthority extends FakeAuthority {
  probeCalls = 0;
  getCookieHeaderForProbe(): Promise<CookieHeaderResult> {
    this.probeCalls++;
    return Promise.resolve(this.header);
  }
}

/**
 * The recorded fixtures for a test that simulates a cookie-bearing session: the Cookie header is
 * recorded by `recording()` and stripped here (fixture mode itself refuses cookies — a guard).
 */
export function fixturesIgnoringCookies(slot: LeagueSlot): FetchLike {
  const inner = createFixtureFetch({ dir: FIXTURES, league: slot });
  return (url, init) => {
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    delete headers.cookie;
    return inner(url, { ...init, headers });
  };
}

/** A stub translator: echoes the items into a minimal ScoringSettings (the real one is the scoring module's). */
export function stubScoring(input: EspnScoringInput): ScoringSettings {
  return {
    platform: "espn",
    rules: input.items.map((i) => ({
      canonical: null,
      platform_id: String(i.stat_id),
      abbr: "",
      points: i.points,
      overrides: i.overrides,
      is_reverse: i.is_reverse,
      applies_to: ["O"],
      disputed: false,
    })),
    families: [],
    matchup: {
      tie_rule: input.matchup_tie_rule ?? "NONE",
      playoff_tie_rule: input.playoff_tie_rule ?? "NONE",
      home_bonus: input.home_bonus,
      playoff_home_bonus: input.playoff_home_bonus,
    },
    rounding: { mode: "exact", verified: false },
    settings_hash: "0".repeat(64),
  };
}

/** A recorded call: what the provider sent (headers lower-cased). */
export interface SentRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirect: RequestInit["redirect"];
}

/** Wraps a fetch so every request is recorded (no network: the inner fetch is a fake or fixtures). */
export function recording(inner: FetchLike): { fetch: FetchLike; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  return {
    sent,
    fetch: (url, init) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
        h[k.toLowerCase()] = v;
      sent.push({ url, headers: h, redirect: init.redirect });
      return inner(url, init);
    },
  };
}

/** A JSON response. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", ...headers },
  });
}

/** The world a provider test runs in. */
export interface World {
  readonly provider: EspnProvider;
  readonly clock: FixedClock;
  readonly limiter: MemoryLimiterRepo;
  readonly cache: MemoryCache;
  readonly drift: MemoryDrift;
  readonly sent: SentRequest[];
  readonly sleeps: number[];
  readonly ref: { readonly platform: "espn"; readonly league_id: string; readonly season: number };
}

/** Builds a provider over `fetch` (default: the recorded fixtures of `slot`) with in-memory ports. */
export function makeWorld(
  opts: {
    readonly slot?: LeagueSlot;
    readonly fetch?: FetchLike;
    readonly credentials?: CredentialAuthority | null;
    readonly teamId?: number | null;
    readonly over?: Partial<EspnProviderDeps>;
    readonly limiter?: MemoryLimiterRepo;
    readonly cache?: MemoryCache;
    readonly drift?: MemoryDrift;
    readonly clock?: FixedClock;
  } = {},
): World {
  const clock = opts.clock ?? fixedClock(NOW_ISO);
  const limiter = opts.limiter ?? new MemoryLimiterRepo();
  const cache = opts.cache ?? new MemoryCache();
  const drift = opts.drift ?? new MemoryDrift();
  const sleeps: number[] = [];
  const inner =
    opts.fetch ?? createFixtureFetch({ dir: FIXTURES, league: opts.slot ?? "league-a" });
  const rec = recording(inner);
  const provider = new EspnProvider({
    config: {
      leagueId: LEAGUE_ID,
      season: SEASON,
      teamId: opts.teamId ?? null,
      espnReadHost: "lm-api-reads.fantasy.espn.com",
      fixtureRecord: false,
    },
    fetch: rec.fetch,
    credentials: opts.credentials ?? null,
    repos: { limiter, cache, driftState: drift },
    clock,
    scoring: stubScoring,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...opts.over,
  });
  return {
    provider,
    clock,
    limiter,
    cache,
    drift,
    sent: rec.sent,
    sleeps,
    ref: { platform: "espn", league_id: LEAGUE_ID, season: SEASON },
  };
}
