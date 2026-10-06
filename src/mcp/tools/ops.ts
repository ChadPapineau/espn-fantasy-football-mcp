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
import { TOOL_CONTRACT } from "../contract.js";
import { leagueRef } from "./common.js";
import { count, iso, isoNull } from "./schemas.js";

/** The SDK the server is built on (pinned exactly in package.json; a test keeps them equal). */
export const SDK_VERSION = "2.2.0";
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

const driftBlock = z.strictObject({
  status: z.enum(DRIFT_STATUSES),
  last_probe_at: isoNull,
  manifest_hash: z.string().max(80).nullable(),
  diff: z
    .array(
      z.strictObject({
        view: z.string().max(40),
        removed: z.array(z.string().max(200)).max(200),
        added: z.array(z.string().max(200)).max(200),
        enums: z.array(z.string().max(200)).max(200),
      }),
    )
    .max(30),
  affected_tools: z.array(z.string().max(40)).max(40),
});

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
  crosswalk: z.strictObject({
    matched: count,
    unmatched_rostered: count,
    unmatched_top_owned: count,
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

/** Whole days since `iso`, or null. */
function ageDays(storedAt: string | null, nowMs: number): number | null {
  if (storedAt === null) return null;
  const ms = Date.parse(storedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
}

/** The Phase-1 dataset sources G1 lists (plan 10 §3.1a: six in Phase 1a). */
export const STATUS_SOURCES: readonly DatasetSourceId[] = Object.freeze(
  DATASET_SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].phase === "1a"),
);

/** One `sources[]` row from refresh_log (fixed codes only — never an exception text). */
function sourceStatus(ctx: ToolContext, id: DatasetSourceId): StatusData["sources"][number] {
  const info = SOURCE_REGISTRY[id];
  const current = ctx.services.refreshLog.current().find((r) => r.source === id) ?? null;
  const latest = ctx.services.refreshLog.latest(id);
  const lastError = latest !== null && !latest.ok ? latest.error : null;
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
  const st = stampState(
    FRESHNESS_TABLE[info.freshness],
    {
      as_of: current.release_updated_at ?? current.finished_at,
      fetched_at: current.finished_at,
      checked_at: current.checked_at,
    },
    ctx.nowMs,
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
): Promise<StatusData> {
  const s = ctx.services;
  const ref = leagueRef(ctx);
  const cred = s.status.credential();
  const age = ageDays(cred.stored_at, ctx.nowMs);
  const league = await cachedOnly(ctx, (budget) => s.platform.getLeague(ref, { budget }));
  const rules = await cachedOnly(ctx, (budget) => s.platform.getLeagueRules(ref, { budget }));
  const drift = s.status.drift();
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
  let topOwnedUnmatched = 0;
  try {
    const pool = s.poolSnapshots.latestTwo()[0];
    poolLast = pool?.taken_at ?? null;
    for (const p of pool?.players ?? []) {
      if ((p.ownership?.percent_owned ?? 0) < 1 || p.ref.id < 0) continue;
      if (s.crosswalk.get(p.ref.id) === null) topOwnedUnmatched++;
    }
  } catch {
    poolLast = null;
  }
  let rosteredUnmatched = 0;
  const week = league === null ? null : league.value.clock.current_scoring_period;
  if (week !== null && week >= 1) {
    const rosters = await cachedOnly(ctx, (budget) => s.platform.getRosters(ref, week, { budget }));
    for (const r of rosters?.value ?? [])
      for (const e of r.entries)
        if (e.player.ref.id > 0 && s.crosswalk.get(e.player.ref.id) === null) rosteredUnmatched++;
  }
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
      current_week: league?.value.clock.current_scoring_period ?? null,
      is_public: league?.value.is_public ?? null,
      seeding_mode_configured: s.seedingMode,
      seeding_confirmed:
        s.seedingConfirmedAt !== null && Number.isFinite(Date.parse(s.seedingConfirmedAt)),
    },
    drift: {
      status: drift.status,
      last_probe_at: drift.last_probe_at,
      manifest_hash: drift.manifest_hash,
      diff: drift.diff,
      affected_tools: affectedTools(drift.diff.map((d) => d.view)),
    },
    limiter: {
      requests_last_minute: limiter.requests_last_minute,
      requests_today: limiter.requests_today,
      breaker_open: transport.breaker_open,
      etag_304_count: transport.etag_304_count,
    },
    sources: STATUS_SOURCES.map((id) => sourceStatus(ctx, id)),
    crosswalk: {
      matched,
      unmatched_rostered: rosteredUnmatched,
      unmatched_top_owned: topOwnedUnmatched,
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
    const data = await statusSnapshot(ctx, args.include_checks);
    const warnings: string[] = [];
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
export function freshnessReport(ctx: ToolContext): FreshnessResourceData {
  const ages = new Map<FreshnessClassId, { age_s: number; state: FreshnessClassRow["state"] }>();
  const sources = STATUS_SOURCES.map((id) => sourceStatus(ctx, id));
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

/** The drift resource's data (G1's `drift` block — ESPN-only). */
export function driftReport(ctx: ToolContext): StatusData["drift"] {
  const d = ctx.services.status.drift();
  return {
    status: d.status,
    last_probe_at: d.last_probe_at,
    manifest_hash: d.manifest_hash,
    diff: d.diff,
    affected_tools: affectedTools(d.diff.map((x) => x.view)),
  };
}

export const driftResourceSchema = driftBlock;
