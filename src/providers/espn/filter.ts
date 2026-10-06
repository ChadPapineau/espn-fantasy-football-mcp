// filter.ts — the ONE `X-Fantasy-Filter` builder (plan 02 §5; plan 01 §4.2; research 03 §A.3):
// typed keys only; `limit` present ⇒ a sort present (a limit without a sort is ESPN's 400
// FILTER_LIMIT_MISSING_SORT — refused here as VALIDATION, never sent); `limit ≤ 100`, `offset ≤
// 5 000`, ≤ 50 `filterIds`; nesting chosen by route (entity-nested on league paths, root-level on
// `/players`); serialised once, canonically (keys sorted, arrays as given), so equal specs produce
// byte-equal headers and one cache key. The C2 `sort` → ESPN sort mapping is PLAYER_SORT_MAP's.
import { POOL_STATUSES, type PoolStatus } from "../../domain/league/types.js";
import { EspnRequestError } from "./path.js";
import {
  FILTER_IDS_MAX,
  FILTER_LIMIT_MAX,
  FILTER_OFFSET_MAX,
  PLAYER_SORT_KEYS,
  PLAYER_SORT_MAP,
  TRANSACTION_TYPES,
  isEspnPlayerIdValue,
  type PlayerSortKey,
  type PlayerSortName,
} from "./types.js";

/** One sort term (`{"sortPriority":p,"sortAsc":b,"value"?:v}` under its key). */
export interface SortTerm {
  readonly key: PlayerSortKey;
  readonly asc: boolean;
  readonly priority: number;
  readonly value?: string;
}

/** A player filter (inside `players` on league paths; root-level on `/players`). */
export interface PlayerFilterSpec {
  readonly filterStatus?: readonly PoolStatus[];
  readonly filterSlotIds?: readonly number[];
  readonly filterIds?: readonly number[];
  readonly filterActive?: boolean;
  readonly filterStatsForTopScoringPeriodIds?: {
    readonly value: number;
    readonly additionalValue: readonly string[];
  };
  readonly limit?: number;
  readonly offset?: number;
  readonly sorts?: readonly SortTerm[];
}

const PLAYER_SPEC_KEYS: readonly string[] = [
  "filterStatus",
  "filterSlotIds",
  "filterIds",
  "filterActive",
  "filterStatsForTopScoringPeriodIds",
  "limit",
  "offset",
  "sorts",
];
const STAT_SPLIT_ID_RE = /^[01][0-2][0-9]{4}$/;

/** JSON with keys sorted at every depth (arrays keep their order) — the one serialisation. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function intIn(v: unknown, min: number, max: number, reason: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new EspnRequestError(reason);
  return v;
}

/** Array membership without narrowing (the typed value stays typed). */
function isList(v: unknown): boolean {
  return Array.isArray(v);
}

function nonEmpty<T>(v: readonly T[] | undefined, max: number, reason: string): readonly T[] {
  if (v === undefined || !isList(v) || v.length === 0 || v.length > max)
    throw new EspnRequestError(reason);
  return v;
}

/** Builds the player filter object (not yet serialised); throws VALIDATION on any refused shape. */
export function playerFilterObject(spec: PlayerFilterSpec): Record<string, unknown> {
  if (typeof spec !== "object" || (spec as unknown) === null)
    throw new EspnRequestError("filter_not_object");
  for (const k of Object.keys(spec))
    if (!PLAYER_SPEC_KEYS.includes(k)) throw new EspnRequestError("filter_key_unknown");
  const out: Record<string, unknown> = {};
  if (spec.filterStatus !== undefined) {
    const s = nonEmpty(spec.filterStatus, POOL_STATUSES.length, "filter_status_invalid");
    if (!s.every((x) => (POOL_STATUSES as readonly string[]).includes(x)))
      throw new EspnRequestError("filter_status_invalid");
    out.filterStatus = { value: POOL_STATUSES.filter((p) => s.includes(p)) };
  }
  if (spec.filterSlotIds !== undefined) {
    const ids = nonEmpty(spec.filterSlotIds, 26, "filter_slot_ids_invalid");
    for (const id of ids) intIn(id, 0, 25, "filter_slot_ids_invalid");
    out.filterSlotIds = { value: [...new Set(ids)].sort((a, b) => a - b) };
  }
  if (spec.filterIds !== undefined) {
    const ids = nonEmpty(spec.filterIds, FILTER_IDS_MAX, "filter_ids_invalid");
    if (!ids.every((id) => isEspnPlayerIdValue(id)))
      throw new EspnRequestError("filter_ids_invalid");
    out.filterIds = { value: [...new Set(ids)].sort((a, b) => a - b) };
  }
  if (spec.filterActive !== undefined) {
    if (typeof spec.filterActive !== "boolean") throw new EspnRequestError("filter_active_invalid");
    out.filterActive = { value: spec.filterActive };
  }
  if (spec.filterStatsForTopScoringPeriodIds !== undefined) {
    const f = spec.filterStatsForTopScoringPeriodIds;
    const value = intIn(f.value, 0, 22, "filter_stats_invalid");
    const extra = nonEmpty(f.additionalValue, 8, "filter_stats_invalid");
    if (!extra.every((x) => typeof x === "string" && STAT_SPLIT_ID_RE.test(x)))
      throw new EspnRequestError("filter_stats_invalid");
    out.filterStatsForTopScoringPeriodIds = { value, additionalValue: [...extra] };
  }
  const sorts: readonly SortTerm[] = spec.sorts ?? [];
  if (!isList(sorts) || sorts.length > PLAYER_SORT_KEYS.length)
    throw new EspnRequestError("sort_invalid");
  for (const s of sorts) {
    if (!(PLAYER_SORT_KEYS as readonly string[]).includes(s.key) || s.key in out)
      throw new EspnRequestError("sort_invalid");
    intIn(s.priority, 1, 1000, "sort_invalid");
    if (typeof s.asc !== "boolean") throw new EspnRequestError("sort_invalid");
    if (s.value !== undefined && !/^[A-Z0-9_]{1,24}$/.test(s.value))
      throw new EspnRequestError("sort_invalid");
    out[s.key] = {
      sortAsc: s.asc,
      sortPriority: s.priority,
      ...(s.value === undefined ? {} : { value: s.value }),
    };
  }
  if (spec.limit !== undefined) {
    out.limit = intIn(spec.limit, 1, FILTER_LIMIT_MAX, "limit_out_of_range");
    if (sorts.length === 0) throw new EspnRequestError("limit_without_sort");
  }
  if (spec.offset !== undefined) {
    if (spec.limit === undefined) throw new EspnRequestError("offset_without_limit");
    out.offset = intIn(spec.offset, 0, FILTER_OFFSET_MAX, "offset_out_of_range");
  }
  if (Object.keys(out).length === 0) throw new EspnRequestError("filter_empty");
  return out;
}

/** The player filter header value: entity-nested (`{"players":…}`) on league paths, root on `/players`. */
export function playerFilter(spec: PlayerFilterSpec, nesting: "league" | "root"): string {
  const inner = playerFilterObject(spec);
  if (nesting === "root") {
    if (spec.limit !== undefined) throw new EspnRequestError("root_filter_limit_refused");
    return canonicalJson(inner);
  }
  return canonicalJson({ players: inner });
}

/**
 * The sort terms for one C2 `sort` (plan 07 C2; PLAYER_SORT_MAP): the primary term at priority 1
 * and, unless the primary is the draft rank itself, `sortDraftRanks` STANDARD at priority 100 as a
 * deterministic tie-break (the recorded request's pair). An applied-stat sort ranks by the split
 * the map names, encoded as ESPN's split id (`11<season><week>` weekly, `10<season>` rest of
 * season — the community encoding, research 03 §A.3 [V-community]).
 */
export function sortTerms(sort: PlayerSortName, season: number, week: number): SortTerm[] {
  const spec = PLAYER_SORT_MAP[sort];
  let value: string | undefined = spec.value ?? undefined;
  if (spec.split === "weekly_projection") value = `11${String(season)}${String(week)}`;
  else if (spec.split === "ros_projection") value = `10${String(season)}`;
  const primary: SortTerm = {
    key: spec.key,
    asc: spec.sort_asc,
    priority: 1,
    ...(value === undefined ? {} : { value }),
  };
  return spec.key === "sortDraftRanks"
    ? [primary]
    : [primary, { key: "sortDraftRanks", asc: true, priority: 100, value: "STANDARD" }];
}

/** The `mTransactions2` filter (`{"transactions":{"filterType":{"value":[…]}}}`; research 03 §A.3). */
export function transactionsFilter(types: readonly string[]): string {
  const t = nonEmpty(types, TRANSACTION_TYPES.length, "transaction_types_invalid");
  if (!t.every((x) => (TRANSACTION_TYPES as readonly string[]).includes(x)))
    throw new EspnRequestError("transaction_types_invalid");
  return canonicalJson({
    transactions: { filterType: { value: TRANSACTION_TYPES.filter((x) => t.includes(x)) } },
  });
}

/** The box-score filter (`{"schedule":{"filterMatchupPeriodIds":{"value":[n]}}}` — the recorded shape). */
export function scheduleFilter(matchupPeriodIds: readonly number[]): string {
  const ids = nonEmpty(matchupPeriodIds, 25, "matchup_period_invalid");
  for (const id of ids) intIn(id, 1, 25, "matchup_period_invalid");
  return canonicalJson({
    schedule: { filterMatchupPeriodIds: { value: [...new Set(ids)].sort((a, b) => a - b) } },
  });
}

/** The board probe filter (plan 02 §2.1): one topic, newest first; the body is discarded. */
export function boardProbeFilter(): string {
  return canonicalJson({
    topics: { limit: 1, sortMessageDate: { sortAsc: false, sortPriority: 1 } },
  });
}
