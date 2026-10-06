// reliability.ts — the source reliability model behind the claim extractor (research 05 §6 "the
// source and claim type get a calibration table … rather than trust"; sibling research 05 §10.2
// "score the source and the claim type separately … coaching-intent claims start with a low prior";
// plan 07 D6 `reliability_prior`, E10 `evidence[].reliability`, `decayed`, `calibration_state`;
// plan 07 §6 "a calibrated news reliability table at P1 needs ≥ 200 scored claims →
// `calibration_state.note: "priors are hand-set"`; `posterior: null` until then").
//
// Phase 2 ships HAND-SET priors: P(a claim of this type from this source is borne out), a table the
// retrospective (E13, Phase 3) will replace once it has scored EVIDENCE_POSTERIOR_MIN_N claims. Four
// deterministic modifiers, each named so a Skill can explain it: (1) league-member text never
// enters the model (research 05 §6 rule 4: `reliabilitySourceOf` maps those tags to null); (2) the
// preseason `seasonOutlook` decays linearly to zero by week 4 unless `lastNewsDate` moved since the
// season started (rule 2); (3) a text carrying any injection flag is capped at
// INJECTION_RELIABILITY_CAP — it stays structured data, with almost no weight; (4) `other` (no
// recognised claim) has no prior. Structured fields always win over any of these (rule 3,
// structured.ts).
import { EVIDENCE_POSTERIOR_MIN_N } from "../analytics/types.js";
import type { InjectionFlag, UntrustedSource } from "../league/types.js";
import type { ClaimType } from "./claims.js";

/** The text sources the model scores (league-member strings are deliberately absent — rule 4). */
export const RELIABILITY_SOURCES = [
  "rss.rotowire",
  "rss.espn",
  "rss.cbs",
  "espn.player.outlook",
  "espn.player.season_outlook",
  "user.claim",
] as const;
export type ReliabilitySource = (typeof RELIABILITY_SOURCES)[number];

/** The claim types a prior exists for (`other` has none). */
export type ScoredClaimType = Exclude<ClaimType, "other">;

/**
 * The hand-set priors (P(borne out)), per source × claim type. Rationale, so a reviewer can argue
 * with each row: RotoWire and ESPN headlines relay team announcements and insiders (availability,
 * transactions high); CBS a step lower (more aggregation, sibling 04 B10's fallback); ESPN's weekly
 * outlook is editorial and written days ahead (research 05 §6 case 3: "low, cold-start"); the
 * preseason outlook lower still and decaying; a user-pasted claim is the least known source.
 * Coaching intent is the least reliable class everywhere (sibling research 05 §10.2).
 */
// prettier-ignore
export const RELIABILITY_PRIORS: Readonly<Record<ReliabilitySource, Readonly<Record<ScoredClaimType, number>>>> = Object.freeze({
  "rss.rotowire": Object.freeze({ availability: 0.8, health: 0.75, role: 0.6, coaching_intent: 0.35, transaction: 0.9 }),
  "rss.espn": Object.freeze({ availability: 0.8, health: 0.75, role: 0.55, coaching_intent: 0.35, transaction: 0.9 }),
  "rss.cbs": Object.freeze({ availability: 0.75, health: 0.7, role: 0.5, coaching_intent: 0.3, transaction: 0.85 }),
  "espn.player.outlook": Object.freeze({ availability: 0.5, health: 0.55, role: 0.5, coaching_intent: 0.3, transaction: 0.6 }),
  "espn.player.season_outlook": Object.freeze({ availability: 0.4, health: 0.45, role: 0.45, coaching_intent: 0.25, transaction: 0.5 }),
  "user.claim": Object.freeze({ availability: 0.3, health: 0.3, role: 0.25, coaching_intent: 0.2, transaction: 0.35 }),
});

/** The ceiling of a text that carries any injection flag (it stays data, with almost no weight). */
export const INJECTION_RELIABILITY_CAP = 0.05;

/** The week by which a preseason outlook has decayed to zero weight (research 05 §6 rule 2). */
export const SEASON_OUTLOOK_ZERO_WEEK = 4;

/** The provenance tags that map onto a scored source; every other tag (league members!) → null. */
const SOURCE_OF_TAG: Readonly<Partial<Record<UntrustedSource, ReliabilitySource>>> = Object.freeze({
  "rss.rotowire.title": "rss.rotowire",
  "rss.rotowire.blurb": "rss.rotowire",
  "rss.espn.title": "rss.espn",
  "rss.espn.blurb": "rss.espn",
  "rss.cbs.title": "rss.cbs",
  "rss.cbs.blurb": "rss.cbs",
  "espn.player.outlook": "espn.player.outlook",
  "espn.player.season_outlook": "espn.player.season_outlook",
  "user.claim.text": "user.claim",
});

/**
 * The scored source of a provenance tag, or null when the tag never enters the model: team, member,
 * league and division names, trade blocks, board text, URLs, dataset text (research 05 §6 rule 4).
 */
export function reliabilitySourceOf(tag: UntrustedSource): ReliabilitySource | null {
  return Object.prototype.hasOwnProperty.call(SOURCE_OF_TAG, tag)
    ? (SOURCE_OF_TAG[tag] ?? null)
    : null;
}

/** The scored source of a feed key (`rotowire` → `rss.rotowire`). */
export function newsReliabilitySource(feed: "rotowire" | "espn" | "cbs"): ReliabilitySource {
  return `rss.${feed}`;
}

/** What `reliabilityOf` needs besides the source and the type. */
export interface ReliabilityContext {
  /** The text's injection flags (plan 07 C14); any flag caps the reliability. */
  readonly flags?: readonly InjectionFlag[];
  /** The scoring period the claim is weighed in (the season-outlook decay); null = unknown. */
  readonly week?: number | null;
  /** Whether ESPN's `lastNewsDate` moved since the season started (stops the decay). */
  readonly news_moved?: boolean;
}

/** A reliability with the reason it is not the plain prior. */
export interface Reliability {
  /** 0–1, or null when the claim type has no prior (`other`). */
  readonly reliability: number | null;
  /** The plain table value. */
  readonly prior: number | null;
  /** The season-outlook decay applied (E10 `evidence[].decayed`). */
  readonly decayed: boolean;
  /** The injection cap applied. */
  readonly capped: boolean;
}

/** The season-outlook decay factor in [0, 1]: 1 in week ≤ 1, 0 from SEASON_OUTLOOK_ZERO_WEEK. */
export function seasonOutlookWeight(week: number | null | undefined, newsMoved = false): number {
  if (newsMoved || week === null || week === undefined || !Number.isFinite(week)) return 1;
  if (week <= 1) return 1;
  if (week >= SEASON_OUTLOOK_ZERO_WEEK) return 0;
  return round4(1 - (week - 1) / (SEASON_OUTLOOK_ZERO_WEEK - 1));
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** The reliability of one claim (the prior, then the decay, then the injection cap). */
export function reliabilityOf(
  source: ReliabilitySource,
  type: ClaimType,
  ctx: ReliabilityContext = {},
): Reliability {
  if (type === "other") return { reliability: null, prior: null, decayed: false, capped: false };
  const prior = RELIABILITY_PRIORS[source][type];
  let r = prior;
  let decayed = false;
  if (source === "espn.player.season_outlook") {
    const w = seasonOutlookWeight(ctx.week, ctx.news_moved === true);
    if (w < 1) {
      r = round4(r * w);
      decayed = true;
    }
  }
  const capped = (ctx.flags?.length ?? 0) > 0 && r > INJECTION_RELIABILITY_CAP;
  if (capped) r = INJECTION_RELIABILITY_CAP;
  return { reliability: r, prior, decayed, capped };
}

/** The plain prior of a source × type, or null for `other` (plan 07 D6 `reliability_prior`). */
export function reliabilityPrior(source: ReliabilitySource, type: ClaimType): number | null {
  return type === "other" ? null : RELIABILITY_PRIORS[source][type];
}

/** The note every E10 result carries until the table is calibrated (plan 07 §6, plan 10 B8). */
export const HAND_SET_NOTE = "priors are hand-set" as const;

/** E10 `calibration_state`: the scored-claim count, and the note while it is below the threshold. */
export interface CalibrationState {
  readonly table_n: number;
  readonly note: typeof HAND_SET_NOTE | null;
}

/**
 * The calibration state for a scored-claim count (Phase 2: always 0 — no table is fitted yet). The
 * note is present whenever `table_n < EVIDENCE_POSTERIOR_MIN_N`; a negative or non-integer count is
 * treated as 0.
 */
export function calibrationState(tableN = 0): CalibrationState {
  const n = Number.isSafeInteger(tableN) && tableN > 0 ? tableN : 0;
  return { table_n: n, note: n >= EVIDENCE_POSTERIOR_MIN_N ? null : HAND_SET_NOTE };
}

/** Whether E10 may show a posterior (sib ADV OBJ-21: only once the table has ≥ 200 claims). */
export function posteriorAllowed(state: CalibrationState): boolean {
  return state.table_n >= EVIDENCE_POSTERIOR_MIN_N;
}
