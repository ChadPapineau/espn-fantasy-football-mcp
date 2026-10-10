// reproduce.ts — the seeding reproduction (plan 10 §3.3 C4; research 05 §2.4 "Evaluation" and §8.4
// #5: "on every finished ESPN season available, reproduce `playoffSeed` exactly from records, PF and
// the tiebreak chain"). The chain is the simulator's own (`rankFinalStandings` in ../seeding.ts —
// `tiebreakChain` + `rankAll`, the code every simulated path ranks with): reading (a) = division
// winners first when the league has more than one division, then `TOTAL_POINTS_SCORED`'s win % →
// PF → H2H → division record → PA → coin; reading (b) = PF → coin. The ranking reads ESPN's own
// final standings (what ESPN seeds from); the regular-season rows (period ≤ `matchupPeriodCount`)
// give the head-to-head and division records and are recomputed into records that must agree with
// the standings (to 0.01 points). Exact = every team's `playoffSeed` equals its position with no
// coin flip needed. A season neither reading reproduces carries findings that explain it — a
// non-reproduction with nothing but `seed_mismatch` is unexplained and fails C4. Pure. New here.
import type { SeedingMode } from "../../../config/schema.js";
import type { League, LeagueRules, Matchup, Standing } from "../../league/types.js";
import {
  rankFinalStandings,
  type FinalGame,
  type FinalStandingTeam,
  type TieLevel,
} from "../seeding.js";
import type {
  ReadingReproduction,
  ReproductionFinding,
  ReproductionFindingCode,
  ReproductionSummary,
  SeasonReproduction,
  SeasonReproductionInput,
  SeedMismatch,
} from "./types.js";

/** Points agreement between ESPN's standings and the recomputed regular-season results. */
export const RECORDS_TOLERANCE = 0.01;
/** C4's minimum: seasons reproduced exactly under reading (a). */
export const C4_MIN_SEASONS = 2;

/**
 * Season-level findings that explain a non-reproduction. A coin flip explains one only for the
 * reading it hit and only when ESPN's seeds follow that chain everywhere above it (see
 * `explanations`); a bare `seed_mismatch` or an unknown schedule row explains nothing.
 */
const EXPLAINING: ReadonlySet<ReproductionFindingCode> = new Set([
  "regular_season_unknown",
  "season_unfinished",
  "standings_invalid",
  "seeds_incomplete",
  "records_disagree",
  "playoff_edited",
  "rule_unknown",
]);

/** What explains a season's non-reproduction (empty: unexplained, or nothing to explain). */
function explanations(
  findings: readonly ReproductionFinding[],
  readings: readonly ReadingReproduction[],
): string[] {
  const out: string[] = [
    ...new Set(findings.filter((f) => EXPLAINING.has(f.code)).map((f) => f.code)),
  ];
  for (const r of readings)
    if (r.coin_flip_decides && r.consistent_up_to_coin)
      out.push(`coin_flip_decides under ${r.seeding_mode} (the seeds follow the chain above it)`);
  return out;
}

const finding = (
  code: ReproductionFindingCode,
  reading: SeedingMode | null,
  detail: string,
): ReproductionFinding => Object.freeze({ code, reading, detail });

const ids = (xs: readonly number[]): string => xs.map(String).join(", ");

/** The decided regular-season games, the recomputed records and the schedule findings. */
function regularSeason(input: SeasonReproductionInput): {
  readonly games: FinalGame[];
  readonly findings: ReproductionFinding[];
  readonly records: Map<number, { w: number; l: number; t: number; pf: number; pa: number }>;
} {
  const findings: ReproductionFinding[] = [];
  const known = new Set(input.teams.map((t) => t.team_id));
  const records = new Map<number, { w: number; l: number; t: number; pf: number; pa: number }>(
    input.teams.map((t) => [t.team_id, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]),
  );
  const games: FinalGame[] = [];
  const regular = input.playoff.regular_season_matchups;
  if (regular === null || !Number.isInteger(regular) || regular < 1) {
    findings.push(
      finding(
        "regular_season_unknown",
        null,
        "matchupPeriodCount is missing: no game is read, so head-to-head and division records are unavailable",
      ),
    );
    return { games, findings, records };
  }
  let unknownRows = 0;
  const undecided: number[] = [];
  for (const m of input.matchups) {
    if (!Number.isInteger(m.matchup_period) || m.matchup_period < 1 || m.matchup_period > regular)
      continue;
    if (m.is_bye || m.away === null) continue;
    const h = m.home;
    const a = m.away;
    if (!known.has(h.team_id) || !known.has(a.team_id) || h.team_id === a.team_id) {
      unknownRows += 1;
      continue;
    }
    const hp = h.points;
    const ap = a.points;
    let winner: FinalGame["winner"] | null = null;
    if (m.winner === "HOME" || m.winner === "AWAY") winner = m.winner;
    else if (
      m.winner === null &&
      hp !== null &&
      ap !== null &&
      Number.isFinite(hp) &&
      Number.isFinite(ap) &&
      hp === ap
    )
      winner = "TIE";
    if (winner === null) {
      undecided.push(m.matchup_period);
      continue;
    }
    games.push({ home: h.team_id, away: a.team_id, winner });
    const rh = records.get(h.team_id);
    const ra = records.get(a.team_id);
    if (rh === undefined || ra === undefined) continue;
    const hpf = hp !== null && Number.isFinite(hp) ? hp : 0;
    const apf = ap !== null && Number.isFinite(ap) ? ap : 0;
    rh.pf += hpf;
    rh.pa += apf;
    ra.pf += apf;
    ra.pa += hpf;
    if (winner === "HOME") {
      rh.w += 1;
      ra.l += 1;
    } else if (winner === "AWAY") {
      ra.w += 1;
      rh.l += 1;
    } else {
      rh.t += 1;
      ra.t += 1;
    }
  }
  if (unknownRows > 0)
    findings.push(
      finding(
        "schedule_unknown_team",
        null,
        `${String(unknownRows)} regular-season row(s) name a team outside the standings (or a team against itself): skipped`,
      ),
    );
  if (undecided.length > 0)
    findings.push(
      finding(
        "season_unfinished",
        null,
        `${String(undecided.length)} regular-season row(s) undecided (periods ${ids([...new Set(undecided)].sort((x, y) => x - y))})`,
      ),
    );
  return { games, findings, records };
}

/** Seeds form a permutation of 1..N. */
function seedsComplete(input: SeasonReproductionInput): boolean {
  const n = input.teams.length;
  const seeds = input.teams.map((t) => t.playoff_seed);
  return (
    seeds.every((s) => s !== null && Number.isInteger(s) && s >= 1 && s <= n) &&
    new Set(seeds).size === n
  );
}

/** One reading's reproduction. */
function readingOf(
  mode: SeedingMode,
  teams: readonly FinalStandingTeam[],
  games: readonly FinalGame[],
  input: SeasonReproductionInput,
  complete: boolean,
): ReadingReproduction {
  const rule = input.playoff.seeding_rule;
  const forward = rankFinalStandings({ teams, games, mode, rule, coin: "forward" });
  const reverse = rankFinalStandings({ teams, games, mode, rule, coin: "reverse" });
  const chain = forward.chain;
  const same = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const coin = !same(forward.order, reverse.order);
  // the deepest level needed: the fewest leading levels after which no tie survives (ranking the
  // team list and its reverse agree)
  const reversed = [...teams].reverse();
  let depth = chain.length;
  for (let k = 0; k <= chain.length; k++) {
    const a = rankFinalStandings({ teams, games, mode, rule, levels: k }).order;
    const b = rankFinalStandings({ teams: reversed, games, mode, rule, levels: k }).order;
    if (same(a, b)) {
      depth = k;
      break;
    }
  }
  const deciding: TieLevel | null = depth === 0 ? null : (chain[depth - 1] ?? null);
  const seedOf = new Map(input.teams.map((t) => [t.team_id, t.playoff_seed] as const));
  const order = forward.order;
  const mismatches: SeedMismatch[] = order.flatMap((team_id, i) => {
    const seed = seedOf.get(team_id) ?? null;
    return seed === i + 1 ? [] : [{ team_id, seed, predicted: i + 1 }];
  });
  const P =
    input.playoff.team_count !== null &&
    Number.isInteger(input.playoff.team_count) &&
    input.playoff.team_count >= 1
      ? Math.min(input.playoff.team_count, order.length)
      : order.length;
  const fieldOk = order.slice(0, P).every((team_id, i) => seedOf.get(team_id) === i + 1);
  // consistent up to the coin: with ESPN's seed order as the tie order and the coin level removed,
  // the chain returns ESPN's order exactly
  let consistent = false;
  if (complete) {
    const bySeed = [...teams].sort(
      (x, y) => (seedOf.get(x.team_id) ?? 0) - (seedOf.get(y.team_id) ?? 0),
    );
    const levels = chain.at(-1) === "coin_flip" ? chain.length - 1 : chain.length;
    const r = rankFinalStandings({ teams: bySeed, games, mode, rule, levels }).order;
    consistent = r.every((team_id, i) => seedOf.get(team_id) === i + 1);
  }
  return Object.freeze({
    seeding_mode: mode,
    chain: Object.freeze([
      ...(forward.divisions_first ? ["division_winners_first"] : []),
      ...chain,
    ]),
    order: Object.freeze([...order]),
    exact: complete && !coin && mismatches.length === 0,
    field_exact: complete && !coin && fieldOk,
    consistent_up_to_coin: consistent,
    coin_flip_decides: coin,
    deciding_level: deciding,
    mismatches: Object.freeze(mismatches),
  });
}

/** The empty reading of a season that cannot be ranked (invalid standings). */
function unranked(mode: SeedingMode): ReadingReproduction {
  return Object.freeze({
    seeding_mode: mode,
    chain: Object.freeze([]),
    order: Object.freeze([]),
    exact: false,
    field_exact: false,
    consistent_up_to_coin: false,
    coin_flip_decides: false,
    deciding_level: null,
    mismatches: Object.freeze([]),
  });
}

const LEVEL_WORDS: Readonly<Record<TieLevel, string>> = Object.freeze({
  win_pct: "win %",
  points_for: "points for",
  head_to_head: "head-to-head",
  division_record: "division record",
  points_against: "points against",
  coin_flip: "the coin flip",
});

/**
 * Reproduces one finished season's `playoffSeed` under both readings. Never throws on data: a
 * malformed season returns `reproduced_by: "neither"` with the findings that say why.
 */
export function reproduceSeason(input: SeasonReproductionInput): SeasonReproduction {
  const findings: ReproductionFinding[] = [];
  const n = input.teams.length;
  const divisions = new Set(
    input.teams.map((t) => t.division_id).filter((d): d is number => d !== null),
  ).size;
  const valid =
    n >= 2 &&
    n <= 20 &&
    new Set(input.teams.map((t) => t.team_id)).size === n &&
    input.teams.every(
      (t) =>
        Number.isInteger(t.team_id) &&
        [t.wins, t.losses, t.ties, t.points_for, t.points_against].every(
          (x) => Number.isFinite(x) && x >= 0,
        ),
    );
  const base = {
    season: input.season,
    teams: n,
    playoff_team_count: input.playoff.team_count,
    rule: input.playoff.seeding_rule,
    rule_by: input.playoff.seeding_rule_by,
    divisions,
  };
  if (!valid) {
    findings.push(
      finding(
        "standings_invalid",
        null,
        "the standings are not 2–20 distinct teams with finite, non-negative records: nothing ranked",
      ),
    );
    return Object.freeze({
      ...base,
      regular_games: 0,
      records_agree: false,
      espn_rule: unranked("espn_rule"),
      points_only: unranked("points_only"),
      reproduced_by: "neither",
      findings: Object.freeze(findings),
      note: `${String(input.season)}: not reproduced — the standings are invalid`,
    });
  }
  const season = regularSeason(input);
  findings.push(...season.findings);
  const differing = input.teams
    .filter((t) => {
      const r = season.records.get(t.team_id);
      if (r === undefined) return true;
      return (
        r.w !== t.wins ||
        r.l !== t.losses ||
        r.t !== t.ties ||
        Math.abs(r.pf - t.points_for) > RECORDS_TOLERANCE ||
        Math.abs(r.pa - t.points_against) > RECORDS_TOLERANCE
      );
    })
    .map((t) => t.team_id)
    .sort((a, b) => a - b);
  const recordsAgree = season.games.length > 0 && differing.length === 0;
  if (season.games.length > 0 && differing.length > 0)
    findings.push(
      finding(
        "records_disagree",
        null,
        `the standings differ from the recomputed regular season for team(s) ${ids(differing)}`,
      ),
    );
  const complete = seedsComplete(input);
  if (!complete)
    findings.push(
      finding("seeds_incomplete", null, `playoffSeed is not a permutation of 1..${String(n)}`),
    );
  if (input.playoff_edited === true)
    findings.push(
      finding(
        "playoff_edited",
        null,
        "the commissioner edited the playoff bracket (isPlayoffMatchupEdited)",
      ),
    );
  const teams: FinalStandingTeam[] = input.teams.map((t) => ({
    team_id: t.team_id,
    division_id: t.division_id,
    wins: t.wins,
    losses: t.losses,
    ties: t.ties,
    points_for: t.points_for,
    points_against: t.points_against,
  }));
  const a = readingOf("espn_rule", teams, season.games, input, complete);
  const b = readingOf("points_only", teams, season.games, input, complete);
  if (
    !rankFinalStandings({ teams, games: [], mode: "espn_rule", rule: input.playoff.seeding_rule })
      .known_rule
  )
    findings.push(
      finding(
        "rule_unknown",
        "espn_rule",
        `playoffSeedingRule "${/^[A-Z_]{1,40}$/.test(input.playoff.seeding_rule) ? input.playoff.seeding_rule : "?"}" is not one ESPN is known to send: read as TOTAL_POINTS_SCORED`,
      ),
    );
  for (const r of [a, b])
    if (r.coin_flip_decides)
      findings.push(
        finding(
          "coin_flip_decides",
          r.seeding_mode,
          `a tie survives every level above the coin flip under ${r.seeding_mode}; ESPN's seeds are ${r.consistent_up_to_coin ? "" : "not "}consistent with the chain above it`,
        ),
      );
  const reproducedBy: SeasonReproduction["reproduced_by"] =
    a.exact && b.exact ? "both" : a.exact ? "espn_rule" : b.exact ? "points_only" : "neither";
  if (reproducedBy === "neither" && complete)
    for (const r of [a, b])
      if (r.mismatches.length > 0)
        findings.push(
          finding(
            "seed_mismatch",
            r.seeding_mode,
            `${String(r.mismatches.length)} of ${String(n)} seeds differ under ${r.seeding_mode} (${r.mismatches
              .slice(0, 6)
              .map(
                (m) =>
                  `team ${String(m.team_id)}: seed ${String(m.seed)}, chain ${String(m.predicted)}`,
              )
              .join("; ")}${r.mismatches.length > 6 ? "; …" : ""})`,
          ),
        );
  const used = reproducedBy === "points_only" ? b : a;
  const depth =
    used.deciding_level === null
      ? "no tiebreak needed"
      : `ties broken down to ${LEVEL_WORDS[used.deciding_level]}`;
  const why = explanations(findings, [a, b]);
  const note =
    reproducedBy === "neither"
      ? `${String(input.season)}: not reproduced — ${why.length > 0 ? why.join("; ") : "unexplained seed mismatch"}`
      : `${String(input.season)}: reproduced exactly under ${reproducedBy === "both" ? "both readings" : reproducedBy} (${used.chain.includes("division_winners_first") ? "division winners first, " : ""}${depth})`;
  return Object.freeze({
    ...base,
    regular_games: season.games.length,
    records_agree: recordsAgree,
    espn_rule: a,
    points_only: b,
    reproduced_by: reproducedBy,
    findings: Object.freeze(findings),
    note,
  });
}

/**
 * Whether a season reproduces, or carries what explains why not: a season-level finding, or a
 * coin flip under a reading whose chain ESPN's seeds follow everywhere above it.
 */
export function isExplained(s: SeasonReproduction): boolean {
  return (
    s.reproduced_by !== "neither" ||
    explanations(s.findings, [s.espn_rule, s.points_only]).length > 0
  );
}

/**
 * C4 over many seasons: met when ≥ `minSeasons` seasons reproduce exactly under reading (a) and
 * every season either reproduces under one reading or carries a finding that explains why not.
 */
export function summarizeReproductions(
  seasons: readonly SeasonReproduction[],
  minSeasons: number = C4_MIN_SEASONS,
): ReproductionSummary {
  const ordered = [...seasons].sort((x, y) => x.season - y.season);
  const a = ordered.filter((s) => s.espn_rule.exact).length;
  const b = ordered.filter((s) => s.points_only.exact).length;
  const neither = ordered.filter((s) => s.reproduced_by === "neither").map((s) => s.season);
  return Object.freeze({
    seasons: Object.freeze(ordered),
    reproduced_espn_rule: a,
    reproduced_points_only: b,
    neither: Object.freeze(neither),
    c4_met: a >= minSeasons && ordered.every(isExplained),
    min_seasons: minSeasons,
  });
}

/**
 * The reproduction input from a previous season read through the provider (`getStandings`,
 * `getMatchups`, `getLeagueRules`, and `getLeague` for the bracket-edit flag when it is available).
 */
export function reproductionInputFrom(args: {
  readonly season: number;
  readonly standings: readonly Pick<
    Standing,
    | "team_id"
    | "division_id"
    | "playoff_seed"
    | "wins"
    | "losses"
    | "ties"
    | "points_for"
    | "points_against"
  >[];
  readonly matchups: readonly Pick<
    Matchup,
    "matchup_period" | "winner" | "is_bye" | "home" | "away"
  >[];
  readonly rules: Pick<LeagueRules, "playoffs">;
  readonly league?: Pick<League, "playoff_matchup_edited"> | null;
}): SeasonReproductionInput {
  return {
    season: args.season,
    teams: args.standings.map((t) => ({
      team_id: t.team_id,
      division_id: t.division_id,
      playoff_seed: t.playoff_seed,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      points_for: t.points_for,
      points_against: t.points_against,
    })),
    matchups: args.matchups.map((m) => ({
      matchup_period: m.matchup_period,
      winner: m.winner,
      is_bye: m.is_bye,
      home: { team_id: m.home.team_id, points: m.home.points },
      away: m.away === null ? null : { team_id: m.away.team_id, points: m.away.points },
    })),
    playoff: {
      team_count: args.rules.playoffs.team_count,
      seeding_rule: args.rules.playoffs.seeding_rule,
      seeding_rule_by: args.rules.playoffs.seeding_rule_by,
      regular_season_matchups: args.rules.playoffs.regular_season_matchups,
    },
    playoff_edited: args.league?.playoff_matchup_edited ?? null,
  };
}
