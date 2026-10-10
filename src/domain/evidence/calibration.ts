// calibration.ts — the per-source calibration table and E10's posterior over it (plan 10 §3.3 C8;
// plan 07 E10 `posterior`, `calibration_state`; research 05 §6 "the source and claim type get a
// calibration table … rather than trust"; sibling research 05 §10.2 "score the source and the claim
// type separately", §10.4 "P(active) … updated Bayesianly: prior from the numbers, likelihood from
// each news item scaled by its source/claim reliability", §12.1 Brier, §12.5 "update the per-source
// news table"; sib ADV OBJ-21 — the merge is shown only once the table holds ≥ 200 scored claims).
//
// What it is. The retrospective scores each claim once its game is final (`claimOutcome`: an
// availability or health claim is borne out when the player played as it said; a role claim when
// his snap share moved ≥ 10 points the way it said within two games) and keeps a value-free
// `ScoredClaim` — source, claim type, signal, the structured prior it was made against, the
// outcome; never the text. `buildCalibrationTable` groups them into rows keyed by source × type ×
// signal × the prior's injury status and fits, per row, (1) the reliability P(borne out) — a Beta
// posterior around the hand-set prior (reliability.ts) with PRIOR_WEIGHT pseudo-claims — and (2)
// the log-likelihood ratio the claim carries for P(active) on top of the structured prior: the MAP
// of a one-parameter logistic regression with the prior's log-odds as the offset and a Gaussian
// prior on the ratio centred on the hand-set value (Newton; the Laplace sd beside it). Rows are
// split by the prior's status because the evidence is not additive across designations: an
// official "did not practise" means one thing beside a Questionable tag and another beside no tag.
//
// E10's posterior (`evidencePosterior`) is the structured prior's log-odds plus each claim's row
// ratio — the latest item per source (later beats earlier), availability and health claims only,
// an injection-flagged item weighted 0 (it stays data) — shown only once the table's `table_n` (the
// scored TEXT claims: RSS, ESPN outlooks, the user's pasted claims) reaches EVIDENCE_POSTERIOR_MIN_N;
// until then E10 keeps `posterior: null` and the "priors are hand-set" note. Structured fields win
// (research 05 §6 rule 3): a prior of exactly 0 (OUT, IR, SUSPENSION — an official ruling) is never
// moved; a prior of 1 (no designation) is moved only by evidence, through a clamped log-odds. Role
// shares pass through unchanged (no fitted role model yet). The official practice report is a
// calibration source of its own (`official.practice`), fitted from the nflverse injury history; it
// never counts toward `table_n`, which is the news table's. Pure; no I/O; no text ever enters.
import { P_ACTIVE_BY_STATUS } from "../analytics/constants.js";
import { EVIDENCE, OFFICIAL_RELIABILITY } from "../analytics/marketConstants.js";
import { EVIDENCE_POSTERIOR_MIN_N } from "../analytics/types.js";
import type { InjectionFlag, InjuryStatus, UntrustedSource } from "../league/types.js";
import {
  availabilityClass,
  CLAIM_DIRECTIONS,
  DESIGNATIONS,
  type ClaimDirection,
  type ClaimType,
  type Designation,
} from "./claims.js";
import {
  calibrationState,
  posteriorAllowed,
  RELIABILITY_PRIORS,
  RELIABILITY_SOURCES,
  reliabilitySourceOf,
  type CalibrationState,
  type ReliabilitySource,
  type ScoredClaimType,
} from "./reliability.js";

/** The official channel calibrated beside the text sources (E10's practice-report evidence item). */
export const OFFICIAL_CALIBRATION_SOURCES = ["official.practice"] as const;
export type OfficialCalibrationSource = (typeof OFFICIAL_CALIBRATION_SOURCES)[number];

/** Every source a calibration row may belong to. */
export const CALIBRATION_SOURCES = [
  ...RELIABILITY_SOURCES,
  ...OFFICIAL_CALIBRATION_SOURCES,
] as const;
export type CalibrationSource = (typeof CALIBRATION_SOURCES)[number];

/** The claim types a row may hold (`other` is never scored). */
export const SCORED_CLAIM_TYPES: readonly ScoredClaimType[] = Object.freeze([
  "availability",
  "health",
  "role",
  "coaching_intent",
  "transaction",
]);

/** A claim's signal: its designation when it has one (availability, practice), else its direction. */
export type ClaimSignal = Designation | ClaimDirection;

/** The prior's status a row is keyed by: ESPN's injury status, `ACTIVE` for none, `OTHER` for a new one. */
export const PRIOR_STATUSES = [
  "ACTIVE",
  "QUESTIONABLE",
  "DOUBTFUL",
  "DAY_TO_DAY",
  "OUT",
  "INJURY_RESERVE",
  "SUSPENSION",
  "OTHER",
] as const;
export type PriorStatus = (typeof PRIOR_STATUSES)[number];

/** The table's fitting constants (each named so a reviewer can argue with it). */
export const CALIBRATION = Object.freeze({
  /** Pseudo-claims the hand-set reliability counts for in a row's Beta prior. */
  priorWeight: 10,
  /** The Gaussian prior's sd on a row's log-likelihood ratio (log-odds units). */
  llrPriorSd: 1,
  /** A prior of exactly 1 (no designation) is read as 1 − eps in log-odds (0 is a ruling: never moved). */
  priorEps: 0.01,
  /** A row is `calibrated` (its numbers beat the hand-set ones) from this many scored claims (sib §12.6 "~30"). */
  rowMinN: 30,
  /** Newton iterations and tolerance for the ratio's MAP. */
  newtonMaxIter: 60,
  newtonTol: 1e-10,
  /** Largest ratio magnitude (log-odds) a row may carry — a guard against a degenerate row. */
  maxAbsLlr: 8,
  /** Most claim records one table reads, and the largest `count` one record may carry (bounded work). */
  maxClaims: 200_000,
});

/** One scored claim as the retrospective keeps it (value-free: no text, no player identity). */
export interface ScoredClaim {
  readonly source: CalibrationSource;
  readonly type: ScoredClaimType;
  readonly signal: ClaimSignal;
  /** The injury status behind the structured prior when the claim was made (null = none: ACTIVE). */
  readonly prior_status: InjuryStatus | null;
  /** The structured P(active) the claim was made against (null when not an availability fact). */
  readonly prior_p: number | null;
  /** Whether he played in the game the claim was about (availability and health claims). */
  readonly active: boolean | null;
  /** Whether the claim was borne out (null for a neutral claim or an unscorable type). */
  readonly borne_out: boolean | null;
  /** Identical claims this record stands for (default 1 — the history seed is stored as counts). */
  readonly count?: number;
}

/** One row of the table. */
export interface CalibrationRow {
  readonly key: string;
  readonly source: CalibrationSource;
  readonly type: ScoredClaimType;
  readonly signal: ClaimSignal;
  readonly prior_status: PriorStatus;
  /** Claims with a defined `borne_out`, and how many were. */
  readonly n: number;
  readonly k: number;
  /** The hand-set reliability (the Beta prior's mean). */
  readonly prior_reliability: number;
  /** The posterior mean P(borne out). */
  readonly reliability: number;
  /** Claims with a prior in (0, 1] and a defined `active` (the ratio's data). */
  readonly m: number;
  /** The hand-set log-likelihood ratio (the Gaussian prior's mean). */
  readonly llr_prior: number;
  /** The MAP log-likelihood ratio for P(active), and its Laplace sd. */
  readonly llr: number;
  readonly llr_sd: number;
  /** Whether the row has ≥ CALIBRATION.rowMinN scored claims. */
  readonly calibrated: boolean;
}

/** The calibration table. */
export interface CalibrationTable {
  readonly rows: readonly CalibrationRow[];
  /** Scored TEXT claims (the news sources) — E10 `calibration_state.table_n`. */
  readonly table_n: number;
  /** Every accepted claim, official ones included. */
  readonly n_total: number;
  /** Records that did not read back as a scored claim (malformed, unknown source or type). */
  readonly dropped: number;
}

const own = (o: object, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
const SIGNALS: readonly string[] = [...DESIGNATIONS, ...CLAIM_DIRECTIONS];
const isProb = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

/** The calibration source of a provenance tag (text tags via reliability.ts; the practice report). */
export function calibrationSourceOf(tag: UntrustedSource): CalibrationSource | null {
  if (tag === "nflverse.injuries.practice_status") return "official.practice";
  return reliabilitySourceOf(tag);
}

/** Whether a source is a news (text) source — the ones `table_n` counts. */
export function isTextSource(source: CalibrationSource): source is ReliabilitySource {
  return isOneOf(RELIABILITY_SOURCES, source);
}

/** The row status of a prior's injury status. */
export function priorStatusOf(status: InjuryStatus | null): PriorStatus {
  if (status === null) return "ACTIVE";
  return isOneOf(PRIOR_STATUSES, status) && status !== "OTHER" ? status : "OTHER";
}

/** The signal of a claim: its designation when it has one, else its direction. */
export function claimSignal(
  designation: Designation | null,
  direction: ClaimDirection,
): ClaimSignal {
  return designation ?? direction;
}

/**
 * A stored scored claim read back defensively (a forged or corrupt record is data too): a known
 * source, a scored type, a known signal, probabilities in [0, 1], booleans or null. Anything else →
 * null.
 */
export function readScoredClaim(v: unknown): ScoredClaim | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const source = own(v, "source");
  const type = own(v, "type");
  const signal = own(v, "signal");
  const status = own(v, "prior_status") ?? null;
  const prior = own(v, "prior_p") ?? null;
  const active = own(v, "active") ?? null;
  const borne = own(v, "borne_out") ?? null;
  const count = own(v, "count") ?? 1;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > CALIBRATION.maxClaims
  )
    return null;
  if (!isOneOf(CALIBRATION_SOURCES, source) || !isOneOf(SCORED_CLAIM_TYPES, type)) return null;
  if (typeof signal !== "string" || !SIGNALS.includes(signal)) return null;
  if (status !== null && (typeof status !== "string" || status.length === 0 || status.length > 32))
    return null;
  if (prior !== null && !isProb(prior)) return null;
  if (active !== null && typeof active !== "boolean") return null;
  if (borne !== null && typeof borne !== "boolean") return null;
  if (active === null && borne === null) return null;
  return {
    source,
    type,
    signal: signal as ClaimSignal,
    prior_status: status,
    prior_p: prior,
    active,
    borne_out: borne,
    ...(count === 1 ? {} : { count }),
  };
}

/** What the retrospective knows about the game a claim was about. */
export interface ClaimOutcomeFacts {
  /** Whether he took a snap in that game (null = unknown or not final). */
  readonly played: boolean | null;
  /** His snap share before the claim (mean of up to four games) and over the next two (role claims). */
  readonly snap_before?: number | null;
  readonly snap_after?: number | null;
}

/** The sign a signal reads in: +1 (plays more / bigger role), −1, or 0 (genuinely uncertain). */
export function signalSign(signal: ClaimSignal): -1 | 0 | 1 {
  if (signal === "up") return 1;
  if (signal === "down") return -1;
  if (signal === "neutral") return 0;
  const c = availabilityClass(signal);
  return c === "plays" ? 1 : c === "out" ? -1 : 0;
}

/**
 * The outcome of one claim (sib research 05 §10.2's examples: "will play" → played; "expanded role"
 * → snap share up ≥ 10 points within two weeks): availability and health claims carry `active` and,
 * unless neutral, `borne_out`; role and coaching-intent claims carry `borne_out` from the snap
 * shares; a transaction is not scored here (both null).
 */
export function claimOutcome(
  type: ScoredClaimType,
  signal: ClaimSignal,
  facts: ClaimOutcomeFacts,
): { readonly active: boolean | null; readonly borne_out: boolean | null } {
  const sign = signalSign(signal);
  if (type === "availability" || type === "health") {
    const played = facts.played;
    return {
      active: played,
      borne_out: played === null || sign === 0 ? null : sign > 0 ? played : !played,
    };
  }
  if (type === "role" || type === "coaching_intent") {
    const b = facts.snap_before ?? null;
    const a = facts.snap_after ?? null;
    if (sign === 0 || b === null || a === null || !Number.isFinite(a - b))
      return { active: null, borne_out: null };
    const move = (a - b) * sign;
    return { active: null, borne_out: move >= EVIDENCE.roleConfirmSnap };
  }
  return { active: null, borne_out: null };
}

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const clampLlr = (x: number): number =>
  Math.max(-CALIBRATION.maxAbsLlr, Math.min(CALIBRATION.maxAbsLlr, x));

/** The hand-set reliability of a source × type (the Beta prior's mean). */
export function handSetReliability(source: CalibrationSource, type: ScoredClaimType): number {
  if (source === "official.practice")
    return type === "availability"
      ? OFFICIAL_RELIABILITY.availability
      : OFFICIAL_RELIABILITY.health;
  return RELIABILITY_PRIORS[source][type];
}

/**
 * The hand-set log-likelihood ratio of a signal: its sign × max(0, logit(reliability)) — a source
 * borne out no more often than a coin carries no weight a priori, and a genuinely uncertain signal
 * carries none until the data say otherwise.
 */
export function handSetLlr(
  source: CalibrationSource,
  type: ScoredClaimType,
  signal: ClaimSignal,
): number {
  const r = handSetReliability(source, type);
  return signalSign(signal) * Math.max(0, logit(r));
}

/** The prior's log-odds offset, or null when the prior is a ruling (exactly 0) or absent. */
function offsetOf(p: number | null): number | null {
  if (p === null || !(p > 0)) return null;
  return logit(Math.min(p, 1 - CALIBRATION.priorEps));
}

/**
 * The MAP and Laplace sd of a row's ratio given its (offset, active) data. The log-posterior is
 * strictly concave, so its gradient falls monotonically: a safeguarded Newton keeps a bracket
 * [−maxAbsLlr, maxAbsLlr] on the root and bisects whenever a Newton step would leave it (a plain
 * Newton step overshoots when the offsets sit far from the answer — a prior of 1 − eps against a
 * row that plays 80 % of the time). A root beyond the bracket returns its edge.
 */
export function fitLlr(
  data: readonly { readonly offset: number; readonly active: boolean; readonly w?: number }[],
  mu0: number,
  sd0: number = CALIBRATION.llrPriorSd,
): { readonly llr: number; readonly sd: number } {
  const prec0 = 1 / (sd0 * sd0);
  if (data.length === 0) return { llr: clampLlr(mu0), sd: sd0 };
  const at = (theta: number): { g: number; h: number } => {
    let g = -(theta - mu0) * prec0;
    let h = prec0;
    for (const d of data) {
      const w = d.w ?? 1;
      const p = sigmoid(d.offset + theta);
      g += w * ((d.active ? 1 : 0) - p);
      h += w * p * (1 - p);
    }
    return { g, h };
  };
  let lo: number = -CALIBRATION.maxAbsLlr;
  let hi: number = CALIBRATION.maxAbsLlr;
  const atLo = at(lo);
  const atHi = at(hi);
  let theta = clampLlr(mu0);
  let cur = at(theta);
  if (atLo.g <= 0) {
    theta = lo;
    cur = atLo;
  } else if (atHi.g >= 0) {
    theta = hi;
    cur = atHi;
  } else {
    for (let it = 0; it < CALIBRATION.newtonMaxIter; it++) {
      if (cur.g > 0) lo = theta;
      else hi = theta;
      const newton = theta + cur.g / cur.h;
      const next = newton > lo && newton < hi ? newton : (lo + hi) / 2;
      const done = Math.abs(next - theta) < CALIBRATION.newtonTol;
      theta = next;
      cur = at(theta);
      if (done || cur.g === 0) break;
    }
  }
  return { llr: theta, sd: 1 / Math.sqrt(cur.h) };
}

const rowKey = (
  source: CalibrationSource,
  type: ScoredClaimType,
  signal: ClaimSignal,
  status: PriorStatus,
): string => `${source}|${type}|${signal}|${status}`;

/**
 * The table from the retrospective's scored claims (each read back defensively; at most
 * CALIBRATION.maxClaims are read). Rows are sorted by key; `table_n` counts the text sources only.
 */
export function buildCalibrationTable(claims: readonly unknown[]): CalibrationTable {
  const groups = new Map<string, { readonly first: ScoredClaim; readonly cs: ScoredClaim[] }>();
  let dropped = 0;
  let total = 0;
  let text = 0;
  for (const raw of claims.slice(0, CALIBRATION.maxClaims)) {
    const c = readScoredClaim(raw);
    if (c === null) {
      dropped++;
      continue;
    }
    const w = c.count ?? 1;
    total += w;
    if (isTextSource(c.source)) text += w;
    const k = rowKey(c.source, c.type, c.signal, priorStatusOf(c.prior_status));
    const g = groups.get(k);
    if (g === undefined) groups.set(k, { first: c, cs: [c] });
    else g.cs.push(c);
  }
  dropped += Math.max(0, claims.length - CALIBRATION.maxClaims);
  const rows: CalibrationRow[] = [];
  // keys are unique, so the order is total without an equality case
  for (const [key, { first, cs }] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let n = 0;
    let k = 0;
    // identical (offset, outcome) pairs fitted once, weighted (bounded work for a large history)
    const cells = new Map<string, { offset: number; active: boolean; w: number }>();
    for (const c of cs) {
      const w = c.count ?? 1;
      if (c.borne_out !== null) {
        n += w;
        if (c.borne_out) k += w;
      }
      const o = offsetOf(c.prior_p);
      if (o === null || c.active === null) continue;
      const ck = `${String(o)}|${String(c.active)}`;
      const cell = cells.get(ck);
      if (cell === undefined) cells.set(ck, { offset: o, active: c.active, w });
      else cell.w += w;
    }
    const data = [...cells.values()];
    const m = data.reduce((a, d) => a + d.w, 0);
    const r0 = handSetReliability(first.source, first.type);
    const mu0 = handSetLlr(first.source, first.type, first.signal);
    const fit = fitLlr(data, mu0);
    rows.push({
      key,
      source: first.source,
      type: first.type,
      signal: first.signal,
      prior_status: priorStatusOf(first.prior_status),
      n,
      k,
      prior_reliability: r0,
      reliability: (CALIBRATION.priorWeight * r0 + k) / (CALIBRATION.priorWeight + n),
      m,
      llr_prior: mu0,
      llr: fit.llr,
      llr_sd: fit.sd,
      calibrated: Math.max(n, m) >= CALIBRATION.rowMinN,
    });
  }
  return { rows, table_n: text, n_total: total, dropped };
}

/** E10 `calibration_state` of a table (the note stays until `table_n` reaches the threshold). */
export function calibrationStateOf(table: CalibrationTable): CalibrationState {
  return calibrationState(table.table_n);
}

/** A row of the table, or null. */
export function rowOf(
  table: CalibrationTable,
  source: CalibrationSource,
  type: ScoredClaimType,
  signal: ClaimSignal,
  status: InjuryStatus | null,
): CalibrationRow | null {
  const key = rowKey(source, type, signal, priorStatusOf(status));
  return table.rows.find((r) => r.key === key) ?? null;
}

/** One evidence item as the merge reads it (E10's item, reduced to the table's key). */
export interface PosteriorEvidence {
  readonly source: CalibrationSource;
  readonly type: ClaimType;
  readonly signal: ClaimSignal;
  /** Epoch ms of publication (null = unknown: older than any dated item of the same source). */
  readonly time_ms: number | null;
  /** 0..1: 0 for an injection-flagged item (it stays data), the decay for a preseason outlook. */
  readonly weight?: number;
}

/**
 * P(active) after the evidence: the prior's log-odds plus each applicable item's row ratio (the
 * fitted one, or the hand-set one where the table has no row) × its weight; the latest item per
 * source; availability and health claims only. A prior of exactly 0 stays 0 (an official ruling); a
 * null prior → null; no applicable item → the prior unchanged. Not gated: E10 shows it through
 * `evidencePosterior`; the backtest scores it directly.
 */
export function mergePActive(
  priorP: number | null,
  priorStatus: InjuryStatus | null,
  evidence: readonly PosteriorEvidence[],
  table: CalibrationTable,
): number | null {
  if (priorP === null || !isProb(priorP)) return null;
  if (priorP === 0) return 0;
  const latest = new Map<CalibrationSource, PosteriorEvidence>();
  for (const e of evidence) {
    if (e.type !== "availability" && e.type !== "health") continue;
    const w = e.weight ?? 1;
    if (!(w > 0)) continue;
    const prev = latest.get(e.source);
    if (prev === undefined || (e.time_ms ?? -Infinity) >= (prev.time_ms ?? -Infinity))
      latest.set(e.source, e);
  }
  if (latest.size === 0) return priorP;
  let x = logit(Math.min(priorP, 1 - CALIBRATION.priorEps));
  for (const e of latest.values()) {
    const type = e.type as "availability" | "health";
    const row = rowOf(table, e.source, type, e.signal, priorStatus);
    const llr = row === null ? handSetLlr(e.source, type, e.signal) : row.llr;
    x += Math.min(1, e.weight ?? 1) * llr;
  }
  return Math.round(sigmoid(x) * 1000) / 1000;
}

/** E10 `posterior` (plan 07 E10; analytics/types.ts EvidenceData). */
export interface EvidencePosterior {
  readonly p_active: number | null;
  readonly role_shares: Readonly<Record<string, number>> | null;
}

/** What E10 passes for its posterior. */
export interface PosteriorInput {
  readonly prior: {
    readonly p_active: number | null;
    readonly role_shares: Readonly<Record<string, number>> | null;
  } | null;
  readonly prior_status: InjuryStatus | null;
  readonly evidence: readonly PosteriorEvidence[];
  readonly table: CalibrationTable;
}

/**
 * E10's posterior: null until the table holds EVIDENCE_POSTERIOR_MIN_N scored text claims (sib ADV
 * OBJ-21 — "priors are hand-set" until then) or when there is no prior; else P(active) merged and
 * the role shares passed through.
 */
export function evidencePosterior(input: PosteriorInput): EvidencePosterior | null {
  if (!posteriorAllowed(calibrationStateOf(input.table)) || input.prior === null) return null;
  return {
    p_active: mergePActive(input.prior.p_active, input.prior_status, input.evidence, input.table),
    role_shares: input.prior.role_shares,
  };
}

/** The threshold E10 shows a posterior from (re-exported for the Skill text and tests). */
export const POSTERIOR_MIN_N = EVIDENCE_POSTERIOR_MIN_N;

// --- the official channel's history seed (plan 10 §3.3 C8; D9's three backtest seasons) --------------

/**
 * The official practice report's labelled history: the regular-season rows of the nflverse injury
 * report 2023–2025 that carry a practice participation and whose player could be matched to his
 * team's snap counts (16,663 of the 16,772 matched; 17,188 report rows — tests/domain/evidence/
 * data/injury_outcomes), by official game status (none = ACTIVE) and the week's final practice
 * participation: how many, and how many took a snap that week. Held equal to the committed excerpt
 * by tests/domain/evidence/calibration-history.test.ts. Value-free counts.
 */
export const PRACTICE_REPORT_HISTORY: readonly {
  readonly status: "ACTIVE" | "QUESTIONABLE" | "DOUBTFUL" | "OUT";
  readonly practice: "practice_dnp" | "practice_limited" | "practice_full";
  readonly n: number;
  readonly played: number;
}[] = Object.freeze([
  { status: "ACTIVE", practice: "practice_dnp", n: 876, played: 702 },
  { status: "ACTIVE", practice: "practice_full", n: 6921, played: 6621 },
  { status: "ACTIVE", practice: "practice_limited", n: 1160, played: 1105 },
  { status: "DOUBTFUL", practice: "practice_dnp", n: 247, played: 2 },
  { status: "DOUBTFUL", practice: "practice_full", n: 42, played: 0 },
  { status: "DOUBTFUL", practice: "practice_limited", n: 144, played: 1 },
  { status: "OUT", practice: "practice_dnp", n: 2771, played: 0 },
  { status: "OUT", practice: "practice_full", n: 143, played: 0 },
  { status: "OUT", practice: "practice_limited", n: 328, played: 0 },
  { status: "QUESTIONABLE", practice: "practice_dnp", n: 639, played: 340 },
  { status: "QUESTIONABLE", practice: "practice_full", n: 981, played: 715 },
  { status: "QUESTIONABLE", practice: "practice_limited", n: 2411, played: 1625 },
] as const);

/**
 * The history seed as scored claims (two counted records per cell: played, not played), each made
 * against the shipped designation-only prior — what the retrospective would have recorded. A table
 * built from `[...practiceHistoryClaims(), ...storedClaims]` carries a calibrated official channel
 * from day one; `table_n` (the news table) is unchanged by it.
 */
export function practiceHistoryClaims(): ScoredClaim[] {
  const out: ScoredClaim[] = [];
  for (const h of PRACTICE_REPORT_HISTORY) {
    const prior = P_ACTIVE_BY_STATUS[h.status] ?? 1;
    const status = h.status === "ACTIVE" ? null : h.status;
    for (const played of [true, false]) {
      const count = played ? h.played : h.n - h.played;
      if (count === 0) continue;
      const o = claimOutcome("health", h.practice, { played });
      out.push({
        source: "official.practice",
        type: "health",
        signal: h.practice,
        prior_status: status,
        prior_p: prior,
        active: o.active,
        borne_out: o.borne_out,
        count,
      });
    }
  }
  return out;
}

// --- E10's items as the merge reads them ----------------------------------------------------------

/** One E10 evidence item, as analyzeEvidence holds it (no text: tag, type, signal, time, flags). */
export interface E10EvidenceItem {
  readonly source: UntrustedSource;
  readonly type: ClaimType;
  readonly direction: ClaimDirection;
  readonly designation: Designation | null;
  readonly time: string | null;
  readonly flags?: readonly InjectionFlag[];
  /** The preseason-outlook decay factor in [0, 1] (reliability.ts seasonOutlookWeight); default 1. */
  readonly decay?: number;
}

/**
 * E10's items mapped for `evidencePosterior`: a tag outside the calibration sources (league-member
 * text, the official game status — the prior's own basis) is dropped; an injection-flagged item
 * keeps weight 0 (it stays data); a decayed outlook its decay; an unparseable time reads as unknown.
 */
export function posteriorEvidenceOf(items: readonly E10EvidenceItem[]): PosteriorEvidence[] {
  const out: PosteriorEvidence[] = [];
  for (const it of items) {
    const source = calibrationSourceOf(it.source);
    if (source === null) continue;
    const t = it.time === null ? Number.NaN : Date.parse(it.time);
    const decay = it.decay ?? 1;
    out.push({
      source,
      type: it.type,
      signal: claimSignal(it.designation, it.direction),
      time_ms: Number.isFinite(t) ? t : null,
      weight:
        (it.flags?.length ?? 0) > 0
          ? 0
          : Number.isFinite(decay)
            ? Math.max(0, Math.min(1, decay))
            : 0,
    });
  }
  return out;
}
