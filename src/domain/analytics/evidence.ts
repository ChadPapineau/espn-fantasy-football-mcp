// evidence.ts — E10 `espn_analyze_evidence`, the deterministic P1 engine (plan 07 E10; plan 10 B8;
// research 05 §6 rules 1–5; sib research 05 §10.1–§10.4). It composes the evidence domain
// (src/domain/evidence: the `rules_v1` claim extractor, the hand-set source reliabilities with the
// season-outlook decay and the injection cap, the class-based `injury_status` comparator and
// `calibration_state`) into the E10 result: every text item (ESPN's outlooks, RSS headlines, the
// user's pasted claim) becomes a typed claim with its reliability; the official report is official
// evidence; STRUCTURED FIELDS WIN (rule 3) — the injury status (and the official report), the
// official practice participation, the IR slot, the lineup lock, `waiverProcessDate` and the usage
// numbers are compared with the claims and a disagreement is flagged in both directions (narrative >
// numbers → `unconfirmed_narrative`; numbers > narrative → `quiet_role_change`; a structured
// availability field contradicted → `availability_conflict`); league-member strings never enter
// (rule 4); `posterior: null` until the calibrated table (P2); and the recommendation is computed
// from the structured fields and the usage only, so it is INVARIANT to the text except for the flag
// (rule 5). Text is data with a reliability score; it is never an instruction (plan 02 §6.4). Pure.
import type { Clock } from "../clock.js";
import {
  calibrationState,
  claimFold,
  extractClaim,
  reliabilityOf,
  reliabilitySourceOf,
  structuredDisagreement,
  type Designation,
  type RulesV1Claim,
} from "../evidence/index.js";
import { slotClassOf } from "../league/slots.js";
import {
  INJECTION_FLAGS,
  isIrEligible,
  wrapUntrusted,
  type BareText,
  type ClaimExtract,
  type InjectionFlag,
  type InjuryStatus,
  type IsoInstant,
  type UntrustedSource,
  type UntrustedText,
  type Week,
} from "../league/types.js";
import { P_ACTIVE_BY_STATUS } from "./constants.js";
import { ensure } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { EVIDENCE, OFFICIAL_RELIABILITY } from "./marketConstants.js";
import { meanOf, round, zeroDist } from "./math.js";
import type { UsageWeek } from "./usageSignals.js";
import {
  EVIDENCE_POSTERIOR_MIN_N,
  type Assumption,
  type EvidenceData,
  type InputFreshness,
  type Rec,
} from "./types.js";

type ClaimType = ClaimExtract["type"];

/** Structured-field checks that are not claim types (the comparator's own patterns, on folded text). */
const CHECK = {
  irMove: /\b(move (him )?(to|into) (the )?ir|put (him )?on ir|stash (him )?(in|on) ir)\b/,
  lockTiming:
    /\b(before (the |thursday'?s |sunday'?s |monday'?s )?(lock|kickoff)|still time to (start|swap|move|bench))\b/,
  noWaivers: /\b(free agent now|available now|no waivers|skips? waivers|already cleared waivers)\b/,
} as const;

/** One already-wrapped text item and when it was published. */
export interface EvidenceText {
  readonly text: UntrustedText;
  readonly time: IsoInstant | null;
}

/** The player's structured fields (the facts every claim is compared with). */
export interface EvidencePlayer {
  readonly player_id: number | null;
  readonly gsis_id: string | null;
  readonly name: BareText;
  readonly position: string;
  readonly injury_status: InjuryStatus | null;
  readonly roster: "mine" | "rival" | "none";
  /** His lineup slot when rostered. */
  readonly slot_id: number | null;
  readonly lineup_locked: boolean | null;
  readonly waiver_process_date: IsoInstant | null;
  readonly last_news_at: IsoInstant | null;
}

/** An E10 request. */
export interface EvidenceRequest {
  readonly player: EvidencePlayer;
  /** The official report (nflverse injuries): structured, `official: true`. */
  readonly official?: {
    readonly report_status: string | null;
    readonly practice: readonly { readonly day: string; readonly status: string }[];
    readonly as_of: IsoInstant;
  } | null;
  /** Recent usage (D1), oldest first or any order. */
  readonly usage?: readonly UsageWeek[] | null;
  /** ESPN outlooks and RSS items, already wrapped with their source tags. */
  readonly texts: readonly EvidenceText[];
  /** The user's pasted claim (raw; wrapped here as `user.claim.text`). */
  readonly claim?: {
    readonly text: string;
    readonly source?: string;
    readonly time?: IsoInstant;
    readonly type?: ClaimType;
  } | null;
  /** Scored claims in the calibration table (P2 feeds it; Phase 2 always 0). */
  readonly calibration_n?: number;
  readonly week: Week;
  readonly clock: Clock;
  readonly inputs?: readonly InputFreshness[];
}

/** E10's outcome. */
export interface EvidenceOutcome {
  readonly data: EvidenceData;
  readonly warnings: readonly string[];
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });
const UNAVAILABLE: ReadonlySet<string> = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]);

/** The official report's own labels (nflverse enums, not free text) as designations. */
function officialDesignation(label: string): Designation | null {
  const s = claimFold(label);
  if (/\b(did not participate|did not practice|dnp)\b/.test(s)) return "practice_dnp";
  if (/\blimited\b/.test(s)) return "practice_limited";
  if (/\bfull\b/.test(s)) return "practice_full";
  if (/\bout\b/.test(s)) return "out";
  if (/\bdoubtful\b/.test(s)) return "doubtful";
  if (/\bquestionable\b/.test(s)) return "questionable";
  return null;
}

/** Whether a source tag is one E10 reads as a claim (never a league-member string — rule 4). */
export function isEvidenceSource(source: UntrustedSource): boolean {
  return reliabilitySourceOf(source) !== null;
}

interface Item {
  readonly source: UntrustedSource;
  readonly claim: UntrustedText;
  /** The extract (null = no claim → type `other`). */
  readonly extract: RulesV1Claim | null;
  readonly type: ClaimType;
  readonly direction: ClaimExtract["direction"];
  readonly folded: string;
  readonly time: IsoInstant | null;
  readonly official: boolean;
  readonly reliability: number;
  readonly decayed: boolean;
}

/** The usage move: the latest game against the mean of up to four before it. */
function usageMove(usage: readonly UsageWeek[]): {
  readonly snap: number | null;
  readonly share: number | null;
  readonly latestSnap: number | null;
} {
  const g = [...usage].sort((a, b) => a.week - b.week);
  const last = g[g.length - 1];
  if (last === undefined || g.length < 2)
    return { snap: null, share: null, latestSnap: last?.snap_pct ?? null };
  const prev = g.slice(-5, -1);
  const d = (pick: (u: UsageWeek) => number | null): number | null => {
    const now = pick(last);
    const base = prev.map(pick).filter((x): x is number => x !== null && Number.isFinite(x));
    return now === null || base.length === 0 ? null : now - meanOf(base);
  };
  const t = d((u) => u.target_share);
  const r = d((u) => u.rz_share);
  const share = t === null ? r : r === null ? t : Math.abs(t) >= Math.abs(r) ? t : r;
  return { snap: d((u) => u.snap_pct), share, latestSnap: last.snap_pct };
}

/** E10. Never acts on a text; throws only on a malformed request. */
export function analyzeEvidence(req: EvidenceRequest): EvidenceOutcome {
  ensure(
    Number.isInteger(req.week) && req.week >= 0 && req.week <= 25,
    "week out of range",
    "week",
  );
  ensure(req.texts.length <= 200, "too many texts", "player");
  const nowMs = req.clock.nowMs();
  const p = req.player;
  const warnings: string[] = [];
  const newsMoved =
    p.last_news_at !== null && nowMs - Date.parse(p.last_news_at) <= EVIDENCE.newsFreshMs;

  // structure every text claim (rule 1), weighted by the hand-set table (rule 2), never league text (rule 4)
  const items: Item[] = [];
  const addText = (
    wrapped: UntrustedText,
    time: IsoInstant | null,
    typeOverride?: ClaimType,
  ): boolean => {
    const src = wrapped.untrusted_text.source;
    const rs = reliabilitySourceOf(src);
    if (rs === null) return false;
    const ex = extractClaim(wrapped.untrusted_text.value);
    const type = typeOverride ?? ex?.type ?? "other";
    const rel = reliabilityOf(rs, type, {
      flags: wrapped.untrusted_text.flags ?? [],
      week: req.week,
      news_moved: newsMoved,
    });
    items.push({
      source: src,
      claim: wrapped,
      extract: ex,
      type,
      direction: ex?.direction ?? "neutral",
      folded: claimFold(wrapped.untrusted_text.value),
      time,
      official: false,
      reliability: rel.reliability ?? 0,
      decayed: rel.decayed,
    });
    return true;
  };
  let ignored = 0;
  for (const t of req.texts) if (!addText(t.text, t.time)) ignored += 1;
  if (ignored > 0)
    warnings.push(
      `${String(ignored)} text item(s) from a non-claim source ignored (league-member text is display-only)`,
    );
  const userClaim = req.claim ?? null;
  if (userClaim !== null)
    addText(
      wrapUntrusted(userClaim.text, "user.claim.text"),
      userClaim.time ?? null,
      userClaim.type,
    );

  // the official report: structured, official evidence (its labels are nflverse enums)
  const off = req.official ?? null;
  const lastPractice = off?.practice[off.practice.length - 1] ?? null;
  const addOfficial = (
    raw: string,
    source: "nflverse.injuries.report_status" | "nflverse.injuries.practice_status",
    type: "availability" | "health",
  ): Designation | null => {
    const wrapped = wrapUntrusted(raw, source);
    const d = officialDesignation(wrapped.untrusted_text.value);
    const down =
      d === "out" || d === "doubtful" || d === "practice_dnp" || d === "practice_limited";
    items.push({
      source,
      claim: wrapped,
      extract: null,
      type,
      direction: d === null ? "neutral" : down ? "down" : d === "practice_full" ? "up" : "neutral",
      folded: claimFold(wrapped.untrusted_text.value),
      time: off?.as_of ?? null,
      official: true,
      reliability: OFFICIAL_RELIABILITY[type],
      decayed: false,
    });
    return d;
  };
  const offStatus =
    off !== null && off.report_status !== null
      ? addOfficial(off.report_status, "nflverse.injuries.report_status", "availability")
      : null;
  const offPractice =
    off !== null && lastPractice !== null
      ? addOfficial(
          `${lastPractice.day}: ${lastPractice.status}`,
          "nflverse.injuries.practice_status",
          "health",
        )
      : null;

  // the structured facts
  const status = p.injury_status;
  const offOut = offStatus === "out";
  const unavailable = (status !== null && UNAVAILABLE.has(status)) || offOut;
  const move = usageMove(req.usage ?? []);
  const roleUp =
    (move.snap !== null && move.snap >= EVIDENCE.roleConfirmSnap) ||
    (move.share !== null && move.share >= EVIDENCE.roleConfirmShare);
  const roleDown =
    (move.snap !== null && move.snap <= -EVIDENCE.roleConfirmSnap) ||
    (move.share !== null && move.share <= -EVIDENCE.roleConfirmShare);
  const inIr = p.slot_id !== null && slotClassOf(p.slot_id) === "ir";

  // comparisons: structured fields win (rule 3); the most important disagreement is named
  type Disagree = NonNullable<EvidenceData["structured_disagrees"]>;
  const found: Disagree[] = [];
  const claimsOnly = items.filter((i) => !i.official);
  const facts = { injury_status: status ?? (offOut ? "OUT" : null) };
  for (const it of claimsOnly) {
    const s = it.folded;
    const d = structuredDisagreement(it.extract, facts);
    if (d !== null)
      found.push({
        field: "injury_status",
        structured_value:
          status === null ? `${d.structured_value} (official report)` : d.structured_value,
        claim_value: d.claim_value,
      });
    const cd = it.extract?.designation ?? null;
    if ((cd === "practice_limited" || cd === "practice_full") && offPractice === "practice_dnp")
      found.push({
        field: "injury_status",
        structured_value: "official practice: did not participate",
        claim_value: cd,
      });
    else if (cd === "practice_dnp" && offPractice === "practice_full")
      found.push({
        field: "injury_status",
        structured_value: "official practice: full",
        claim_value: cd,
      });
    if (CHECK.irMove.test(s) && !isIrEligible(status) && !inIr)
      found.push({
        field: "lineup_slot",
        structured_value: `not IR-eligible (${status ?? "no designation"})`,
        claim_value: "IR move",
      });
    if (CHECK.lockTiming.test(s) && p.lineup_locked === true)
      found.push({ field: "lineup_locked", structured_value: true, claim_value: false });
    if (
      CHECK.noWaivers.test(s) &&
      p.waiver_process_date !== null &&
      Date.parse(p.waiver_process_date) > nowMs
    )
      found.push({
        field: "waiver_process_date",
        structured_value: p.waiver_process_date,
        claim_value: "free agent now",
      });
    if (it.type === "role" && it.direction === "up" && !roleUp && (req.usage ?? []).length > 0)
      found.push({
        field: "stats",
        structured_value: move.latestSnap ?? 0,
        claim_value: "role up",
      });
    if (it.type === "role" && it.direction === "down" && roleUp)
      found.push({
        field: "stats",
        structured_value: move.latestSnap ?? 0,
        claim_value: "role down",
      });
  }
  const order: Disagree["field"][] = [
    "injury_status",
    "lineup_slot",
    "lineup_locked",
    "waiver_process_date",
    "stats",
  ];
  found.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));
  const disagree = found[0] ?? null;
  const roleClaims = claimsOnly.filter((i) => i.type === "role" || i.type === "availability");
  const typed = claimsOnly.filter((i) => i.type !== "other");
  const flag: EvidenceData["flag"] =
    disagree !== null && disagree.field !== "stats"
      ? "availability_conflict"
      : disagree !== null
        ? "unconfirmed_narrative"
        : (roleUp || roleDown) && roleClaims.length === 0
          ? "quiet_role_change"
          : typed.length > 0
            ? "consistent"
            : "no_claim";

  const evidence: EvidenceData["evidence"] = items.slice(0, EVIDENCE.maxEvidence).map((it) => ({
    source: it.source,
    claim: it.claim,
    type: it.type,
    direction: it.direction,
    reliability: round(it.reliability, 3),
    time: it.time,
    official: it.official,
    decayed: it.decayed,
  }));
  if (items.length > EVIDENCE.maxEvidence)
    warnings.push(`${String(items.length - EVIDENCE.maxEvidence)} evidence items not listed (cap)`);

  // injection flags across every wrapped text (shown, never obeyed)
  const seen = new Set<InjectionFlag>();
  for (const it of items) for (const f of it.claim.untrusted_text.flags ?? []) seen.add(f);
  const injection_flags = INJECTION_FLAGS.filter((f) => seen.has(f));

  const pActive =
    status === null
      ? 1
      : Object.hasOwn(P_ACTIVE_BY_STATUS, status)
        ? (P_ACTIVE_BY_STATUS[status] ?? null)
        : null;
  const lastUsage = [...(req.usage ?? [])].sort((a, b) => a.week - b.week).at(-1) ?? null;
  const shares: Record<string, number> = {};
  if (lastUsage !== null) {
    if (lastUsage.snap_pct !== null) shares.snap_pct = round(lastUsage.snap_pct, 3);
    if (lastUsage.target_share !== null) shares.target_share = round(lastUsage.target_share, 3);
    if (lastUsage.rz_share !== null) shares.rz_share = round(lastUsage.rz_share, 3);
  }
  const prior = {
    p_active: pActive === null ? null : round(pActive, 3),
    role_shares: Object.keys(shares).length > 0 ? shares : null,
  };

  const confirm: string[] = [];
  if (flag === "availability_conflict")
    confirm.push(
      "ESPN's injuryStatus or the official game status changes",
      "the inactives list about 90 minutes before kickoff",
    );
  else if (flag === "unconfirmed_narrative")
    confirm.push(
      `a snap share at or above ${String(round((move.latestSnap ?? 0) + EVIDENCE.roleConfirmSnap, 2))} next game`,
      "an opportunity-share rise held two games",
    );
  else if (flag === "quiet_role_change")
    confirm.push("the depth chart's next update", "the role holding a second game");
  else confirm.push("the next official injury report");

  const affects: EvidenceData["consequence"]["affects"] =
    p.roster === "mine" ? ["lineup", "trade"] : p.roster === "rival" ? ["trade"] : ["waivers"];
  const reRun = affects.map((a) =>
    a === "lineup"
      ? "espn_analyze_lineup"
      : a === "trade"
        ? "espn_analyze_trade"
        : "espn_analyze_waivers",
  );

  // the recommendation: structured fields and usage only — invariant to every text (rule 5)
  const structuredAction =
    roleUp && p.roster === "none"
      ? "usage rose without a structured change: re-run espn_analyze_waivers"
      : unavailable
        ? `follow the structured status (${status ?? "OUT"}): no move on any text`
        : "no move: structured fields win over text";
  const inputs = [...(req.inputs ?? [])];
  const rec: Rec = {
    action: structuredAction,
    subjects: [],
    lineup: null,
    point_estimate: 0,
    distribution: zeroDist("position_cv"),
    delta_vs_next: { value: 0, p10: 0, p90: 0 },
    decision_metric: "structured_fields",
    drivers: [],
    assumptions: [
      A(
        "structured fields win: no text changes this recommendation",
        "never (research 05 §6 rule 3)",
      ),
      A(
        "source reliabilities are hand-set priors",
        `the calibration table reaches ${String(EVIDENCE_POSTERIOR_MIN_N)} scored claims`,
      ),
    ],
    confidence: { role_games: (req.usage ?? []).length, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: null,
    no_move: true,
    log_id: null,
  };
  return {
    data: {
      flag,
      structured_disagrees: disagree,
      injection_flags,
      prior: prior.p_active === null && prior.role_shares === null ? null : prior,
      evidence,
      // the merge is P2 (sib ADV OBJ-21): never shown before the calibrated table exists
      posterior: null,
      what_would_confirm: confirm,
      consequence: { affects, re_run: reRun },
      calibration_state: calibrationState(req.calibration_n ?? 0),
      rec,
      inputs,
    },
    warnings,
  };
}
