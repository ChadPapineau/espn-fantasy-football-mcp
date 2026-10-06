// resolver.ts — the pure ESPN player → gsis_id resolver (research 04 §C steps 1–5; plan 01 §0.3 only
// gsis_id crosses; plan 05 §2 `domain/crosswalk`; plan 06 §1.3 alert; plan 07 C1 { method, confidence },
// G1 counts; plan 10 A6a). Ported from sibling @8db206f (matcher.ts), adapted: the ESPN id is the
// entry point. Precedence: team unit by team → override → roster_weekly espn_id → nflverse players
// espn_id → persisted pair → name + team + position (confidence 0.8; never name alone).
import type { NflTeam } from "../../config/schema.js";
import { GSIS_ID_RE } from "../../config/schema.js";
import type { IsoInstant, PlatformPlayer } from "../league/types.js";
import { cleanEspnId, isPersonId, teamUnitPositionOf, teamUnitProTeamId } from "./ids.js";
import { cleanGsisId, compareCodePoints, nameKey, surnameKey } from "./normalize.js";
import { espnPositionFamily, positionFamily } from "./positions.js";
import { normalizeTeam, readEspnTeam, teamOfProTeamId } from "./teams.js";
import {
  CROSSWALK_METHODS,
  TEAM_UNIT_POSITION_IDS,
  TOP_OWNED_PERCENT,
  UNMATCHED_ALERT_THRESHOLD,
  type CrosswalkMethod,
  type CrosswalkOverride,
  type CrosswalkPair,
  type CrosswalkSource,
  type CrosswalkStatus,
  type EspnPlayerIdentity,
  type MatchCandidate,
  type MatchDecision,
  type MatchEvidence,
  type NflPlayerRecord,
  type NflRosterPlayer,
  type UnmatchedPlayer,
} from "./types.js";

/**
 * Confidence recorded on a pair: an id pair or an override is exact (1); a deterministic name + team
 * + position match is 0.8 (research 04 §C step 2, "flagged confidence = 0.8"); a match that needed the
 * jersey to break a tie between several name + team + position candidates is 0.75 (plan silent: a
 * tie-broken match is weaker than a unique one).
 */
export const MATCH_CONFIDENCE = Object.freeze({
  exact: 1,
  nameTeamPosition: 0.8,
  jerseyTieBreak: 0.75,
});

/** Diagnostic weight of each kind of agreement (MatchCandidate.score = the sum, 2 dp). */
export const EVIDENCE_WEIGHTS: Readonly<Record<MatchEvidence, number>> = Object.freeze({
  id: 1,
  name: 0.4,
  team: 0.3,
  position: 0.2,
  jersey: 0.1,
});

/** At most this many candidates are carried per unmatched/ambiguous player. */
export const MAX_REPORTED_CANDIDATES = 5;

const PAIR_METHODS: readonly CrosswalkMethod[] = CROSSWALK_METHODS.filter((m) => m !== "none");
const SOURCES: readonly CrosswalkSource[] = [
  "nflverse:roster_weekly",
  "nflverse:players",
  "matcher",
  "overrides",
];
const EMPTY_ROWS: readonly NflRosterPlayer[] = Object.freeze([]);
const EMPTY_IDS: readonly number[] = Object.freeze([]);
const EMPTY_GSIS: readonly string[] = Object.freeze([]);
const EMPTY_RECORDS: readonly NflPlayerRecord[] = Object.freeze([]);

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

// --- indexes -------------------------------------------------------------------------------------

/** An in-memory index over nflverse `roster_weekly` rows (research 04 §C step 1: the LOOKUP). */
export interface RosterIndex {
  /** Distinct gsis ids indexed. */
  readonly size: number;
  /** The latest (season, week) row of a gsis id. */
  byGsis(gsisId: string): NflRosterPlayer | null;
  /** The distinct gsis ids carrying this ESPN id in ANY row (more than one = ambiguous, never used). */
  byEspnId(espnId: number): readonly string[];
  /** The distinct ESPN ids nflverse gives this gsis id in any row, ascending. */
  espnIdsOf(gsisId: string): readonly number[];
  /** Latest rows whose `nameKey(full_name)` equals `key`. */
  byNameKey(key: string): readonly NflRosterPlayer[];
  /** Latest rows whose `surnameKey(full_name)` equals `key` (report hints only). */
  bySurname(key: string): readonly NflRosterPlayer[];
}

function isLater(a: NflRosterPlayer, b: NflRosterPlayer): boolean {
  return a.season > b.season || (a.season === b.season && a.week > b.week);
}

/**
 * Indexes roster rows. Rows without a valid gsis id are dropped (trimmed first); the latest
 * (season, week) row per gsis id carries its name, team and position (ties keep the first); ESPN ids
 * are collected from EVERY row (all weeks, all statuses — research 04 §C step 1), cleaned so an
 * empty, zero or non-integer id can never match.
 */
export function buildRosterIndex(rows: readonly NflRosterPlayer[]): RosterIndex {
  const latest = new Map<string, NflRosterPlayer>();
  const gsisByEspn = new Map<number, Set<string>>();
  const espnByGsis = new Map<string, Set<number>>();
  for (const row of rows) {
    const gsis = cleanGsisId(row.gsis_id);
    if (gsis === null) continue;
    const espn = cleanEspnId(row.espn_id);
    if (espn !== null) {
      addTo(gsisByEspn, espn, gsis);
      addTo(espnByGsis, gsis, espn);
    }
    const prev = latest.get(gsis);
    if (prev === undefined || isLater(row, prev)) {
      latest.set(gsis, row.gsis_id === gsis ? row : { ...row, gsis_id: gsis });
    }
  }
  const names = new Map<string, NflRosterPlayer[]>();
  const surnames = new Map<string, NflRosterPlayer[]>();
  for (const row of latest.values()) {
    const key = nameKey(row.full_name);
    if (key !== null) pushTo(names, key, row);
    const sur = surnameKey(row.full_name);
    if (sur !== null) pushTo(surnames, sur, row);
  }
  const sortedGsis = new Map<number, readonly string[]>(
    [...gsisByEspn].map(([k, v]) => [k, Object.freeze([...v].sort())]),
  );
  const sortedEspn = new Map<string, readonly number[]>(
    [...espnByGsis].map(([k, v]) => [k, Object.freeze([...v].sort((a, b) => a - b))]),
  );
  return Object.freeze({
    size: latest.size,
    byGsis: (gsisId: string) => latest.get(gsisId) ?? null,
    byEspnId: (espnId: number) => sortedGsis.get(espnId) ?? EMPTY_GSIS,
    espnIdsOf: (gsisId: string) => sortedEspn.get(gsisId) ?? EMPTY_IDS,
    byNameKey: (key: string) => names.get(key) ?? EMPTY_ROWS,
    bySurname: (key: string) => surnames.get(key) ?? EMPTY_ROWS,
  });
}

/** An in-memory index over nflverse `players` rows (research 04 §C step 2: the id fallback). */
export interface NflPlayersIndex {
  readonly size: number;
  /** One row per distinct gsis id carrying this ESPN id (more than one = ambiguous, never used). */
  byEspnId(espnId: number): readonly NflPlayerRecord[];
  /** Whether any row carries this gsis id. */
  hasGsis(gsisId: string): boolean;
}

/** Indexes nflverse `players` rows: invalid gsis or ESPN ids are dropped; first row per pair wins. */
export function buildNflPlayersIndex(rows: readonly NflPlayerRecord[]): NflPlayersIndex {
  const byEspn = new Map<number, Map<string, NflPlayerRecord>>();
  const gsisSeen = new Set<string>();
  for (const row of rows) {
    const gsis = cleanGsisId(row.gsis_id);
    const espn = cleanEspnId(row.espn_id);
    if (gsis === null) continue;
    gsisSeen.add(gsis);
    if (espn === null) continue;
    let perGsis = byEspn.get(espn);
    if (perGsis === undefined) {
      perGsis = new Map();
      byEspn.set(espn, perGsis);
    }
    if (!perGsis.has(gsis))
      perGsis.set(gsis, row.gsis_id === gsis ? row : { ...row, gsis_id: gsis });
  }
  const frozen = new Map<number, readonly NflPlayerRecord[]>(
    [...byEspn].map(([k, v]) => [
      k,
      Object.freeze([...v.values()].sort((a, b) => compareCodePoints(a.gsis_id, b.gsis_id))),
    ]),
  );
  return Object.freeze({
    size: gsisSeen.size,
    byEspnId: (espnId: number) => frozen.get(espnId) ?? EMPTY_RECORDS,
    hasGsis: (gsisId: string) => gsisSeen.has(gsisId),
  });
}

const NO_PLAYERS: NflPlayersIndex = buildNflPlayersIndex([]);

// --- inputs and results --------------------------------------------------------------------------

/** The persisted-pair lookup a run reads (CrosswalkRepository satisfies it). */
export interface PersistedPairLookup {
  get(espnId: number): CrosswalkPair | null;
}

/** Input to one crosswalk run over ESPN players of any shape `P`. */
export interface CrosswalkRunInput<P> {
  readonly players: readonly P[];
  /** How to read `P` as an ESPN identity (`identityOf` for ds_players rows, `identityOfPlatformPlayer`). */
  readonly identify: (player: P) => EspnPlayerIdentity;
  readonly roster: RosterIndex;
  /** The nflverse `players` rows for ESPN ids roster_weekly lacks (NflPlayersReader.byEspnIds). */
  readonly nflPlayers?: NflPlayersIndex;
  readonly overrides: readonly CrosswalkOverride[];
  readonly persisted: PersistedPairLookup;
  /** The Clock instant stamped on new pairs. */
  readonly now: IsoInstant;
  /** ESPN ids on any fantasy roster of the league. Default: none. */
  readonly rostered?: ReadonlySet<number>;
  /** Default TOP_OWNED_PERCENT (≥ 1 % owned — plan 06 §1.3). */
  readonly topOwnedPercent?: number;
  /** Default UNMATCHED_ALERT_THRESHOLD (1). */
  readonly alertThreshold?: number;
}

/** How one ESPN player resolved. */
export type CrosswalkResolution =
  | {
      readonly status: "matched";
      readonly pair: CrosswalkPair;
      readonly evidence: readonly MatchEvidence[];
      /** New, or different from the persisted pair in gsis_id/method/source/confidence. */
      readonly changed: boolean;
    }
  | {
      readonly status: "team_unit";
      /** Null when the unit's team could not be read (reported apart; never counted as unmatched). */
      readonly nfl_team: NflTeam | null;
    }
  | { readonly status: "ambiguous"; readonly candidates: readonly MatchCandidate[] }
  | {
      readonly status: "unmatched";
      readonly reason: "no_candidate" | "name_only" | "unknown_team";
      readonly candidates: readonly MatchCandidate[];
    };

/** What a run noticed that a human may need to look at (ids only — no third-party text). */
export type CrosswalkDiagnosticCode =
  | "override_vs_id"
  | "override_vs_persisted"
  | "override_gsis_unseen"
  | "id_vs_persisted"
  | "ambiguous_espn_id"
  | "ambiguous_players_id"
  | "players_id_conflict"
  | "candidate_id_conflict"
  | "persisted_id_conflict"
  | "stale_override_pair"
  | "invalid_persisted_pair"
  | "duplicate_gsis"
  | "invalid_override"
  | "duplicate_override"
  | "invalid_player"
  | "duplicate_player"
  | "unknown_team"
  | "team_conflict";

/** One diagnostic. */
export interface CrosswalkDiagnostic {
  readonly code: CrosswalkDiagnosticCode;
  readonly espn_id: number | null;
  /** The gsis ids involved, when any. */
  readonly gsis_ids: readonly string[];
}

/** One player and its resolution. */
export interface ResolvedPlayer<P> {
  readonly player: P;
  readonly espn_id: number;
  readonly resolution: CrosswalkResolution;
}

/** A team unit resolved by its team. */
export interface ResolvedTeamUnit {
  readonly espn_id: number;
  readonly nfl_team: NflTeam;
}

/** One unresolved player in the report (`UnmatchedPlayer` when `P` is PlatformPlayer). */
export interface UnmatchedEntry<P> {
  readonly player: P;
  readonly reason: UnmatchedPlayer["reason"];
  readonly candidates: readonly MatchCandidate[];
}

/** The unmatched report (`UnmatchedReport` when `P` is PlatformPlayer — plan 07 G1 `crosswalk`). */
export interface CrosswalkReport<P> {
  readonly matched: number;
  readonly unmatched_rostered: readonly UnmatchedEntry<P>[];
  readonly unmatched_top_owned: readonly UnmatchedEntry<P>[];
}

/**
 * Plan 06 §1.3's notification rule (research 04 §C step 5): rostered or ≥ 1 %-owned ESPN players
 * WITHOUT a confidence-1.0 pair — unmatched, ambiguous, or matched only by name — at or above the
 * threshold (1) is a data-quality event. Team units never count.
 */
export interface CrosswalkAlert {
  readonly threshold: number;
  readonly count: number;
  /** Ascending. */
  readonly espn_ids: readonly number[];
  readonly triggered: boolean;
}

/** The result of one run. */
export interface CrosswalkRun<P> {
  /** Input order, first occurrence of each ESPN id only. */
  readonly resolved: readonly ResolvedPlayer<P>[];
  /** Every matched pair. */
  readonly pairs: readonly CrosswalkPair[];
  /** The pairs to hand to `CrosswalkRepository.upsertDelta` (new or changed). */
  readonly changed: readonly CrosswalkPair[];
  /** ESPN ids whose pair is unchanged (for `CrosswalkRepository.touch`). */
  readonly unchanged_ids: readonly number[];
  readonly team_units: readonly ResolvedTeamUnit[];
  /** Team units whose team could not be read (never counted in the report or the alert). */
  readonly unresolved_team_units: readonly P[];
  readonly report: CrosswalkReport<P>;
  readonly alert: CrosswalkAlert;
  readonly diagnostics: readonly CrosswalkDiagnostic[];
}

// --- identities ----------------------------------------------------------------------------------

/** A ds_players row is already an identity. */
export function identityOf(player: EspnPlayerIdentity): EspnPlayerIdentity {
  return player;
}

/** Reads a PlatformPlayer as the identity the crosswalk needs (plan 01 §9 crosswalk fields). */
export function identityOfPlatformPlayer(player: PlatformPlayer): EspnPlayerIdentity {
  return {
    espn_id: player.ref.id,
    full_name: player.name,
    position_id: player.position_id,
    pro_team_id: player.pro_team_id,
    pro_team: player.pro_team,
    percent_owned: player.ownership?.percent_owned ?? null,
    jersey: player.jersey,
  };
}

/** The ESPN ids of the PlatformPlayers on a fantasy roster (`status === "ONTEAM"`). */
export function rosteredIdsOf(players: readonly PlatformPlayer[]): ReadonlySet<number> {
  return new Set(players.filter((p) => p.status === "ONTEAM").map((p) => p.ref.id));
}

/** Whether an ESPN identity is a team unit (D/ST, TQB, HC): by its id range or its position id. */
export function isTeamUnitIdentity(
  identity: Pick<EspnPlayerIdentity, "espn_id" | "position_id">,
): boolean {
  return (
    teamUnitPositionOf(identity.espn_id) !== null ||
    TEAM_UNIT_POSITION_IDS.includes(identity.position_id)
  );
}

// --- the run -------------------------------------------------------------------------------------

type Stage = "override" | "roster_id" | "players_id" | "persisted" | "match";

interface Internal {
  readonly resolution: CrosswalkResolution;
  readonly stage: Stage | null;
  /** The accepted candidate, for a deterministic match. */
  readonly candidate: MatchCandidate | null;
}

interface Work<P> {
  readonly player: P;
  readonly identity: EspnPlayerIdentity;
  result: Internal;
}

interface Ctx {
  readonly roster: RosterIndex;
  readonly nflPlayers: NflPlayersIndex;
  readonly overrides: ReadonlyMap<number, CrosswalkOverride>;
  readonly persisted: PersistedPairLookup;
  readonly now: IsoInstant;
  readonly diag: (
    code: CrosswalkDiagnosticCode,
    espnId: number | null,
    gsis?: readonly string[],
  ) => void;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** An upper-case code (`WR`, `D/ST`) or "" — third-party text never reaches a candidate. */
function safeCode(s: unknown): string {
  return typeof s === "string" && /^[A-Za-z/]{1,8}$/.test(s) ? s.toUpperCase() : "";
}

/** ESPN `jersey` text ("17") or nflverse's number → 0..99, else null. */
export function jerseyNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw <= 99 ? raw : null;
  if (typeof raw !== "string" || !/^[0-9]{1,2}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function candidateOf(
  row: NflRosterPlayer,
  team: NflTeam | null,
  family: string | null,
  jersey: number | null,
  name: boolean,
): MatchCandidate {
  const evidence: MatchEvidence[] = name ? ["name"] : [];
  const rowTeam = normalizeTeam(row.team);
  if (team !== null && rowTeam === team) evidence.push("team");
  if (family !== null && positionFamily(row.position) === family) evidence.push("position");
  const rowJersey = jerseyNumber(row.jersey_number);
  if (jersey !== null && rowJersey !== null && rowJersey === jersey) evidence.push("jersey");
  return {
    gsis_id: row.gsis_id,
    team: rowTeam ?? "",
    position: safeCode(row.position),
    jersey_number: rowJersey,
    evidence,
    score: round2(evidence.reduce((s, e) => s + EVIDENCE_WEIGHTS[e], 0)),
  };
}

function topCandidates(list: readonly MatchCandidate[]): readonly MatchCandidate[] {
  return [...list]
    .sort((a, b) => b.score - a.score || compareCodePoints(a.gsis_id, b.gsis_id))
    .slice(0, MAX_REPORTED_CANDIDATES);
}

function validPersisted(
  pair: CrosswalkPair | null,
  espnId: number,
  ctx: Ctx,
): CrosswalkPair | null {
  if (pair === null) return null;
  const ok =
    pair.espn_id === espnId &&
    typeof pair.gsis_id === "string" &&
    GSIS_ID_RE.test(pair.gsis_id) &&
    PAIR_METHODS.includes(pair.method) &&
    SOURCES.includes(pair.source) &&
    Number.isFinite(pair.confidence) &&
    pair.confidence >= 0 &&
    pair.confidence <= 1 &&
    typeof pair.first_seen === "string" &&
    pair.first_seen.length > 0 &&
    typeof pair.last_seen === "string" &&
    pair.last_seen.length > 0;
  if (!ok) ctx.diag("invalid_persisted_pair", espnId);
  return ok ? pair : null;
}

/** Whether nflverse gives `gsis` ESPN ids and none of them is `espnId` (id evidence contradicts). */
function contradicted(gsis: string, espnId: number, ctx: Ctx): boolean {
  const ids = ctx.roster.espnIdsOf(gsis);
  return ids.length > 0 && !ids.includes(espnId);
}

function matched(
  ctx: Ctx,
  espnId: number,
  stage: Stage,
  gsis: string,
  method: Exclude<CrosswalkMethod, "none">,
  source: CrosswalkSource,
  confidence: number,
  prev: CrosswalkPair | null,
  evidence: readonly MatchEvidence[],
  candidate: MatchCandidate | null = null,
): Internal {
  const same = prev !== null && prev.gsis_id === gsis;
  const pair: CrosswalkPair = {
    espn_id: espnId,
    gsis_id: gsis,
    method,
    source,
    confidence,
    first_seen: same ? prev.first_seen : ctx.now,
    last_seen: same ? prev.last_seen : ctx.now,
  };
  const changed =
    !same || prev.method !== method || prev.source !== source || prev.confidence !== confidence;
  return { resolution: { status: "matched", pair, evidence, changed }, stage, candidate };
}

function unmatched(
  reason: "no_candidate" | "name_only" | "unknown_team",
  candidates: readonly MatchCandidate[] = [],
): Internal {
  return { resolution: { status: "unmatched", reason, candidates }, stage: null, candidate: null };
}

function ambiguous(candidates: readonly MatchCandidate[]): Internal {
  return { resolution: { status: "ambiguous", candidates }, stage: null, candidate: null };
}

interface IdHit {
  readonly gsis: string;
  readonly stage: "roster_id" | "players_id";
  readonly source: CrosswalkSource;
}

/** Research 04 §C steps 1–2: roster_weekly's espn_id, then nflverse players' — each unambiguous. */
function idEvidence(espnId: number, ctx: Ctx): IdHit | null {
  const fromRoster = ctx.roster.byEspnId(espnId);
  const [only] = fromRoster;
  if (fromRoster.length > 1) {
    ctx.diag("ambiguous_espn_id", espnId, fromRoster);
    return null;
  }
  if (only !== undefined)
    return { gsis: only, stage: "roster_id", source: "nflverse:roster_weekly" };
  const fromPlayers = ctx.nflPlayers.byEspnId(espnId);
  const [record] = fromPlayers;
  if (fromPlayers.length > 1) {
    ctx.diag(
      "ambiguous_players_id",
      espnId,
      fromPlayers.map((r) => r.gsis_id),
    );
    return null;
  }
  if (record === undefined) return null;
  if (contradicted(record.gsis_id, espnId, ctx)) {
    // roster_weekly gives that gsis another ESPN id: roster_weekly is step 1 and wins.
    ctx.diag("players_id_conflict", espnId, [record.gsis_id]);
    return null;
  }
  return { gsis: record.gsis_id, stage: "players_id", source: "nflverse:players" };
}

function deterministic(
  identity: EspnPlayerIdentity,
  prev: CrosswalkPair | null,
  ctx: Ctx,
): Internal {
  const espnId = identity.espn_id;
  const reading = readEspnTeam(identity.pro_team_id, identity.pro_team);
  if (reading.kind === "unknown" || reading.kind === "conflict") {
    ctx.diag(reading.kind === "unknown" ? "unknown_team" : "team_conflict", espnId);
    return unmatched("unknown_team");
  }
  const team = reading.kind === "team" ? reading.team : null;
  const family = espnPositionFamily(identity.position_id);
  const jersey = jerseyNumber(identity.jersey);
  const key = nameKey(identity.full_name);
  if (key === null) return unmatched("no_candidate");
  const named = ctx.roster.byNameKey(key);
  if (named.length === 0) {
    // Hints only (never accepted): same surname with the team and position agreeing.
    const sur = surnameKey(identity.full_name);
    const hints = (sur === null ? EMPTY_ROWS : ctx.roster.bySurname(sur))
      .map((row) => candidateOf(row, team, family, jersey, false))
      .filter((c) => c.evidence.includes("team") && c.evidence.includes("position"));
    return unmatched("no_candidate", topCandidates(hints));
  }
  const all = named.map((row) => candidateOf(row, team, family, jersey, true));
  const full = all.filter((c) => c.evidence.includes("team") && c.evidence.includes("position"));
  const refuted = full.filter((c) => contradicted(c.gsis_id, espnId, ctx));
  for (const c of refuted) ctx.diag("candidate_id_conflict", espnId, [c.gsis_id]);
  const open = full.filter((c) => !refuted.includes(c));
  const accept = (c: MatchCandidate, confidence: number): Internal =>
    matched(ctx, espnId, "match", c.gsis_id, "match", "matcher", confidence, prev, c.evidence, c);
  const [first] = open;
  if (first === undefined) {
    return refuted.length > 0
      ? ambiguous(topCandidates(refuted))
      : unmatched("name_only", topCandidates(all));
  }
  if (open.length === 1) return accept(first, MATCH_CONFIDENCE.nameTeamPosition);
  const byJersey = open.filter((c) => c.evidence.includes("jersey"));
  const [tie] = byJersey;
  if (byJersey.length === 1 && tie !== undefined)
    return accept(tie, MATCH_CONFIDENCE.jerseyTieBreak);
  return ambiguous(topCandidates(open));
}

function unit(nflTeam: NflTeam | null): Internal {
  return { resolution: { status: "team_unit", nfl_team: nflTeam }, stage: null, candidate: null };
}

/**
 * A team unit (D/ST, TQB, HC) resolves to its pro team: the identity's `(proTeamId, abbreviation)`,
 * checked against the team its id encodes (`base − proTeamId`); the id alone when no team is given.
 * Unknown or contradictory → unresolved (null), with a diagnostic.
 */
function teamUnit(identity: EspnPlayerIdentity, ctx: Ctx): Internal {
  const espnId = identity.espn_id;
  const reading = readEspnTeam(identity.pro_team_id, identity.pro_team);
  const derived = teamOfProTeamId(teamUnitProTeamId(espnId));
  if (reading.kind === "team" && (derived === null || derived === reading.team)) {
    return unit(reading.team);
  }
  if (reading.kind === "none" && derived !== null) return unit(derived);
  ctx.diag(
    reading.kind === "team" || reading.kind === "conflict" ? "team_conflict" : "unknown_team",
    espnId,
  );
  return unit(null);
}

function resolveOne(identity: EspnPlayerIdentity, ctx: Ctx): Internal {
  const espnId = identity.espn_id;
  if (isTeamUnitIdentity(identity)) return teamUnit(identity, ctx);
  const prev = validPersisted(ctx.persisted.get(espnId), espnId, ctx);
  const hit = idEvidence(espnId, ctx);
  const override = ctx.overrides.get(espnId);
  if (override !== undefined) {
    const gsis = override.gsis_id;
    if (hit !== null && hit.gsis !== gsis) ctx.diag("override_vs_id", espnId, [gsis, hit.gsis]);
    if (prev !== null && prev.gsis_id !== gsis) {
      ctx.diag("override_vs_persisted", espnId, [gsis, prev.gsis_id]);
    }
    if (ctx.roster.size > 0 && ctx.roster.byGsis(gsis) === null && !ctx.nflPlayers.hasGsis(gsis)) {
      ctx.diag("override_gsis_unseen", espnId, [gsis]);
    }
    return matched(ctx, espnId, "override", gsis, "override", "overrides", 1, prev, ["id"]);
  }
  if (hit !== null) {
    if (prev !== null && prev.gsis_id !== hit.gsis) {
      ctx.diag("id_vs_persisted", espnId, [hit.gsis, prev.gsis_id]);
    }
    return matched(ctx, espnId, hit.stage, hit.gsis, "id", hit.source, 1, prev, ["id"]);
  }
  if (prev !== null && prev.method !== "override") {
    if (!contradicted(prev.gsis_id, espnId, ctx)) {
      return {
        resolution: {
          status: "matched",
          pair: prev,
          evidence: prev.method === "id" ? ["id"] : ["name", "team", "position"],
          changed: false,
        },
        stage: "persisted",
        candidate: null,
      };
    }
    ctx.diag("persisted_id_conflict", espnId, [prev.gsis_id]);
  } else if (prev !== null) {
    ctx.diag("stale_override_pair", espnId, [prev.gsis_id]);
  }
  return deterministic(identity, prev, ctx);
}

function indexOverrides(
  overrides: readonly CrosswalkOverride[],
  diag: Ctx["diag"],
): ReadonlyMap<number, CrosswalkOverride> {
  const out = new Map<number, CrosswalkOverride>();
  for (const o of overrides) {
    if (!isPersonId(o.espn_id) || typeof o.gsis_id !== "string" || !GSIS_ID_RE.test(o.gsis_id)) {
      diag("invalid_override", null);
      continue;
    }
    if (out.has(o.espn_id)) {
      diag("duplicate_override", o.espn_id, [o.gsis_id]);
      continue;
    }
    out.set(o.espn_id, o);
  }
  return out;
}

/**
 * A new deterministic match may not take a gsis id another player in the same run also holds: it is
 * demoted to ambiguous (two ESPN ids never silently share one NFL player on name evidence). Any other
 * shared claim (two overrides, an override and an id pair, two persisted pairs) is kept and reported.
 */
function enforceUniqueGsis<P>(work: Work<P>[], diag: Ctx["diag"]): void {
  const claims = new Map<string, Work<P>[]>();
  for (const w of work) {
    if (w.result.resolution.status === "matched")
      pushTo(claims, w.result.resolution.pair.gsis_id, w);
  }
  for (const [gsis, claimants] of claims) {
    if (claimants.length < 2) continue;
    const keep: Work<P>[] = [];
    for (const w of claimants) {
      const r = w.result;
      if (r.stage === "match" && r.candidate !== null) w.result = ambiguous([r.candidate]);
      else keep.push(w);
    }
    if (keep.length > 1) for (const w of keep) diag("duplicate_gsis", w.identity.espn_id, [gsis]);
  }
}

function checkInput<P>(input: CrosswalkRunInput<P>): { top: number; threshold: number } {
  if (
    typeof input.now !== "string" ||
    input.now.length === 0 ||
    input.now.length > 64 ||
    !Number.isFinite(Date.parse(input.now))
  ) {
    throw new TypeError("crosswalk: `now` must be an ISO instant");
  }
  const top = input.topOwnedPercent ?? TOP_OWNED_PERCENT;
  if (!Number.isFinite(top) || top < 0 || top > 100) {
    throw new RangeError("crosswalk: topOwnedPercent must be within 0..100");
  }
  const threshold = input.alertThreshold ?? UNMATCHED_ALERT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError("crosswalk: alertThreshold must be an integer ≥ 1");
  }
  return { top, threshold };
}

/**
 * Resolves every player of one run (pure). The caller persists `changed` through
 * `CrosswalkRepository.upsertDelta`, refreshes `unchanged_ids` through `touch`, puts the report
 * counts into `espn_get_status.crosswalk` and notifies when `alert.triggered` (plan 06 §1.3).
 */
export function resolveCrosswalk<P>(input: CrosswalkRunInput<P>): CrosswalkRun<P> {
  const { top, threshold } = checkInput(input);
  const diagnostics: CrosswalkDiagnostic[] = [];
  const diag: Ctx["diag"] = (code, espnId, gsis = []) => {
    diagnostics.push({ code, espn_id: espnId, gsis_ids: [...gsis] });
  };
  const ctx: Ctx = {
    roster: input.roster,
    nflPlayers: input.nflPlayers ?? NO_PLAYERS,
    overrides: indexOverrides(input.overrides, diag),
    persisted: input.persisted,
    now: input.now,
    diag,
  };
  const work: Work<P>[] = [];
  const seen = new Set<number>();
  for (const player of input.players) {
    const identity = input.identify(player);
    const id = identity.espn_id;
    // A person id or a team-unit id; anything else is not an ESPN player and is never resolved.
    if (!Number.isInteger(id) || !(isPersonId(id) || isTeamUnitIdentity(identity))) {
      diag("invalid_player", null);
      continue;
    }
    if (seen.has(id)) {
      diag("duplicate_player", id);
      continue;
    }
    seen.add(id);
    work.push({ player, identity, result: resolveOne(identity, ctx) });
  }
  enforceUniqueGsis(work, diag);

  const rostered = input.rostered ?? new Set<number>();
  const resolved: ResolvedPlayer<P>[] = [];
  const pairs: CrosswalkPair[] = [];
  const changed: CrosswalkPair[] = [];
  const unchanged: number[] = [];
  const teamUnits: ResolvedTeamUnit[] = [];
  const unresolvedUnits: P[] = [];
  const rosteredOut: (readonly [number, UnmatchedEntry<P>])[] = [];
  const topOut: (readonly [number, UnmatchedEntry<P>])[] = [];
  const alertIds: number[] = [];
  let matchedCount = 0;

  for (const { player, identity, result } of work) {
    const { resolution } = result;
    const espnId = identity.espn_id;
    resolved.push({ player, espn_id: espnId, resolution });
    if (resolution.status === "team_unit") {
      if (resolution.nfl_team === null) unresolvedUnits.push(player);
      else teamUnits.push({ espn_id: espnId, nfl_team: resolution.nfl_team });
      continue;
    }
    const isRostered = rostered.has(espnId);
    const owned = identity.percent_owned;
    const isTop = typeof owned === "number" && Number.isFinite(owned) && owned >= top;
    if (resolution.status === "matched") {
      matchedCount += 1;
      pairs.push(resolution.pair);
      if (resolution.changed) changed.push(resolution.pair);
      else unchanged.push(espnId);
      if ((isRostered || isTop) && resolution.pair.confidence < 1) alertIds.push(espnId);
      continue;
    }
    if (isRostered || isTop) alertIds.push(espnId);
    const entry: UnmatchedEntry<P> = {
      player,
      reason: resolution.status === "ambiguous" ? "ambiguous" : resolution.reason,
      candidates: resolution.candidates,
    };
    if (isRostered) rosteredOut.push([espnId, entry]);
    else if (isTop) topOut.push([espnId, entry]);
  }

  const sortById = (list: (readonly [number, UnmatchedEntry<P>])[]): readonly UnmatchedEntry<P>[] =>
    list.sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  const alertSorted = [...new Set(alertIds)].sort((a, b) => a - b);
  return {
    resolved,
    pairs,
    changed,
    unchanged_ids: unchanged,
    team_units: teamUnits,
    unresolved_team_units: unresolvedUnits,
    report: {
      matched: matchedCount,
      unmatched_rostered: sortById(rosteredOut),
      unmatched_top_owned: sortById(topOut),
    },
    alert: {
      threshold,
      count: alertSorted.length,
      espn_ids: alertSorted,
      triggered: alertSorted.length >= threshold,
    },
    diagnostics,
  };
}

// --- what tools show -----------------------------------------------------------------------------

/** The `crosswalk` block a tool shows (plan 07 C1). A resolved team unit is exact by its team. */
export function crosswalkStatus(resolution: CrosswalkResolution): CrosswalkStatus {
  if (resolution.status === "matched") {
    return { method: resolution.pair.method, confidence: resolution.pair.confidence };
  }
  if (resolution.status === "team_unit" && resolution.nfl_team !== null) {
    return { method: "id", confidence: MATCH_CONFIDENCE.exact };
  }
  return { method: "none", confidence: 0 };
}

/**
 * The `crosswalk` block from a persisted pair (the tool-time path: `CrosswalkRepository.get`), with
 * team units exact by their team and no pair = `none`.
 */
export function crosswalkStatusOfPair(
  identity: Pick<EspnPlayerIdentity, "espn_id" | "position_id">,
  pair: CrosswalkPair | null,
): CrosswalkStatus {
  if (isTeamUnitIdentity(identity)) return { method: "id", confidence: MATCH_CONFIDENCE.exact };
  return pair?.espn_id === identity.espn_id
    ? { method: pair.method, confidence: pair.confidence }
    : { method: "none", confidence: 0 };
}

/** The gsis id a resolution identifies, or null (team units have none). */
export function gsisOf(resolution: CrosswalkResolution): string | null {
  return resolution.status === "matched" ? resolution.pair.gsis_id : null;
}

/** The contract's MatchDecision for a resolution (a team unit is never matched: `team_unit`). */
export function decisionOf(resolution: CrosswalkResolution): MatchDecision {
  switch (resolution.status) {
    case "matched":
      return { status: "matched", pair: resolution.pair };
    case "ambiguous":
      return { status: "ambiguous", candidates: resolution.candidates };
    case "team_unit":
      return { status: "unmatched", reason: "team_unit" };
    case "unmatched":
      return { status: "unmatched", reason: resolution.reason };
  }
}

/** `espn_get_status.crosswalk` (plan 07 G1). */
export function statusCounts<P>(report: CrosswalkReport<P>): {
  readonly matched: number;
  readonly unmatched_rostered: number;
  readonly unmatched_top_owned: number;
} {
  return {
    matched: report.matched,
    unmatched_rostered: report.unmatched_rostered.length,
    unmatched_top_owned: report.unmatched_top_owned.length,
  };
}
