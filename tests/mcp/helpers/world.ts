// world.ts — the MCP tests' fixture world (plan 05 §3: recorded fixtures + injected fetch; no test
// ever touches the network, ~/.config, ~/.cache or the real keychain): a temp HOME/config/cache, the
// real store, the ESPN pro schedule and player universe published as dataset files from the recorded
// season views, optionally the nflverse excerpts through the REAL runner + publisher, the composition
// root's own buildServices over the REAL EspnProvider with a fixture-backed fetch, and a real Client
// connected in-process (InMemoryTransport). The credential store is a file in the temp config dir
// (nothing stored) and the keyring loader throws, so a keychain can never be reached.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLogger, type Logger } from "../../../src/cli/log.js";
import { backupDir, datasetDir, storePath } from "../../../src/config/paths.js";
import { loadConfig, type Config } from "../../../src/config/schema.js";
import { parseIso, seededRng, toIso, type FixedClock } from "../../../src/domain/clock.js";
import { CHECKED_IN_OVERRIDES } from "../../../src/domain/crosswalk/overrides.js";
import { rebuildCrosswalk } from "../../../src/domain/crosswalk/rebuild.js";
import { createServer } from "../../../src/mcp/server.js";
import type { McpServerOptions, McpServices } from "../../../src/mcp/services.js";
import { createFixtureFetch, type FetchLike } from "../../../src/providers/espn/index.js";
import { buildServices, type Wiring } from "../../../src/services/index.js";
import { NFLVERSE_SOURCES } from "../../../src/sources/nflverse/index.js";
import { fsTempArea, runRefresh } from "../../../src/sources/runner.js";
import {
  columnsHash,
  DS_PLAYERS,
  DS_PRO_SCHEDULE,
  DS_PRO_TEAMS,
} from "../../../src/store/datasets/tables.js";
import { storeFactory } from "../../../src/store/index.js";
import type { DatasetRow, Store } from "../../../src/store/types.js";
import { fakeHttp } from "../../sources/nflverse/helpers/harness.js";
import { fixtureRoutes } from "../../sources/nflverse/helpers/fixtures.js";

/** The repository root. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** The recorded ESPN fixtures (fixtures/espn; manifest.json inside). */
export const ESPN_FIXTURES = path.join(ROOT, "fixtures", "espn");
/** The fixture season and the clock: the recording day (week 4 current; weeks 1–3 final). */
export const SEASON = 2026;
export const T0 = "2026-10-06T12:00:00.000Z";

export type LeagueSlot = "league-a" | "league-b" | "league-c";

/**
 * A clock that starts at `start` and runs with real time (the ESPN limiter's per-second window must
 * see time pass), plus `advance`/`set` jumps for tests.
 */
export function runningClock(start: number | string): FixedClock {
  let base = typeof start === "number" ? start : parseIso(start);
  let origin = performance.now();
  const now = (): number => Math.floor(base + (performance.now() - origin));
  return {
    nowMs: now,
    nowIso: () => toIso(now()),
    advance(ms: number) {
      base += ms;
    },
    set(at: number | string) {
      base = typeof at === "number" ? at : parseIso(at);
      origin = performance.now();
    },
  };
}

/** Options of one world. */
export interface WorldOptions {
  readonly league?: LeagueSlot;
  /** ESPN_TEAM_ID (default 1 — a team of every recorded league). */
  readonly teamId?: number | null;
  /** Publish the pro schedule + player universe dataset files (default true). */
  readonly publishEspn?: boolean;
  /** Publish the nflverse excerpts through the real runner (default false; slower). */
  readonly publishNflverse?: boolean;
  /** Extra env for loadConfig (EFF_TOOLSET, EFF_ENABLE_WRITES, …). */
  readonly env?: Readonly<Record<string, string>>;
  readonly clock?: string;
  /** Wraps the fixture fetch (fault injection). */
  readonly wrapFetch?: (inner: FetchLike) => FetchLike;
}

/** One fixture world. */
export interface World {
  readonly root: string;
  readonly cache: string;
  readonly clock: FixedClock;
  readonly store: Store;
  readonly config: Config;
  readonly wiring: Wiring;
  readonly services: McpServices;
  readonly options: McpServerOptions;
  readonly logLines: string[];
  readonly logger: Logger;
  /** Every URL the provider asked the fixture fetch for. */
  readonly requests: string[];
  cleanup(): void;
}

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(ESPN_FIXTURES, rel), "utf8")) as unknown;
}

interface WirePlayerEntry {
  readonly id: number;
  readonly player?: { readonly id: number };
}

/**
 * The fixture fetch plus the gaps a recording cannot cover in tests: a `filterIds` request for any
 * id subset is answered from the league's recorded kona_player_info pages (the players present), and
 * an mRoster request for an unrecorded scoring period is answered with the newest recorded one ≤ it.
 * Everything else is the recorded fixture (or the fixture's own refusal).
 */
export function fixtureFetchPlus(league: LeagueSlot, requests: string[]): FetchLike {
  const base = createFixtureFetch({ dir: ESPN_FIXTURES, league });
  const pool = new Map<number, unknown>();
  for (const f of ["kona_player_info.ids.json", "kona_player_info.json"]) {
    try {
      const body = readJson(`recorded/${league}/${f}`) as { players?: WirePlayerEntry[] };
      for (const p of body.players ?? []) pool.set(p.id, p);
    } catch {
      // a league without that recording
    }
  }
  return async (url, init) => {
    requests.push(url);
    const u = new URL(url);
    const params = new URLSearchParams(u.search);
    const views = params.getAll("view");
    const filterRaw = (() => {
      const h = init.headers;
      if (h === undefined || h instanceof Headers || Array.isArray(h)) return null;
      for (const [k, v] of Object.entries(h))
        if (k.toLowerCase() === "x-fantasy-filter") return v ?? null;
      return null;
    })();
    try {
      return await base(url, init);
    } catch (e) {
      if ((e as { name?: unknown }).name !== "FixtureError") throw e;
      const json = (b: unknown): Response =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { "content-type": "application/json;charset=utf-8" },
        });
      if (views.length === 1 && views[0] === "kona_player_info" && filterRaw !== null) {
        const f = JSON.parse(filterRaw) as { players?: { filterIds?: { value?: number[] } } };
        const ids = f.players?.filterIds?.value;
        if (Array.isArray(ids)) {
          const players = ids.map((id) => pool.get(id)).filter((p) => p !== undefined);
          const sample = readJson(`recorded/${league}/kona_player_info.ids.json`) as Record<
            string,
            unknown
          >;
          return json({ ...sample, players });
        }
        return json(readJson(`recorded/${league}/kona_player_info.json`));
      }
      // P1 views a recording cannot key by every filter (plan 05 §3): the league's recorded
      // kona_playercard for any id subset, and mPositionalRatings as embedded in every pool page
      if (views.length === 1 && views[0] === "kona_playercard")
        return json(readJson(`recorded/${league}/kona_playercard.json`));
      if (views.length === 1 && views[0] === "mPositionalRatings") {
        const page = readJson(`recorded/${league}/kona_player_info.json`) as {
          positionAgainstOpponent?: unknown;
        };
        return json({ positionAgainstOpponent: page.positionAgainstOpponent ?? {} });
      }
      if (views.length === 1 && views[0] === "mTransactions2")
        return json({ transactions: embeddedTransactions(league) });
      if (views.length === 1 && views[0] === "mPendingTransactions")
        return json({ pendingTransactions: [] });
      const sp = Number(params.get("scoringPeriodId"));
      if (views.length === 1 && views[0] === "mRoster" && Number.isInteger(sp) && sp > 3) {
        params.set("scoringPeriodId", "3");
        return base(`${u.origin}${u.pathname}?${params.toString()}`, init);
      }
      throw e;
    }
  };
}

/** The recorded transactions embedded in the league's kona_playercard players, deduplicated by id. */
export function embeddedTransactions(league: LeagueSlot): unknown[] {
  const out = new Map<unknown, unknown>();
  try {
    const card = readJson(`recorded/${league}/kona_playercard.json`) as {
      players?: Record<string, unknown>[];
    };
    for (const p of card.players ?? []) {
      const list = (p.transactions as Record<string, unknown>[] | undefined) ?? [];
      for (const t of list) if (!out.has(t.id)) out.set(t.id, t);
    }
  } catch {
    // no card recording for this league
  }
  return [...out.values()];
}

/** Publishes `ds_pro_schedule` + `ds_pro_teams` and `ds_players` from the recorded season views. */
export async function publishEspnDatasets(t: {
  storePath: string;
  datasetDir: string;
  clock: FixedClock;
}): Promise<void> {
  const publisher = storeFactory.openPublisher({
    storePath: t.storePath,
    datasetDir: t.datasetDir,
    clock: t.clock,
  });
  try {
    const sched = readJson("recorded/season/proTeamSchedules_wl.json") as {
      settings: {
        proTeams: {
          id: number;
          abbrev: string;
          location: string;
          name: string;
          byeWeek: number;
          proGamesByScoringPeriod?: Record<
            string,
            {
              id: number;
              scoringPeriodId: number;
              date: number;
              startTimeTBD: boolean;
              validForLocking: boolean;
              statsOfficial: boolean;
              homeProTeamId: number;
              awayProTeamId: number;
            }[]
          >;
        }[];
      };
    };
    const games = new Map<number, DatasetRow>();
    const teams: DatasetRow[] = [];
    for (const t2 of sched.settings.proTeams) {
      teams.push({
        season: SEASON,
        pro_team_id: t2.id,
        abbrev: t2.abbrev,
        location: t2.location,
        name: t2.name,
        bye_week: t2.byeWeek >= 1 && t2.byeWeek <= 22 ? t2.byeWeek : null,
      });
      for (const list of Object.values(t2.proGamesByScoringPeriod ?? {}))
        for (const g of list)
          games.set(g.id, {
            season: SEASON,
            espn_game_id: g.id,
            week: g.scoringPeriodId,
            date_ms: g.date,
            start_time_tbd: g.startTimeTBD ? 1 : 0,
            valid_for_locking: g.validForLocking ? 1 : 0,
            stats_official: g.statsOfficial ? 1 : 0,
            home_pro_team_id: g.homeProTeamId,
            away_pro_team_id: g.awayProTeamId,
          });
    }
    const out1 = await publisher.publish(
      "espn:pro_schedule",
      `fixture_${String(SEASON)}`,
      null,
      (w) => {
        w.createTable(DS_PRO_SCHEDULE);
        w.createTable(DS_PRO_TEAMS);
        const a = w.insert("ds_pro_schedule", [...games.values()]);
        const b = w.insert("ds_pro_teams", teams);
        return Promise.resolve({
          rows: a + b,
          tables: [
            { name: "ds_pro_schedule", rows: a },
            { name: "ds_pro_teams", rows: b },
          ],
          seasons: [SEASON],
          columns_hash: columnsHash("espn:pro_schedule"),
        });
      },
    );
    if (!out1.ok) throw new Error(`publish espn:pro_schedule failed: ${out1.error}`);
    const players = readJson("recorded/season/players_wl.json") as {
      id: number;
      fullName: string;
      firstName?: string;
      lastName?: string;
      defaultPositionId: number;
      proTeamId: number;
      eligibleSlots?: number[];
      ownership?: { percentOwned?: number };
      droppable?: boolean;
      lastNewsDate?: number;
    }[];
    const rows: DatasetRow[] = players.map((p) => ({
      season: SEASON,
      espn_id: p.id,
      full_name: p.fullName,
      first_name: p.firstName ?? null,
      last_name: p.lastName ?? null,
      position_id: p.defaultPositionId,
      pro_team_id: p.proTeamId,
      eligible_slots: Array.isArray(p.eligibleSlots) ? JSON.stringify(p.eligibleSlots) : null,
      percent_owned:
        typeof p.ownership?.percentOwned === "number" ? p.ownership.percentOwned : null,
      droppable: p.droppable === undefined ? null : p.droppable ? 1 : 0,
      last_news_date_ms: p.lastNewsDate ?? null,
    }));
    const out2 = await publisher.publish("espn:players", `fixture_${String(SEASON)}`, null, (w) => {
      w.createTable(DS_PLAYERS);
      const n = w.insert("ds_players", rows);
      return Promise.resolve({
        rows: n,
        tables: [{ name: "ds_players", rows: n }],
        seasons: [SEASON],
        columns_hash: columnsHash("espn:players"),
      });
    });
    if (!out2.ok) throw new Error(`publish espn:players failed: ${out2.error}`);
  } finally {
    publisher.close();
  }
}

/** The nflverse excerpts published through the real runner (plan 05 §3.2). */
export async function publishNflverse(
  store: Store,
  t: { storePath: string; datasetDir: string; cache: string; clock: FixedClock },
): Promise<void> {
  const publisher = storeFactory.openPublisher({
    storePath: t.storePath,
    datasetDir: t.datasetDir,
    clock: t.clock,
  });
  try {
    const { http, download } = fakeHttp(fixtureRoutes());
    for (const id of [
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:stats_player_week",
    ] as const) {
      await runRefresh(
        { source: NFLVERSE_SOURCES[id], seasons: [SEASON], week: null },
        {
          http,
          download,
          clock: t.clock,
          rng: seededRng(1),
          publisher,
          refreshLog: store.repos.refreshLog,
          proSchedule: store.datasets.proSchedule,
          nflGames: store.datasets.nflGames,
          temp: fsTempArea(path.join(t.cache, "tmp")),
          sleep: () => Promise.resolve(),
        },
      );
    }
  } finally {
    publisher.close();
  }
  store.reopenChangedDatasets();
}

/** Builds a fixture world. */
export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-mcp-")));
  chmodSync(root, 0o700);
  const home = path.join(root, "home");
  const configDir = path.join(root, "config");
  const cache = path.join(root, "cache");
  for (const d of [home, configDir, cache]) mkdirSync(d, { mode: 0o700 });
  const clock = runningClock(o.clock ?? T0);
  const league = o.league ?? "league-a";
  const teamId = o.teamId === undefined ? 1 : o.teamId;
  const env: Record<string, string> = {
    ESPN_LEAGUE_ID: "0",
    ESPN_SEASON: String(SEASON),
    EFF_CONFIG_DIR: configDir,
    EFF_CACHE_DIR: cache,
    EFF_CREDENTIAL_STORE: "file",
    EFF_CREDENTIAL_FILE: path.join(configDir, "session.json"),
    ...(teamId === null ? {} : { ESPN_TEAM_ID: String(teamId) }),
    ...(o.env ?? {}),
  };
  const config = loadConfig({ env, file: undefined, home, repoRoot: ROOT, nowMs: clock.nowMs() });
  const sp = storePath(cache);
  const dd = datasetDir(cache);
  const store = storeFactory.open({
    path: sp,
    datasetDir: dd,
    backupDir: backupDir(cache),
    clock,
    migrate: true,
  });
  const t = { storePath: sp, datasetDir: dd, cache, clock };
  if (o.publishEspn !== false) await publishEspnDatasets(t);
  if (o.publishNflverse === true) {
    await publishNflverse(store, t);
    const r = rebuildCrosswalk({
      season: SEASON,
      roster: store.rosterWeekly,
      universe: store.playerUniverse,
      nflPlayers: store.nflPlayers,
      repository: store.repos.crosswalk,
      overrides: CHECKED_IN_OVERRIDES,
      now: clock.nowIso(),
    });
    if (r.status !== "done") throw new Error(`crosswalk rebuild skipped: ${r.reason}`);
  }
  store.reopenChangedDatasets();
  const logLines: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (l) => logLines.push(l),
    now: () => clock.nowIso(),
  });
  const requests: string[] = [];
  const inner = fixtureFetchPlus(league, requests);
  const wiring = buildServices({
    config,
    store,
    clock,
    logger,
    packageRoot: ROOT,
    home,
    fetch: o.wrapFetch === undefined ? inner : o.wrapFetch(inner),
    loadKeyring: () => Promise.reject(new Error("keychain disabled in tests")),
  });
  return {
    root,
    cache,
    clock,
    store,
    config,
    wiring,
    services: { ...wiring.services, newSeed: () => 7 },
    options: wiring.options,
    logLines,
    logger,
    requests,
    cleanup: () => {
      wiring.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A connected client over a server built from `world`: the legacy era through `server.connect`, or
 * the 2026-07-28 era through `serveStdio` (the production entry) over an in-memory transport.
 */
export async function connect(
  world: Pick<World, "services" | "options">,
  opts: {
    modern?: boolean;
    options?: Partial<McpServerOptions>;
    services?: Partial<McpServices>;
  } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const options = { ...world.options, ...opts.options };
  const services: McpServices = { ...world.services, ...opts.services };
  const [a, b] = InMemoryTransport.createLinkedPair();
  if (opts.modern === true) {
    const handle = serveStdio(() => createServer(services, options), { transport: a });
    const client = new Client(
      { name: "eff-test-client", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(b);
    return {
      client,
      close: async () => {
        await client.close();
        await handle.close();
      },
    };
  }
  const server = createServer(services, options);
  const client = new Client({ name: "eff-test-client", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The parsed envelope (or error body) from a tool result's one text block. */
export function body(r: unknown): Record<string, unknown> {
  const content = (r as { content: { type: string; text: string }[] }).content;
  const first = content[0];
  if (first === undefined) throw new Error("no content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * The client-side request timeout of a test call: generous, because an analytics call under coverage
 * instrumentation and a loaded CI runner can take several times its real-time cost (the SDK's own
 * default is 60 s). The server's own per-call deadlines are what the tests assert, never this.
 */
export const TEST_CALL_TIMEOUT_MS = 300_000;

/** Calls a tool and returns `{ isError, body }`. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; body: Record<string, unknown>; raw: unknown }> {
  const r = await client.callTool({ name, arguments: args }, { timeout: TEST_CALL_TIMEOUT_MS });
  return { isError: (r as { isError?: boolean }).isError === true, body: body(r), raw: r };
}
