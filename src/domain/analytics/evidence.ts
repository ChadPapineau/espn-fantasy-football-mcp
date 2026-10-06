// evidence.ts — E10 `espn_analyze_evidence`, the deterministic P1 part (plan 07 E10; plan 10 B8;
// research 05 §6 rules 1–5; sib research 05 §10.1–§10.4): every text item (ESPN's outlooks, RSS
// headlines, the user's pasted claim, the official report) is structured by the `rules_v1` claim
// extractor into {type, direction} and weighted by a HAND-SET reliability row per source class ×
// claim type (`calibration_state.note: "priors are hand-set"` on every result; `posterior: null`
// until the calibrated table — P2); `seasonOutlook` decays to zero by week 4 unless `lastNewsDate`
// moved (rule 2); STRUCTURED FIELDS WIN (rule 3): `injuryStatus`, the IR slot, the lineup lock,
// `waiverProcessDate` and the usage numbers are compared with the claims and a disagreement is
// flagged in both directions (narrative > numbers → `unconfirmed_narrative`; numbers > narrative →
// `quiet_role_change`; a structured availability field contradicted → `availability_conflict`);
// league-member strings are never inputs (rule 4); and the recommendation is computed from the
// structured fields and the usage only, so it is INVARIANT to the text except for the flag (rule
// 5). Text is data with a reliability score; it is never an instruction (plan 02 §6.4). Pure. New.
import type { Clock } from "../clock.js";
import {
  flagFold,
  INJECTION_FLAGS,
  sanitizeText,
  TEXT_CAPS,
  UNTRUSTED_SOURCE_CLASS,
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
import { slotClassOf } from "../league/slots.js";
import { isIrEligible } from "../league/types.js";
import { P_ACTIVE_BY_STATUS } from "./constants.js";
import { ensure } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { EVIDENCE, RELIABILITY } from "./marketConstants.js";
import { meanOf, round, zeroDist } from "./math.js";
import type { UsageWeek } from "./usageSignals.js";
import {
  EVIDENCE_POSTERIOR_MIN_N,
  type Assumption,
  type EvidenceData,
  type InputFreshness,
  type Rec,
} from "./types.js";

// --- rules_v1: the deterministic claim extractor ----------------------------------------------------

type ClaimType = ClaimExtract["type"];

const RE = {
  availabilityUp:
    /\b(cleared to (play|return)|cleared|will play|expected to play|set to play|active for|available|returns? to (practice|action)|returned to (practice|action)|activated|good to go|no injury designation|out of ir)\b/,
  availabilityDown:
    /\b(ruled out|will not play|won'?t play|inactive|doubtful|questionable|game[- ]time decision|injured reserve|placed on ir|season[- ]ending|out indefinitely|suspended|will miss|to miss|miss (the|this|next)|sidelined)\b|\bout\b(?! of\b)/,
  transaction:
    /\b(signed|re-?signed|released|waived|traded|acquired|claimed off waivers|elevated|promoted from the practice squad|designated to return)\b/,
  health:
    /\b(mri|x-?rays?|sprain(ed)?|strain(ed)?|hamstring|ankle|knee|concussion|fracture(d)?|broken|torn|surgery|limited|full (practice|participant|participation)|did not practice|did not participate|dnp|setback|soreness|illness|rehab)\b/,
  role: /\b(start(s|ing|er)?|lead back|bell-?cow|workload|snaps?|featured|feature back|demoted|benched|depth chart|committee|rb1|wr1|te1|qb1|target share|more work|bigger role|expanded role|reduced role|first-team|second-team|backup|touches|carries|targets)\b/,
  coaching: /\b(coach(es)?|coordinator|expects|plans to|hopes to|intends to|wants to)\b/,
  up: /\b(cleared|will play|expected to play|set to play|available|returns?|returned|activated|good to go|full (practice|participant|participation)|start(s|ing|er)?|promoted|more work|bigger role|expanded role|featured|lead back|bell-?cow|first-team|signed|upgraded|increase(d)?|out of ir)\b/,
  down: /\b(ruled out|will not play|won'?t play|inactive|doubtful|injured reserve|placed on|setback|surgery|torn|fracture(d)?|limited|did not practice|did not participate|dnp|demoted|benched|reduced role|backup|released|waived|suspended|season[- ]ending|downgraded|decrease(d)?|miss(es)?|sidelined)\b|\bout\b(?! of\b)/,
  practiceFull: /\bfull (practice|participant|participation)\b|\bpracticed fully\b/,
  practiceLimited: /\blimited\b/,
  practiceDnp: /\b(did not practice|did not participate|dnp|sat out practice)\b/,
  irMove: /\b(move (him )?(to|into) (the )?ir|put (him )?on ir|stash (him )?(in|on) ir)\b/,
  lockTiming:
    /\b(before (the |thursday'?s |sunday'?s |monday'?s )?(lock|kickoff)|still time to (start|swap|move|bench))\b/,
  noWaivers:
    /\b(free agent now|available now|no waivers|skip(s)? waivers|already cleared waivers)\b/,
} as const;

const count = (re: RegExp, s: string): number => {
  const g = new RegExp(re.source, "g");
  return [...s.matchAll(g)].length;
};

/**
 * `rules_v1`: the claim type (availability before transaction, health, role and coaching intent;
 * `other` when nothing matches) and its direction (up/down keyword counts; a tie is neutral) on the
 * sanitised, folded text. Deterministic; the text is only matched, never executed.
 */
export function extractClaim(text: string): ClaimExtract {
  const s = flagFold(sanitizeText(text, TEXT_CAPS.player_outlook).value);
  let type: ClaimType = "other";
  if (RE.availabilityUp.test(s) || RE.availabilityDown.test(s)) type = "availability";
  else if (RE.transaction.test(s)) type = "transaction";
  else if (RE.health.test(s)) type = "health";
  else if (RE.role.test(s)) type = "role";
  else if (RE.coaching.test(s)) type = "coaching_intent";
  const up = count(RE.up, s);
  const down = count(RE.down, s);
  const direction = up > down ? "up" : down > up ? "down" : "neutral";
  return { type, direction, extractor: "rules_v1" };
}

// --- E10 ----------------------------------------------------------------------------------------------

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
  /** Scored claims in the calibration table (P2 feeds it); default 0. */
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

function reliabilityClass(source: UntrustedSource): keyof typeof RELIABILITY {
  if (source.startsWith("nflverse.injuries")) return "official";
  if (source.startsWith("espn.player")) return "espn_outlook";
  if (source.startsWith("rss.")) return "news";
  return "user";
}

interface Item {
  readonly source: UntrustedSource;
  readonly claim: UntrustedText;
  readonly extract: ClaimExtract;
  readonly folded: string;
  readonly time: IsoInstant | null;
  readonly official: boolean;
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

  // structure every text (the user's claim wrapped here; the official report as official evidence)
  const items: Item[] = [];
  let ignored = 0;
  for (const t of req.texts) {
    const src = t.text.untrusted_text.source;
    // league-member strings never enter the reliability model (rule 4)
    if (!isEvidenceSource(src)) {
      ignored += 1;
      continue;
    }
    items.push({
      source: src,
      claim: t.text,
      extract: extractClaim(t.text.untrusted_text.value),
      folded: flagFold(t.text.untrusted_text.value),
      time: t.time,
      official: false,
    });
  }
  if (ignored > 0)
    warnings.push(
      `${String(ignored)} text item(s) from a non-claim source ignored (league-member text is display-only)`,
    );
  const userClaim = req.claim ?? null;
  if (userClaim !== null) {
    const wrapped = wrapUntrusted(userClaim.text, "user.claim.text");
    const ex = extractClaim(wrapped.untrusted_text.value);
    items.push({
      source: "user.claim.text",
      claim: wrapped,
      extract: userClaim.type === undefined ? ex : { ...ex, type: userClaim.type },
      folded: flagFold(wrapped.untrusted_text.value),
      time: userClaim.time ?? null,
      official: false,
    });
  }
  const off = req.official ?? null;
  const lastPractice = off?.practice[off.practice.length - 1] ?? null;
  if (off !== null && off.report_status !== null) {
    const w = wrapUntrusted(off.report_status, "nflverse.injuries.report_status");
    items.push({
      source: "nflverse.injuries.report_status",
      claim: w,
      extract: { ...extractClaim(w.untrusted_text.value), type: "availability" },
      folded: flagFold(w.untrusted_text.value),
      time: off.as_of,
      official: true,
    });
  }
  if (off !== null && lastPractice !== null) {
    const w = wrapUntrusted(
      `${lastPractice.day}: ${lastPractice.status}`,
      "nflverse.injuries.practice_status",
    );
    items.push({
      source: "nflverse.injuries.practice_status",
      claim: w,
      extract: { ...extractClaim(w.untrusted_text.value), type: "health" },
      folded: flagFold(w.untrusted_text.value),
      time: off.as_of,
      official: true,
    });
  }

  // the structured facts
  const status = p.injury_status;
  const offOut =
    off?.report_status !== null &&
    off?.report_status !== undefined &&
    /\bout\b/i.test(off.report_status);
  const unavailable = (status !== null && UNAVAILABLE.has(status)) || offOut;
  const available = !unavailable && (status === null || status === "ACTIVE");
  const officialPractice = lastPractice === null ? null : flagFold(lastPractice.status);
  const move = usageMove(req.usage ?? []);
  const roleUp =
    (move.snap !== null && move.snap >= EVIDENCE.roleConfirmSnap) ||
    (move.share !== null && move.share >= EVIDENCE.roleConfirmShare);
  const roleDown =
    (move.snap !== null && move.snap <= -EVIDENCE.roleConfirmSnap) ||
    (move.share !== null && move.share <= -EVIDENCE.roleConfirmShare);
  const inIr = p.slot_id !== null && slotClassOf(p.slot_id) === "ir";

  // comparisons: structured fields win (rule 3); the first, most important disagreement is named
  type Disagree = NonNullable<EvidenceData["structured_disagrees"]>;
  const found: Disagree[] = [];
  const claimsOnly = items.filter((i) => !i.official);
  for (const it of claimsOnly) {
    const s = it.folded;
    const e = it.extract;
    if (e.type === "availability" && e.direction === "up" && unavailable)
      found.push({
        field: "injury_status",
        structured_value: status ?? "OUT (official report)",
        claim_value: "available",
      });
    if (e.type === "availability" && e.direction === "down" && available)
      found.push({
        field: "injury_status",
        structured_value: status ?? "ACTIVE",
        claim_value: "unavailable",
      });
    if (officialPractice !== null) {
      const offDnp = RE.practiceDnp.test(officialPractice);
      const offFull = RE.practiceFull.test(officialPractice) || /\bfull\b/.test(officialPractice);
      if ((RE.practiceLimited.test(s) || RE.practiceFull.test(s)) && offDnp)
        found.push({
          field: "injury_status",
          structured_value: "official practice: did not participate",
          claim_value: RE.practiceFull.test(s) ? "full practice" : "limited practice",
        });
      else if (RE.practiceDnp.test(s) && offFull)
        found.push({
          field: "injury_status",
          structured_value: "official practice: full",
          claim_value: "did not practice",
        });
    }
    if (RE.irMove.test(s) && !isIrEligible(status) && !inIr)
      found.push({
        field: "lineup_slot",
        structured_value: `not IR-eligible (${status ?? "no designation"})`,
        claim_value: "IR move",
      });
    if (RE.lockTiming.test(s) && p.lineup_locked === true)
      found.push({ field: "lineup_locked", structured_value: true, claim_value: false });
    if (
      RE.noWaivers.test(s) &&
      p.waiver_process_date !== null &&
      Date.parse(p.waiver_process_date) > nowMs
    )
      found.push({
        field: "waiver_process_date",
        structured_value: p.waiver_process_date,
        claim_value: "free agent now",
      });
    if (e.type === "role" && e.direction === "up" && !roleUp && (req.usage ?? []).length > 0)
      found.push({
        field: "stats",
        structured_value: move.latestSnap ?? 0,
        claim_value: "role up",
      });
    if (e.type === "role" && e.direction === "down" && roleUp)
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
  const roleClaims = claimsOnly.filter(
    (i) => i.extract.type === "role" || i.extract.type === "availability",
  );
  const typed = claimsOnly.filter((i) => i.extract.type !== "other");
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

  // the evidence list with hand-set reliabilities and the season-outlook decay (rule 2)
  const newsMoved =
    p.last_news_at !== null && nowMs - Date.parse(p.last_news_at) <= EVIDENCE.newsFreshMs;
  const evidence: EvidenceData["evidence"] = items.slice(0, EVIDENCE.maxEvidence).map((it) => {
    const cls = reliabilityClass(it.source);
    const base = RELIABILITY[cls]?.[it.extract.type] ?? 0;
    let decayed = false;
    let weight = 1;
    if (it.source === "espn.player.season_outlook" && !newsMoved) {
      const d = EVIDENCE.seasonOutlookDecayWeek;
      weight = Math.max(0, 1 - Math.max(0, req.week - 1) / Math.max(1, d - 1));
      decayed = req.week >= d;
    }
    return {
      source: it.source,
      claim: it.claim,
      type: it.extract.type,
      direction: it.extract.direction,
      reliability: round(base * weight, 3),
      time: it.time,
      official: it.official,
      decayed,
    };
  });
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
  const n = req.calibration_n ?? 0;

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
      posterior: null,
      what_would_confirm: confirm,
      consequence: { affects, re_run: reRun },
      calibration_state: { table_n: n, note: "priors are hand-set" },
      rec,
      inputs,
    },
    warnings,
  };
}

/** Whether a source tag is one E10 reads as a claim (never a league-member string — rule 4). */
export function isEvidenceSource(source: UntrustedSource): boolean {
  const cls = UNTRUSTED_SOURCE_CLASS[source];
  return (
    cls === "player_outlook" ||
    cls === "news_title" ||
    cls === "news_blurb" ||
    cls === "claim_text" ||
    source.startsWith("nflverse.injuries")
  );
}
