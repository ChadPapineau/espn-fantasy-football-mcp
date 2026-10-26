// ops.ts — G1 `espn_get_status` (plan 07 G1; plan 01 §8 snapshot: server, credential observations
// from the credential_state row — never a value, length or fingerprint (plan 02 §2.3) —, capabilities
// with the PHASE W SEAM verdict, drift, limiter, sources, crosswalk, store, snapshots, checks; budget
// 0: every ESPN read here runs under a ZERO-request budget, so a cold cache answers "unknown", never
// a request) and G2 `espn_check_auth` (plan 07 G2: the one explicit credential probe, at most once
// per minute, `RATE_LIMITED` with `retry_after_s` otherwise; the board body is never returned).
// Also the status resources' payloads (plan 07 §4.1 espn-ff://status/freshness, /status/drift).
// Ported from sibling @5daa625 (src/mcp/tools/ops.ts), adapted (ESPN credential/drift/limiter).
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  DATASET_SOURCE_IDS,
  FRESHNESS_CLASS_IDS,
  FRESHNESS_TABLE,
  SOURCE_REGISTRY,
  stampState,
  type DatasetSourceId,
  type FreshnessClassId,
} from "../../config/freshness.js";
import { CREDENTIAL_STATES, DRIFT_STATUSES, SEEDING_MODES, TOOLSETS } from "../../config/schema.js";
import { TOP_OWNED_PERCENT } from "../../domain/crosswalk/types.js";
import { CHECK_IDS, type CheckRow } from "../../domain/league/types.js";
import {
  NO_WRITES,
  WRITE_GATE_FAILING_THIS_BUILD,
  createUpstreamBudget,
  type CheckAuthData,
  type StatusData,
} from "../../providers/platform.js";
import type { FreshnessClassRow, FreshnessResourceData } from "../envelope.js";
import { EffError, SERVER_HINTS } from "../errors.js";
import { defineTool, type ToolContext } from "../define.js";
import type { DatasetRefusalCode, DriftView, McpServerOptions } from "../services.js";
import { TOOL_CONTRACT } from "../contract.js";
import { clockWeek, isTeamUnitIdentity, leagueRef, ttlContextOf, turn } from "./common.js";
import { count, iso, isoNull } from "./schemas.js";

/**
 * The SDK the server is built on: package.json's exact pin of @modelcontextprotocol/server, which
 * tests/mcp/sdk-version.test.ts holds equal to this constant, the lockfile and the installed package
 * (src/mcp reads no file — plan 01 §1.1). A version bump that misses it fails that test (Stage C
 * finding status-sdk-version-stale: the reviewed 2.3.1 bump left 2.2.0 here, untested).
 */
export const SDK_VERSION = "2.3.1";
/** The stateless era the server serves beside the legacy initialize eras (plan 01 §3.1). */
export const MODERN_PROTOCOL_ERA = "2026-07-28";
/** The protocol eras the server answers (the modern one, then the SDK's legacy list). */
export const PROTOCOL_ERAS: readonly string[] = Object.freeze([
  MODERN_PROTOCOL_ERA,
  ...SUPPORTED_PROTOCOL_VERSIONS.slice(0, 5),
]);
/** What G1 shows instead of the store path (the real path is never shown to the model). */
export const STORE_PATH_PLACEHOLDER = "[cache]/store.sqlite";
/** A credential this old earns the Skills' Step 0 warning (research 06 §A.2; plan 07 G1). */
export const STALE_CREDENTIAL_DAYS = 30;
/** espn_check_auth at most once per minute (plan 02 §2.1; plan 07 G2). */
export const CHECK_AUTH_MIN_INTERVAL_MS = 60_000;

/** The views each P0 tool reads (G1 `drift.affected_tools`; plan 01 §7 degradation table). */
export const TOOL_VIEWS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  espn_get_league: ["mSettings", "mNav"],
  espn_get_standings: ["mTeam", "mStandings"],
  espn_get_scoreboard: ["mMatchup"],
  espn_get_live_scoreboard: ["mMatchupScore"],
  espn_get_box_score: ["mBoxscore"],
  espn_list_transactions: ["mTransactions2", "mPendingTransactions"],
  espn_get_roster: ["mRoster"],
  espn_search_players: ["kona_player_info", "players_wl"],
  espn_list_players: ["kona_player_info"],
  espn_get_injuries: ["mRoster", "kona_player_info"],
  espn_get_schedule: ["proTeamSchedules_wl"],
  espn_project_players: ["mSettings", "mRoster", "kona_player_info"],
  espn_analyze_lineup: ["mSettings", "mRoster", "mMatchup"],
  espn_analyze_waivers: ["mSettings", "mRoster", "mTeam", "kona_player_info"],
  espn_analyze_retrospective: ["mBoxscore"],
});

/** The tools a drifted view affects, in registry order. */
export function affectedTools(views: readonly string[]): string[] {
  const set = new Set(views);
  return Object.entries(TOOL_VIEWS)
    .filter(([, vs]) => vs.some((v) => set.has(v)))
    .map(([t]) => t);
}

// --- G1 ------------------------------------------------------------------------------------------

const sourceRow = z.strictObject({
  id: z.enum(DATASET_SOURCE_IDS as unknown as [DatasetSourceId, ...DatasetSourceId[]]),
  license: z.string().max(32),
  last_success_at: isoNull,
  age_s: count.nullable(),
  freshness: z.enum(["fresh", "stale", "provisional", "expired", "never"]),
  rows: count.nullable(),
  last_error: z.string().max(40).nullable(),
});

/**
 * The most steps a shown drift path has. Every path the shipped manifest's patterns yield fits with
 * room to spare (the deepest is 12 — an additive key under an 11-step pattern; held by
 * tests/mcp/drift-diff.test.ts over every pattern); the 200-character cap bounds a path anyway.
 */
export const DRIFT_PATH_MAX_STEPS = 16;
/** Up to DRIFT_PATH_MAX_STEPS steps of the drift path language (`.key`, `.<key>`, `[]`, `{}`). */
const DRIFT_STEPS = `(?:\\.(?:[A-Za-z_$][\\w$]{0,63}|<key>)|\\[\\]|\\{\\}){0,${String(DRIFT_PATH_MAX_STEPS)}}`;
/**
 * The grammar of a drift path as the detector writes it (src/drift/pattern.ts, detect.ts): `$`, then
 * the path language's steps — `.key` in identifier form (a key outside it is recorded as `<key>`),
 * `[]` every array element, `{}` every value of an object (the manifest's map-like patterns:
 * `scoreByStat{}`, `rankings{}[]`, `positionalRatings{}`, `proGamesByScoringPeriod{}[]`) — the ESPN
 * key vocabulary, no whitespace, never prose. Only paths in this grammar leave the server (Stage C
 * finding `status-drift-diff-unwrapped-strings`): the drift diff carries ESPN's own key names, so a
 * value outside it is dropped and counted, never shown. Without the `{}` step, fifteen paths the
 * detector writes from the shipped manifest were dropped (attempt 2 of that finding).
 */
export const DRIFT_PATH_RE = new RegExp(`^\\$${DRIFT_STEPS}$`);
/**
 * A new enum value: a drift path, `=`, and the detector's enum token (detect.ts enumToken: an ESPN
 * token, or an integer — written as `String(v)`, so a negative one carries its `-`) or `?` (a value
 * outside both).
 */
export const DRIFT_ENUM_RE = new RegExp(`^\\$${DRIFT_STEPS}=(?:[A-Z0-9_]{1,64}|-[0-9]{1,21}|\\?)$`);
/** An ESPN view name as the drift row carries it. */
const DRIFT_VIEW_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

const driftBlock = z.strictObject({
  status: z.enum(DRIFT_STATUSES),
  last_probe_at: isoNull,
  manifest_hash: z.string().max(80).nullable(),
  diff: z
    .array(
      z.strictObject({
        view: z.string().regex(DRIFT_VIEW_RE),
        removed: z.array(z.string().max(200).regex(DRIFT_PATH_RE)).max(200),
        added: z.array(z.string().max(200).regex(DRIFT_PATH_RE)).max(200),
        enums: z.array(z.string().max(200).regex(DRIFT_ENUM_RE)).max(200),
      }),
    )
    .max(30),
  affected_tools: z.array(z.string().max(40)).max(40),
});

type DriftDiff = StatusData["drift"]["diff"];

/**
 * The drift diff as G1 and espn-ff://status/drift show it (plan 07 §4.1: "the current manifest
 * diff, the additive-drift list"): the failing diff, then the additive list (new keys and enum
 * values) when the store hands it over, merged per view; every path checked against the detector's
 * grammar (DRIFT_PATH_RE / DRIFT_ENUM_RE) and anything outside it dropped and counted.
 */
export function shownDriftDiff(view: DriftView): { diff: DriftDiff; dropped: number } {
  let dropped = 0;
  const keep = (xs: readonly string[], re: RegExp): string[] => {
    const out: string[] = [];
    for (const x of xs) {
      if (typeof x === "string" && x.length <= 200 && re.test(x)) {
        if (!out.includes(x) && out.length < 200) out.push(x);
      } else dropped++;
    }
    return out;
  };
  const byView = new Map<string, { removed: string[]; added: string[]; enums: string[] }>();
  for (const d of [...view.diff, ...(view.additive ?? [])]) {
    if (!DRIFT_VIEW_RE.test(d.view)) {
      dropped += d.removed.length + d.added.length + d.enums.length;
      continue;
    }
    const cur = byView.get(d.view) ?? { removed: [], added: [], enums: [] };
    for (const x of keep(d.removed, DRIFT_PATH_RE))
      if (!cur.removed.includes(x)) cur.removed.push(x);
    for (const x of keep(d.added, DRIFT_PATH_RE)) if (!cur.added.includes(x)) cur.added.push(x);
    for (const x of keep(d.enums, DRIFT_ENUM_RE)) if (!cur.enums.includes(x)) cur.enums.push(x);
    byView.set(d.view, cur);
  }
  const diff = [...byView.entries()].slice(0, 30).map(([v, d]) => ({
    view: v,
    removed: d.removed.slice(0, 200),
    added: d.added.slice(0, 200),
    enums: d.enums.slice(0, 200),
  }));
  return { diff, dropped };
}

/** The fixed warning for drift paths outside the grammar (counted, never shown). */
export function droppedDriftWarning(n: number): string {
  return `drift diff: ${String(n)} path(s) outside the ESPN key grammar omitted (eff status lists the row)`;
}

/** G1 data (plan 07 G1; src/providers/platform.ts StatusData). */
export const statusDataSchema = z.strictObject({
  server: z.strictObject({
    version: z.string().max(32),
    sdk_version: z.string().max(16),
    protocol_eras: z.array(z.string().max(16)).max(8),
    node: z.string().max(32),
    tool_contract: z.number().int().min(1),
    toolset: z.enum(TOOLSETS),
  }),
  credential: z.strictObject({
    present: z.boolean(),
    store: z.enum(["keychain", "file"]).nullable(),
    state: z.enum(CREDENTIAL_STATES),
    stored_at: isoNull,
    age_days: count.nullable(),
    last_accepted_at: isoNull,
    last_rejected_at: isoNull,
    rejected_since: isoNull,
    next_probe_at: isoNull,
    stale_warning: z.boolean().nullable(),
  }),
  capabilities: z.strictObject({
    read: z.literal(true),
    native_projections: z.literal(true),
    native_ownership: z.literal(true),
    live_scoring: z.literal(true),
    waiver_system: z.enum(["faab", "priority_move_to_last", "continuous", "unknown"]),
    writes: z.literal(false),
    write: z.strictObject({
      lineup: z.literal(false),
      add_drop: z.literal(false),
      waiver: z.literal(false),
      trade: z.literal(false),
    }),
    write_gate_failing: z.string().max(40).nullable(),
  }),
  league: z.strictObject({
    season: z.number().int(),
    current_week: z.number().int().min(0).max(25).nullable(),
    is_public: z.boolean().nullable(),
    seeding_mode_configured: z.enum(SEEDING_MODES),
    seeding_confirmed: z.boolean(),
  }),
  drift: driftBlock,
  limiter: z.strictObject({
    requests_last_minute: count,
    requests_today: count,
    breaker_open: z.boolean(),
    etag_304_count: count,
  }),
  sources: z.array(sourceRow).max(30),
  // matched: every stored pair; matched_by_name: those below confidence 1.0 (research 04 §C step 2);
  // unmatched_*: rostered / ≥ 1 %-owned players without a confidence-1.0 pair, the alert's rule (§C
  // step 5) — a name-only player counts in matched, matched_by_name and unmatched_*; null (with a
  // warning) when this call cannot read the players the alert reads (crosswalkUnmatched)
  crosswalk: z.strictObject({
    matched: count,
    matched_by_name: count,
    unmatched_rostered: count.nullable(),
    unmatched_top_owned: count.nullable(),
  }),
  store: z.strictObject({
    path: z.literal(STORE_PATH_PLACEHOLDER),
    size_bytes: z.number().int().min(0),
    schema_version: z.number().int().min(0),
  }),
  snapshots: z.strictObject({
    roster_last_at: isoNull,
    pool_last_at: isoNull,
    projection_last_at: isoNull,
  }),
  journal: z.null(),
  jobs: z
    .array(
      z.strictObject({
        label: z.string().max(80),
        last_run_at: isoNull,
        exit: z.number().int().nullable(),
      }),
    )
    .max(30),
  checks: z
    .array(
      z.strictObject({
        id: z.enum(CHECK_IDS),
        status: z.enum(["ok", "warn", "fail"]),
        detail: z.record(
          z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
          z.union([z.string().max(64), z.number(), z.boolean(), z.null()]),
        ),
      }),
    )
    .max(50)
    .nullable(),
});

/**
 * G1's data: StatusData with the crosswalk's unmatched counts nullable — null when the call cannot
 * read the players the rebuild's alert reads (Stage C finding status-crosswalk-counts-disagree-alert).
 */
export type G1StatusData = Omit<StatusData, "crosswalk" | "sources"> & {
  readonly crosswalk: Omit<
    StatusData["crosswalk"],
    "unmatched_rostered" | "unmatched_top_owned"
  > & {
    readonly unmatched_rostered: number | null;
    readonly unmatched_top_owned: number | null;
  };
  readonly sources: readonly G1SourceRow[];
};

/**
 * One G1 `sources[]` row: StatusData's, whose `last_error` may also carry the connection layer's
 * refusal of the current file (StatusPort.datasetRefusal — Stage C finding
 * status-damaged-dataset-reported-fresh).
 */
export type G1SourceRow = Omit<StatusData["sources"][number], "last_error"> & {
  readonly last_error: StatusData["sources"][number]["last_error"] | DatasetRefusalCode;
};

/** Crosswalk lookups G1's unmatched counts take per turn of the event loop (~6 ms). */
export const LOOKUPS_PER_TURN = 100;

/** The highest team id G1 probes the store's roster snapshots for (ESPN leagues hold ≤ 20 teams). */
export const SNAPSHOT_TEAM_PROBE_MAX = 40;

/**
 * The rostered players of EVERY league roster (research 04 §C step 5: "ESPN ids on any fantasy
 * roster of the league"), from zero requests: this call's cached rosters of the clock's week, else the
 * store's newest roster-snapshot run (`eff snapshot rosters` stores every team's), else null.
 */
async function leagueRostered(
  ctx: ToolContext,
  week: number | null,
): Promise<ReadonlySet<number> | null> {
  const s = ctx.services;
  const ref = leagueRef(ctx);
  if (week !== null && week >= 1) {
    const rosters = await cachedOnly(ctx, (budget) => s.platform.getRosters(ref, week, { budget }));
    if (rosters !== null && rosters.value.length > 0)
      return new Set(rosters.value.flatMap((r) => r.entries.map((e) => e.player.ref.id)));
  }
  try {
    const runs: { taken: number; ids: number[] }[] = [];
    for (let t = 1; t <= SNAPSHOT_TEAM_PROBE_MAX; t++) {
      const snap = s.rosterSnapshots.latestTwo(t)[0];
      if (snap === undefined) continue;
      runs.push({
        taken: Date.parse(snap.taken_at),
        ids: snap.roster.entries.map((e) => e.player.ref.id),
      });
    }
    if (runs.length === 0) return null;
    // the newest run only: a team's older snapshot is no longer its roster
    const newest = Math.max(...runs.map((r) => r.taken));
    return new Set(runs.filter((r) => r.taken === newest).flatMap((r) => r.ids));
  } catch {
    return null;
  }
}

/**
 * The crosswalk's unmatched counts by the rebuild's alert rule (research 04 §C step 5; plan 06
 * §1.3; src/domain/crosswalk/resolver.ts resolveCrosswalk): over the players the rebuild resolves —
 * ESPN's player index (espn:players) — a player without a confidence-1.0 pair, team units never,
 * counts as rostered when he is on any league roster, else as top-owned when he is ≥ 1 % owned.
 * Before, the top-owned count read the newest POOL snapshot (free agents only, the top of each
 * position) and the rostered one a cached read a new session never has, so both read a hard 0 — a
 * false all-clear — beside the rebuild's alert (Stage C finding status-crosswalk-counts-disagree-
 * alert). A set this call cannot read is null, said in a warning: without the index both (the
 * rebuild itself skips), without a league roster the rostered count, and the top-owned one then
 * counts every ≥ 1 %-owned player.
 */
export async function crosswalkUnmatched(
  ctx: ToolContext,
  week: number | null,
  warn: (w: string) => void,
): Promise<{ readonly rostered: number | null; readonly top_owned: number | null }> {
  const s = ctx.services;
  const lacksConfidentPair = (espnId: number): boolean => {
    const pair = s.crosswalk.get(espnId);
    return pair === null || pair.confidence < 1;
  };
  let universe: ReturnType<typeof s.playerUniverse.all>;
  try {
    universe = s.playerUniverse.all(s.league.season);
  } catch {
    warn("crosswalk: espn:players unreadable: unmatched_rostered and unmatched_top_owned are null");
    return { rostered: null, top_owned: null };
  }
  if (universe.stamp === null) {
    warn(
      "crosswalk: espn:players never loaded: unmatched_rostered and unmatched_top_owned are null (eff refresh espn:players)",
    );
    return { rostered: null, top_owned: null };
  }
  // the index read is one statement step; the lookups run LOOKUPS_PER_TURN to a turn (one
  // indexed read each: ~700 of them cost 35–50 ms, past the stall bound — plan 03 §1.2)
  await turn();
  const rostered = await leagueRostered(ctx, week);
  await turn();
  if (rostered === null)
    warn(
      "crosswalk: no league roster is readable without a request (no cached rosters, no roster snapshot): unmatched_rostered is null, unmatched_top_owned counts every ≥ 1 %-owned player",
    );
  let rosteredUnmatched = 0;
  let topOwnedUnmatched = 0;
  let lookups = 0;
  for (const p of universe.rows) {
    if (p.espn_id <= 0 || isTeamUnitIdentity(p)) continue;
    const isRostered = rostered?.has(p.espn_id) === true;
    const owned = p.percent_owned;
    const isTop = typeof owned === "number" && Number.isFinite(owned) && owned >= TOP_OWNED_PERCENT;
    if (!isRostered && !isTop) continue;
    if (++lookups % LOOKUPS_PER_TURN === 0) await turn();
    if (!lacksConfidentPair(p.espn_id)) continue;
    if (isRostered) rosteredUnmatched++;
    else topOwnedUnmatched++;
  }
  return { rostered: rostered === null ? null : rosteredUnmatched, top_owned: topOwnedUnmatched };
}

/** Whole days since `iso`, or null. */
function ageDays(storedAt: string | null, nowMs: number): number | null {
  if (storedAt === null) return null;
  const ms = Date.parse(storedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
}

/** The Phase-1 dataset sources every toolset reads (weather apart), in refresh order. */
export const PHASE_1_STATUS_SOURCES: readonly DatasetSourceId[] = Object.freeze([
  "espn:pro_schedule",
  "espn:players",
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:players",
  "nflverse:stats_player_week",
]);

/** The Phase-2 dataset sources the P1 tools read (plan 10 §3.2): reported under EFF_TOOLSET=full. */
export const PHASE_2_STATUS_SOURCES: readonly DatasetSourceId[] = Object.freeze([
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:depth_charts",
  "ffopportunity:ep_weekly",
  "sleeper:trending",
  "news:rotowire",
  "news:espn",
  "news:cbs",
]);

/**
 * The configured dataset sources G1 and espn-ff://status/freshness list — the same set, in the same
 * order, as `eff status` (src/cli/status.ts configuredSources, which this layer may not import; a
 * parity test holds them equal): the Phase-1 sources, the Phase-2 ones under EFF_TOOLSET=full (the
 * P1 tools read them), and the ONE weather source EFF_WEATHER_SOURCE names. Before, every toolset
 * listed only the Phase-1 registry rows — both weather sources, never a Phase-2 source — so under
 * `full` the snapshot every Skill reads in Step 0 never showed a stale pbp, snap-count or news feed
 * the P1 tools depend on (Stage C finding status-phase2-sources-missing).
 */
export function statusSources(
  o: Pick<McpServerOptions, "toolset" | "weatherSource">,
): readonly DatasetSourceId[] {
  return [
    ...PHASE_1_STATUS_SOURCES,
    ...(o.toolset === "full" ? PHASE_2_STATUS_SOURCES : []),
    o.weatherSource === "nws" ? "weather:nws" : "weather:open_meteo",
  ];
}

/** The fix G1 names for a dataset file the connection layer refuses. */
export function refusedDatasetWarning(id: DatasetSourceId, code: string): string {
  return `${id}: its dataset file cannot be served (${code}): every tool reads it as never loaded — run \`eff refresh ${id}\``;
}

/**
 * One `sources[]` row from refresh_log (fixed codes only — never an exception text), judged against
 * the dataset connection layer: a current file it refuses (StatusPort.datasetRefusal — truncated,
 * damaged, re-laid-out) is unusable — freshness `never`, no rows, the refusal as `last_error` and the
 * refresh named — as every reader reads it, never fresh from refresh_log alone (Stage C finding
 * status-damaged-dataset-reported-fresh).
 */
function sourceStatus(
  ctx: ToolContext,
  id: DatasetSourceId,
  warn?: (w: string) => void,
): G1SourceRow {
  const info = SOURCE_REGISTRY[id];
  const current = ctx.services.refreshLog.current().find((r) => r.source === id) ?? null;
  const latest = ctx.services.refreshLog.latest(id);
  const lastError = latest !== null && !latest.ok ? latest.error : null;
  let refusal: DatasetRefusalCode | null = null;
  if (current !== null)
    try {
      refusal = ctx.services.status.datasetRefusal?.(id) ?? null;
    } catch {
      refusal = null;
    }
  if (current !== null && refusal !== null) {
    warn?.(refusedDatasetWarning(id, refusal));
    return {
      id,
      license: info.license,
      last_success_at: current.finished_at,
      age_s: null,
      freshness: "never",
      rows: null,
      last_error: refusal,
    };
  }
  if (current === null)
    return {
      id,
      license: info.license,
      last_success_at: null,
      age_s: null,
      freshness: "never",
      rows: null,
      last_error: lastError,
    };
  // judged under the call's TTL context, as every tool input (game-day TTLs — Stage C finding
  // freshness-gameday-ttl-never-applied)
  const st = stampState(
    FRESHNESS_TABLE[info.freshness],
    {
      as_of: current.release_updated_at ?? current.finished_at,
      fetched_at: current.finished_at,
      checked_at: current.checked_at,
    },
    ctx.nowMs,
    ttlContextOf(ctx),
  );
  return {
    id,
    license: info.license,
    last_success_at: current.finished_at,
    age_s: st.age_s,
    freshness: st.state,
    rows: current.rows,
    last_error: lastError,
  };
}

/** A read answered only from cache (a zero-request budget): null on a miss or any failure. */
async function cachedOnly<T>(
  ctx: ToolContext,
  read: (budget: ReturnType<typeof createUpstreamBudget>) => Promise<T>,
): Promise<T | null> {
  try {
    return await read(createUpstreamBudget(ctx.requestId, ctx.nowMs, 0));
  } catch {
    return null;
  }
}

/** The G1 snapshot (also espn-ff://status). Zero ESPN requests by construction. */
export async function statusSnapshot(
  ctx: ToolContext,
  includeChecks: boolean,
  droppedDrift?: (n: number) => void,
  warn?: (w: string) => void,
): Promise<G1StatusData> {
  const s = ctx.services;
  const ref = leagueRef(ctx);
  const cred = s.status.credential();
  const age = ageDays(cred.stored_at, ctx.nowMs);
  const league = await cachedOnly(ctx, (budget) => s.platform.getLeague(ref, { budget }));
  const rules = await cachedOnly(ctx, (budget) => s.platform.getLeagueRules(ref, { budget }));
  const drift = s.status.drift();
  const shown = shownDriftDiff(drift);
  droppedDrift?.(shown.dropped);
  const limiter = s.status.limiter(ctx.nowMs);
  const transport = s.transport();
  const store = s.status.store();
  const myTeam = league?.value.my_team?.team_id ?? s.configuredTeamId;
  let rosterLast: string | null = null;
  if (myTeam !== null) {
    try {
      rosterLast = s.rosterSnapshots.latestTwo(myTeam)[0]?.taken_at ?? null;
    } catch {
      rosterLast = null;
    }
  }
  let poolLast: string | null = null;
  try {
    poolLast = s.poolSnapshots.latestTwo()[0]?.taken_at ?? null;
  } catch {
    poolLast = null;
  }
  // A player counts as unmatched exactly when the rebuild's alert would list him (research 04 §C
  // step 5; plan 06 §1.3): no stored pair, or one below confidence 1.0 — a name-only pair (§C step 2)
  // is surfaced as matched_by_name, never hidden among the confident ones (Stage C finding
  // crosswalk-alert-remediation-dead). A pair the rebuild rejected is removed from the store, so it
  // reads as no pair here (crosswalk-rejected-pair-persists). Every league roster and the player
  // index, as the alert reads them (crosswalkUnmatched).
  const week = league === null ? null : clockWeek(league.value.clock);
  const unmatched = await crosswalkUnmatched(ctx, week, (w) => warn?.(w));
  let projectionLast: string | null = null;
  try {
    projectionLast = s.espnProjections.lastSnapshotAt();
  } catch {
    projectionLast = null;
  }
  let matched = 0;
  try {
    matched = s.crosswalk.count();
  } catch {
    matched = 0;
  }
  let matchedByName = 0;
  try {
    matchedByName = s.crosswalk.countMatchedByName();
  } catch {
    matchedByName = 0;
  }
  const checks: CheckRow[] = includeChecks ? [...s.status.checks()] : [];
  return {
    server: {
      version: ctx.options.version,
      sdk_version: SDK_VERSION,
      protocol_eras: PROTOCOL_ERAS,
      node: process.versions.node,
      tool_contract: TOOL_CONTRACT,
      toolset: ctx.options.toolset,
    },
    credential: {
      present: cred.present,
      store: cred.store,
      state: cred.state,
      stored_at: cred.stored_at,
      age_days: age,
      last_accepted_at: cred.last_accepted_at,
      last_rejected_at: cred.last_rejected_at,
      rejected_since: cred.rejected_since,
      next_probe_at: cred.next_probe_at,
      stale_warning: age === null ? null : age >= STALE_CREDENTIAL_DAYS,
    },
    capabilities: {
      read: true,
      native_projections: true,
      native_ownership: true,
      live_scoring: true,
      waiver_system: rules?.value.waiver_system ?? "unknown",
      // PHASE W SEAM — NOT IMPLEMENTED (plan 10 §3.W; D11): writes are literal false.
      writes: false,
      write: NO_WRITES,
      write_gate_failing: WRITE_GATE_FAILING_THIS_BUILD,
    },
    league: {
      season: ref.season,
      // the week the league's clock means — its final scoring period once the season is over,
      // as every tool's default week (Stage C finding league-postseason-default-week-18)
      current_week: league === null ? null : clockWeek(league.value.clock),
      is_public: league?.value.is_public ?? null,
      seeding_mode_configured: s.seedingMode,
      seeding_confirmed:
        s.seedingConfirmedAt !== null && Number.isFinite(Date.parse(s.seedingConfirmedAt)),
    },
    drift: {
      status: drift.status,
      last_probe_at: drift.last_probe_at,
      manifest_hash: drift.manifest_hash,
      diff: shown.diff,
      affected_tools: affectedTools(shown.diff.map((d) => d.view)),
    },
    limiter: {
      requests_last_minute: limiter.requests_last_minute,
      requests_today: limiter.requests_today,
      breaker_open: transport.breaker_open,
      etag_304_count: transport.etag_304_count,
    },
    sources: statusSources(ctx.options).map((id) => sourceStatus(ctx, id, warn)),
    crosswalk: {
      matched,
      matched_by_name: matchedByName,
      unmatched_rostered: unmatched.rostered,
      unmatched_top_owned: unmatched.top_owned,
    },
    store: {
      path: STORE_PATH_PLACEHOLDER,
      size_bytes: store.size_bytes,
      schema_version: store.schema_version,
    },
    snapshots: {
      roster_last_at: rosterLast,
      pool_last_at: poolLast,
      projection_last_at: projectionLast,
    },
    // PHASE W SEAM — NOT IMPLEMENTED: the write journal is empty and not shown.
    journal: null,
    jobs: s.status.jobs(),
    checks: includeChecks
      ? checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail }))
      : null,
  };
}

/** G1 `espn_get_status`. */
export const getStatus = defineTool({
  name: "espn_get_status",
  description:
    "Server, credential state (never a value), capabilities, drift, limiter, data-source ages, crosswalk, store; zero ESPN requests. Call first.",
  input: z.strictObject({ include_checks: z.boolean().default(false) }),
  data: statusDataSchema,
  budget: "list",
  run: async (args, ctx) => {
    const warnings: string[] = [];
    const data = await statusSnapshot(
      ctx,
      args.include_checks,
      (n) => {
        if (n > 0) warnings.push(droppedDriftWarning(n));
      },
      (w) => {
        if (!warnings.includes(w)) warnings.push(w);
      },
    );
    if (data.credential.stale_warning === true)
      warnings.push(`credential stored ${String(data.credential.age_days)} days ago`);
    if (data.drift.status !== "green") warnings.push(`drift status is ${data.drift.status}`);
    return { data, inputs: [], warnings, extraSources: ["store:status"] };
  },
});

// --- G2 ------------------------------------------------------------------------------------------

/** G2 data (plan 07 G2; src/providers/platform.ts CheckAuthData). */
export const checkAuthDataSchema = z.strictObject({
  accepted: z.boolean().nullable(),
  probe: z.enum(["settings", "board"]),
  reason: z.enum(["not_configured", "board_not_discriminating"]).nullable(),
  state: z.enum(CREDENTIAL_STATES),
  upstream_status: z.number().int().min(100).max(599).nullable(),
  checked_at: iso,
  next_allowed_at: iso,
});

const LAST_CHECK = new WeakMap<object, number>();

/** G2 `espn_check_auth`. */
export const checkAuth = defineTool({
  name: "espn_check_auth",
  description:
    "One explicit ESPN credential probe (accepted / rejected / undeterminable), at most once a minute; use after eff setup following ESPN_AUTH_REJECTED.",
  input: z.strictObject({}),
  data: checkAuthDataSchema,
  budget: "list",
  wire: "outline",
  run: async (_args, ctx) => {
    const last = LAST_CHECK.get(ctx.services);
    if (last !== undefined && ctx.nowMs - last < CHECK_AUTH_MIN_INTERVAL_MS) {
      throw new EffError("RATE_LIMITED", {
        retry_after_s: Math.ceil((last + CHECK_AUTH_MIN_INTERVAL_MS - ctx.nowMs) / 1000),
        hint: SERVER_HINTS.checkAuthTooSoon,
      });
    }
    LAST_CHECK.set(ctx.services, ctx.nowMs);
    const r = await ctx.services.auth.probe(leagueRef(ctx));
    const data: CheckAuthData = {
      accepted: r.accepted,
      probe: r.probe,
      reason: r.reason,
      state: ctx.services.auth.state(),
      upstream_status: r.upstream_status,
      checked_at: r.checked_at,
      next_allowed_at: new Date(ctx.nowMs + CHECK_AUTH_MIN_INTERVAL_MS).toISOString(),
    };
    return {
      data,
      inputs: [],
      extraSources: [r.probe === "board" ? "espn:kona_league_communication" : "espn:mSettings"],
    };
  },
});

// --- status resources (plan 07 §4.1) -------------------------------------------------------------

/** The plan 01 §5.4 class table with each class's current age and state. */
export function freshnessReport(
  ctx: ToolContext,
  warn?: (w: string) => void,
): FreshnessResourceData {
  const ages = new Map<FreshnessClassId, { age_s: number; state: FreshnessClassRow["state"] }>();
  const sources = statusSources(ctx.options).map((id) => sourceStatus(ctx, id, warn));
  for (const s of sources) {
    if (s.age_s === null) continue;
    const cls = SOURCE_REGISTRY[s.id as DatasetSourceId].freshness;
    const st = s.freshness === "never" || s.freshness === "provisional" ? "fresh" : s.freshness;
    const prev = ages.get(cls);
    if (prev === undefined || s.age_s < prev.age_s) ages.set(cls, { age_s: s.age_s, state: st });
  }
  const classes: FreshnessClassRow[] = FRESHNESS_CLASS_IDS.map((id) => {
    const c = FRESHNESS_TABLE[id];
    const a = ages.get(id);
    return {
      class: id,
      fresh_s: c.ttlSeconds,
      hard_limit_s: c.hardLimitSeconds,
      beyond_hard: c.beyondHard,
      age_s: a?.age_s ?? null,
      state: a?.state ?? "never",
    };
  });
  return { sources, classes };
}

/** The freshness resource's data schema. */
export const freshnessResourceSchema = z.strictObject({
  sources: z.array(sourceRow).max(30),
  classes: z
    .array(
      z.strictObject({
        class: z.enum(FRESHNESS_CLASS_IDS),
        fresh_s: count.nullable(),
        hard_limit_s: count.nullable(),
        beyond_hard: z.enum(["STALE_ONLY", "omit"]).nullable(),
        age_s: count.nullable(),
        state: z.enum(["fresh", "stale", "expired", "never"]),
      }),
    )
    .max(60),
});

/** The drift resource's data (G1's `drift` block — ESPN-only) and its warnings. */
export function driftReport(ctx: ToolContext): {
  data: StatusData["drift"];
  warnings: string[];
} {
  const d = ctx.services.status.drift();
  const shown = shownDriftDiff(d);
  return {
    data: {
      status: d.status,
      last_probe_at: d.last_probe_at,
      manifest_hash: d.manifest_hash,
      diff: shown.diff,
      affected_tools: affectedTools(shown.diff.map((x) => x.view)),
    },
    warnings: shown.dropped > 0 ? [droppedDriftWarning(shown.dropped)] : [],
  };
}

export const driftResourceSchema = driftBlock;
