// stat_map.ts — ESPN statId → canonical (plan 08 E3, §3.1 the id-keyed table; research 03 §B.2) and
// the ESPN line translator's id step (§3.3: numbers on the wire, a non-number fails the entry as
// drift; position via the POSITION map, never the slot map). Platform-owned: it never moves to
// fantasy-core (§10). Every row is checked against the recorded fixtures by the golden test.
import { ScoringError } from "./errors.js";
import { finiteWithin, MAX_ABS_STAT } from "./numeric.js";
import { type CanonicalDef, canonicalDef } from "./registry.js";
import type { BracketFamilyName, Canonical, PositionClass, StatLine, StatSplit } from "./types.js";
import { asPositionId } from "./types.js";

/** One ESPN stat id. */
export interface EspnStatDef {
  /** The ESPN statId as a decimal string, e.g. "53". */
  readonly id: string;
  readonly canonical: Canonical;
  /** ESPN's abbreviation where research 03 §B.2 gives one; ours (`PY/25` style) otherwise. */
  readonly abbr: string;
  /**
   * E9 (plan 08): 103/104 shipped disputed until a recorded week settled the order. Settled on the
   * recorded fixtures (E9_EVIDENCE), so no id is disputed today; the flag stays for a future one.
   */
  readonly disputed: boolean;
}

/**
 * E9 settled (plan 08 E9, §8 "D/ST return TD in a week with exactly one of 103/104"): 103 is the
 * INTERCEPTION-return TD and 104 the FUMBLE-return TD (S-PY's order; S-JS has them reversed).
 * Evidence, all in fixtures/espn/recorded: three D/ST weeks carry 103 = 1 with NO fumble recovery
 * (96 absent) but ≥ 1 interception (95) — a fumble-return TD needs a recovery — and across all 70
 * recorded D/ST weeks 103 equals nflverse `def_tds` (interception-return TDs) and 104 equals the
 * defensive fumble-return TDs. The swap is a named mutation test.
 */
export const E9_EVIDENCE = Object.freeze({
  int_return_td: "103",
  fumble_return_td: "104",
  recorded_weeks_with_103_and_no_fumble_recovery: 3,
  nflverse_agreement: "70/70 D/ST weeks",
});

/** [id, canonical, abbr] — abbreviations from research 03 §B.2 where it names them. */
const ROWS: readonly (readonly [number, Canonical, string])[] = [
  [0, "pass_att", "PA"],
  [1, "pass_cmp", "PC"],
  [2, "pass_inc", "INC"],
  [3, "pass_yd", "PY"],
  [4, "pass_td", "PTD"],
  [5, "per_n_pass_yd_5", "PY5"],
  [6, "per_n_pass_yd_10", "PY10"],
  [7, "per_n_pass_yd_20", "PY20"],
  [8, "per_n_pass_yd_25", "PY25"],
  [9, "per_n_pass_yd_50", "PY50"],
  [10, "per_n_pass_yd_100", "PY100"],
  [11, "per_n_pass_cmp_5", "PC5"],
  [12, "per_n_pass_cmp_10", "PC10"],
  [13, "per_n_pass_inc_5", "INC5"],
  [14, "per_n_pass_inc_10", "INC10"],
  [15, "pass_td_40", "PTD40"],
  [16, "pass_td_50", "PTD50"],
  [17, "pass_yd_300", "P300"],
  [18, "pass_yd_400", "P400"],
  [19, "pass_2pt", "2PC"],
  [20, "pass_int", "INTT"],
  [22, "pass_ypg", "PYPG"],
  [23, "rush_att", "RA"],
  [24, "rush_yd", "RY"],
  [25, "rush_td", "RTD"],
  [26, "rush_2pt", "2PR"],
  [27, "per_n_rush_yd_5", "RY/5"],
  [28, "per_n_rush_yd_10", "RY/10"],
  [29, "per_n_rush_yd_20", "RY/20"],
  [30, "per_n_rush_yd_25", "RY/25"],
  [31, "per_n_rush_yd_50", "RY/50"],
  [32, "per_n_rush_yd_100", "RY/100"],
  [33, "per_n_rush_att_5", "RA/5"],
  [34, "per_n_rush_att_10", "RA/10"],
  [35, "rush_td_40", "RTD40"],
  [36, "rush_td_50", "RTD50"],
  [37, "rush_yd_100", "RY100"],
  [38, "rush_yd_200", "RY200"],
  [40, "rush_ypg", "RYPG"],
  [41, "rec_stat", "RECS"],
  [42, "rec_yd", "REY"],
  [43, "rec_td", "RETD"],
  [44, "rec_2pt", "2PRE"],
  [45, "rec_td_40", "RETD40"],
  [46, "rec_td_50", "RETD50"],
  [47, "per_n_rec_yd_5", "REY/5"],
  [48, "per_n_rec_yd_10", "REY/10"],
  [49, "per_n_rec_yd_20", "REY/20"],
  [50, "per_n_rec_yd_25", "REY/25"],
  [51, "per_n_rec_yd_50", "REY/50"],
  [52, "per_n_rec_yd_100", "REY/100"],
  [53, "rec", "REC"],
  [54, "per_n_rec_5", "REC/5"],
  [55, "per_n_rec_10", "REC/10"],
  [56, "rec_yd_100", "REY100"],
  [57, "rec_yd_200", "REY200"],
  [58, "targets", "RET"],
  [61, "rec_ypg", "REYPG"],
  [62, "two_pt_total", "PTL"],
  [63, "fum_rec_td_off", "FTD"],
  [64, "sacked", "SKD"],
  [68, "fum", "FUM"],
  [72, "fum_lost", "FUML"],
  [73, "turnovers", "TT"],
  [74, "fg_50p", "FG50P"],
  [75, "fg_att_50p", "FGA50P"],
  [76, "fg_miss_50p", "FGM50P"],
  [77, "fg_40_49", "FG40"],
  [78, "fg_att_40_49", "FGA40"],
  [79, "fg_miss_40_49", "FGM40"],
  [80, "fg_0_39", "FG0"],
  [81, "fg_att_0_39", "FGA0"],
  [82, "fg_miss_0_39", "FGM0"],
  [83, "fg_made_total", "FG"],
  [84, "fg_att_total", "FGA"],
  [85, "fg_miss_total", "FGM"],
  [86, "pat_made", "PAT"],
  [87, "pat_att", "PATA"],
  [88, "pat_miss", "PATM"],
  [89, "dst_pa_0", "PA0"],
  [90, "dst_pa_1_6", "PA1"],
  [91, "dst_pa_7_13", "PA7"],
  [92, "dst_pa_14_17", "PA14"],
  [93, "dst_blk_td", "BLKKRTD"],
  [94, "dst_ret_td", "DEFRETTD"],
  [95, "dst_int", "INT"],
  [96, "dst_fr", "FR"],
  [97, "dst_blk", "BLKK"],
  [98, "dst_safety", "SF"],
  [99, "dst_sack", "SK"],
  [101, "kr_td", "KRTD"],
  [102, "pr_td", "PRTD"],
  [103, "dst_int_td", "INTTD"],
  [104, "dst_fr_td", "FRTD"],
  [105, "ret_td_total", "TRTD"],
  [106, "dst_ff", "FF"],
  [107, "dst_tk_ast", "TKA"],
  [108, "dst_tk_solo", "TKS"],
  [109, "dst_tk", "TK"],
  [113, "dst_pd", "PD"],
  [114, "kr_yd", "KR"],
  [115, "pr_yd", "PR"],
  [120, "dst_pa_raw", "PTSA"],
  [121, "dst_pa_18_21", "PA18"],
  [122, "dst_pa_22_27", "PA22"],
  [123, "dst_pa_28_34", "PA28"],
  [124, "dst_pa_35_45", "PA35"],
  [125, "dst_pa_46p", "PA46"],
  [127, "dst_ya_raw", "YA"],
  [128, "dst_ya_lt100", "YA100"],
  [129, "dst_ya_100_199", "YA199"],
  [130, "dst_ya_200_299", "YA299"],
  [131, "dst_ya_300_349", "YA349"],
  [132, "dst_ya_350_399", "YA399"],
  [133, "dst_ya_400_449", "YA449"],
  [134, "dst_ya_450_499", "YA499"],
  [135, "dst_ya_500_549", "YA549"],
  [136, "dst_ya_550p", "YA550"],
  [155, "hc_win", "TW"],
  [156, "hc_loss", "TL"],
  [157, "hc_tie", "TIE"],
  [158, "hc_pts", "PTS"],
  [161, "margin_win_25p", "WM25"],
  [162, "margin_win_20_24", "WM20"],
  [163, "margin_win_15_19", "WM15"],
  [164, "margin_win_10_14", "WM10"],
  [165, "margin_win_5_9", "WM5"],
  [166, "margin_win_1_4", "WM1"],
  [167, "margin_loss_1_4", "LM1"],
  [168, "margin_loss_5_9", "LM5"],
  [169, "margin_loss_10_14", "LM10"],
  [170, "margin_loss_15_19", "LM15"],
  [171, "margin_loss_20_24", "LM20"],
  [172, "margin_loss_25p", "LM25"],
  [198, "fg_50_59", "FG50"],
  [199, "fg_att_50_59", "FGA50"],
  [200, "fg_miss_50_59", "FGM50"],
  [201, "fg_60p", "FG60"],
  [202, "fg_att_60p", "FGA60"],
  [203, "fg_miss_60p", "FGM60"],
  [205, "dst_2pt_ret", "D2PRET"],
  [206, "two_pt_ret", "2PRET"],
  [209, "one_pt_safety", "1PSF"],
  [210, "gp", "GP"],
  [211, "pass_1d", "PFD"],
  [212, "rush_1d", "RFD"],
  [213, "rec_1d", "REFD"],
  [214, "fg_yd", "FGY"],
  [215, "fg_yd_miss", "FGMY"],
  [216, "fg_yd_att", "FGAY"],
  [217, "per_n_fg_yd_5", "FGY/5"],
  [218, "per_n_fg_yd_10", "FGY/10"],
  [219, "per_n_fg_yd_20", "FGY/20"],
  [220, "per_n_fg_yd_25", "FGY/25"],
  [221, "per_n_fg_yd_50", "FGY/50"],
  [222, "per_n_fg_yd_100", "FGY/100"],
  [223, "per_n_fg_yd_miss_5", "FGMY/5"],
  [224, "per_n_fg_yd_miss_10", "FGMY/10"],
  [225, "per_n_fg_yd_miss_20", "FGMY/20"],
  [226, "per_n_fg_yd_miss_25", "FGMY/25"],
  [227, "per_n_fg_yd_miss_50", "FGMY/50"],
  [228, "per_n_fg_yd_miss_100", "FGMY/100"],
  [229, "per_n_fg_yd_att_5", "FGAY/5"],
  [230, "per_n_fg_yd_att_10", "FGAY/10"],
  [231, "per_n_fg_yd_att_20", "FGAY/20"],
  [232, "per_n_fg_yd_att_25", "FGAY/25"],
  [233, "per_n_fg_yd_att_50", "FGAY/50"],
  [234, "per_n_fg_yd_att_100", "FGAY/100"],
];

/** The ESPN table keyed by statId string (a Map: a hostile key never reads Object.prototype). */
export const ESPN_STAT_MAP: ReadonlyMap<string, EspnStatDef> = new Map(
  ROWS.map(([id, canonical, abbr]) => [
    String(id),
    Object.freeze({ id: String(id), canonical, abbr, disputed: false }),
  ]),
);

/** canonical → ESPN statId (the table is one-to-one). */
const ID_BY_CANONICAL: ReadonlyMap<Canonical, string> = new Map(
  ROWS.map(([id, canonical]) => [canonical, String(id)]),
);

/** The ESPN row of a statId string, or undefined (unregistered → unmapped / ignored). */
export function espnStat(id: string): EspnStatDef | undefined {
  return ESPN_STAT_MAP.get(id);
}

/** The ESPN statId of a canonical name, or undefined. */
export function espnIdOf(canonical: Canonical): string | undefined {
  return ID_BY_CANONICAL.get(canonical);
}

/**
 * ESPN POSITION ids (`defaultPositionId`, `pointsOverrides` keys) → scoring class — never the slot
 * map (research 03 §B.2 trap). Mirrors ESPN_POSITIONS in src/providers/espn/types.ts (P → K there
 * too); a test holds the two equal. 15 = TQB scores as offence with override key "15".
 */
export const ESPN_POSITION_CLASS: Readonly<Record<number, PositionClass>> = Object.freeze({
  1: "O",
  2: "O",
  3: "O",
  4: "O",
  5: "K",
  7: "K",
  9: "IDP",
  10: "IDP",
  11: "IDP",
  12: "IDP",
  13: "IDP",
  14: "HC",
  15: "O",
  16: "DST",
});

/** The scoring class of an ESPN position id; an id outside the table is drift (plan 01 §7). */
export function positionClassOf(position: number): PositionClass {
  const cls: PositionClass | undefined = ESPN_POSITION_CLASS[asPositionId(position)];
  if (cls === undefined) {
    throw new ScoringError("drift", "unknown ESPN position id", [String(position)]);
  }
  return cls;
}

/** `stats{statId: raw}` keys: decimal ids only. */
const STAT_ID_RE = /^(0|[1-9]\d{0,3})$/;
/** The most raw stats one entry may carry (ESPN sends ≈ 150 at most). */
export const MAX_RAW_STATS = 1000;

/** One ESPN stats entry's id map plus how to label the line (a plain object, no wire type). */
export interface EspnLineInput {
  /** `stats{statId: raw}` — numbers on the wire (plan 08 §3.3). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Any game of the period has `statsOfficial: false` (research 04 §B.1.6). Default false. */
  readonly provisional?: boolean;
  readonly split?: StatSplit;
}

/** The translated line plus the ESPN ids the registry does not know (additive drift, `eff status`). */
export interface EspnLineResult {
  readonly line: StatLine;
  /** Stat ids present in `raw` with no registry row, numerically sorted; never in the line. */
  readonly unregistered: readonly string[];
}

/**
 * `toStatLine(espn)`'s id step (plan 08 §3.3): `stats{statId: raw}` → canonical values by the
 * table; `position` is the player's `defaultPositionId` (class from ESPN_POSITION_CLASS). A value
 * that is not a finite number within ±MAX_ABS_STAT fails the entry as `drift`; a key that is not a
 * decimal id, or an id with no row, is listed in `unregistered` and left out of the line.
 * `appliedStats`/`appliedTotal` never enter the line — `verify` reads them.
 */
export function statLineFromEspn(input: EspnLineInput, position: number): EspnLineResult {
  const raw: unknown = (input as { raw?: unknown } | null)?.raw;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScoringError("drift", "ESPN stats must be an object");
  }
  const cls = positionClassOf(position);
  const keys = Object.keys(raw);
  if (keys.length > MAX_RAW_STATS) throw new ScoringError("drift", "too many ESPN stats");
  const values: Record<Canonical, number> = {};
  const unregistered: string[] = [];
  for (const k of keys) {
    const v = (raw as Record<string, unknown>)[k];
    if (!finiteWithin(v, MAX_ABS_STAT)) {
      throw new ScoringError("drift", "ESPN stat value is not a finite number", [k]);
    }
    const def = STAT_ID_RE.test(k) ? espnStat(k) : undefined;
    if (def === undefined) unregistered.push(k);
    else values[def.canonical] = v === 0 ? 0 : v;
  }
  const line: StatLine = {
    values: Object.freeze(values),
    present: Object.freeze(Object.keys(values).sort()),
    position: asPositionId(position),
    position_class: cls,
    provisional: input.provisional === true,
    source: "espn",
    ...(input.split === undefined ? {} : { split: Object.freeze({ ...input.split }) }),
  };
  return Object.freeze({
    line: Object.freeze(line),
    unregistered: Object.freeze(sortIds(unregistered)),
  });
}

/** Decimal ids in numeric order, then any other key in code-unit order. */
function sortIds(keys: readonly string[]): string[] {
  const ids = keys.filter((k) => STAT_ID_RE.test(k)).sort((a, b) => Number(a) - Number(b));
  return [...ids, ...keys.filter((k) => !STAT_ID_RE.test(k)).sort()];
}

/** One `espn-ff://game/stat-ids` row (plan 07; structurally StatIdResourceRow). */
export interface EspnStatIdRow {
  readonly stat_id: string;
  readonly abbr: string;
  readonly meaning: string;
  readonly canonical: Canonical;
  readonly family: BracketFamilyName | null;
  readonly disputed: boolean;
}

/**
 * Every registered ESPN stat id with its meaning and family, in id order (the stat-id resource).
 * `lookup` is the registry (a parameter so the fallback for a missing row is testable).
 */
export function espnStatIdRows(
  lookup: (c: Canonical) => CanonicalDef | undefined = canonicalDef,
): readonly EspnStatIdRow[] {
  return Object.freeze(
    ROWS.map(([id, canonical, abbr]) => {
      const def = lookup(canonical);
      return Object.freeze({
        stat_id: String(id),
        abbr,
        meaning: def === undefined ? canonical : def.meaning,
        canonical,
        family: def?.family?.name ?? null,
        disputed: false,
      });
    }),
  );
}
