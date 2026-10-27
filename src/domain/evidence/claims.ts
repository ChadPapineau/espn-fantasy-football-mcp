// claims.ts — the `rules_v1` claim extractor (plan 07 D6 "a deterministic claim extract", E10; plan
// 02 §6.4 "news feeds analytics only as extracted structured features from deterministic parsers";
// research 05 §6 / sibling research 05 §10.1 — every item is structured into a claim type and a
// direction, text is data with a reliability score and never an instruction; plan 10 B8 — ≥ 0.8
// precision on a hand-labelled set of real items, fixtures/news/labelled/README.md).
//
// What it is: a fixed, ordered table of regular expressions over a folded copy of the text (the
// plan 02 §6.2 sanitiser, then `flagFold`: NFKC, lower case, confusables folded — so "out" spelt
// with a Cyrillic o still reads as "out"). Every hit is a (position, rule); the claim is the EARLIEST
// hit in reading order (a hit starting inside its phrase is the same claim read twice, and the table
// order decides: availability, transaction, health, role, coaching intent — "suffers season-ending
// injury" is availability), the title before the blurb — the labelling convention of the B8 set.
// Rules marked negatable are dropped when a negator stands within two words before them ("not
// expected to play"); a suspension
// is never read as a player's when the text is about game officials. The output is a closed
// vocabulary (type, direction, rule id, designation): no part of the input text ever reaches it, so
// an instruction in a headline cannot travel through the extractor (research 05 §6 rule 5).
// Never a model; bounded work (the text is capped before any regex runs; every pattern is linear).
//
// Availability is read in its everyday wordings too (Stage C finding
// evidence-availability-claims-missed: "is active", "is playing Sunday", "in the lineup", "is a go"
// read as no claim, so an OUT player's "is active for Sunday" never met ESPN's OUT), each with its
// negated mirror ("won't be active", "isn't playing Sunday"). "Is playing" and "active" are read only
// next to the coming game — its day, night or week, an opponent, an injury he plays through, or the
// clause's end — never "is playing well", "active in the passing game" or "the active roster". A
// claim that he STARTS the coming game ("will start Sunday", "gets the start") stays a role claim
// (the B8 labelling convention) and carries what it implies, that he plays: `claimAvailability` is
// what the structured comparator reads (structured.ts), so "will start Sunday" about a player ESPN
// lists OUT names `injury_status`. A start that is not this game's start implies nothing: practice
// ("will start practicing"), a wish or a decision ("hoping to start", "the decision to start"), a
// condition in its clause ("will start if healthy", "once cleared, he will start"); and "will start
// the season on IR" is read as what it is, an IR placement.
import type { ClaimExtract } from "../league/types.js";
import { flagFold, sanitizeText } from "../league/types.js";

/** The claim types (plan 07 D6 `claim.type`; research 05 §6: availability, role, health-detail, …). */
export const CLAIM_TYPES = [
  "availability",
  "role",
  "health",
  "coaching_intent",
  "transaction",
  "other",
] as const satisfies readonly ClaimExtract["type"][];
export type ClaimType = ClaimExtract["type"];

/** The claim directions, from the player's fantasy value (up = plays more, bigger role, signed). */
export const CLAIM_DIRECTIONS = [
  "up",
  "down",
  "neutral",
] as const satisfies readonly ClaimExtract["direction"][];
export type ClaimDirection = ClaimExtract["direction"];

/** The extractor id carried by every extract (plan 07 D6 `extractor: "rules_v1"`). */
export const RULES_V1 = "rules_v1" as const;

/** The structured availability value an availability rule reads (E10 `claim_value`). */
export const DESIGNATIONS = [
  "out",
  "doubtful",
  "questionable",
  "game_time_decision",
  "status_unknown",
  "injured_reserve",
  "pup_nfi",
  "suspended",
  "week_to_week",
  "day_to_day",
  "practice_dnp",
  "practice_limited",
  "practice_full",
  "will_play",
  "cleared",
  "returning",
  "exited",
] as const;
export type Designation = (typeof DESIGNATIONS)[number];

/** The availability classes the structured comparator lines up against ESPN's injury enum. */
export type AvailabilityClass = "plays" | "uncertain" | "out";

const CLASS_OF: Readonly<Record<Designation, AvailabilityClass>> = Object.freeze({
  out: "out",
  doubtful: "out",
  questionable: "uncertain",
  game_time_decision: "uncertain",
  status_unknown: "uncertain",
  injured_reserve: "out",
  pup_nfi: "out",
  suspended: "out",
  week_to_week: "out",
  day_to_day: "uncertain",
  practice_dnp: "uncertain",
  practice_limited: "uncertain",
  practice_full: "plays",
  will_play: "plays",
  cleared: "plays",
  returning: "plays",
  exited: "out",
});

/** Which availability class a designation reads as. */
export function availabilityClass(d: Designation): AvailabilityClass {
  return CLASS_OF[d];
}

interface Rule {
  readonly id: string;
  readonly type: Exclude<ClaimType, "other">;
  readonly direction: ClaimDirection;
  readonly designation: Designation | null;
  readonly re: RegExp;
  /** Dropped when a negator stands within two words before the hit. */
  readonly negatable: boolean;
  /** Dropped when the text is about game officials (a referee's suspension is not a player's). */
  readonly notOfficials: boolean;
  /** Dropped when a condition stands in its clause ("if healthy, he will start"; CONDITIONED_RE). */
  readonly unconditional: boolean;
  /**
   * The availability a claim of this (non-availability) rule implies: a role claim that he starts
   * the coming game says he plays (`will_play`). Null for every other rule — an availability rule
   * states its own `designation`.
   */
  readonly implies: Designation | null;
}

const rule = (
  id: string,
  type: Rule["type"],
  direction: ClaimDirection,
  designation: Designation | null,
  source: string,
  opts: {
    negatable?: boolean;
    notOfficials?: boolean;
    unconditional?: boolean;
    implies?: Designation;
  } = {},
): Rule =>
  Object.freeze({
    id,
    type,
    direction,
    designation,
    re: new RegExp(source, "g"),
    negatable: opts.negatable ?? false,
    notOfficials: opts.notOfficials ?? false,
    unconditional: opts.unconditional ?? false,
    implies: opts.implies ?? null,
  });

const BODY =
  "(?:ankle|high[- ]ankle|knee|hamstring|groin|quad|quadriceps|calf|foot|toe|turf toe|hip|shoulder|elbow|wrist|hand|finger|thumb|back|neck|rib|ribs|chest|pectoral|oblique|achilles|acl|mcl|pcl|meniscus|abdominal|core|heel|shin|forearm|biceps|triceps|lisfranc|head|jaw|eye|illness)";
const INJURY_NOUN =
  "(?:sprain|strain|injury|tear|fracture|bruise|contusion|issue|soreness|tightness|problem|ailment|surgery|dislocation)";

/**
 * The coming game, named by its day, night or week ("Sunday", "tonight", "this week", "Week 7",
 * "on Monday"): what ties "is playing" or "will start" to this game, not to a season ("will start
 * for the Bucs this year") or to practice ("will start practicing").
 */
const GAME_TIME = String.raw`(?:sunday|monday|thursday|saturday|friday|tuesday|wednesday|tonight|today|tomorrow|this week(?:end)?|(?:in )?week \d{1,2}|on (?:sunday|monday|thursday|saturday|friday|tuesday|wednesday))`;
/** The end of a clause: its punctuation, a spaced dash, or the end of the text. */
const CLAUSE_END = String.raw`(?:\s*(?:[.!?;,:)]|$)|\s+-)`;
/** What may follow "is playing" for it to say he plays the coming game (not "is playing well"). */
const PLAYING_GAME = String.raw`(?=${CLAUSE_END}|\s+(?:${GAME_TIME}|against|vs|versus|through|for ${GAME_TIME})\b)`;
/**
 * What may follow "is active" for it to be a game-day active ("active for Sunday", "active despite
 * the ankle", "is active."), never a roster or usage word ("active roster", "active in the passing
 * game", "active-duty").
 */
const ACTIVE_GAME = String.raw`(?=${CLAUSE_END}|\s+(?:${GAME_TIME}|for|against|vs|versus|again|and|but|despite|after|following|as)\b)`;
/** What may follow "will start" / "is starting" for it to be the coming game's start. */
const START_GAME = String.raw`(?=${CLAUSE_END}|\s+(?:${GAME_TIME}|against|vs|versus|again|for ${GAME_TIME}|in place of|in (?:his|the) (?:place|stead|absence)|for (?:the\s+)?(?:injured|sidelined|ailing|banged-up|absent|suspended|inactive)|at (?:quarterback|qb|running back|tailback|rb|wide receiver|receiver|wr|tight end|te|kicker|fullback)\s+(?:${GAME_TIME}|against|vs|versus))\b)`;
/** "Play" as the game, never a role ("expected to play a bigger role", "to play more snaps"). */
const PLAY_NOT_ROLE = String.raw`(?!\s+(?:(?:a|an|the|his)\s+(?:[a-z-]+\s+){0,2}(?:role|part)|more|fewer|less|a lot)\b)`;
/**
 * The words before "to start" that make it a wish, an attempt or a decision rather than his start
 * ("hoping to start", "fighting to start", "the decision to start", "too banged up to start") —
 * read as a lookbehind AFTER the words matched, so it costs nothing where "to start" is absent.
 */
const NOT_HIS_START = String.raw`(?<!\b(?:hopes?|hoping|wants?|wanting|aims?|aiming|try|tries|trying|attempts?|attempting|looking|fighting|battling|competing|pushing|waiting|eager|needs?|time|decision|choice|reason|chance|opportunity|bid)\s+to\s+start|\btoo\s+(?:[a-z'-]+\s+){1,3}to\s+start)`;

/**
 * The rule table, in tie-break order (a hit's position decides first). Patterns read the folded,
 * lower-case text; `'` and `-` are the folded apostrophe and dash.
 */
export const RULES_V1_TABLE: readonly Rule[] = Object.freeze([
  // --- availability: down ---------------------------------------------------------------------------
  rule("availability.ruled_out", "availability", "down", "out", String.raw`\bruled out\b`),
  rule(
    "availability.wont_play",
    "availability",
    "down",
    "out",
    [
      String.raw`\b(?:won't|wont|will not|not expected to|unlikely to|isn't expected to|is not expected to|not going to|doesn't expect to|does not expect to)\s+(?:play|suit up|dress|be available|go|be active${ACTIVE_GAME}|be playing${PLAYING_GAME}|be (?:back\s+)?in (?:the\s+)?lineup)\b`,
      String.raw`\b(?:unlikely|not expected|not likely)\s+(?:for|against|vs)\s+(?:week|sunday|monday|thursday|saturday|tonight|the game)\b`,
      // the mirrors of "is active" / "is playing Sunday" / "in the lineup" (claims.ts header)
      String.raw`\b(?:isn't|is not|not)\s+(?:active${ACTIVE_GAME}|playing${PLAYING_GAME}|in (?:the\s+)?lineup\b)`,
      // "unable to start" is no start (it precedes role.will_start's "to start" in reading order)
      String.raw`\b(?:unable|not able|isn't able|is not able|won't be able|will not be able)\s+to\s+(?:play|suit up|dress|go|start|be active)\b`,
    ].join("|"),
  ),
  rule(
    "availability.will_miss",
    "availability",
    "down",
    "out",
    String.raw`\b(?:will|to|set to|expected to|could|may|might|likely to|going to|poised to|slated to|figures to|should)\s+miss\b`,
  ),
  rule(
    "availability.misses",
    "availability",
    "down",
    "out",
    String.raw`\bmiss(?:es|ed|ing)?\s+(?:week|weeks|game|games|time|the rest|the remainder|the season|sunday|monday|thursday|saturday|multiple|several|extended|significant|the game|next|another)\b(?!-)`,
  ),
  rule(
    "availability.out",
    "availability",
    "down",
    "out",
    String.raw`\b(?:is|was|will be|remains|remain|listed|declared|considered|officially|be|been|being)\s+out\b(?!-|\s+of\b)|\bout\s+(?:indefinitely|again|this week|sunday|monday|thursday|saturday|week \d{1,2})\b|\bout for (?:the\s+)?(?:week|weeks|game|games|sunday|monday|thursday|saturday|the rest|the remainder|several|multiple|an extended|extended|\d{1,2})\b|\bout of (?:the\s+)?lineup\b`,
    { negatable: true },
  ),
  rule(
    "availability.inactive",
    "availability",
    "down",
    "out",
    String.raw`\b(?:inactive|healthy scratch)\b`,
    { negatable: true },
  ),
  rule("availability.sidelined", "availability", "down", "out", String.raw`\bsidelined\b`),
  rule(
    "availability.doubtful",
    "availability",
    "down",
    "doubtful",
    String.raw`\bdoubtful\s+(?:for|to|with|against|ahead|heading|on|sunday|monday|thursday|saturday|week)\b|\b(?:listed as|is|remains|officially|tagged|designated|considered)\s+doubtful\b`,
    { negatable: true },
  ),
  rule(
    "availability.questionable",
    "availability",
    "down",
    "questionable",
    String.raw`\bquestionable\s+(?:for|to|with|against|ahead|heading|on|sunday|monday|thursday|saturday|week)\b|\b(?:listed as|is|remains|officially|tagged|designated|considered)\s+questionable\b`,
    { negatable: true, notOfficials: true },
  ),
  rule(
    "availability.game_time_decision",
    "availability",
    "neutral",
    "game_time_decision",
    String.raw`\bgame[- ]time decision\b`,
  ),
  rule(
    "availability.status_unknown",
    "availability",
    "neutral",
    "status_unknown",
    String.raw`\bstatus (?:is |still |remains |remained )?(?:unknown|unclear|uncertain|in doubt|up in the air|to be determined)\b|\b(?:uncertain|iffy|in doubt)\s+(?:for|to play|to suit)\b`,
  ),
  rule(
    "availability.injured_reserve",
    "availability",
    "down",
    "injured_reserve",
    String.raw`\b(?:placed|place|places|placing|moved|moves|move|sent|put|puts)\s+(?:[a-z.'-]+\s+){0,3}?(?:on|to)\s+(?:the\s+)?(?:injured reserve|ir|reserve/injured)\b|\b(?:landed|lands|land|headed|heads|head|going|goes|reverts|revert|reverted|to)\s+(?:on|to)\s+(?:the\s+)?(?:injured reserve|ir|reserve/injured)\b|\bseason[- ]ending\b|\bout for the (?:season|year)\b|\b(?:starts|start|starting|begins|begin|beginning|opens|open|opening)\s+(?:the\s+(?:season|year)\s+)?on\s+(?:the\s+)?(?:injured reserve|ir|reserve/injured)\b`,
  ),
  rule(
    "availability.pup_nfi",
    "availability",
    "down",
    "pup_nfi",
    String.raw`\b(?:placed|remains|remain|stays|stay|starts|start|begins|begin|opens|open)\s+(?:the\s+(?:season|year)\s+)?on\s+(?:the\s+)?(?:pup|nfi|reserve/pup|reserve/nfi|physically unable to perform)\b`,
  ),
  rule(
    "availability.suspension_lifted",
    "availability",
    "up",
    "returning",
    String.raw`\bsuspension\s+(?:is\s+)?(?:lifted|overturned|rescinded|reduced|ends|ended|is over|over)\b`,
    { notOfficials: true },
  ),
  rule(
    "availability.suspended",
    "availability",
    "down",
    "suspended",
    String.raw`\bsuspen(?:ded|sions?|ds|d)\b`,
    { negatable: true, notOfficials: true },
  ),
  rule(
    "availability.week_to_week",
    "availability",
    "down",
    "week_to_week",
    String.raw`\b(?:week[- ]to[- ]week|month[- ]to[- ]month)\b`,
  ),
  rule(
    "availability.day_to_day",
    "availability",
    "down",
    "day_to_day",
    String.raw`\bday[- ]to[- ]day\b`,
  ),
  rule(
    "availability.practice_dnp",
    "availability",
    "down",
    "practice_dnp",
    String.raw`\b(?:did not|didn't|does not|doesn't|won't|will not|unable to|not)\s+practic(?:e|ed|ing)\b|\bdnp\b|\b(?:held out of|absent from|missed|misses|missing|sat out|sits out)\s+(?:\w+\s+)?practice\b`,
  ),
  rule(
    "availability.practice_limited",
    "availability",
    "down",
    "practice_limited",
    String.raw`\blimited\s+(?:in|at|during)\s+(?:\w+\s+)?practice\b|\blimited (?:participant|participation)\b`,
  ),
  rule(
    "availability.exited",
    "availability",
    "down",
    "exited",
    String.raw`\b(?:exit(?:s|ed)?|carted off|helped off)\b|\b(?:won't|will not|did not|didn't|wouldn't|doesn't|does not)\s+return\b`,
  ),
  rule(
    "availability.chance_down",
    "availability",
    "down",
    "doubtful",
    String.raw`\b(?:slim|outside|small|little|no|low)\s+chance\s+(?:to|of)\s+(?:play|playing|suit|return|returning|be)\b`,
  ),
  rule(
    "availability.trending_down",
    "availability",
    "down",
    "doubtful",
    String.raw`\btrending (?:toward|towards|to)\s+(?:not playing|missing|sitting|being inactive)\b`,
  ),
  rule(
    "availability.concussion_protocol",
    "availability",
    "down",
    "out",
    String.raw`\b(?:enter(?:s|ed)?|in|placed in|remains in|still in)\s+(?:the\s+)?concussion protocol\b`,
  ),
  // --- availability: up --------------------------------------------------------------------------------
  rule(
    "availability.cleared",
    "availability",
    "up",
    "cleared",
    String.raw`\bcleared\s+(?:to\s+(?:play|return|practice|go)|for\s+(?:practice|contact|action|the game|week|sunday|monday|thursday|return|full)|from\s+(?:the\s+)?(?:concussion|injury)|of\s+(?:the\s+)?(?:concussion|injury)|(?:the\s+)?concussion protocol)\b`,
    { negatable: true },
  ),
  rule(
    "availability.will_play",
    "availability",
    "up",
    "will_play",
    [
      String.raw`\b(?:will|expected to|expects to|expect to|set to|plans to|planning to|intends to|on track to|is going to|going to|in line to|slated to|should|poised to)\s+(?:play|suit up|be available|dress)\b${PLAY_NOT_ROLE}`,
      // a game-day active: "is active", "will be active for Sunday", a headline's "Active for Week 7"
      String.raw`\b(?:is|be|remains|remain|stays|stay|listed as|declared|officially)\s+active\b${ACTIVE_GAME}`,
      String.raw`(?:^|:\s*)active\b${ACTIVE_GAME}`,
      String.raw`\bactive\s+(?:(?:for\s+)?${GAME_TIME}|against|vs|versus)\b`,
      // "is playing Sunday", "will be playing through the ankle", a headline's "Playing Sunday"
      String.raw`\b(?:is|be)\s+playing\b${PLAYING_GAME}`,
      String.raw`:\s*playing\b${PLAYING_GAME}`,
      String.raw`\bplan(?:s|ning)? on playing\b`,
      // "is in the lineup", "will be back in the starting lineup", a headline's "In lineup Sunday"
      String.raw`\b(?:is|be|remains|remain|stays|stay)\s+(?:back\s+)?in\s+(?:the\s+)?(?:starting\s+)?lineup\b`,
      String.raw`(?:^|:\s*)(?:back\s+)?in\s+(?:the\s+)?(?:starting\s+)?lineup\b`,
      // "is a go for Sunday", "a full go" (never "a go-to target")
      String.raw`\b(?:is|be|remains)\s+a\s+(?:full\s+)?go\b(?!-)`,
      // "is available for Sunday" (never "available in 60 % of leagues" or "for pickup")
      String.raw`\b(?:is|remains)\s+available\s+(?:to play|to suit up|for ${GAME_TIME}|${GAME_TIME}|against|vs|versus)\b`,
    ].join("|"),
    { negatable: true },
  ),
  rule(
    "availability.no_designation",
    "availability",
    "up",
    "will_play",
    String.raw`\bgood to go\b|\bno injury designation\b|\boff (?:the |his )?injury report\b|\bremoved (?:from )?(?:the )?injury report\b|\bwithout (?:an |a )?(?:injury )?designation\b|\bnot (?:listed )?on (?:the |his )?injury report\b|\bdesignation removed\b`,
  ),
  rule(
    "availability.activated",
    "availability",
    "up",
    "returning",
    String.raw`\b(?:activated|reinstated)\b|\b(?:comes|came|coming)\s+off\s+(?:the\s+)?(?:injured reserve|ir|pup|nfi|reserve)\b`,
    { negatable: true },
  ),
  rule(
    "availability.designated_return",
    "availability",
    "up",
    "returning",
    String.raw`\bdesignated (?:to|for) return\b|\b(?:opens?|opened|opening) (?:his |the )?(?:practice|21-day|return) window\b`,
  ),
  rule(
    "availability.returns",
    "availability",
    "up",
    "returning",
    String.raw`\b(?:return(?:s|ed|ing)?|back)\s+(?:to|at|for)\s+(?:practice|action|play|the field|the lineup|the practice field|game action|full practice|the starting lineup)\b|\breturn(?:s|ed|ing)?\s+from\s+(?:injury|injured reserve|ir|suspension|(?:a|an|his)\s+[a-z-]+\s+injury)\b|\b(?:will|could|expected to|set to|on track to|poised to|hopes to|aims to|plans to|should|likely to)\s+return\b`,
    { negatable: true },
  ),
  rule(
    "availability.practice_full",
    "availability",
    "up",
    "practice_full",
    String.raw`\bfull(?:y)? participant\b|\bfull participation\b|\bpractic(?:e|ed|es|ing)\s+(?:in\s+)?full\b|\bfull practice\b|\bpractic(?:ed|es) fully\b|\bupgraded\b`,
    { negatable: true },
  ),
  rule(
    "availability.chance_up",
    "availability",
    "up",
    "will_play",
    String.raw`\b(?:good|great|strong|decent|real|solid)\s+chance\s+(?:to|of)\s+(?:play|playing|suit|return|returning|be available)\b`,
  ),
  rule(
    "availability.trending_up",
    "availability",
    "up",
    "will_play",
    String.raw`\btrending (?:toward|towards|to)\s+play(?:ing)?\b`,
  ),
  // --- transaction ------------------------------------------------------------------------------------
  rule(
    "transaction.not_signed",
    "transaction",
    "down",
    null,
    String.raw`\b(?:not|won't|will not|decline(?:s|d)? to|opt(?:s|ed)? not to|decide(?:s|d)? not to|no longer)\s+(?:to\s+)?(?:sign|signed|signing|join|joined|joining|re-sign)\b|\bpass(?:es|ed)? on (?:signing|him)\b`,
  ),
  rule(
    "transaction.signed",
    "transaction",
    "up",
    null,
    String.raw`\b(?:re-?)?sign(?:s|ed|ing)\b|\bsign\s+(?:with|him|a deal|a contract|on)\b|\bagree(?:s|d)?\s+to\s+(?:terms|a deal|a contract|sign)\b|\bclaim(?:s|ed)?\s+(?:him\s+)?off waivers\b|\b(?:promote[sd]?|elevate[sd]?|promoting|elevating)\b|\bacquir(?:e|es|ed|ing)\b|\bcom(?:es|ing) out of retirement\b|\bunretire(?:s|d)?\b|\binks?\s+(?:a\s+)?(?:[a-z0-9-]+\s+){0,2}(?:deal|contract|extension)\b|\b(?:contract|multi-year|\d-year)\s+extension\b|\bclaimed by\b`,
    { negatable: true },
  ),
  rule(
    "transaction.released",
    "transaction",
    "down",
    null,
    String.raw`\b(?:release[sd]?|releasing)\s+(?:by|from|him|veteran|rb|wr|qb|te|kicker|running back|wide receiver|quarterback|tight end)\b|\b(?:was|were|been|is|gets?|got)\s+(?:released|cut)\b|\b(?:waive[sd]?|waiving)\b|\bcut\s+(?:by|from|ties)\b|\bpart(?:s|ed)? ways\b`,
    { negatable: true },
  ),
  rule(
    "transaction.traded",
    "transaction",
    "neutral",
    null,
    String.raw`\btraded\b|\btrades\s+(?:for|away)\b|\bdealt\s+to\b|\bin a trade\b|\brequests? (?:a )?trade\b|\btrade request\b`,
    { negatable: true },
  ),
  rule(
    "transaction.retired",
    "transaction",
    "down",
    null,
    String.raw`\bretire[sd]?\b(?!\s+(?:number|jersey|no\b))|\bretirement\b|\bretiring\b|\bhangs? up (?:his|the) cleats\b`,
    { negatable: true },
  ),
  // --- health -----------------------------------------------------------------------------------------
  rule(
    "health.clean",
    "health",
    "up",
    null,
    String.raw`\b(?:mri|x-rays?|tests?|scans?)\s+(?:came back\s+)?(?:clean|negative)\b|\bno structural damage\b|\bavoid(?:s|ed)?\s+(?:a\s+|an\s+)?(?:serious|significant|major|long-term|season-ending|severe)\s+(?:knee |ankle |foot |shoulder |hamstring )?injury\b|\bminor\s+(?:injury|sprain|strain|tweak)\b|\bdodged? (?:a )?bullet\b|\bavoid(?:s|ed)?\s+surgery\b|\bwon't need surgery\b`,
  ),
  rule(
    "health.injury",
    "health",
    "down",
    null,
    `\\b${BODY}\\s+${INJURY_NOUN}\\b|\\bconcussion\\b|\\billness\\b|\\bsetback\\b`,
  ),
  rule(
    "health.suffered",
    "health",
    "down",
    null,
    String.raw`\b(?:suffer(?:s|ed|ing)?|sustain(?:s|ed|ing)?)\s+(?:a\s+|an\s+|another\s+)?(?:[a-z-]+\s+){0,2}(?:injury|sprain|strain|tear|fracture|concussion|setback|bruise|contusion)\b|\b(?:tore|torn|fractured|sprained|strained|dislocated|aggravated|re-?injured)\b|\btweak(?:s|ed)?\s+(?:his|a|an)\b|\binjured\b(?!\s+(?:reserve|list))|\btears?\s+(?:his\s+)?(?:acl|mcl|pcl|achilles|meniscus|labrum|hamstring|pectoral|pec|biceps|triceps)\b|\b(?:breaks|broke|broken)\s+(?:his\s+)?(?:foot|leg|arm|hand|wrist|ankle|collarbone|rib|ribs|finger|thumb|jaw|fibula|tibia|clavicle|fibula)\b|\b(?:undergo(?:es|ing)?|underwent|to undergo|scheduled for|getting|gets)\s+(?:an\s+)?mri\b`,
    { negatable: true },
  ),
  rule("health.surgery", "health", "down", null, String.raw`\bsurgery\b|\bsurgical\b`, {
    negatable: true,
  }),
  // --- role -------------------------------------------------------------------------------------------
  rule(
    "role.lost_job",
    "role",
    "down",
    null,
    String.raw`\b(?:lose|loses|lost|losing)\s+(?:his\s+|the\s+)?(?:starting\s+|lead\s+|featured\s+)?(?:job|role|spot|gig)\b|\b(?:lose|loses|lost|losing)\s+(?:snaps|carries|targets|touches|work|reps)\b|\b(?:benched|demoted|relegated)\b|\bout-?snapped\b|\b(?:won't|will not|not expected to|isn't expected to|is not expected to|unlikely to|not likely to|not going to|isn't going to)\s+start\b`,
  ),
  rule(
    "role.reduced",
    "role",
    "down",
    null,
    String.raw`\b(?:reduced|smaller|diminished|limited|backup|reserve|change-of-pace|rotational|depth)\s+(?:role|snaps|workload|usage|work)\b|\b(?:will|to)\s+(?:be|serve as|remain)\s+(?:the\s+)?backup\b|\bsplit(?:s|ting)?\s+(?:carries|work|snaps|time|the backfield|reps)\b|\bby committee\b|\bbackfield committee\b|\bcommittee (?:approach|backfield|role)\b|\b(?:fewer|less|decreased|dip in|drop in|decline in)\s+(?:snaps|touches|targets|carries|work|reps|playing time|usage|opportunities)\b`,
  ),
  rule(
    "role.lead",
    "role",
    "up",
    null,
    String.raw`\b(?:lead|starting|featured|bigger|expanded|increased|larger|feature|primary|every-down|three-down|workhorse|bell-?cow)\s+(?:role|back|job|workload|duties|usage)\b`,
  ),
  // the coming game's start: a role claim that also says he plays (`implies`; claims.ts header) —
  // before role.starter, which reads the same words where they are not this game's
  rule(
    "role.will_start",
    "role",
    "up",
    null,
    [
      // "will start", "is expected to start", a headline's "Ostrander to start Sunday" — never
      // "hoping to start" (NOT_HIS_START); "expected"/"set"/"in line" before "to" are read by
      // role.starter at the phrase's own start, so negation and attribution see the whole phrase
      String.raw`\b(?:will|to)\s+start\b${NOT_HIS_START}${START_GAME}`,
      String.raw`(?:\b(?:is|be)\s+|:\s*)starting\b${START_GAME}`,
      String.raw`\b(?:gets|get|getting|draws|draw|earns|earn|makes|make|making|set for|in line for)\s+(?:(?:his|the|a|an)\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|another|career|nfl|consecutive|straight|\d{1,2}(?:st|nd|rd|th))\s+){0,2}start\b(?!-|\s+(?:time|of|to)\b)`,
      String.raw`\b(?:gets|get|getting|draws|draw|earns|earn|set for|in line for)\s+(?:the\s+)?starting nod\b`,
    ].join("|"),
    { negatable: true, unconditional: true, implies: "will_play" },
  ),
  rule(
    "role.starter",
    "role",
    "up",
    null,
    String.raw`\b(?:named|name|names|will be|to be|remains|as)\s+(?:the\s+)?(?:[a-z]+\s+)?starter\b|\b(?:will|to|set to|expected to|in line to|poised to|slated to)\s+start\b(?!\s+(?:time|the (?:season|year) on))|\b(?:gets|get|getting|draws|draw|drew|earns|earned|makes|making|set for|in line for)\s+(?:his\s+|the\s+|a\s+)?(?:[a-z]+\s+){0,2}starts?\b|\btakes? over\s+(?:as|at)\b|\btakes? over\s+(?:the\s+)?(?:backfield|starting|lead|kicking|duties|role|job)\b|\bstarting nod\b|\bfirst-team reps\b|\b(?:runs|ran|running|working|works) with the (?:first|starting) (?:team|unit|offense)s?\b|\bwith the starters\b`,
    { negatable: true },
  ),
  rule(
    "role.more_work",
    "role",
    "up",
    null,
    String.raw`\b(?:more|increased|extra|additional|uptick in|bump in|rise in|spike in)\s+(?:snaps|touches|targets|carries|work|reps|playing time|usage|opportunities|involvement)\b|\bmoves? up (?:the )?depth chart\b`,
    { negatable: true },
  ),
  // --- coaching intent --------------------------------------------------------------------------------
  rule(
    "coaching_intent.less",
    "coaching_intent",
    "down",
    null,
    String.raw`\b(?:wants?|plans?|hopes?|intends?|expects?|looking|aims?)\s+to\s+(?:limit|reduce|ease|manage|monitor|lighten)\b|\b(?:on|under)\s+a\s+(?:snap|pitch|play)\s+count\b|\beased? back\b|\beasing (?:him )?back\b|\bworkload (?:will be |to be |is being )?(?:managed|monitored|limited)\b`,
  ),
  rule(
    "coaching_intent.more",
    "coaching_intent",
    "up",
    null,
    String.raw`\b(?:wants?|plans?|hopes?|intends?|expects?|looking|aims?|vows?|promises?)\s+to\s+(?:get|give|use|feature|involve|increase|expand|lean on|ride)\b|\bmore involved\b`,
    { negatable: true },
  ),
]);

/** A rule id of the table (a closed vocabulary; tests hold it). */
export type RuleId = string;

/** Every rule id, in table order. */
export const RULE_IDS: readonly RuleId[] = Object.freeze(RULES_V1_TABLE.map((r) => r.id));

/** The availability each implying rule's claims carry (`Rule.implies`), by rule id. */
const IMPLIED: ReadonlyMap<RuleId, Designation> = new Map(
  RULES_V1_TABLE.flatMap((r) => (r.implies === null ? [] : [[r.id, r.implies] as const])),
);

/** The extractor's full output: the plan 07 D6 `claim` plus the rule and the structured value. */
export interface RulesV1Claim extends ClaimExtract {
  readonly extractor: typeof RULES_V1;
  /** The rule that fired (RULE_IDS). */
  readonly rule: RuleId;
  /** An availability rule's structured value (E10 `claim_value`); null for the other types. */
  readonly designation: Designation | null;
  /** Where the claim was read. */
  readonly field: "title" | "blurb" | "text";
}

/** The longest text one extraction reads (a title, a blurb, an outlook; the rest is not read). */
export const CLAIM_TEXT_CAP = 2_000;

/** A negator within two words before a hit (`not expected to play`, `no longer questionable`). */
const NEGATED_RE =
  /\b(?:not|no|never|won't|wont|isn't|wasn't|aren't|didn't|doesn't|don't|can't|cannot|without|no longer)(?:\s+[a-z'-]+){0,2}\s*$/;
/** The text is about game officials: a suspension rule does not read it as a player's. */
const OFFICIALS_RE =
  /\b(?:referees?|refs|officials?|officiating|umpires?|line judge|side judge|back judge|field judge)\b/;
/**
 * A condition ("if healthy", "once cleared", "pending a test", "as long as"; "once again" is none):
 * an `unconditional` rule's hit is dropped when one stands in its clause within CONDITION_REACH
 * characters before or after it — "will start Sunday if he clears the protocol" says nothing about
 * an OUT player's game.
 */
const CONDITIONED_RE =
  /\b(?:if|pending|provided|assuming|(?:as|so) long as)\b|\bonce\b(?!\s+again\b)/;
/** How far a condition is looked for around an `unconditional` hit (its clause, within this). */
const CONDITION_REACH = 60;

/** Whether a condition stands in the clause of `folded[index, end)` (CONDITIONED_RE). */
function conditioned(folded: string, index: number, end: number): boolean {
  // the clause around the hit: back to the last sentence end or semicolon, on to the next one
  let from = Math.max(0, index - CONDITION_REACH);
  for (const stop of ".;!?") from = Math.max(from, folded.lastIndexOf(stop, index - 1) + 1);
  const after = folded.slice(end, end + CONDITION_REACH);
  const cut = after.search(/[.;!?]/);
  return (
    CONDITIONED_RE.test(folded.slice(from, index)) ||
    CONDITIONED_RE.test(cut < 0 ? after : after.slice(0, cut))
  );
}

/**
 * The copy the rules read: the plan 02 §6.2 sanitiser (HTML, entities, controls, bidi and
 * zero-width removed; NFC; capped), then `flagFold` (NFKC, lower case, confusables, marks), with
 * typographic apostrophes and dashes folded to `'` and `-`.
 */
export function claimFold(raw: string): string {
  const clean = sanitizeText(raw, CLAIM_TEXT_CAP).value;
  return (
    flagFold(clean)
      .replace(/[‘’ʼʻ´`′]/gu, "'")
      .replace(/[‐‑‒–—―−]/gu, "-")
      .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/gu, '"')
      // a quoting mark is not part of a word ("viewed as 'unlikely' for"); "won't" keeps its own
      .replace(/(^|[^a-z0-9])['"]+|['"]+(?=[^a-z0-9]|$)/g, "$1")
      .trim()
  );
}

interface Hit {
  readonly index: number;
  readonly end: number;
  readonly order: number;
  readonly rule: Rule;
}

/** Every surviving hit of the table on an already-folded text, earliest first. */
function hitsOf(folded: string): Hit[] {
  const officials = OFFICIALS_RE.test(folded);
  const out: Hit[] = [];
  RULES_V1_TABLE.forEach((r, order) => {
    r.re.lastIndex = 0;
    for (const m of folded.matchAll(r.re)) {
      const index = m.index;
      if (r.notOfficials && officials) continue;
      if (r.negatable && NEGATED_RE.test(folded.slice(Math.max(0, index - 48), index))) continue;
      const end = index + m[0].length;
      if (r.unconditional && conditioned(folded, index, end)) continue;
      out.push({ index, end, order, rule: r });
      break; // the earliest hit of a rule is the only one that can win
    }
  });
  out.sort((a, b) => a.index - b.index || a.order - b.order);
  return out;
}

/**
 * The winning hit: the earliest; when other hits START INSIDE its phrase (one claim read by two
 * rules — "suffers season-ending injury", "to start the year on PUP"), the table order decides.
 */
function winner(hits: readonly Hit[]): Hit | undefined {
  const first = hits[0];
  if (first === undefined) return undefined;
  let best = first;
  for (const h of hits) if (h.index < first.end && h.order < best.order) best = h;
  return best;
}

/** The claim of one text, or null when no rule fires (nothing is ever guessed). */
export function extractClaim(
  text: string | null | undefined,
  field: RulesV1Claim["field"] = "text",
): RulesV1Claim | null {
  return claimHit(text, field)?.claim ?? null;
}

/**
 * The claim of one text (exactly `extractClaim`'s) and where its words start in `claimFold(text)`:
 * the earliest hit's position (a rule that wins on table order from inside that phrase reads the same
 * words). What E10's attribution reads to see whether a clause states the claim of the player it
 * opens with (src/domain/evidence/attribution.ts). Null when no rule fires.
 */
export function claimHit(
  text: string | null | undefined,
  field: RulesV1Claim["field"] = "text",
): { readonly claim: RulesV1Claim; readonly at: number } | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const hits = hitsOf(claimFold(text));
  const best = winner(hits);
  const start = hits[0];
  if (best === undefined || start === undefined) return null;
  const r = best.rule;
  const claim = Object.freeze({
    type: r.type,
    direction: r.direction,
    extractor: RULES_V1,
    rule: r.id,
    designation: r.designation,
    field,
  });
  return { claim, at: start.index };
}

/**
 * The claim of a news item: the title first, the blurb only when the title carries none (the B8
 * labelling convention — the first claim in reading order).
 */
export function extractItemClaim(item: {
  readonly title?: string | null;
  readonly blurb?: string | null;
}): RulesV1Claim | null {
  return extractClaim(item.title, "title") ?? extractClaim(item.blurb, "blurb");
}

/** Every rule that fires on a text, earliest first (diagnostics and tests; never an output field). */
export function ruleHits(
  text: string,
): readonly { readonly index: number; readonly rule: RuleId }[] {
  return hitsOf(claimFold(text)).map((h) => ({ index: h.index, rule: h.rule.id }));
}

/**
 * The availability a claim states or implies, as a designation: an availability claim's own; for a
 * claim whose rule implies one, that one — "will start Sunday" is a role claim that says he plays
 * (`will_play`); null otherwise (no claim, another type, an availability claim with no designation).
 * What the structured comparator lines up against ESPN's injury status (structured.ts).
 */
export function claimAvailability(c: RulesV1Claim | null): Designation | null {
  if (c === null) return null;
  if (c.type === "availability") return c.designation;
  return IMPLIED.get(c.rule) ?? null;
}

/** The plan 07 D6 `claim` shape of an extract (the three public fields only). */
export function toClaimExtract(c: RulesV1Claim | null): ClaimExtract | null {
  return c === null ? null : { type: c.type, direction: c.direction, extractor: c.extractor };
}
