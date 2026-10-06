// index.ts — the scoring engine's public surface (plan 08 E1, §10): what the ESPN provider, the
// nflverse sources, the store, analytics and the tools import. Types live in ./types.js.
import { explain, score, scoreSamples } from "./engine.js";
import type { ScoringEngine } from "./types.js";
import { verify } from "./verify.js";

export type * from "./types.js";
export {
  asPositionId,
  BRACKET_FAMILY_NAMES,
  CANONICAL_NAME_RE,
  DISPUTED_STAT_IDS,
  DIST_BASES,
  GOLDEN_TOLERANCE,
  LEAGUE_MISMATCH_REFUSAL_SHARE,
  POSITION_CLASSES,
  SETTINGS_HASH_RE,
} from "./types.js";
export { ScoringError, type ScoringErrorCode } from "./errors.js";
export { denoise, MAX_ABS_MODIFIER, MAX_ABS_STAT, round2, stableSum } from "./numeric.js";
export {
  CANONICAL_DEFS,
  CANONICAL_REGISTRY,
  type CanonicalDef,
  canonicalDef,
  FAMILY_KIND,
  type FamilyKind,
  type FamilyMembership,
  SCALAR_FLOOR,
} from "./registry.js";
export {
  E9_EVIDENCE,
  ESPN_POSITION_CLASS,
  ESPN_STAT_MAP,
  type EspnLineInput,
  type EspnLineResult,
  type EspnStatDef,
  type EspnStatIdRow,
  espnIdOf,
  espnStat,
  espnStatIdRows,
  MAX_RAW_STATS,
  positionClassOf,
  statLineFromEspn,
} from "./stat_map.js";
export { bracketize, buildFamilies, familyKey, familyKind } from "./brackets.js";
export {
  applyRounding,
  ESPN_APPLIED_TOTAL_DECIMALS,
  ESPN_ROUNDING,
  type RoundingCandidates,
  roundingCandidates,
} from "./rounding.js";
export {
  canonicalJson,
  computeSettingsHash,
  createUnmappedLog,
  type EspnScoringItem,
  type EspnScoringSettings,
  MAX_OVERRIDES,
  MAX_RULES,
  type NormalizeOptions,
  normalizeSettings,
  type ProviderScoringInput,
  renormalizeSettings,
  ROUNDING_MODES,
  settingsWarnings,
  translateScoringInput,
  type UnmappedLog,
  unmappedIds,
} from "./settings.js";
export { explain, MAX_SAMPLES, score, scoreSamples, sumPoints } from "./engine.js";
export {
  classifyMismatch,
  isLeagueWideMismatch,
  statPointsMatch,
  totalPointsMatch,
  verify,
} from "./verify.js";
export {
  coerceScalar,
  type DefenseLineOptions,
  espnPositionForNflverse,
  type LineOptions,
  type NflverseRow,
  parseKickList,
  type PlayerWeekOptions,
  pointsAllowed,
  type PointsAllowedDefinition,
  type PointsAllowedInput,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "./nflverse.js";

/** The engine as one object (plan 08 E1; the ScoringEngine contract). */
export const scoringEngine: ScoringEngine = Object.freeze({ score, scoreSamples, explain, verify });
