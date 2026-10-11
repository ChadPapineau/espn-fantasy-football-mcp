// attribution.ts — retrospective attribution (plan 10 §3.3 C9 "retrospective attribution populated for
// every projection-backed call"; plan 07 E13 `attribution`; sib research 05 §12.4: decompose the
// projection error into the layers of §1 — availability, opportunity, efficiency, touchdowns,
// turnovers — plus the matchup/weather multipliers, so the tuning loop knows WHICH parameter to move
// rather than "the projection was off"). Model-agnostic: a row is the model's expected stat line
// (conditional on playing) and the realised line, both scored through the plan 08 engine under the
// league's S, so the decomposition is in league points and works for any model that stores an
// expectation (v1 or v2). The layers sum to the error exactly:
//   error = realised − reported
//         = a·(E_R − E_E)            [opportunity + efficiency + touchdowns + turnovers + other]
//         + (a − p)·E_E              [availability]
//         + (p·E_E − reported)       [anchor: the error added by reporting the anchored mean —
//                                     ESPN's while weight_espn = 1.0 — instead of the model's own]
//         + (realised − a·E_R)       [scoring: ESPN appliedTotal vs the engine on the realised line]
// with a = 1 when the player played, p = P(active), E_x = engine points of a line. Per opportunity
// family (pass / rush / receive) the volume × efficiency split is the exact two-factor one:
// Δ(c·e) = (c_R − c_E)·e_E + c_R·(e_R − e_E). A multiplier's lift (|error without it| − |error with
// it|, on the model's own mean) is reported beside the sum, never inside it. Pure. New here.
import type { ModelVersion, SubjectRole } from "../analytics/types.js";
import type { Week } from "../league/types.js";
import { score } from "../scoring/engine.js";
import { positionClassOf, statLineFromEspn } from "../scoring/stat_map.js";
import {
  CANONICAL_NAME_RE,
  asPositionId,
  type Canonical,
  type ScoringSettings,
  type StatLine,
} from "../scoring/types.js";
import { isMetricValue, stableMean, stableSum } from "./metrics.js";
import { nTooSmall, type RecommendationRecord } from "./types.js";

// --- vocabulary ------------------------------------------------------------------------------------

/** The layers, in report order; their sum is the error (see the header). */
export const ATTRIBUTION_LAYERS = Object.freeze([
  "availability",
  "opportunity",
  "efficiency",
  "touchdowns",
  "turnovers",
  "other",
  "anchor",
  "scoring",
] as const);
export type AttributionLayer = (typeof ATTRIBUTION_LAYERS)[number];
export type LayerValues = Readonly<Record<AttributionLayer, number>>;

/** The opportunity layers reported per position (the ones the projection parameters move). */
export const POSITION_LAYERS: readonly AttributionLayer[] = Object.freeze([
  "availability",
  "opportunity",
  "efficiency",
  "touchdowns",
]);

/** The share windows a v2 trace may carry (sib §1 step 2). */
export const SHARE_NAMES = Object.freeze([
  "target_share",
  "carry_share",
  "snap_share",
  "route_share",
  "air_yards_share",
  "rz_target_share",
  "rz_carry_share",
] as const);
export type ShareName = (typeof SHARE_NAMES)[number];

/** The shrunk efficiency rates a v2 trace may carry (sib §1 step 4). */
export const RATE_NAMES = Object.freeze([
  "catch_rate",
  "yards_per_target",
  "yards_per_reception",
  "yards_per_carry",
  "completion_rate",
  "yards_per_attempt",
  "int_rate",
  "td_rate",
] as const);
export type RateName = (typeof RATE_NAMES)[number];

/** A display position usable as a map key (`QB`, `D/ST` — never `__proto__`). */
export const ATTRIBUTION_POSITION_RE = /^[A-Z][A-Za-z/]{0,9}$/;

/** Bounds on a row (a hostile or corrupt row is excluded, never fatal). */
export const ATTRIBUTION_BOUNDS = Object.freeze({
  statKeys: 512,
  shares: 16,
  shareHistory: 32,
  rates: 16,
  halfLife: { min: 0.1, max: 100 },
  k: { min: 1e-6, max: 1e6 },
  z: 100,
  beta: { min: 0, max: 10 },
  multiplier: { min: 1e-3, max: 10 },
});

/** Signed weight of a subject's role in a call's edge: what it gains minus what it gives up. */
export const CALL_ROLE_WEIGHT: Readonly<Record<SubjectRole, number>> = Object.freeze({
  start: 1,
  add: 1,
  claim: 1,
  stream: 1,
  trade_in: 1,
  sit: -1,
  drop: -1,
  trade_out: -1,
  ir_move: 0,
});

/** Per-call keys reach the wire for at most this many projection-backed calls (token budget). */
export const MAX_WIRE_CALLS = 20;

const LAYER_ALT = ATTRIBUTION_LAYERS.join("|");
/**
 * The grammar of every `data.attribution` key (`attributionMap`): fixed words, the layer names, a
 * display position (ATTRIBUTION_POSITION_RE) and a call index — server-composed, so no third-party
 * string can form one. The tool keeps only keys matching it and the A6 walk admits exactly these
 * dotted keys (the envelope's OUTPUT_KEY_RE has no dot; the precedent is E13's RETRO_METRIC_KEYS).
 */
export const ATTRIBUTION_KEY_RE = new RegExp(
  `^(?:n_player_weeks|calls\\.(?:projection_backed|complete|unbacked)|error\\.(?:mean|mae)` +
    `|(?:${LAYER_ALT})\\.(?:mean|mae)` +
    `|[A-Z][A-Za-z/]{0,9}\\.(?:n|error\\.mae|(?:${LAYER_ALT})\\.mae)` +
    `|(?:matchup_lift|weather_lift)\\.(?:n|mean)` +
    `|calls\\.[0-9]{1,3}\\.(?:error|complete|${LAYER_ALT}))$`,
);

// --- inputs ----------------------------------------------------------------------------------------

/** One EWM share window the opportunity layer used (oldest game first) and the realised share. */
export interface ShareTrace {
  readonly name: ShareName;
  /** Per-game shares in [0, 1], oldest first (the window AFTER any change-point re-base). */
  readonly history: readonly number[];
  /** The half-life (games) the model used. */
  readonly half_life: number;
  /** The realised share this week in [0, 1]; null = not observed (did not play, no data). */
  readonly realised: number | null;
}

/** One shrunk rate: rate_hat = (n·observed + k·prior) / (n + k), and what was realised. */
export interface RateTrace {
  readonly name: RateName;
  /** The player's opportunities behind `observed`. */
  readonly n_obs: number;
  readonly observed: number;
  readonly prior: number;
  /** The stabilisation constant the model used. */
  readonly k: number;
  /** The realised rate this week; null = not observed. */
  readonly realised: number | null;
  /** The realised opportunities behind `realised` (its weight in the fit). */
  readonly realised_n: number;
}

/** The v2-opportunity model's tuning trace for one player-week (null for v1 / unknown). */
export interface ProjectionTrace {
  /** The matchup multiplier m = 1 + beta·z on the active-conditional mean; null = none applied. */
  readonly matchup: { readonly z: number; readonly beta: number } | null;
  /** The weather multiplier on the active-conditional mean (1 or null = none applied). */
  readonly weather_mult: number | null;
  readonly shares: readonly ShareTrace[];
  readonly rates: readonly RateTrace[];
}

/** One projected player-week and what happened (the caller joins the stored projection to facts). */
export interface AttributionRow {
  readonly week: Week;
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  /** Display position (ATTRIBUTION_POSITION_RE). */
  readonly position: string;
  /** ESPN default position id (the engine's overrides key on it). */
  readonly position_id: number;
  readonly model_version: ModelVersion;
  /** The point estimate the tool reported (Dist.mean — ESPN's mean while weight_espn = 1.0). */
  readonly reported_mean: number;
  /** P(active) the projection used; null = unknown (read as 1: the expectation is the mean). */
  readonly p_active: number | null;
  /** The model's expected stat line CONDITIONAL ON PLAYING (canonical → expected value). */
  readonly expected: Readonly<Record<Canonical, number>>;
  /** Whether the player played; an inactive week realises nothing. */
  readonly active: boolean;
  /** The realised canonical line ({} when inactive). */
  readonly realised: Readonly<Record<Canonical, number>>;
  /** `espn`: an ESPN line scored as sent; `nflverse`: a derived line (brackets from scalars). */
  readonly realised_source: "espn" | "nflverse";
  /** ESPN `appliedTotal` — the realised value. */
  readonly realised_points: number;
  /** ESPN's own projection mean (the comparator); null = not captured. */
  readonly espn_mean: number | null;
  readonly trace: ProjectionTrace | null;
}

/** One attributed player-week. */
export interface PlayerWeekAttribution {
  readonly week: Week;
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly position: string;
  readonly active: boolean;
  /** realised_points − reported_mean (= Σ layers). */
  readonly error: number;
  readonly layers: LayerValues;
  readonly reported_mean: number;
  readonly realised_points: number;
  /** engine(expected): the model's active-conditional mean. */
  readonly expected_points: number;
  /** p·engine(expected): the model's own mixture mean. */
  readonly model_mean: number;
  /** engine(realised) when active, else 0. */
  readonly realised_engine: number;
  readonly espn_mean: number | null;
  /** |realised − model_mean/m| − |realised − model_mean|: > 0 = the matchup multiplier helped. */
  readonly matchup_lift: number | null;
  /** The same for the weather multiplier. */
  readonly weather_lift: number | null;
  /** The validated trace (null when absent or invalid). */
  readonly trace: ProjectionTrace | null;
}

// --- validation --------------------------------------------------------------------------------------

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const inRange = (x: unknown, lo: number, hi: number): x is number =>
  isFiniteNum(x) && x >= lo && x <= hi;
const isProb = (x: unknown): x is number => inRange(x, 0, 1);

/** A stat map with canonical keys and metric values, rebuilt as an own-property object; null if bad. */
export function cleanStatMap(m: unknown): Record<Canonical, number> | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const entries = Object.entries(m as Record<string, unknown>);
  if (entries.length > ATTRIBUTION_BOUNDS.statKeys) return null;
  const out: [string, number][] = [];
  for (const [k, v] of entries) {
    if (!CANONICAL_NAME_RE.test(k) || !isMetricValue(v)) return null;
    out.push([k, v]);
  }
  return Object.fromEntries(out);
}

function cleanShare(s: unknown): ShareTrace | null {
  if (typeof s !== "object" || s === null) return null;
  const x = s as Record<string, unknown>;
  if (!(SHARE_NAMES as readonly unknown[]).includes(x.name)) return null;
  const h: unknown = x.history;
  if (
    !Array.isArray(h) ||
    h.length === 0 ||
    h.length > ATTRIBUTION_BOUNDS.shareHistory ||
    !h.every(isProb)
  )
    return null;
  if (!inRange(x.half_life, ATTRIBUTION_BOUNDS.halfLife.min, ATTRIBUTION_BOUNDS.halfLife.max))
    return null;
  if (x.realised !== null && !isProb(x.realised)) return null;
  return {
    name: x.name as ShareName,
    history: [...h],
    half_life: x.half_life,
    realised: x.realised,
  };
}

function cleanRate(r: unknown): RateTrace | null {
  if (typeof r !== "object" || r === null) return null;
  const x = r as Record<string, unknown>;
  if (!(RATE_NAMES as readonly unknown[]).includes(x.name)) return null;
  if (!inRange(x.n_obs, 0, 1e5) || !isMetricValue(x.observed) || !isMetricValue(x.prior))
    return null;
  if (!inRange(x.k, ATTRIBUTION_BOUNDS.k.min, ATTRIBUTION_BOUNDS.k.max)) return null;
  if (x.realised !== null && !isMetricValue(x.realised)) return null;
  if (!inRange(x.realised_n, 0, 1e5)) return null;
  return {
    name: x.name as RateName,
    n_obs: x.n_obs,
    observed: x.observed,
    prior: x.prior,
    k: x.k,
    realised: x.realised,
    realised_n: x.realised_n,
  };
}

/** The trace with every part checked; null when anything is malformed (the row stays attributed). */
export function cleanTrace(t: unknown): ProjectionTrace | null {
  if (typeof t !== "object" || t === null) return null;
  const x = t as Record<string, unknown>;
  let matchup: ProjectionTrace["matchup"] = null;
  if (x.matchup !== null) {
    const m = x.matchup as Record<string, unknown> | undefined;
    if (
      typeof m !== "object" ||
      !inRange(m.z, -ATTRIBUTION_BOUNDS.z, ATTRIBUTION_BOUNDS.z) ||
      !inRange(m.beta, ATTRIBUTION_BOUNDS.beta.min, ATTRIBUTION_BOUNDS.beta.max) ||
      !(1 + m.beta * m.z > 0)
    )
      return null;
    matchup = { z: m.z, beta: m.beta };
  }
  if (
    x.weather_mult !== null &&
    !inRange(x.weather_mult, ATTRIBUTION_BOUNDS.multiplier.min, ATTRIBUTION_BOUNDS.multiplier.max)
  )
    return null;
  const sh: unknown = x.shares;
  const ra: unknown = x.rates;
  if (!Array.isArray(sh) || sh.length > ATTRIBUTION_BOUNDS.shares) return null;
  if (!Array.isArray(ra) || ra.length > ATTRIBUTION_BOUNDS.rates) return null;
  const shares: ShareTrace[] = [];
  for (const s of sh as unknown[]) {
    const c = cleanShare(s);
    if (c === null) return null;
    shares.push(c);
  }
  const rates: RateTrace[] = [];
  for (const r of ra as unknown[]) {
    const c = cleanRate(r);
    if (c === null) return null;
    rates.push(c);
  }
  return { matchup, weather_mult: x.weather_mult, shares, rates };
}

// --- the engine view of a line ---------------------------------------------------------------------

/** The opportunity families of the volume × efficiency split. */
type Family = "pass" | "rush" | "rec";
const FAMILIES: readonly Family[] = ["pass", "rush", "rec"];

const TD_RE = /^(?:pass|rush|rec)_td(?:_\d+)?$/;
const TURNOVERS: ReadonlySet<string> = new Set(["pass_int", "fum", "fum_lost", "turnovers"]);

/** The family a scored canonical belongs to (null = outside the opportunity families → `other`). */
export function familyOf(c: Canonical): Family | null {
  if (c.endsWith("_2pt")) return null;
  if (c.startsWith("pass_") || c.startsWith("per_n_pass_") || c === "sacked") return "pass";
  if (c.startsWith("rush_") || c.startsWith("per_n_rush_")) return "rush";
  if (c === "rec" || c === "targets" || c.startsWith("rec_") || c.startsWith("per_n_rec"))
    return "rec";
  return null;
}

/** The volume count a family's efficiency is per (receiving: targets, else receptions). */
const VOLUME: Readonly<Record<Family, readonly Canonical[]>> = Object.freeze({
  pass: ["pass_att"],
  rush: ["rush_att"],
  rec: ["targets", "rec"],
});

/** One line's points by group (non-TD per family, TD per family, turnovers, other) and volumes. */
export interface LineGroups {
  readonly total: number;
  readonly nonTd: Readonly<Record<Family, number>>;
  readonly td: Readonly<Record<Family, number>>;
  readonly turnovers: number;
  /** Everything else, incl. 2-pt, returns, K and D/ST items and the rounding of the sum. */
  readonly other: number;
}

/** Scores a line and groups its contributions (`other` absorbs what no group claims, so Σ = total). */
export function lineGroups(line: StatLine, settings: ScoringSettings): LineGroups {
  const r = score(line, settings);
  const nonTd = { pass: [] as number[], rush: [] as number[], rec: [] as number[] };
  const td = { pass: [] as number[], rush: [] as number[], rec: [] as number[] };
  const turnovers: number[] = [];
  for (const c of r.contributions) {
    if (TURNOVERS.has(c.canonical)) {
      turnovers.push(c.points);
      continue;
    }
    const f = familyOf(c.canonical);
    if (f === null) continue;
    (TD_RE.test(c.canonical) ? td : nonTd)[f].push(c.points);
  }
  const g = {
    nonTd: { pass: stableSum(nonTd.pass), rush: stableSum(nonTd.rush), rec: stableSum(nonTd.rec) },
    td: { pass: stableSum(td.pass), rush: stableSum(td.rush), rec: stableSum(td.rec) },
    turnovers: stableSum(turnovers),
  };
  const claimed = stableSum([
    ...FAMILIES.map((f) => g.nonTd[f]),
    ...FAMILIES.map((f) => g.td[f]),
    g.turnovers,
  ]);
  return { total: r.points_exact, ...g, other: r.points_exact - claimed };
}

function statLine(
  values: Readonly<Record<Canonical, number>>,
  positionId: number,
  source: string,
): StatLine {
  return {
    values,
    present: Object.keys(values).sort(),
    position: asPositionId(positionId),
    position_class: positionClassOf(positionId),
    provisional: false,
    source,
  };
}

/**
 * Below this many opportunities a volume counts as none (an efficiency per 1e-300 targets would turn
 * the exact split into a cancellation of two enormous terms).
 */
export const VOLUME_EPS = 0.01;

/** A family's volume pair: the first VOLUME canonical present (≥ 0) in BOTH lines, else none. */
function volumes(
  family: Family,
  e: Readonly<Record<Canonical, number>>,
  r: Readonly<Record<Canonical, number>>,
): { readonly cE: number; readonly cR: number } | null {
  for (const c of VOLUME[family]) {
    const a = Object.hasOwn(e, c) ? e[c] : undefined;
    const b = Object.hasOwn(r, c) ? r[c] : undefined;
    if (a !== undefined && b !== undefined && a >= 0 && b >= 0) return { cE: a, cR: b };
  }
  return null;
}

/**
 * The active-conditional layers of realised vs expected (opportunity, efficiency, touchdowns,
 * turnovers, other), summing to engine(realised) − engine(expected) exactly. Per family with a
 * volume pair: opportunity = (c_R − c_E)·(P_E / c_E) when c_E > 0; all of ΔP when only the realised
 * side had volume; efficiency = ΔP − opportunity. A family without a volume pair is all efficiency;
 * a volume under VOLUME_EPS is none.
 */
export function activeLayers(
  E: LineGroups,
  R: LineGroups,
  expected: Readonly<Record<Canonical, number>>,
  realised: Readonly<Record<Canonical, number>>,
): Pick<LayerValues, "opportunity" | "efficiency" | "touchdowns" | "turnovers" | "other"> {
  const opp: number[] = [];
  const eff: number[] = [];
  const tds: number[] = [];
  for (const f of FAMILIES) {
    const dP = R.nonTd[f] - E.nonTd[f];
    const v = volumes(f, expected, realised);
    let o = 0;
    if (v !== null) {
      const cE = v.cE >= VOLUME_EPS ? v.cE : 0;
      const cR = v.cR >= VOLUME_EPS ? v.cR : 0;
      if (cE > 0) o = (cR - cE) * (E.nonTd[f] / cE);
      else if (cR > 0) o = dP;
    }
    opp.push(o);
    eff.push(dP - o);
    tds.push(R.td[f] - E.td[f]);
  }
  return {
    opportunity: stableSum(opp),
    efficiency: stableSum(eff),
    touchdowns: stableSum(tds),
    turnovers: R.turnovers - E.turnovers,
    other: R.other - E.other,
  };
}

/** The realised-line sources and the models a row may name (anything else is refused). */
const REALISED_SOURCES: readonly unknown[] = Object.freeze(["espn", "nflverse"]);
const MODEL_VERSIONS: readonly unknown[] = Object.freeze(["v1-ensemble", "v2-opportunity"]);

/** Why a row could not be attributed (fixed vocabulary for the envelope's count warnings). */
export type AttributionRefusal = "invalid_row" | "unscorable_line";

/** The lift of a multiplier m on the model's mean: |y − μ/m| − |y − μ|; null when m is 1 or absent. */
export function multiplierLift(y: number, modelMean: number, m: number | null): number | null {
  if (m === null || m === 1 || !(m > 0)) return null;
  return Math.abs(y - modelMean / m) - Math.abs(y - modelMean);
}

/**
 * Attributes one player-week (see the header for the identity). A malformed row is refused
 * (`invalid_row`), a line the engine cannot score is `unscorable_line`; a malformed trace only drops
 * the trace.
 */
export function attributePlayerWeek(
  row: AttributionRow,
  settings: ScoringSettings,
):
  | { readonly ok: true; readonly value: PlayerWeekAttribution }
  | { readonly ok: false; readonly reason: AttributionRefusal } {
  const raw: unknown = row;
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "invalid_row" };
  const expected = cleanStatMap(row.expected);
  const realised = cleanStatMap(row.realised);
  if (
    expected === null ||
    realised === null ||
    typeof row.position !== "string" ||
    !ATTRIBUTION_POSITION_RE.test(row.position) ||
    !Number.isInteger(row.week) ||
    !isMetricValue(row.reported_mean) ||
    !isMetricValue(row.realised_points) ||
    (row.p_active !== null && !isProb(row.p_active)) ||
    (row.espn_mean !== null && !isMetricValue(row.espn_mean)) ||
    typeof row.active !== "boolean" ||
    !REALISED_SOURCES.includes(row.realised_source) ||
    !MODEL_VERSIONS.includes(row.model_version) ||
    (row.player_id !== null && !Number.isSafeInteger(row.player_id)) ||
    (row.gsis_id !== null && typeof row.gsis_id !== "string")
  )
    return { ok: false, reason: "invalid_row" };
  let E: LineGroups;
  let R: LineGroups;
  try {
    E = lineGroups(
      statLine(expected, row.position_id, `projection:${row.model_version}`),
      settings,
    );
    R = row.active
      ? lineGroups(statLine(realised, row.position_id, row.realised_source), settings)
      : lineGroups(statLine({}, row.position_id, row.realised_source), settings);
  } catch {
    return { ok: false, reason: "unscorable_line" };
  }
  const a = row.active ? 1 : 0;
  const p = row.p_active ?? 1;
  const act = row.active
    ? activeLayers(E, R, expected, realised)
    : { opportunity: 0, efficiency: 0, touchdowns: 0, turnovers: 0, other: 0 };
  const realisedEngine = a * R.total;
  const modelMean = p * E.total;
  const layers: LayerValues = {
    availability: (a - p) * E.total,
    opportunity: act.opportunity,
    efficiency: act.efficiency,
    touchdowns: act.touchdowns,
    turnovers: act.turnovers,
    // inactive: the expected line's own `other` is inside availability already
    other: act.other,
    anchor: modelMean - row.reported_mean,
    scoring: row.realised_points - realisedEngine,
  };
  const trace = row.trace === null ? null : cleanTrace(row.trace);
  const m = trace?.matchup ? 1 + trace.matchup.beta * trace.matchup.z : null;
  return {
    ok: true,
    value: {
      week: row.week,
      player_id: row.player_id,
      gsis_id: row.gsis_id,
      position: row.position,
      active: row.active,
      error: row.realised_points - row.reported_mean,
      layers,
      reported_mean: row.reported_mean,
      realised_points: row.realised_points,
      expected_points: E.total,
      model_mean: modelMean,
      realised_engine: realisedEngine,
      espn_mean: row.espn_mean,
      matchup_lift: multiplierLift(row.realised_points, modelMean, m),
      weather_lift: multiplierLift(row.realised_points, modelMean, trace?.weather_mult ?? null),
      trace,
    },
  };
}

// --- the ESPN box-score row (what the E13 tool joins) ------------------------------------------------

/** ESPN's games-played stat id (210 → `gp`): 1 on every weekly actual line of a player who played. */
export const ESPN_GP_STAT_ID = "210";

/**
 * Whether an ESPN weekly actual line (`actual.raw`) says the player played: gp ≥ 1; without a gp
 * entry, any non-zero stat. A did-not-play entry carries an empty stats map (recorded fixtures).
 */
export function playedFromEspn(raw: Readonly<Record<string, number>> | null): boolean {
  if (raw === null) return false;
  if (Object.hasOwn(raw, ESPN_GP_STAT_ID)) return (raw[ESPN_GP_STAT_ID] ?? 0) >= 1;
  return Object.values(raw).some((v) => typeof v === "number" && v !== 0);
}

/** One projected player-week as the store and the box score give it (plan 07 E13 data: A5 + store). */
export interface EspnAttributionSource {
  readonly week: Week;
  readonly player_id: number;
  readonly gsis_id: string | null;
  readonly position: string;
  readonly position_id: number;
  readonly model_version: ModelVersion;
  /** The stored projection's expected line, conditional on playing (`projection.expectation_json`). */
  readonly expectation: Readonly<Record<Canonical, number>>;
  /** The point estimate the tool reported for the week. */
  readonly reported_mean: number;
  readonly p_active: number | null;
  /** The box-score entry's `actual.raw` (ESPN `stats{statId: raw}`); null = no actual line. */
  readonly actual_raw: Readonly<Record<string, number>> | null;
  /** The entry's `actual.applied_total`; null = unknown (no row is built). */
  readonly applied_total: number | null;
  readonly espn_mean: number | null;
  readonly trace: ProjectionTrace | null;
}

/**
 * The AttributionRow of an ESPN box-score week: the realised line is the entry's ESPN stats through
 * the plan 08 id table (ESPN lines are scored as sent, so the `scoring` layer is the golden's
 * residual, ≈ 0), `active` by playedFromEspn, realised = ESPN `appliedTotal`. Null when the applied
 * total is unknown or the ESPN stats fail the translator (drift — the caller counts it).
 */
export function attributionRowFromEspn(src: EspnAttributionSource): AttributionRow | null {
  if (src.applied_total === null) return null;
  const active = playedFromEspn(src.actual_raw);
  let realised: Record<Canonical, number> = {};
  if (active && src.actual_raw !== null) {
    try {
      realised = { ...statLineFromEspn({ raw: src.actual_raw }, src.position_id).line.values };
    } catch {
      return null;
    }
  }
  return {
    week: src.week,
    player_id: src.player_id,
    gsis_id: src.gsis_id,
    position: src.position,
    position_id: src.position_id,
    model_version: src.model_version,
    reported_mean: src.reported_mean,
    p_active: src.p_active,
    expected: src.expectation,
    active,
    realised,
    realised_source: "espn",
    realised_points: src.applied_total,
    espn_mean: src.espn_mean,
    trace: src.trace,
  };
}

// --- per call ------------------------------------------------------------------------------------

/** One call's attribution: the layers of its realised vs projected edge (Σ weight × player layers). */
export interface CallAttribution {
  readonly log_id: string;
  /** The call's index in the retrospective's `calls[]`. */
  readonly index: number;
  /** ≥ 1 weighted subject carries an attributed player-week. */
  readonly projection_backed: boolean;
  /** Every weighted subject carries one. */
  readonly complete: boolean;
  readonly subjects_weighted: number;
  readonly subjects_attributed: number;
  /** Σ weight × (realised − reported) over the attributed subjects; null when not backed. */
  readonly error: number | null;
  readonly layers: LayerValues | null;
}

const zeroLayers = (): Record<AttributionLayer, number> =>
  Object.fromEntries(ATTRIBUTION_LAYERS.map((l) => [l, 0])) as Record<AttributionLayer, number>;

/**
 * A lookup of the scored week's attributed player-weeks by subject (the retrospective builds it over
 * its SubjectIndex): undefined = no row, null = ambiguous (conflicting duplicate rows).
 */
export type AttributionLookup = (s: {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
}) => PlayerWeekAttribution | null | undefined;

/**
 * Attributes one call of the scored week from its structured subjects (never its text — plan 07
 * C15): each subject's player-week layers, weighted by CALL_ROLE_WEIGHT (gains +1, what the call
 * gives up −1, an IR move 0). A subject without a row (or with an ambiguous one) leaves the call
 * incomplete.
 */
export function attributeCall(
  record: RecommendationRecord,
  index: number,
  rows: AttributionLookup,
): CallAttribution {
  let weighted = 0;
  let attributed = 0;
  const err: number[] = [];
  const parts = new Map<AttributionLayer, number[]>(ATTRIBUTION_LAYERS.map((l) => [l, []]));
  for (const s of record.rec.subjects) {
    const w = CALL_ROLE_WEIGHT[s.role];
    if (w === 0) continue;
    weighted++;
    const r = rows(s);
    if (r === undefined || r === null) continue;
    attributed++;
    err.push(w * r.error);
    for (const l of ATTRIBUTION_LAYERS) parts.get(l)?.push(w * r.layers[l]);
  }
  const backed = attributed > 0;
  let layers: LayerValues | null = null;
  if (backed) {
    const out = zeroLayers();
    for (const l of ATTRIBUTION_LAYERS) out[l] = stableSum(parts.get(l) ?? []);
    layers = out;
  }
  return {
    log_id: record.log_id,
    index,
    projection_backed: backed,
    complete: backed && attributed === weighted,
    subjects_weighted: weighted,
    subjects_attributed: attributed,
    error: backed ? stableSum(err) : null,
    layers,
  };
}

// --- the wire map ----------------------------------------------------------------------------------

/** Rounds a reported number to 0.001 (the map is a report; the per-row values stay exact). */
export function round3(x: number): number {
  const r = Math.round(x * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/** The aggregate and its caveats. */
export interface AttributionAggregate {
  readonly map: Readonly<Record<string, number>>;
  readonly caveats: readonly string[];
  readonly n: number;
}

/**
 * The flat `data.attribution` map (plan 07 E13's `Record<string, number>`; every key ≤ 40 chars):
 *   n_player_weeks, calls.projection_backed, calls.complete, calls.unbacked — always;
 *   error.mean, error.mae, <layer>.mean, <layer>.mae — once n ≥ min_n;
 *   <POS>.n, <POS>.error.mae, <POS>.<layer>.mae (POSITION_LAYERS) — positions with n ≥ min_n;
 *   matchup_lift.n, weather_lift.n — always; .mean once its n ≥ min_n;
 *   calls.<i>.error, calls.<i>.<layer>, calls.<i>.complete (1/0) — per projection-backed call of
 *   the scored week (i = its index in `calls[]`), for the first MAX_WIRE_CALLS of them. A single
 *   call's decomposition is a fact about that call, so it is never gated on n.
 */
export function attributionMap(
  rows: readonly PlayerWeekAttribution[],
  calls: readonly CallAttribution[],
  minN: number,
): AttributionAggregate {
  const map: Record<string, number> = {};
  const caveats: string[] = [];
  const n = rows.length;
  const backed = calls.filter((c) => c.projection_backed);
  map.n_player_weeks = n;
  map["calls.projection_backed"] = backed.length;
  map["calls.complete"] = backed.filter((c) => c.complete).length;
  map["calls.unbacked"] = calls.filter(
    (c) => !c.projection_backed && c.subjects_weighted > 0,
  ).length;
  const meanOf = (xs: readonly number[]): number => stableMean(xs) ?? 0;
  const maeOf = (xs: readonly number[]): number => meanOf(xs.map((x) => Math.abs(x)));
  if (n >= minN) {
    map["error.mean"] = round3(meanOf(rows.map((r) => r.error)));
    map["error.mae"] = round3(maeOf(rows.map((r) => r.error)));
    for (const l of ATTRIBUTION_LAYERS) {
      const xs = rows.map((r) => r.layers[l]);
      map[`${l}.mean`] = round3(meanOf(xs));
      map[`${l}.mae`] = round3(maeOf(xs));
    }
    const byPos = new Map<string, PlayerWeekAttribution[]>();
    for (const r of rows) byPos.set(r.position, [...(byPos.get(r.position) ?? []), r]);
    for (const [pos, list] of [...byPos.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (list.length < minN) continue;
      map[`${pos}.n`] = list.length;
      map[`${pos}.error.mae`] = round3(maeOf(list.map((r) => r.error)));
      for (const l of POSITION_LAYERS)
        map[`${pos}.${l}.mae`] = round3(maeOf(list.map((r) => r.layers[l])));
    }
  } else caveats.push(`attribution: ${nTooSmall(n, minN)}`);
  for (const [key, pick] of [
    ["matchup_lift", (r: PlayerWeekAttribution) => r.matchup_lift],
    ["weather_lift", (r: PlayerWeekAttribution) => r.weather_lift],
  ] as const) {
    const xs = rows.flatMap((r) => {
      const v = pick(r);
      return v === null ? [] : [v];
    });
    map[`${key}.n`] = xs.length;
    if (xs.length >= minN) map[`${key}.mean`] = round3(meanOf(xs));
  }
  for (const c of backed.slice(0, MAX_WIRE_CALLS)) {
    if (c.error === null || c.layers === null) continue;
    map[`calls.${String(c.index)}.error`] = round3(c.error);
    for (const l of ATTRIBUTION_LAYERS) map[`calls.${String(c.index)}.${l}`] = round3(c.layers[l]);
    map[`calls.${String(c.index)}.complete`] = c.complete ? 1 : 0;
  }
  if (backed.length > MAX_WIRE_CALLS)
    caveats.push(
      `attribution: per-call keys cover the first ${String(MAX_WIRE_CALLS)} of ${String(backed.length)} projection-backed calls`,
    );
  return { map, caveats, n };
}
