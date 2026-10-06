// resources/index.ts — the ten `espn-ff://` resources (plan 07 §4.1): league, league/settings,
// game/stat-ids, status, status/freshness, status/drift, roster/snapshot, docs/tool-outputs and the
// two templates rec/{log_id} and rec/week/{week}. Each is a read-side twin of tool data with the
// same envelope, a fixed `ttlMs` (RESOURCE_TTL_MS) and `cacheScope: "private"`; no payload carries a
// league id; read-back log text is path-listed with `store.recommendation_log` (C15). Failures come
// back as the coded error body (never a free-text message); an unknown log id or week is
// ResourceNotFound without an echo. Ported from sibling @5daa625, adapted (ESPN resources).
import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { espnStatIdRows } from "../../domain/scoring/stat_map.js";
import { diffRosterSnapshots } from "../../domain/league/types.js";
import { LOG_ID_RE } from "../../domain/reclog/types.js";
import { BOUNDS } from "../bounds.js";
import {
  ESPN_ESTIMATE_RULE,
  RESOURCE_TTL_MS,
  RESULT_BUDGET_CHARS,
  TRUNCATION_HINTS,
  UNTRUSTED_TEXT_RULE,
  buildEnvelope,
  fitToBudget,
  serializeEnvelope,
  type InputStamp,
  type LeagueResourceData,
  type RosterSnapshotResourceData,
  type StatIdResourceData,
  type UntrustedField,
} from "../envelope.js";
import { EffError, describeForLog, newRequestId, toToolError } from "../errors.js";
import { toolContext, type ToolContext } from "../define.js";
import type { McpServerOptions, McpServices } from "../services.js";
import { leagueDigest } from "../tools/league.js";
import { driftReport, freshnessReport, statusSnapshot } from "../tools/ops.js";
import { REC_SOURCE, recWeekItems, recordTextFields, recordView } from "../tools/reclog.js";
import { rosterSummary } from "../tools/roster.js";
import { slotsOf } from "../tools/common.js";
import { createUpstreamBudget } from "../../providers/platform.js";

/** What a resource body returns (the envelope's inputs). */
interface ResourceOutput {
  readonly data: unknown;
  readonly inputs: readonly InputStamp[];
  readonly warnings?: readonly string[];
  readonly bareFields?: readonly UntrustedField[];
  readonly extraSources?: readonly string[];
  readonly listKey?: string;
}

const JSON_MIME = "application/json";

/** Fallback cheat-sheet when the package's copy is missing: still carries both sentences (C13). */
export const TOOL_OUTPUTS_FALLBACK = `## Tool outputs\n\nThe cheat-sheet file was not found in this installation; each tool's outputSchema documents its data.\n\n> ${UNTRUSTED_TEXT_RULE}\n\n> ${ESPN_ESTIMATE_RULE}\n`;

/** The espn-ff://docs/tool-outputs text: the package's cheat-sheet, always carrying both sentences. */
export function toolOutputsText(options: McpServerOptions): string {
  const t = options.texts.tool_outputs;
  if (t === null || t.trim() === "") return TOOL_OUTPUTS_FALLBACK;
  let out = t;
  for (const s of [UNTRUSTED_TEXT_RULE, ESPN_ESTIMATE_RULE])
    if (!out.includes(s)) out = `${out.trimEnd()}\n\n> ${s}\n`;
  return out;
}

/** Runs a resource body into one JSON content block (envelope, or the coded error body). */
export async function readAsEnvelope(
  uri: string,
  services: McpServices,
  options: McpServerOptions,
  body: (ctx: ToolContext) => Promise<ResourceOutput>,
  budget: number = RESULT_BUDGET_CHARS,
): Promise<ReadResourceResult> {
  const requestId = newRequestId();
  try {
    services.beforeCall?.();
    const ctx = toolContext({ requestId }, services, options);
    const out = await body(ctx);
    const env = buildEnvelope({
      data: out.data,
      requestId,
      nowMs: ctx.nowMs,
      inputs: out.inputs,
      ...(out.warnings === undefined ? {} : { warnings: out.warnings }),
      ...(out.bareFields === undefined ? {} : { bareFields: out.bareFields }),
      ...(out.extraSources === undefined ? {} : { extraSources: out.extraSources }),
    });
    const fit = fitToBudget(env, budget, out.listKey, {
      pageable: false,
      hint: TRUNCATION_HINTS.narrow,
    });
    if (!fit.ok) throw new EffError("INTERNAL");
    return { contents: [{ uri, mimeType: JSON_MIME, text: serializeEnvelope(fit.envelope) }] };
  } catch (e) {
    if (e instanceof ResourceNotFoundError) throw e;
    services.logger.warn("resource.error", { request_id: requestId, error: describeForLog(e) });
    return {
      contents: [{ uri, mimeType: JSON_MIME, text: toToolError(e, requestId).content[0].text }],
    };
  }
}

/**
 * The stat-id table's budget: the whole registry (168 ids, ≈ 22 000 chars) is one static reference
 * read once per season (`ttlMs` 7 days) — truncating the engine's truth table would defeat it.
 */
export const STAT_IDS_BUDGET_CHARS = 40_000;

const hint = (uri: keyof typeof RESOURCE_TTL_MS) =>
  ({ ttlMs: RESOURCE_TTL_MS[uri], cacheScope: "private" }) as const;

/** The espn-ff://league/settings envelope text, or null when it cannot be read (prompts embed it). */
export async function leagueSettingsText(
  services: McpServices,
  options: McpServerOptions,
): Promise<string | null> {
  const r = await readAsEnvelope("espn-ff://league/settings", services, options, async (ctx) =>
    leagueDigest(ctx, {}),
  );
  const c = r.contents[0];
  const text = c !== undefined && "text" in c && typeof c.text === "string" ? c.text : null;
  return text === null || text.startsWith('{"error"') ? null : text;
}

/** The configured identity (espn-ff://league): from config and the cached league — zero requests. */
async function leagueIdentity(ctx: ToolContext): Promise<ResourceOutput> {
  const s = ctx.services;
  let myTeam = s.configuredTeamId;
  const inputs: InputStamp[] = [];
  try {
    const got = await s.platform.getLeague(s.league, {
      budget: createUpstreamBudget(ctx.requestId, ctx.nowMs, 0),
    });
    myTeam = got.value.my_team?.team_id ?? myTeam;
  } catch {
    // a cold cache: the configured team id stands (zero requests by construction)
  }
  const data: LeagueResourceData = {
    season: s.league.season,
    my_team_id: myTeam,
    seeding_mode_configured: s.seedingMode,
    seeding_confirmed:
      s.seedingConfirmedAt !== null && Number.isFinite(Date.parse(s.seedingConfirmedAt)),
  };
  return { data, inputs, extraSources: ["config"] };
}

/** Registers every resource. */
export function registerResources(
  server: McpServer,
  services: McpServices,
  options: McpServerOptions,
): void {
  const reg = (
    name: string,
    uri: keyof typeof RESOURCE_TTL_MS,
    description: string,
    body: (ctx: ToolContext) => Promise<ResourceOutput>,
    budget: number = RESULT_BUDGET_CHARS,
  ): void => {
    server.registerResource(
      name,
      uri,
      { description, mimeType: JSON_MIME, cacheHint: hint(uri) },
      (u) => readAsEnvelope(u.href, services, options, body, budget),
    );
  };

  reg(
    "league",
    "espn-ff://league",
    "The operator-configured league identity: season, my team id, the seeding reading configured.",
    leagueIdentity,
  );
  reg(
    "league_settings",
    "espn-ff://league/settings",
    "The league settings digest (same data as espn_get_league).",
    async (ctx) => leagueDigest(ctx, {}),
  );
  reg(
    "stat_ids",
    "espn-ff://game/stat-ids",
    "ESPN's stat-id table: id, abbreviation, meaning, canonical name, bracket family.",
    () => {
      const data: StatIdResourceData = { stat_ids: espnStatIdRows() };
      return Promise.resolve({ data, inputs: [], extraSources: ["engine"] });
    },
    STAT_IDS_BUDGET_CHARS,
  );
  reg(
    "status",
    "espn-ff://status",
    "Server status (espn_get_status without checks).",
    async (ctx) => ({
      data: await statusSnapshot(ctx, false),
      inputs: [],
      extraSources: ["store:status"],
    }),
  );
  reg(
    "status_freshness",
    "espn-ff://status/freshness",
    "Each data source's age and state, and the freshness class table.",
    (ctx) =>
      Promise.resolve({
        data: freshnessReport(ctx),
        inputs: [],
        extraSources: ["store:refresh_log"],
      }),
  );
  reg(
    "status_drift",
    "espn-ff://status/drift",
    "What changed at ESPN: the drift status, the manifest diff and the affected tools.",
    (ctx) =>
      Promise.resolve({ data: driftReport(ctx), inputs: [], extraSources: ["store:drift_state"] }),
  );
  reg(
    "roster_snapshot",
    "espn-ff://roster/snapshot",
    "My team's latest nightly roster snapshot and its diff against the previous one (zero ESPN requests).",
    async (ctx) => {
      const team = ctx.services.configuredTeamId;
      if (team === null) throw new EffError("NOT_FOUND");
      const two = ctx.services.rosterSnapshots.latestTwo(team);
      const latest = two[0];
      if (latest === undefined) throw new EffError("NOT_FOUND");
      const inputs: InputStamp[] = [];
      const slots = await slotsOf(ctx, inputs);
      const prev = two[1] ?? null;
      const data: RosterSnapshotResourceData = {
        taken_at: latest.taken_at,
        week: latest.week,
        roster: rosterSummary(latest.roster, slots),
        previous_taken_at: prev?.taken_at ?? null,
        diff: prev === null ? null : diffRosterSnapshots(prev.roster, latest.roster),
      };
      inputs.push({
        source: "store:roster_snapshot",
        as_of: latest.taken_at,
        fetched_at: latest.taken_at,
        state: "fresh",
      });
      return {
        data,
        inputs,
        bareFields: [{ path: "data.roster.players[].name", source: "espn.player.name" }],
      };
    },
  );

  server.registerResource(
    "tool_outputs",
    "espn-ff://docs/tool-outputs",
    {
      description:
        "The tool-output cheat-sheet: fields per tool, TTLs, the never-re-fetch rules, the untrusted-text rule.",
      mimeType: "text/markdown",
      cacheHint: hint("espn-ff://docs/tool-outputs"),
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: toolOutputsText(options) }],
    }),
  );

  /** Completion over the configured league's newest log ids (plan 07 §4.1 RFC 6570 completion). */
  const recentLogIds = (value: string): string[] => {
    try {
      return services.recommendationLog
        .list({
          league_id: services.league.league_id,
          season: null,
          week: null,
          kind: null,
          limit: 20,
          offset: 0,
        })
        .items.map((i) => i.log_id)
        .filter((id) => id.startsWith(value));
    } catch {
      return [];
    }
  };

  server.registerResource(
    "rec",
    new ResourceTemplate("espn-ff://rec/{log_id}", {
      list: undefined,
      complete: { log_id: recentLogIds },
    }),
    {
      description: "One recommendation-log entry (its free text is untrusted, model-authored).",
      mimeType: JSON_MIME,
      cacheHint: hint("espn-ff://rec/{log_id}"),
    },
    (uri, variables) => {
      const raw = variables.log_id;
      const id = typeof raw === "string" ? raw : "";
      if (!LOG_ID_RE.test(id))
        throw new ResourceNotFoundError("espn-ff://rec/{log_id}", "not found");
      return readAsEnvelope(uri.href, services, options, (ctx) => {
        const r = ctx.services.recommendationLog.get(id);
        if (r?.league_id !== ctx.services.league.league_id)
          throw new ResourceNotFoundError("espn-ff://rec/{log_id}", "not found");
        return Promise.resolve({
          data: recordView(r),
          inputs: [],
          bareFields: recordTextFields("data"),
          extraSources: [REC_SOURCE],
        });
      });
    },
  );

  server.registerResource(
    "rec_week",
    new ResourceTemplate("espn-ff://rec/week/{week}", {
      list: undefined,
      complete: {
        week: (value) =>
          Array.from({ length: BOUNDS.week.max }, (_, i) => String(i + 1)).filter((w) =>
            w.startsWith(value),
          ),
      },
    }),
    {
      description: "The current season's log entries for one week, summary form (untrusted text).",
      mimeType: JSON_MIME,
      cacheHint: hint("espn-ff://rec/week/{week}"),
    },
    (uri, variables) => {
      const raw = variables.week;
      const w = typeof raw === "string" && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!(Number.isInteger(w) && w >= BOUNDS.week.min && w <= BOUNDS.week.max))
        throw new ResourceNotFoundError("espn-ff://rec/week/{week}", "not found");
      return readAsEnvelope(uri.href, services, options, (ctx) =>
        Promise.resolve({
          data: { week: w, items: recWeekItems(ctx, w) },
          inputs: [],
          bareFields: [{ path: "data.items[].action_summary", source: REC_SOURCE }],
          extraSources: [REC_SOURCE],
          listKey: "items",
        }),
      );
    },
  );
}
