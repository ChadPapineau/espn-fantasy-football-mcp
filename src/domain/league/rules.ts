// rules.ts — the league's rules from its settings (plan 01 §9 `getLeagueRules`: the platform's own
// enums as strings plus conservative predicates; plan 07 A1 `rules` incl. `waiver.next_execution`
// from `status.waiverNextExecutionDate`, `playoff_weeks` from `matchupPeriods` — never the help
// page — and `bye_seeds` from the bracket size; research 05 §1.1 waiver mechanics, §2.3 playoff
// structure; research 03 §B.1 paths, §G.1 #8 the unverified waiver fields). Unknown enum values are
// kept (an enum-shaped token only, never free text) and named in `unverified`; nothing is guessed.
// ESPN-specific (the sibling's rules.ts reduces Yahoo spellings; nothing of it fits).
import { buildRosterSlots, enumToken } from "./slots.js";
import { easternDayHour, gamesOfWeek, kickoffMsOf, scheduledWeeks } from "./schedule.js";
import {
  normaliseAcquisitionBudget,
  normaliseAcquisitionLimit,
  normaliseMatchupAcquisitionLimit,
  waiverPredicatesOf,
  waiverSystemOf,
  type IsoInstant,
  type LeagueRules,
  type LeagueSettingsDigest,
  type LeagueSettingsInput,
  type PlayoffRules,
  type ProSchedule,
  type ScheduleSettingsInput,
  type TieRules,
  type TieSettingsInput,
  type TradeRules,
  type TradeSettingsInput,
  type WaiverRules,
  type WaiverSettingsInput,
  type Week,
} from "./types.js";

// --- vocabularies (the domain's copies; a parity test holds them equal to the provider's) ---------

/** `acquisitionType` values observed on the recorded leagues. */
export const KNOWN_ACQUISITION_TYPES: readonly string[] = Object.freeze([
  "WAIVERS_CONTINUOUS",
  "WAIVERS_TRADITIONAL",
]);
/** `waiverProcessDays[]` values, in calendar order (Monday first). */
export const WAIVER_DAYS: readonly string[] = Object.freeze([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
/** `playoffSeedingRule` values (TOTAL_POINTS_SCORED observed; the others [V-community]). */
export const KNOWN_SEEDING_RULES: readonly string[] = Object.freeze([
  "TOTAL_POINTS_SCORED",
  "H2H_RECORD",
  "INTRA_DIVISION_RECORD",
]);
/** `matchupTieRule` / `playoffMatchupTieRule` values observed. */
export const KNOWN_TIE_RULES: readonly string[] = Object.freeze(["SLOT_POINTS", "NONE"]);
/** The placeholder for an absent or unreadable enum in a field typed `string`. */
export const UNKNOWN_ENUM = "UNKNOWN";

// --- small validators --------------------------------------------------------------------------------

/** The plausible instant range for an ESPN epoch-ms date (2000-01-01 .. 2100-01-01). */
const EPOCH_MIN_MS = Date.UTC(2000, 0, 1);
const EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

/** ESPN epoch ms → ISO, or null when absent, non-integer or outside 2000–2100. */
export function epochMsToIso(ms: number | null): IsoInstant | null {
  return typeof ms === "number" && Number.isInteger(ms) && ms >= EPOCH_MIN_MS && ms <= EPOCH_MAX_MS
    ? new Date(ms).toISOString()
    : null;
}

/** An integer in [min, max], else null. */
function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** A boolean, else null. */
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** −1 (any negative integer) = unlimited → null; a non-negative integer is kept; else null. */
function capOrUnlimited(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

// --- waivers ---------------------------------------------------------------------------------------

/** `waiverProcessDays[]` → known days in calendar order, then unknown tokens; plus a problem flag. */
function processDays(raw: readonly string[] | null): { days: string[]; unknown: boolean } {
  if (raw === null) return { days: [], unknown: false };
  if (!Array.isArray(raw)) return { days: [], unknown: true };
  const tokens = raw.slice(0, 14);
  let unknown = raw.length > 14;
  const known = new Set<string>();
  const other = new Set<string>();
  for (const t of tokens) {
    const tok = enumToken(t);
    if (tok === null) unknown = true;
    else if (WAIVER_DAYS.includes(tok)) known.add(tok);
    else {
      other.add(tok);
      unknown = true;
    }
  }
  return { days: [...WAIVER_DAYS.filter((d) => known.has(d)), ...[...other].sort()], unknown };
}

/**
 * The waiver rules (plan 07 A1 `rules.waiver`). `budget` and `min_bid` only when a budget is used
 * (a no-budget league still sends numbers); `waiver_hours` 0–336; `process_hour` 0–23. `unverified`
 * always names `order_reset` (its meaning is inferred from three recorded leagues, not documented —
 * research 03 §G.1 #8), `process_hour` (read as ET, but one recorded league processes hours away
 * from it) and `matchup_limit_per_period` ([U]); it adds `type` for an unobserved acquisition type
 * and `process_days` for an unknown day token.
 */
export function buildWaiverRules(a: WaiverSettingsInput): WaiverRules {
  const type = enumToken(a.acquisition_type);
  const usesBudget = boolOrNull(a.uses_budget);
  const days = processDays(a.process_days);
  const unverified = ["matchup_limit_per_period", "order_reset", "process_hour"];
  if (type === null || !KNOWN_ACQUISITION_TYPES.includes(type)) unverified.push("type");
  if (days.unknown) unverified.push("process_days");
  const minBid = a.min_bid;
  return Object.freeze({
    type: type ?? UNKNOWN_ENUM,
    uses_budget: usesBudget,
    budget: normaliseAcquisitionBudget(usesBudget, a.budget),
    min_bid:
      usesBudget === true && typeof minBid === "number" && Number.isFinite(minBid) && minBid >= 0
        ? minBid
        : null,
    waiver_hours: intIn(a.waiver_hours, 0, 336),
    process_days: Object.freeze(days.days),
    process_hour: intIn(a.process_hour, 0, 23),
    order_reset: boolOrNull(a.order_reset),
    next_execution: epochMsToIso(a.next_execution_ms),
    last_execution: epochMsToIso(a.last_execution_ms),
    acquisition_limit: normaliseAcquisitionLimit(a.acquisition_limit),
    matchup_acquisition_limit: normaliseMatchupAcquisitionLimit(a.matchup_acquisition_limit),
    matchup_limit_per_period: boolOrNull(a.matchup_limit_per_period),
    unverified: Object.freeze(unverified.sort()),
  });
}

/** The waiver system of already-sanitised settings (the contract's conservative mapping). */
function systemOf(a: WaiverSettingsInput): ReturnType<typeof waiverSystemOf> {
  return waiverSystemOf({
    acquisition_type: enumToken(a.acquisition_type),
    uses_budget: boolOrNull(a.uses_budget),
    budget: a.budget,
    order_reset: boolOrNull(a.order_reset),
    acquisition_limit: a.acquisition_limit,
    matchup_acquisition_limit: a.matchup_acquisition_limit,
  });
}

/**
 * How the waiver ORDER moves (research 05 §1.1: ESPN offers two refresh rules): `move_to_last` —
 * a successful claim sends the team to the bottom (`waiverOrderReset: false`, the recorded rolling
 * league); `weekly_reset` — the order resets each week to inverse standings (`true`; the help
 * page's other rule — the FAAB leagues send it, where it orders bid ties) — inferred, so the waiver
 * rules list `order_reset` as unverified; `unknown` when the field is absent.
 */
export type WaiverOrderRule = "move_to_last" | "weekly_reset" | "unknown";

/** The waiver order rule of a league's waiver rules. */
export function waiverOrderRuleOf(w: Pick<WaiverRules, "order_reset">): WaiverOrderRule {
  if (w.order_reset === false) return "move_to_last";
  return w.order_reset === true ? "weekly_reset" : "unknown";
}

/** When the next waiver run happens and how that is known. */
export interface NextWaiverRun {
  readonly at: IsoInstant | null;
  /** `status` = `waiverNextExecutionDate`; `process_days_et` = the ET fallback (plan 06 §2); else unknown. */
  readonly basis: "status" | "process_days_et" | "unknown";
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The next waiver run after `nowMs`: `status.waiverNextExecutionDate` when it is still ahead (plan
 * 07 A1; ADV OBJ-16); otherwise the first `process_days` day at `process_hour` read as US-Eastern
 * (plan 06 §2's fallback — unverified, a doctor warning); otherwise unknown. Never the calendar.
 */
export function nextWaiverRun(w: WaiverRules, nowMs: number): NextWaiverRun {
  const stated = w.next_execution === null ? null : Date.parse(w.next_execution);
  if (stated !== null && stated > nowMs)
    return { at: new Date(stated).toISOString(), basis: "status" };
  const hour = w.process_hour;
  const days = new Set(
    w.process_days.filter((d) => WAIVER_DAYS.includes(d)).map((d) => d.toLowerCase()),
  );
  if (hour === null || days.size === 0 || !Number.isFinite(nowMs))
    return { at: null, basis: "unknown" };
  // walk whole hours from the next hour boundary: the first instant whose ET weekday is a process
  // day and whose ET hour is the process hour (DST-safe; at most 8 days of hours)
  const start = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (let t = start; t <= start + 8 * DAY_MS; t += HOUR_MS) {
    const { day, hour: h } = easternDayHour(t);
    if (h === hour && days.has(day))
      return { at: new Date(t).toISOString(), basis: "process_days_et" };
  }
  return { at: null, basis: "unknown" };
}

// --- trades ----------------------------------------------------------------------------------------

/** The trade rules (plan 07 A1 `rules.trade`); `max` −1 → null (unlimited). */
export function buildTradeRules(t: TradeSettingsInput): TradeRules {
  return Object.freeze({
    deadline: epochMsToIso(t.deadline_ms),
    revision_hours: intIn(t.revision_hours, 0, 24 * 30),
    veto_votes_required: intIn(t.veto_votes_required, 0, 100),
    max: capOrUnlimited(t.max),
  });
}

/** Where `nowMs` stands against the trade deadline. */
export interface TradeDeadlineStatus {
  readonly deadline: IsoInstant | null;
  /** null when the league states no deadline. */
  readonly passed: boolean | null;
  readonly ms_remaining: number | null;
}

/** The deadline's status at `nowMs` (inclusive: at the instant itself trading is closed). */
export function tradeDeadlineStatus(
  t: Pick<TradeRules, "deadline">,
  nowMs: number,
): TradeDeadlineStatus {
  const at = t.deadline === null ? Number.NaN : Date.parse(t.deadline);
  if (!Number.isFinite(at)) return { deadline: null, passed: null, ms_remaining: null };
  return { deadline: t.deadline, passed: nowMs >= at, ms_remaining: Math.max(0, at - nowMs) };
}

/**
 * The NFL weeks either side of the deadline (research 05 §2.2's deadline calculus): `first_week_after`
 * is the first week whose first known kickoff is at or after the deadline — the post-deadline
 * horizon starts there — and `last_week_before` the last week that kicked off before it.
 */
export function tradeDeadlineWeeks(
  t: Pick<TradeRules, "deadline">,
  schedule: Pick<ProSchedule, "games">,
): { readonly last_week_before: Week | null; readonly first_week_after: Week | null } {
  const at = t.deadline === null ? Number.NaN : Date.parse(t.deadline);
  if (!Number.isFinite(at)) return { last_week_before: null, first_week_after: null };
  let before: Week | null = null;
  let after: Week | null = null;
  for (const w of scheduledWeeks(schedule)) {
    const first =
      gamesOfWeek(schedule, w)
        .map(kickoffMsOf)
        .find((k) => k !== null) ?? null;
    if (first === null) continue;
    if (first < at) before = w;
    else after ??= w;
  }
  return { last_week_before: before, first_week_after: after };
}

// --- playoffs and the season calendar ----------------------------------------------------------------

/** The largest playoff field the bracket arithmetic accepts (ESPN leagues hold ≤ 20 teams). */
export const MAX_PLAYOFF_TEAMS = 20;

/** The bracket size: the smallest power of two ≥ the playoff field; null for no or a bad count. */
export function bracketSizeOf(teamCount: number | null): number | null {
  if (intIn(teamCount, 1, MAX_PLAYOFF_TEAMS) === null || teamCount === null) return null;
  let b = 1;
  while (b < teamCount) b *= 2;
  return b;
}

/**
 * Seeds with a first-round bye (research 05 §2.3 [V-docs]: "Any BYEs replace the seed starting with
 * the highest number" — 6 teams in an 8-team bracket → seeds 1 and 2 idle).
 */
export function byeSeedsOf(teamCount: number | null): number | null {
  const b = bracketSizeOf(teamCount);
  return b === null || teamCount === null ? null : b - teamCount;
}

/** Playoff rounds: log₂ of the bracket (0 for a one-team field). */
export function playoffRoundsOf(teamCount: number | null): number | null {
  const b = bracketSizeOf(teamCount);
  return b === null ? null : Math.round(Math.log2(b));
}

/** The largest week a matchup period may name (plan 02 §5's outer bound). */
const MAX_WEEK = 22;

/**
 * `matchupPeriods` validated: canonical period ids `"1"`…`"99"`, each a sorted, de-duplicated list
 * of integer weeks 1–22 (≤ 22 of them); an empty or unreadable period is dropped and flagged.
 */
export function normaliseMatchupPeriods(raw: unknown): {
  readonly periods: Readonly<Record<string, readonly number[]>>;
  readonly problem: boolean;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { periods: {}, problem: true };
  const keys = Object.keys(raw);
  let problem = keys.length > 99;
  const out: [number, readonly number[]][] = [];
  for (const k of keys.slice(0, 99)) {
    const v = (raw as Record<string, unknown>)[k];
    if (!/^[1-9][0-9]?$/.test(k) || !Array.isArray(v)) {
      problem = true;
      continue;
    }
    const weeks = [
      ...new Set(
        (v as unknown[])
          .slice(0, MAX_WEEK)
          .filter((w): w is number => intIn(w, 1, MAX_WEEK) !== null),
      ),
    ].sort((a, b) => a - b);
    if (weeks.length === 0 || weeks.length !== (v as unknown[]).length) problem = true;
    if (weeks.length > 0) out.push([Number(k), Object.freeze(weeks)]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return {
    periods: Object.freeze(Object.fromEntries(out.map(([k, w]) => [String(k), w]))),
    problem,
  };
}

/**
 * The playoff rules (plan 07 A1 `rules.playoffs`). `playoff_weeks` = the weeks of every matchup
 * period after the regular season's `matchupPeriodCount` — read from `matchupPeriods`, never assumed
 * (research 05 §2.3). `consolation` = not `consolationLadderDisabled`. Flags `playoff_weeks` as
 * unverified when the map is missing or unreadable, when a playoff week repeats a regular-season
 * week, or when the number of playoff periods differs from the bracket's rounds.
 */
export function buildPlayoffRules(s: ScheduleSettingsInput): {
  readonly playoffs: PlayoffRules;
  readonly unverified: readonly string[];
} {
  const unverified: string[] = ["seeding_rule_by"];
  const rule = enumToken(s.playoff_seeding_rule);
  if (rule === null || !KNOWN_SEEDING_RULES.includes(rule)) unverified.push("seeding_rule");
  const teamCount = intIn(s.playoff_team_count, 0, MAX_PLAYOFF_TEAMS);
  const regular = intIn(s.regular_season_matchups, 1, 99);
  const { periods, problem } =
    s.matchup_periods === null
      ? { periods: {}, problem: true }
      : normaliseMatchupPeriods(s.matchup_periods);
  const playoffPeriods = Object.keys(periods)
    .map(Number)
    .filter((p) => regular !== null && p > regular);
  const playoffWeeks = [...new Set(playoffPeriods.flatMap((p) => periods[String(p)] ?? []))].sort(
    (a, b) => a - b,
  );
  const regularWeeks = new Set(
    Object.keys(periods)
      .map(Number)
      .filter((p) => regular !== null && p <= regular)
      .flatMap((p) => periods[String(p)] ?? []),
  );
  const rounds = playoffRoundsOf(teamCount);
  if (
    problem ||
    regular === null ||
    playoffWeeks.some((w) => regularWeeks.has(w)) ||
    (rounds !== null && rounds !== playoffPeriods.length)
  )
    unverified.push("playoff_weeks");
  const disabled = boolOrNull(s.consolation_ladder_disabled);
  const playoffs: PlayoffRules = Object.freeze({
    team_count: teamCount,
    seeding_rule: rule ?? UNKNOWN_ENUM,
    seeding_rule_by: intIn(s.playoff_seeding_rule_by, -1000, 1000),
    reseed: boolOrNull(s.playoff_reseed),
    matchup_period_length: intIn(s.playoff_matchup_period_length, 1, 8),
    variable_length: boolOrNull(s.variable_playoff_length),
    consolation: disabled === null ? null : !disabled,
    regular_season_matchups: regular,
    matchup_periods: periods,
    playoff_weeks: Object.freeze(playoffWeeks),
    bye_seeds: byeSeedsOf(teamCount),
  });
  return Object.freeze({ playoffs, unverified: Object.freeze(unverified.sort()) });
}

/** The tie rules; an unknown token is kept and flagged. */
export function buildTieRules(t: TieSettingsInput): {
  readonly ties: TieRules;
  readonly unverified: readonly string[];
} {
  const matchup = enumToken(t.matchup_tie_rule);
  const playoff = enumToken(t.playoff_tie_rule);
  const unverified: string[] = [];
  if (
    (t.matchup_tie_rule !== null && matchup === null) ||
    (matchup !== null && !KNOWN_TIE_RULES.includes(matchup))
  )
    unverified.push("matchup_tie_rule");
  if (
    (t.playoff_tie_rule !== null && playoff === null) ||
    (playoff !== null && !KNOWN_TIE_RULES.includes(playoff))
  )
    unverified.push("playoff_tie_rule");
  return Object.freeze({
    ties: Object.freeze({ matchup_tie_rule: matchup, playoff_tie_rule: playoff }),
    unverified: Object.freeze(unverified),
  });
}

/** `financeSettings` amounts: snake_case keys (≤ 32), finite non-negative numbers; null stays null. */
export function normaliseFees(fees: unknown): Readonly<Record<string, number>> | null {
  if (fees === null || typeof fees !== "object" || Array.isArray(fees)) return null;
  const out: [string, number][] = [];
  for (const k of Object.keys(fees).slice(0, 32)) {
    const v = (fees as Record<string, unknown>)[k];
    if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && typeof v === "number" && Number.isFinite(v) && v >= 0)
      out.push([k, v]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return Object.freeze(Object.fromEntries(out));
}

/**
 * The league's rules (plan 01 §9 `getLeagueRules`; plan 07 A1 `rules`): waiver, trade, playoff and
 * tie rules, fees, the waiver system with its conservative predicates (unknown → null), and every
 * unverified field as a `section.field` path.
 */
export function buildLeagueRules(input: LeagueSettingsInput): LeagueRules {
  const waiver = buildWaiverRules(input.acquisition);
  const { playoffs, unverified: playoffUnverified } = buildPlayoffRules(input.schedule);
  const { ties, unverified: tieUnverified } = buildTieRules(input.ties);
  const system = systemOf(input.acquisition);
  const unverified = new Set<string>([
    ...waiver.unverified.map((f) => `waiver.${f}`),
    ...playoffUnverified.map((f) => `playoffs.${f}`),
    ...tieUnverified.map((f) => `ties.${f}`),
  ]);
  if (system === "unknown") unverified.add("waiver_system");
  return Object.freeze({
    waiver,
    trade: buildTradeRules(input.trade),
    playoffs,
    ties,
    fees: normaliseFees(input.fees),
    waiver_system: system,
    predicates: Object.freeze(waiverPredicatesOf(system)),
    unverified_fields: Object.freeze([...unverified].sort()),
  });
}

/**
 * The settings digest the provider and `espn_get_league` share (plan 07 A1 `roster`, `rules`,
 * `unverified_fields`): one pure call over one league's normalised settings.
 */
export function buildLeagueSettings(input: LeagueSettingsInput): LeagueSettingsDigest {
  const { roster, unverified } = buildRosterSlots(input.roster);
  const rules = buildLeagueRules(input);
  return Object.freeze({
    roster,
    rules,
    unverified_fields: Object.freeze(
      [...new Set([...unverified, ...rules.unverified_fields])].sort(),
    ),
  });
}

// --- the calendar helpers the engines share --------------------------------------------------------

/** The matchup period a week belongs to (the lowest period id listing it), or null. */
export function matchupPeriodOfWeek(
  p: Pick<PlayoffRules, "matchup_periods">,
  week: Week,
): number | null {
  let best: number | null = null;
  for (const [k, weeks] of Object.entries(p.matchup_periods))
    if (weeks.includes(week) && (best === null || Number(k) < best)) best = Number(k);
  return best;
}

/** Whether a week is a playoff week. */
export function isPlayoffWeek(p: Pick<PlayoffRules, "playoff_weeks">, week: Week): boolean {
  return p.playoff_weeks.includes(week);
}

/** The regular season's weeks (periods 1..`regular_season_matchups`), ascending. */
export function regularSeasonWeeks(
  p: Pick<PlayoffRules, "matchup_periods" | "regular_season_matchups">,
): Week[] {
  const regular = p.regular_season_matchups;
  if (regular === null) return [];
  const out = new Set<Week>();
  for (const [k, weeks] of Object.entries(p.matchup_periods))
    if (Number(k) <= regular) for (const w of weeks) out.add(w);
  return [...out].sort((a, b) => a - b);
}

/**
 * The weeks from `fromWeek` (inclusive) to the season's end — regular season, plus the playoff
 * weeks unless `playoffs` is false (the waiver DP's `W`, research 05 §1.2).
 */
export function remainingWeeks(
  p: Pick<PlayoffRules, "matchup_periods" | "regular_season_matchups" | "playoff_weeks">,
  fromWeek: Week,
  opts: { readonly playoffs?: boolean } = {},
): Week[] {
  const weeks = new Set(regularSeasonWeeks(p));
  if (opts.playoffs !== false) for (const w of p.playoff_weeks) weeks.add(w);
  return [...weeks].filter((w) => w >= fromWeek).sort((a, b) => a - b);
}
