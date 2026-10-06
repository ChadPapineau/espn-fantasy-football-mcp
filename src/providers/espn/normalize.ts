// normalize.ts — the ONLY code that turns ESPN wire bodies into platform objects (plan 01 §4.4, §9;
// plan 02 §2.4, §6.2; research 03 §B): every free-text field is wrapped at its tag's cap (team and
// league names, divisions, outlooks) or emitted bare-and-listed (player names, `espn.player.name`);
// slot ids and position ids are decoded with their OWN maps (ids.ts); member GUIDs, member names,
// `clientAddress` and `notificationSettings` never leave this file (`is_mine` and `commissioner` are
// computed here); epoch-ms timestamps become ISO; a stat entry with an unknown
// `(statSourceId, statSplitTypeId)` fails the ENTRY (plan 01 §7) and is counted, never coerced.
import { createHash } from "node:crypto";
import {
  bareUntrusted,
  normaliseAcquisitionBudget,
  normaliseAcquisitionLimit,
  normaliseMatchupAcquisitionLimit,
  POOL_STATUSES,
  waiverPredicatesOf,
  waiverSystemOf,
  wrapUntrusted,
  wrapUntrustedOrNull,
  type BoxScoreEntry,
  type BoxScoreMatchup,
  type BoxScoreSide,
  type Division,
  type GameState,
  type League,
  type LeagueRef,
  type LeagueRules,
  type LiveMatchup,
  type LiveSide,
  type Matchup,
  type MatchupSide,
  type MatchupWinner,
  type NativeProjection,
  type Ownership,
  type PlatformPlayer,
  type PlatformStatLine,
  type PlayerOutlook,
  type PoolStatus,
  type PositionalRating,
  type ProGame,
  type ProSchedule,
  type ProjectionHorizon,
  type Roster,
  type RosterEntry,
  type RosterSlot,
  type RosterSlots,
  type Standing,
  type Standings,
  type Transaction,
  type UntrustedText,
} from "../../domain/league/types.js";
import type { StatSourceId, StatSplitTypeId } from "../../domain/scoring/types.js";
import { decodePosition, decodeSlot, isIdInteger, proTeamAbbrev } from "./ids.js";
import {
  ESPN_SLOTS,
  MATCHUP_WINNERS,
  POSITIONAL_RATING_POSITION_IDS,
  statSplitName,
  type EspnScoringInput,
  type StatSplitName,
} from "./types.js";
import type {
  WireBoxscoreBody,
  WireMatchupBody,
  WireMatchupScoreBody,
  WireNavBody,
  WirePlayer,
  WirePoolEntry,
  WirePositionalRatingsBody,
  WireProScheduleBody,
  WireRosterBody,
  WireSettingsBody,
  WireStatEntry,
  WireTeamBody,
} from "./views/index.js";
import { transactionSchema } from "./views/index.js";

// --- small value helpers ------------------------------------------------------------------------

/** Epoch ms → ISO, or null for anything that is not a plausible instant (0 < ms < year 2100). */
export function isoFromMs(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms < 4_102_444_800_000
    ? new Date(ms).toISOString()
    : null;
}

/** A finite number or null. */
export function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const STAT_KEY_RE = /^-?[0-9]{1,6}$/;
const TOKEN_RE = /^[A-Z][A-Z0-9_]{0,47}$/;

/** A numeric-keyed map with finite values only (stat ids, weeks); anything else is dropped. */
export function numericMap(m: unknown): Readonly<Record<string, number>> {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return {};
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(m))
    if (STAT_KEY_RE.test(k) && typeof v === "number" && Number.isFinite(v)) out.push([k, v]);
  return Object.fromEntries(out);
}

/** An ESPN enum token (UPPER_SNAKE, bounded) or null — an enum is never free text. */
export function token(v: unknown): string | null {
  return typeof v === "string" && TOKEN_RE.test(v) ? v : null;
}

/** Counts of what the normaliser refused (logged by the provider; never values). */
export interface NormalizeCounts {
  /** Stat entries whose (source, split) is unknown (plan 01 §7: the entry fails). */
  stat_entries_failed: number;
  /** Rows dropped because an id was outside its grammar. */
  rows_dropped: number;
  /** Transactions that did not match the community shape (plan 07 A6: not drift). */
  transactions_skipped: number;
}

/** A fresh counter set. */
export function newCounts(): NormalizeCounts {
  return { stat_entries_failed: 0, rows_dropped: 0, transactions_skipped: 0 };
}

// --- league identity: names wrapped, owners kept internal ---------------------------------------

/** One team's identity. `owners` are member GUIDs — used only to compute `is_mine`, never emitted. */
export interface TeamIdentity {
  readonly team_id: number;
  readonly name: UntrustedText;
  readonly abbrev: UntrustedText;
  readonly owners: readonly string[];
}

/** The league's teams and members as the provider needs them (internal; never a tool result). */
export interface LeagueIdentity {
  readonly teams: ReadonlyMap<number, TeamIdentity>;
  readonly members: readonly {
    readonly id: string;
    readonly creator: boolean;
    readonly manager: boolean;
  }[];
}

interface WireTeamNames {
  readonly id: number;
  readonly name?: string | null | undefined;
  readonly abbrev?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly nickname?: string | null | undefined;
}

/** A team's display name: `name`, else `location nickname`, else `Team <id>` — always wrapped. */
export function teamName(t: WireTeamNames): UntrustedText {
  const composed = [t.location, t.nickname]
    .filter((x) => typeof x === "string" && x !== "")
    .join(" ");
  const raw = typeof t.name === "string" && t.name !== "" ? t.name : composed;
  return wrapUntrusted(raw === "" ? `Team ${String(t.id)}` : raw, "espn.team.name");
}

/** A team's abbreviation, wrapped (member-authored). */
export function teamAbbrev(t: WireTeamNames): UntrustedText {
  return wrapUntrusted(typeof t.abbrev === "string" ? t.abbrev : "", "espn.team.abbrev");
}

/** The identity from an `mNav` body (teams with owners, members with their flags — no names). */
export function identityFromNav(nav: WireNavBody): LeagueIdentity {
  const teams = new Map<number, TeamIdentity>();
  for (const t of nav.teams)
    teams.set(t.id, { team_id: t.id, name: teamName(t), abbrev: teamAbbrev(t), owners: t.owners });
  return {
    teams,
    members: nav.members.map((m) => ({
      id: m.id,
      creator: m.isLeagueCreator,
      manager: m.isLeagueManager === true,
    })),
  };
}

/** A team's wrapped name from the identity, or `Team <id>` when the team is not in it. */
export function nameOf(identity: LeagueIdentity | null, teamId: number): UntrustedText {
  return identity?.teams.get(teamId)?.name ?? teamName({ id: teamId });
}

/**
 * The caller's team: the operator-recorded `ESPN_TEAM_ID` when it is a team of this league, else
 * the one team whose owners include the SWID (GUIDs compared case-insensitively); null otherwise.
 */
export function myTeamId(
  identity: LeagueIdentity | null,
  swid: string | null,
  configuredTeamId: number | null,
): number | null {
  if (identity === null) return null;
  if (configuredTeamId !== null && identity.teams.has(configuredTeamId)) return configuredTeamId;
  if (swid === null) return null;
  const s = swid.toUpperCase();
  const hits = [...identity.teams.values()].filter((t) =>
    t.owners.some((o) => o.toUpperCase() === s),
  );
  return hits.length === 1 ? (hits[0]?.team_id ?? null) : null;
}

/** Whether the SWID is a commissioner (`isLeagueCreator || isLeagueManager` — research 03 §B.6). */
export function isCommissioner(identity: LeagueIdentity | null, swid: string | null): boolean {
  if (identity === null || swid === null) return false;
  const s = swid.toUpperCase();
  return identity.members.some((m) => m.id.toUpperCase() === s && (m.creator || m.manager));
}

// --- stats ---------------------------------------------------------------------------------------

/** One stat entry as a platform line, or null when its split is unknown (the entry fails). */
export function normalizeStatLine(
  e: WireStatEntry,
  playerId: number,
  provisional: boolean,
  counts: NormalizeCounts,
): PlatformStatLine | null {
  const name = statSplitName(e.statSourceId, e.statSplitTypeId);
  if (name === null) {
    counts.stat_entries_failed++;
    return null;
  }
  return {
    player: { platform: "espn", id: playerId },
    split: {
      source_id: e.statSourceId as StatSourceId,
      split_type: e.statSplitTypeId as StatSplitTypeId,
      season: e.seasonId,
      week: e.statSplitTypeId === 1 ? e.scoringPeriodId : null,
    },
    raw: numericMap(e.stats),
    applied_stats: numericMap(e.appliedStats),
    applied_total: finite(e.appliedTotal),
    provisional,
  };
}

/** The first entry of a named split for a season (and week for weekly splits). */
export function findSplit(
  stats: readonly WireStatEntry[] | null | undefined,
  split: StatSplitName,
  season: number,
  week: number | null,
): WireStatEntry | null {
  for (const e of stats ?? []) {
    if (statSplitName(e.statSourceId, e.statSplitTypeId) !== split || e.seasonId !== season)
      continue;
    if (week !== null && e.scoringPeriodId !== week) continue;
    return e;
  }
  return null;
}

// --- players -------------------------------------------------------------------------------------

/** What a player normalisation needs to know. */
export interface PlayerContext {
  readonly season: number;
  /** The scoring period the projection/rank fields refer to; null = none. */
  readonly week: number | null;
  /** Pro-team id → bye week (from the pro schedule), when known. */
  readonly byeWeeks?: ReadonlyMap<number, number>;
  /** Include outlook text (tool-only — plan 07 C14). */
  readonly outlook?: boolean;
}

function ownershipOf(p: WirePlayer): Ownership | null {
  const o = p.ownership;
  if (o === null || o === undefined) return null;
  return {
    percent_owned: finite(o.percentOwned),
    percent_started: finite(o.percentStarted),
    percent_change: finite(o.percentChange),
    average_draft_position: finite(o.averageDraftPosition),
    auction_value_average: finite(o.auctionValueAverage),
    as_of: isoFromMs(o.date),
  };
}

function outlookTexts(p: WirePlayer): { season: string | null; weekly: [string, string][] } {
  const season =
    typeof p.seasonOutlook === "string" && p.seasonOutlook.trim() !== "" ? p.seasonOutlook : null;
  const weekly: [string, string][] = [];
  const byWeek = p.outlooks?.outlooksByWeek;
  if (byWeek !== null && byWeek !== undefined)
    for (const [k, v] of Object.entries(byWeek))
      if (/^[0-9]{1,2}$/.test(k) && typeof v === "string" && v.trim() !== "") weekly.push([k, v]);
  return { season, weekly };
}

/** ESPN outlooks wrapped (`espn.player.season_outlook`, `espn.player.outlook`), optionally by week. */
export function outlookOf(p: WirePlayer, weeks: readonly number[] | null = null): PlayerOutlook {
  const t = outlookTexts(p);
  const weekly: Record<string, UntrustedText> = {};
  for (const [k, v] of t.weekly)
    if (weeks === null || weeks.includes(Number(k)))
      weekly[k] = wrapUntrusted(v, "espn.player.outlook");
  return { season: wrapUntrustedOrNull(t.season, "espn.player.season_outlook"), weekly };
}

function draftRank(p: WirePlayer): number | null {
  const std = p.draftRanksByRankType?.STANDARD;
  if (typeof std !== "object" || std === null) return null;
  const r = finite((std as { rank?: unknown }).rank);
  return r !== null && r > 0 ? r : null;
}

function weekRank(p: WirePlayer, week: number | null): number | null {
  if (week === null) return null;
  const list = p.rankings?.[String(week)];
  if (!Array.isArray(list)) return null;
  for (const r of list) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as { rank?: unknown; rankType?: unknown };
    const rank = finite(o.rank);
    if (o.rankType === "STANDARD" && rank !== null && rank > 0) return rank;
  }
  return null;
}

/**
 * A platform player from a wire `player` and its pool entry (null for slim box-score players).
 * Null when an id is outside its grammar (the row is dropped and counted — never guessed).
 */
export function normalizePlayer(
  p: WirePlayer,
  pool: WirePoolEntry | null,
  ctx: PlayerContext,
  counts: NormalizeCounts,
): PlatformPlayer | null {
  if (!isIdInteger(p.defaultPositionId) || !Number.isInteger(p.proTeamId)) {
    counts.rows_dropped++;
    return null;
  }
  const pos = decodePosition(p.defaultPositionId);
  const slots = p.eligibleSlots.filter(isIdInteger).map(decodeSlot);
  const status = pool?.status;
  const onTeam = pool?.onTeamId;
  const outlook = outlookTexts(p);
  const injury =
    typeof p.injuryStatus === "string" && TOKEN_RE.test(p.injuryStatus) ? p.injuryStatus : null;
  const player: PlatformPlayer = {
    ref: { platform: "espn", id: p.id },
    name: bareUntrusted(p.fullName, "player_name"),
    position_id: pos.id,
    position: pos.name,
    eligible_slot_ids: slots.map((s) => s.id),
    eligible_slots: slots.map((s) => s.name),
    pro_team_id: p.proTeamId,
    pro_team: proTeamAbbrev(p.proTeamId),
    jersey: typeof p.jersey === "string" && /^[0-9]{1,3}$/.test(p.jersey) ? p.jersey : null,
    bye_week: ctx.byeWeeks?.get(p.proTeamId) ?? null,
    injury_status: injury,
    injured: p.injured === true,
    droppable: typeof p.droppable === "boolean" ? p.droppable : null,
    status:
      typeof status === "string" && (POOL_STATUSES as readonly string[]).includes(status)
        ? (status as PoolStatus)
        : null,
    on_team_id: typeof onTeam === "number" && onTeam > 0 ? onTeam : null,
    waiver_process_date: isoFromMs(pool?.waiverProcessDate),
    ownership: ownershipOf(p),
    projection_week_espn:
      ctx.week === null
        ? null
        : finite(findSplit(p.stats, "weekly_projection", ctx.season, ctx.week)?.appliedTotal),
    projection_ros_espn: finite(
      findSplit(p.stats, "ros_projection", ctx.season, null)?.appliedTotal,
    ),
    rank_week_espn: weekRank(p, ctx.week),
    draft_rank_espn: draftRank(p),
    last_news_at: isoFromMs(p.lastNewsDate),
    has_outlook: outlook.season !== null || outlook.weekly.length > 0,
  };
  return ctx.outlook === true ? { ...player, outlook: outlookOf(p) } : player;
}

// --- settings: league, slots, rules, scoring input ---------------------------------------------

/** League identity and status (plan 01 §9 getLeague) from `mSettings` (+ the mNav identity). */
export function normalizeLeague(
  body: WireSettingsBody,
  ref: LeagueRef,
  identity: LeagueIdentity | null,
  myTeam: number | null,
  commissioner: boolean,
): League {
  const s = body.settings;
  const st = body.status;
  const divisions: Division[] = (s.scheduleSettings.divisions ?? []).map((d) => ({
    id: d.id,
    name: wrapUntrusted(d.name ?? `Division ${String(d.id)}`, "espn.division.name"),
    size: d.size ?? null,
  }));
  return {
    ref,
    name: wrapUntrusted(s.name, "espn.league.name"),
    size: s.size,
    scoring_type: s.scoringSettings.scoringType,
    is_public: typeof s.isPublic === "boolean" ? s.isPublic : null,
    clock: {
      current_matchup_period: st.currentMatchupPeriod,
      current_scoring_period: body.scoringPeriodId,
      latest_scoring_period: st.latestScoringPeriod,
      final_scoring_period: st.finalScoringPeriod,
      first_scoring_period: st.firstScoringPeriod,
      transaction_scoring_period: st.transactionScoringPeriod ?? null,
      is_active: st.isActive,
      is_expired: typeof st.isExpired === "boolean" ? st.isExpired : null,
    },
    previous_seasons: [...(st.previousSeasons ?? [])],
    my_team: myTeam === null ? null : { team_id: myTeam, name: nameOf(identity, myTeam) },
    commissioner,
    divisions,
    waiver_last_execution: isoFromMs(st.waiverLastExecutionDate),
    waiver_next_execution: isoFromMs(st.waiverNextExecutionDate),
    standings_updated_at: isoFromMs(st.standingsUpdateDate),
    playoff_matchup_edited:
      typeof st.isPlayoffMatchupEdited === "boolean" ? st.isPlayoffMatchupEdited : null,
    waiver_order_edited:
      typeof st.isWaiverOrderEdited === "boolean" ? st.isWaiverOrderEdited : null,
  };
}

/** The league's roster slots (plan 01 §9 getRosterSlots): slot ids decoded with the SLOT map. */
export function normalizeRosterSlots(body: WireSettingsBody): RosterSlots {
  const rs = body.settings.rosterSettings;
  const slots: RosterSlot[] = [];
  for (const [k, count] of Object.entries(rs.lineupSlotCounts)) {
    const id = Number(k);
    if (!/^[0-9]{1,2}$/.test(k) || !isIdInteger(id) || !Number.isInteger(count) || count <= 0)
      continue;
    const d = decodeSlot(id);
    slots.push({
      slot_id: d.id,
      name: d.name,
      class: d.class,
      count,
      eligible_positions: eligibleNames(id),
    });
  }
  slots.sort((a, b) => a.slot_id - b.slot_id);
  const sum = (pred: (s: RosterSlot) => boolean): number =>
    slots.filter(pred).reduce((n, s) => n + s.count, 0);
  const limits: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(rs.positionLimits ?? {})) {
    const id = Number(k);
    if (!/^[0-9]{1,2}$/.test(k) || !isIdInteger(id) || !Number.isFinite(v)) continue;
    const d = decodePosition(id);
    if (!d.known || v === 0) continue;
    limits[d.name] = v < 0 ? null : v;
  }
  return {
    slots,
    starters: sum((s) => s.class === "starter" || s.class === "flex"),
    bench: sum((s) => s.class === "bench"),
    ir: sum((s) => s.class === "ir"),
    total: sum(() => true),
    lineup_lock_type: token(rs.lineupLocktimeType),
    undroppable_list:
      typeof rs.isUsingUndroppableList === "boolean" ? rs.isUsingUndroppableList : null,
    position_limits: limits,
    move_limit:
      finite(rs.moveLimit) === null || (rs.moveLimit ?? -1) < 0 ? null : (rs.moveLimit ?? null),
  };
}

/** The position names a slot accepts (ESPN_SLOTS' descriptive eligibility, decoded with the POSITION map). */
function eligibleNames(slotId: number): string[] {
  return (ESPN_SLOTS[slotId]?.eligible ?? []).map((p) => decodePosition(p).name);
}

/** Waiver, trade, playoff and tie rules plus the conservative predicates (plan 01 §9 getLeagueRules). */
export function normalizeLeagueRules(body: WireSettingsBody): LeagueRules {
  const s = body.settings;
  const a = s.acquisitionSettings;
  const sch = s.scheduleSettings;
  const t = s.tradeSettings;
  const usesBudget =
    typeof a.isUsingAcquisitionBudget === "boolean" ? a.isUsingAcquisitionBudget : null;
  const input = {
    acquisition_type: token(a.acquisitionType),
    uses_budget: usesBudget,
    budget: finite(a.acquisitionBudget),
    order_reset: typeof a.waiverOrderReset === "boolean" ? a.waiverOrderReset : null,
    acquisition_limit: finite(a.acquisitionLimit),
    matchup_acquisition_limit: finite(a.matchupAcquisitionLimit),
  };
  const system = waiverSystemOf(input);
  const matchupPeriods: Record<string, readonly number[]> = {};
  for (const [k, weeks] of Object.entries(sch.matchupPeriods ?? {}))
    if (/^[0-9]{1,2}$/.test(k)) matchupPeriods[k] = weeks.filter((w) => Number.isInteger(w));
  const regular = finite(sch.matchupPeriodCount);
  const playoffWeeks = Object.entries(matchupPeriods)
    .filter(([k]) => regular !== null && Number(k) > regular)
    .flatMap(([, w]) => w)
    .sort((x, y) => x - y);
  const fees: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.financeSettings ?? {}))
    if (/^[A-Za-z]{1,40}$/.test(k) && typeof v === "number" && Number.isFinite(v)) fees[k] = v;
  const unverified = ["waiver.type", "waiver.order_reset"];
  return {
    waiver: {
      type: input.acquisition_type ?? "UNKNOWN",
      uses_budget: usesBudget,
      budget: normaliseAcquisitionBudget(usesBudget, input.budget),
      min_bid: usesBudget === true ? finite(a.minimumBid) : null,
      waiver_hours: finite(a.waiverHours),
      process_days: (a.waiverProcessDays ?? []).filter((d) => token(d) !== null),
      process_hour: finite(a.waiverProcessHour),
      order_reset: input.order_reset,
      next_execution: isoFromMs(body.status.waiverNextExecutionDate),
      last_execution: isoFromMs(body.status.waiverLastExecutionDate),
      acquisition_limit: normaliseAcquisitionLimit(input.acquisition_limit),
      matchup_acquisition_limit: normaliseMatchupAcquisitionLimit(input.matchup_acquisition_limit),
      matchup_limit_per_period:
        typeof a.matchupLimitPerScoringPeriod === "boolean" ? a.matchupLimitPerScoringPeriod : null,
      unverified,
    },
    trade: {
      deadline: isoFromMs(t?.deadlineDate),
      revision_hours: finite(t?.revisionHours),
      veto_votes_required: finite(t?.vetoVotesRequired),
      max: finite(t?.max) === null || (t?.max ?? -1) < 0 ? null : (t?.max ?? null),
    },
    playoffs: {
      team_count: finite(sch.playoffTeamCount),
      seeding_rule: token(sch.playoffSeedingRule) ?? "UNKNOWN",
      seeding_rule_by: finite(sch.playoffSeedingRuleBy),
      reseed: typeof sch.playoffReseed === "boolean" ? sch.playoffReseed : null,
      matchup_period_length: finite(sch.playoffMatchupPeriodLength),
      variable_length:
        typeof sch.variablePlayoffMatchupPeriodLength === "boolean"
          ? sch.variablePlayoffMatchupPeriodLength
          : null,
      consolation:
        typeof sch.consolationLadderDisabled === "boolean" ? !sch.consolationLadderDisabled : null,
      regular_season_matchups: regular,
      matchup_periods: matchupPeriods,
      playoff_weeks: playoffWeeks,
      bye_seeds: null,
    },
    ties: {
      matchup_tie_rule: token(s.scoringSettings.matchupTieRule),
      playoff_tie_rule: token(s.scoringSettings.playoffMatchupTieRule),
    },
    fees: Object.keys(fees).length === 0 ? null : fees,
    waiver_system: system,
    predicates: waiverPredicatesOf(system),
    unverified_fields: [...unverified, "playoffs.bye_seeds"],
  };
}

/** The scoring items as ESPN sends them, value-checked — the scoring module's translator input. */
export function scoringInputOf(body: WireSettingsBody): EspnScoringInput {
  const sc = body.settings.scoringSettings;
  return {
    scoring_type: sc.scoringType,
    items: sc.scoringItems.map((i) => ({
      stat_id: i.statId,
      points: i.points,
      overrides: numericMap(i.pointsOverrides),
      is_reverse: i.isReverseItem === true,
    })),
    matchup_tie_rule: token(sc.matchupTieRule),
    playoff_tie_rule: token(sc.playoffMatchupTieRule),
    home_bonus: finite(sc.homeTeamBonus) ?? 0,
    playoff_home_bonus: finite(sc.playoffHomeTeamBonus) ?? 0,
  };
}

/** The matchup period(s) a scoring period belongs to (`matchupPeriods{id: [weeks]}`). */
export function matchupPeriodsForWeek(body: WireSettingsBody, week: number): number[] {
  const out: number[] = [];
  for (const [k, weeks] of Object.entries(body.settings.scheduleSettings.matchupPeriods ?? {}))
    if (/^[0-9]{1,2}$/.test(k) && weeks.includes(week)) out.push(Number(k));
  return out.sort((a, b) => a - b);
}

// --- rosters -------------------------------------------------------------------------------------

/** Every team's roster for `week` (one mRoster response; plan 07 B1). */
export function normalizeRosters(
  body: WireRosterBody,
  ref: LeagueRef,
  week: number,
  identity: LeagueIdentity | null,
  myTeam: number | null,
  ctx: PlayerContext,
  counts: NormalizeCounts,
): Roster[] {
  return body.teams.map((t) => {
    const entries: RosterEntry[] = [];
    for (const e of t.roster.entries) {
      const ppe = e.playerPoolEntry;
      const player = normalizePlayer(ppe.player, ppe, ctx, counts);
      if (player === null || !isIdInteger(e.lineupSlotId)) {
        if (player !== null) counts.rows_dropped++;
        continue;
      }
      const slot = decodeSlot(e.lineupSlotId);
      entries.push({
        player,
        slot_id: slot.id,
        slot: slot.name,
        slot_class: slot.class,
        is_flex: slot.is_flex,
        lineup_locked: ppe.lineupLocked === true,
        acquisition: { type: token(e.acquisitionType), date: isoFromMs(e.acquisitionDate) },
        points_week_espn: finite(
          findSplit(ppe.player.stats, "weekly_actual", ctx.season, week)?.appliedTotal,
        ),
        pending_transaction: (e.pendingTransactionIds?.length ?? 0) > 0,
      });
    }
    return {
      team: { league: ref, team_id: t.id },
      team_name: nameOf(identity, t.id),
      week,
      is_mine: myTeam === t.id,
      entries,
    };
  });
}

// --- matchups, live, box scores ------------------------------------------------------------------

function winnerOf(v: unknown): MatchupWinner | null {
  return typeof v === "string" && (MATCHUP_WINNERS as readonly string[]).includes(v)
    ? (v as MatchupWinner)
    : null;
}

/** The season schedule and results (mMatchup; plan 07 A3). A bye is `home` without `away`. */
export function normalizeMatchups(
  body: WireMatchupBody,
  identity: LeagueIdentity | null,
  myTeam: number | null,
): Matchup[] {
  const side = (s: WireMatchupBody["schedule"][number]["home"]): MatchupSide => ({
    team_id: s.teamId,
    name: nameOf(identity, s.teamId),
    points: finite(s.totalPoints),
    points_by_week: numericMap(s.pointsByScoringPeriod),
    is_mine: myTeam === s.teamId,
  });
  return body.schedule.map((r) => ({
    matchup_id: r.id,
    matchup_period: r.matchupPeriodId,
    playoff_tier: token(r.playoffTierType),
    winner: winnerOf(r.winner),
    is_bye: r.away === null || r.away === undefined,
    home: side(r.home),
    away: r.away === null || r.away === undefined ? null : side(r.away),
  }));
}

/**
 * The live matchups of `week` (mMatchupScore; plan 07 A4): the rows whose sides carry that week's
 * points (live fields exist only on the current period). ESPN's numbers, labelled `*_espn`.
 * `players` counts need the pro schedule and are left to the tool (null here).
 */
export function normalizeLiveMatchups(
  body: WireMatchupScoreBody,
  week: number,
  identity: LeagueIdentity | null,
  myTeam: number | null,
): LiveMatchup[] {
  const key = String(week);
  const side = (s: WireMatchupScoreBody["schedule"][number]["home"]): LiveSide => {
    const weekPoints = finite(s.pointsByScoringPeriod?.[key]);
    return {
      team_id: s.teamId,
      name: nameOf(identity, s.teamId),
      points_live: finite(s.totalPointsLive) ?? weekPoints ?? finite(s.totalPoints),
      projected_pre_espn: finite(s.totalProjectedPoints),
      projected_live_espn: finite(s.totalProjectedPointsLive),
      win_probability_espn: finite(s.winProbability),
      players: null,
    };
  };
  return body.schedule
    .filter((r) => r.home.pointsByScoringPeriod?.[key] !== undefined)
    .map((r) => {
      const away = r.away === null || r.away === undefined ? null : side(r.away);
      return {
        matchup_id: r.id,
        home: side(r.home),
        away,
        is_mine: myTeam !== null && (r.home.teamId === myTeam || r.away?.teamId === myTeam),
      };
    });
}

/**
 * A box-score player's game state without the pro schedule: an actual line → `final` once the
 * period is official, else `in`; no actual → `pre` while provisional, `bye` once official (the tool
 * refines this with `ds_pro_schedule` — decision recorded).
 */
export function gameStateOf(hasActual: boolean, provisional: boolean): GameState {
  if (hasActual) return provisional ? "in" : "final";
  return provisional ? "pre" : "bye";
}

/** Per-player box scores with appliedStats (mBoxscore; plan 07 A5 — the golden's input). */
export function normalizeBoxScores(
  body: WireBoxscoreBody,
  week: number,
  season: number,
  provisional: boolean,
  identity: LeagueIdentity | null,
  counts: NormalizeCounts,
): BoxScoreMatchup[] {
  const bodyNames = new Map<number, UntrustedText>();
  for (const t of body.teams ?? []) bodyNames.set(t.id, teamName(t));
  const side = (s: WireBoxscoreBody["schedule"][number]["home"]): BoxScoreSide => {
    const entries: BoxScoreEntry[] = [];
    for (const e of s.rosterForCurrentScoringPeriod.entries) {
      const p = e.playerPoolEntry.player;
      const player = normalizePlayer(p, null, { season, week }, counts);
      if (player === null || !isIdInteger(e.lineupSlotId)) {
        if (player !== null) counts.rows_dropped++;
        continue;
      }
      const slot = decodeSlot(e.lineupSlotId);
      const actualWire = findSplit(p.stats, "weekly_actual", season, week);
      const projWire = findSplit(p.stats, "weekly_projection", season, week);
      for (const st of p.stats ?? [])
        if (statSplitName(st.statSourceId, st.statSplitTypeId) === null)
          counts.stat_entries_failed++;
      const actual =
        actualWire === null ? null : normalizeStatLine(actualWire, p.id, provisional, counts);
      const projected =
        projWire === null ? null : normalizeStatLine(projWire, p.id, provisional, counts);
      entries.push({
        player,
        slot_id: slot.id,
        slot: slot.name,
        slot_class: slot.class,
        game_state: gameStateOf(actual !== null, provisional),
        actual,
        projected,
      });
    }
    return {
      team_id: s.teamId,
      name: bodyNames.get(s.teamId) ?? nameOf(identity, s.teamId),
      total_points: finite(s.totalPoints),
      entries,
    };
  };
  return body.schedule.map((r) => ({
    matchup_id: r.id,
    week,
    home: side(r.home),
    away: r.away === null || r.away === undefined ? null : side(r.away),
  }));
}

// --- standings -----------------------------------------------------------------------------------

/** Standings, waiver order and divisions (mTeam + mStandings, with settings when known; plan 07 A2). */
export function normalizeStandings(
  body: WireTeamBody,
  settings: WireSettingsBody | null,
  myTeam: number | null,
): Standings {
  const usesBudget = settings?.settings.acquisitionSettings.isUsingAcquisitionBudget === true;
  const teams: Standing[] = body.teams.map((t) => {
    const o = t.record.overall;
    const tc = t.transactionCounter;
    const seed = finite(t.playoffSeed);
    const finalRank = finite(t.rankCalculatedFinal);
    return {
      team_id: t.id,
      name: teamName(t),
      abbrev: teamAbbrev(t),
      division_id: t.divisionId ?? null,
      rank:
        finalRank !== null && finalRank > 0 ? finalRank : seed !== null && seed > 0 ? seed : null,
      playoff_seed: seed !== null && seed > 0 ? seed : null,
      wins: o.wins,
      losses: o.losses,
      ties: o.ties,
      pct: finite(o.percentage),
      points_for: finite(o.pointsFor) ?? 0,
      points_against: finite(o.pointsAgainst) ?? 0,
      streak:
        token(o.streakType) !== null && finite(o.streakLength) !== null
          ? { type: o.streakType ?? "", length: o.streakLength ?? 0 }
          : null,
      waiver_rank: finite(t.waiverRank),
      transaction_counter: {
        acquisitions: tc.acquisitions,
        drops: tc.drops,
        trades: tc.trades,
        move_to_ir: finite(tc.moveToIR) ?? 0,
        move_to_active: finite(tc.moveToActive) ?? 0,
        budget_spent: usesBudget ? finite(tc.acquisitionBudgetSpent) : null,
        matchup_acquisitions: numericMap(tc.matchupAcquisitionTotals),
      },
      playoff_pct_espn: finite(t.currentSimulationResults?.playoffPct),
      projected_rank_espn: finite(t.currentProjectedRank),
      clinch: token(t.playoffClinchType),
      eliminated: typeof t.eliminated === "boolean" ? t.eliminated : null,
      is_transaction_locked:
        typeof t.isTransactionLocked === "boolean" ? t.isTransactionLocked : null,
      is_mine: myTeam === t.id,
    };
  });
  const order = [...teams]
    .filter((t) => t.waiver_rank !== null)
    .sort((a, b) => (a.waiver_rank ?? 0) - (b.waiver_rank ?? 0) || a.team_id - b.team_id)
    .map((t) => t.team_id);
  const sch = settings?.settings.scheduleSettings;
  return {
    teams,
    waiver_order: order,
    playoff_line: {
      team_count: finite(sch?.playoffTeamCount),
      seeding_rule: token(sch?.playoffSeedingRule) ?? "UNKNOWN",
      bye_seeds: null,
    },
    divisions: (sch?.divisions ?? []).map((d) => ({
      id: d.id,
      name: wrapUntrusted(d.name ?? `Division ${String(d.id)}`, "espn.division.name"),
      team_ids: teams.filter((t) => t.division_id === d.id).map((t) => t.team_id),
    })),
  };
}

// --- transactions --------------------------------------------------------------------------------

/**
 * A transaction id as emitted: ESPN's ids are GUID-shaped (unbraced) — never member ids, but a
 * GUID-shaped string is never emitted at all (plan 02 §2.4 posture; the logger redacts unbraced
 * GUIDs too), so a non-numeric id becomes `t` + 24 hex of its sha256: deterministic, so
 * `transactions_seen` still dedupes and `related_transaction_id` still links (decision recorded).
 */
export function transactionIdOf(raw: string | number): string {
  const s = String(raw);
  return /^[0-9]{1,20}$/.test(s)
    ? s
    : `t${createHash("sha256").update(s).digest("hex").slice(0, 24)}`;
}

/**
 * One transaction (community shape, plan 07 A6) or null when the entry does not match it (counted —
 * a wrong community guess is not drift). `memberId` is never read; `team_id` is the actor.
 */
export function normalizeTransaction(
  raw: unknown,
  identity: LeagueIdentity | null,
  counts: NormalizeCounts,
): Transaction | null {
  const r = transactionSchema.safeParse(raw);
  if (!r.success) {
    counts.transactions_skipped++;
    return null;
  }
  const t = r.data;
  const slotName = (id: number | null | undefined): string | null =>
    typeof id === "number" && isIdInteger(id) ? decodeSlot(id).name : null;
  const team = (id: number | null | undefined): number | null =>
    typeof id === "number" && id > 0 ? id : null;
  return {
    transaction_id: transactionIdOf(t.id),
    type: token(t.type) ?? "UNKNOWN",
    status: token(t.status),
    team_id: team(t.teamId),
    team_name: team(t.teamId) === null ? null : nameOf(identity, t.teamId ?? 0),
    scoring_period: t.scoringPeriodId ?? null,
    process_date: isoFromMs(t.processDate ?? t.acceptedDate),
    proposed_date: isoFromMs(t.proposedDate),
    bid_amount: finite(t.bidAmount),
    items: (t.items ?? []).map((i) => ({
      type: token(i.type) ?? "UNKNOWN",
      player_id: i.playerId,
      name: null,
      from_team_id: team(i.fromTeamId),
      to_team_id: team(i.toTeamId),
      from_slot: slotName(i.fromLineupSlotId),
      to_slot: slotName(i.toLineupSlotId),
    })),
    related_transaction_id:
      t.relatedTransactionId === null || t.relatedTransactionId === undefined
        ? null
        : transactionIdOf(t.relatedTransactionId),
    note: null,
  };
}

// --- projections, ratings, pro schedule ---------------------------------------------------------

/** ESPN's own projection for one player and horizon (labelled ESPN's — plan 01 D15), or null. */
export function nativeProjectionOf(
  p: WirePlayer,
  horizon: ProjectionHorizon,
  season: number,
  week: number,
  asOf: string | null,
): NativeProjection | null {
  const split: StatSplitName =
    horizon === "week"
      ? "weekly_projection"
      : horizon === "ros"
        ? "ros_projection"
        : "preseason_projection";
  const e = findSplit(p.stats, split, season, horizon === "week" ? week : null);
  const points = finite(e?.appliedTotal);
  if (e === null || points === null) return null;
  return {
    player: { platform: "espn", id: p.id },
    horizon,
    season,
    week: horizon === "week" ? week : null,
    points,
    raw: numericMap(e.stats),
    as_of: asOf,
  };
}

/** Position-vs-opponent ratings (position ids 1–5, 16 — research 03 §A.2). */
export function normalizePositionalRatings(
  body: Pick<WirePositionalRatingsBody, "positionAgainstOpponent">,
): PositionalRating[] {
  const out: PositionalRating[] = [];
  for (const [posKey, r] of Object.entries(body.positionAgainstOpponent.positionalRatings)) {
    const posId = Number(posKey);
    if (!/^[0-9]{1,2}$/.test(posKey) || !POSITIONAL_RATING_POSITION_IDS.some((p) => p === posId))
      continue;
    for (const [teamKey, v] of Object.entries(r.ratingsByOpponent ?? {})) {
      if (!/^[0-9]{1,2}$/.test(teamKey)) continue;
      out.push({
        position_id: decodePosition(posId).id,
        opponent_pro_team_id: Number(teamKey),
        average: finite(v.average),
        rank: finite(v.rank),
      });
    }
  }
  return out.sort(
    (a, b) => a.position_id - b.position_id || a.opponent_pro_team_id - b.opponent_pro_team_id,
  );
}

/** The pro schedule (proTeamSchedules_wl): teams with byes, each game once, TBD kickoffs hidden. */
export function normalizeProSchedule(body: WireProScheduleBody, season: number): ProSchedule {
  const games = new Map<number, ProGame>();
  const teams = body.settings.proTeams.map((t) => {
    for (const list of Object.values(t.proGamesByScoringPeriod ?? {}))
      for (const g of list) {
        if (games.has(g.id)) continue;
        const tbd = g.startTimeTBD === true;
        games.set(g.id, {
          espn_game_id: g.id,
          season,
          week: g.scoringPeriodId,
          kickoff: tbd ? null : isoFromMs(g.date),
          start_time_tbd: tbd,
          valid_for_locking: g.validForLocking === true,
          stats_official: g.statsOfficial === true,
          home_pro_team_id: g.homeProTeamId,
          away_pro_team_id: g.awayProTeamId,
        });
      }
    return {
      id: t.id,
      abbrev: t.abbrev,
      bye_week: typeof t.byeWeek === "number" && t.byeWeek > 0 ? t.byeWeek : null,
    };
  });
  return {
    season,
    teams,
    games: [...games.values()].sort((a, b) => a.week - b.week || a.espn_game_id - b.espn_game_id),
  };
}

/** Pro-team id → bye week, from a pro schedule. */
export function byeWeeksOf(s: ProSchedule): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of s.teams) if (t.bye_week !== null) m.set(t.id, t.bye_week);
  return m;
}
