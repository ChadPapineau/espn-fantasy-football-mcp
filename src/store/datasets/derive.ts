// derive.ts — the pure derivations the dataset contract names (tables.ts `derivation` fields; plan 01
// §5.2 schedules/pro-schedule rows, research 04 §B.1.6 the ESPN game-id join, §C the espn_id lookup).
// Shared by the sources that fill the tables and the store readers that read them; no I/O, no clock.
// Ported from sibling @5302d5c, adapted (ESPN id parsing, epoch-ms kickoffs, the nflverse game id
// derived from an ESPN pro game, ESPN team spellings). Phase 2 (plan 10 §3.2) adds the pbp, snap-count,
// depth-chart, ffopportunity, Sleeper and RSS derivations at the end of the file.
import { createHash } from "node:crypto";
import { isNflTeam, type NflTeam } from "../../config/schema.js";
import { ESPN_TO_NFLVERSE_TEAM } from "../../domain/crosswalk/types.js";

/** The zone nflverse `schedules.gametime` is written in (research 04 §B.1.6 "gameday+gametime ET"). */
export const NFLVERSE_KICKOFF_TZ = "America/New_York";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (wall − UTC). Throws on a bad zone. */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts a wall-clock date + `HH:MM` in `timeZone` to a UTC ISO-8601 instant
 * (`YYYY-MM-DDTHH:MM:00.000Z`). Returns null for anything malformed (bad shape, month 13, Feb 30,
 * 24:00, non-string input) — never throws on data. An unknown zone is a programming error and throws.
 * A wall time inside a spring-forward gap resolves with the pre-transition offset (deterministic;
 * no NFL kickoff is scheduled at 02:xx).
 */
export function wallTimeToUtcIso(date: unknown, time: unknown, timeZone: string): string | null {
  if (typeof date !== "string" || typeof time !== "string") return null;
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [hh, mm] = [Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || hh > 23 || mm > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, hh, mm);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  // Two-pass fixed point: the offset at the guessed instant, then at the corrected one.
  const off1 = zoneOffsetMs(timeZone, naive);
  let utc = naive - off1;
  const off2 = zoneOffsetMs(timeZone, utc);
  if (off2 !== off1) utc = naive - off2;
  return new Date(utc).toISOString();
}

/** `ds_schedules.kickoff_utc` from nflverse `gameday` + `gametime` (America/New_York). */
export function kickoffUtcFromEastern(gameday: unknown, gametime: unknown): string | null {
  return wallTimeToUtcIso(gameday, gametime, NFLVERSE_KICKOFF_TZ);
}

/**
 * Text normalisation applied to every stored TEXT column of the contract: null/undefined, a
 * non-string, or a string that is empty after trimming → null; otherwise the trimmed string.
 * (roster_weekly 2026 carries `yahoo_id = ""` rows and games.parquet `roof = ""` — an empty value
 * must never match a lookup.)
 */
export function emptyToNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * `ds_schedules.roof`: nflverse writes `""` for retractable roofs whose state is not yet known (34 of
 * the 272 games of 2026 on 2026-10-06, all at ATL/DAL/HOU/IND/ARI plus Madrid). `""` → null (the
 * reader then falls back to the venue's `roof_default`); anything else is trimmed + lower-cased.
 */
export function normalizeRoof(v: unknown): string | null {
  const t = emptyToNull(v);
  return t === null ? null : t.toLowerCase();
}

/**
 * A parquet DATE (hyparquet yields a `Date`; a string or day count is accepted defensively) → an
 * ISO calendar date `YYYY-MM-DD`, or null when absent/invalid. (`roster_weekly.birth_date` is a
 * DATE; `players.birth_date` is already a `YYYY-MM-DD` string.)
 */
export function isoDate(v: unknown): string | null {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "string" && DATE_RE.test(v)) d = new Date(`${v}T00:00:00.000Z`);
  else if (typeof v === "number" && Number.isInteger(v)) d = new Date(v * 86_400_000);
  if (!d || Number.isNaN(d.getTime())) return null;
  const s = d.toISOString();
  if (s.length !== 24) return null;
  const out = s.slice(0, 10);
  // A string must round-trip: V8 rolls "2001-02-30" over to March 2 instead of rejecting it.
  return typeof v === "string" && out !== v ? null : out;
}

/** Implied team points from nflverse `spread_line` (+ = home favoured) and `total_line`. */
export interface ImpliedPoints {
  readonly away: number | null;
  readonly home: number | null;
}

/**
 * home = (total + spread) / 2, away = (total − spread) / 2 (research 05 §8 implied totals; the
 * nflverse dictionary: "a positive number means the home team was favored"). Both null when either
 * input is null or non-finite.
 */
export function impliedPoints(spreadLine: unknown, totalLine: unknown): ImpliedPoints {
  if (
    typeof spreadLine !== "number" ||
    typeof totalLine !== "number" ||
    !Number.isFinite(spreadLine) ||
    !Number.isFinite(totalLine)
  ) {
    return { away: null, home: null };
  }
  return { away: (totalLine - spreadLine) / 2, home: (totalLine + spreadLine) / 2 };
}

// --- ESPN-specific derivations ----------------------------------------------------------------------

/** A positive decimal integer with no sign, no leading zero, no exponent, ≤ 16 digits. */
const DECIMAL_ID_RE = /^[1-9][0-9]{0,15}$/;

/**
 * An upstream id written as text (nflverse `espn_id`, `schedules.espn`, both BYTE_ARRAY strings) →
 * a positive safe integer, or null. Accepts a trimmed decimal string, a positive safe integer
 * number, or a positive bigint within the safe range (hyparquet yields INT64 as bigint). Rejects
 * everything else — `"0"`, `"012"`, `"1e5"`, `"0x10"`, `"12.0"`, `"-3"`, `"+3"`, NaN, fractions,
 * full-width digits — so a malformed id can never become a different player's id.
 */
export function parseDecimalId(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "bigint") {
    return v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
  }
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!DECIMAL_ID_RE.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** Latest instant accepted as an ESPN epoch-ms date (year 9999) — anything past it is garbage. */
const MAX_EPOCH_MS = 253_402_300_799_999;

/**
 * An ESPN epoch-ms timestamp (`proTeamSchedules_wl` game `date`, `players_wl` `lastNewsDate`) →
 * the integer it is, or null when it is not a non-negative safe integer ≤ year 9999.
 */
export function epochMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_EPOCH_MS) return null;
  return v;
}

/** `epochMs` as an ISO-8601 UTC instant, or null (what readers emit for a stored `*_ms` column). */
export function epochMsToIso(v: unknown): string | null {
  const ms = epochMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

/** An ESPN boolean flag → 1 | 0 for a STRICT INTEGER column; anything but a boolean → null. */
export function boolToInt(v: unknown): 0 | 1 | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

/**
 * `proTeams[].byeWeek` → the bye week 1–22, or null. ESPN writes `0` for the free-agent pseudo-team
 * (id 0) — no bye, not "week 0".
 */
export function byeWeek(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 22 ? v : null;
}

/**
 * nflverse `players.jersey_number` (a string there; an INT32 in roster_weekly) → an integer 0–99, or
 * null for anything else.
 */
export function jerseyNumber(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^[0-9]{1,2}$/.test(v.trim())) n = Number(v.trim());
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

/**
 * An ESPN pro-team abbreviation → the nflverse spelling (research 04 §C: `WSH`→`WAS`, `LAR`→`LA`;
 * every other team is spelled the same), or null when it is not an NFL team (`FA`, unknown, hostile).
 */
export function espnAbbrevToNflverse(abbrev: unknown): NflTeam | null {
  if (typeof abbrev !== "string") return null;
  const mapped = Object.hasOwn(ESPN_TO_NFLVERSE_TEAM, abbrev)
    ? ESPN_TO_NFLVERSE_TEAM[abbrev]
    : abbrev;
  return mapped !== undefined && isNflTeam(mapped) ? mapped : null;
}

/**
 * The nflverse `game_id` of a game: `<season>_<week, 2 digits>_<away>_<home>` with nflverse team
 * abbreviations. Verified 272/272 on 2026-10-06 against games.parquet by deriving it from every game
 * of the recorded `proTeamSchedules_wl` (ESPN ids matching the `espn` column) — so the weather source,
 * which is driven by the ESPN pro schedule (src/sources/source.ts `SourceContext.datasets`), keys its
 * rows exactly as `ds_schedules` does. Null for a season outside 1999–2999, a week outside 1–22, or a
 * team that is not an nflverse abbreviation (pass ESPN spellings through `espnAbbrevToNflverse`).
 */
export function nflverseGameId(
  season: unknown,
  week: unknown,
  away: unknown,
  home: unknown,
): string | null {
  if (typeof season !== "number" || !Number.isInteger(season) || season < 1999 || season > 2999)
    return null;
  if (typeof week !== "number" || !Number.isInteger(week) || week < 1 || week > 22) return null;
  if (typeof away !== "string" || typeof home !== "string") return null;
  if (!isNflTeam(away) || !isNflTeam(home) || away === home) return null;
  return `${String(season)}_${String(week).padStart(2, "0")}_${away}_${home}`;
}

// --- Phase-2 derivations (plan 10 §3.2 sources; plan 01 §5.2 rows; research 04 §A #2 #5 #7 #13 #15) --
// Grounded on the 2024–2026 release files read on 2026-10-06 (docs/evals/phase2-datasets.md). Every
// function is total: malformed, hostile or out-of-range input returns null (or false), never throws.

/** A finite number (or a safe bigint) → that number; NaN, ±Infinity and every non-number → null. */
export function finiteOrNull(v: unknown): number | null {
  if (typeof v === "bigint")
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A whole number stored as DOUBLE upstream (pbp `play_id`, `yards_gained`, `kick_distance`; snap
 * counts; ffopportunity `week`) → a safe integer of either sign, or null (fraction, NaN, out of range,
 * non-number). `-0` reads as 0.
 */
export function wholeNumber(v: unknown): number | null {
  const n = finiteOrNull(v);
  if (n === null || !Number.isSafeInteger(n)) return null;
  return n === 0 ? 0 : n;
}

/** A 0/1 indicator (nflverse pbp writes them as DOUBLE) → 0 | 1; a boolean maps too; else null. */
export function flag01(v: unknown): 0 | 1 | null {
  if (v === true || v === 1 || v === 1n) return 1;
  if (v === false || v === 0 || v === 0n) return 0;
  return null;
}

/** A share in [0, 1] (snap counts' `*_pct` are fractions, observed 0–1) → itself; else null. */
export function fraction01(v: unknown): number | null {
  const n = finiteOrNull(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

/**
 * A season written as text (ffopportunity `ep_weekly.season` is a string, "2026") or as an integer
 * → 1999–2999, else null. Decimal digits only: "2026.0", " 2026x", "２０２６" are null.
 */
export function seasonFromText(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^[0-9]{4}$/.test(v.trim())) n = Number(v.trim());
  return n !== null && Number.isInteger(n) && n >= 1999 && n <= 2999 ? n : null;
}

/** The red zone: the offence at or inside the opponent's 20 (`yardline_100 ≤ 20`; plan 07 D1 rz_*). */
export const RED_ZONE_YARDLINE = 20;
/** Goal line: at or inside the opponent's 5 (`yardline_100 ≤ 5`; plan 07 D1 gl_carries). */
export const GOAL_LINE_YARDLINE = 5;

function yardline(v: unknown): number | null {
  const n = wholeNumber(v);
  return n !== null && n >= 1 && n <= 99 ? n : null;
}

/** `ds_pbp.rz` from `yardline_100` (1–99, yards from the opponent's end zone) → 1 | 0; else null. */
export function redZoneFlag(yardline100: unknown): 0 | 1 | null {
  const y = yardline(yardline100);
  return y === null ? null : y <= RED_ZONE_YARDLINE ? 1 : 0;
}

/** `ds_pbp.gl` from `yardline_100` → 1 | 0 (inside the 5); else null. */
export function goalLineFlag(yardline100: unknown): 0 | 1 | null {
  const y = yardline(yardline100);
  return y === null ? null : y <= GOAL_LINE_YARDLINE ? 1 : 0;
}

/**
 * The pbp play types `ds_pbp` keeps: every snap and kick. Dropped: `null` (period, timeout and
 * two-minute markers) and `no_play` (penalty-nullified plays — no nflverse stat counts them; with
 * this filter the pbp-derived targets, carries, TDs and FG attempts equal `stats_player_week` on
 * every 2024–2026 player-week but one carry, docs/evals/phase2-datasets.md).
 */
export const PBP_KEPT_PLAY_TYPES = Object.freeze([
  "pass",
  "run",
  "field_goal",
  "extra_point",
  "kickoff",
  "punt",
  "qb_kneel",
  "qb_spike",
] as const);
export type PbpPlayType = (typeof PBP_KEPT_PLAY_TYPES)[number];

/** Whether a pbp `play_type` is kept (exact, case-sensitive). */
export function isKeptPlayType(v: unknown): v is PbpPlayType {
  return typeof v === "string" && (PBP_KEPT_PLAY_TYPES as readonly string[]).includes(v);
}

/** The pbp facts that classify a return touchdown (`ds_pbp` columns). */
export interface ReturnPlay {
  readonly play_type: unknown;
  readonly return_touchdown: unknown;
  readonly td_player_id: unknown;
  readonly kickoff_returner_player_id: unknown;
  readonly punt_returner_player_id: unknown;
}

/**
 * The plan 08 §3.2 `kr_td` / `pr_td` split of a play: `kr` when a kickoff is returned for a TD BY
 * its returner, `pr` likewise for a punt; null otherwise — a muffed punt the kicking team recovers
 * for a TD and a blocked-kick return are not the returner's (2024–2025 pbp: 13 such plays, which is
 * why player `special_teams_tds` is not simply kr + pr).
 */
export function returnTdKind(p: ReturnPlay): "kr" | "pr" | null {
  if (p.return_touchdown !== 1 || typeof p.td_player_id !== "string" || p.td_player_id === "")
    return null;
  if (p.play_type === "kickoff" && p.td_player_id === p.kickoff_returner_player_id) return "kr";
  if (p.play_type === "punt" && p.td_player_id === p.punt_returner_player_id) return "pr";
  return null;
}

/**
 * A depth-chart label (`pos_grp` "3WR 1TE" / "Base 4-3 D" / "Special Teams", `pos_abb` "LDE", legacy
 * `formation` and `depth_position`): a letter or digit, then up to 31 of letters, digits, space and
 * `. / & + -`. Third-party text, so it is held to this grammar at load and never emitted otherwise.
 */
export const DEPTH_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ./&+-]{0,31}$/;

/** A depth-chart label → trimmed, inner whitespace collapsed, when it fits DEPTH_LABEL_RE; else null. */
export function depthLabel(v: unknown): string | null {
  const t = emptyToNull(v);
  if (t === null) return null;
  const s = t.replace(/\s+/g, " ");
  return DEPTH_LABEL_RE.test(s) ? s : null;
}

/** A small non-negative id written as text (`pos_grp_id`, `pos_id`: "0"–"999999") → integer; else null. */
export function nonNegativeDecimal(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 && v <= 999_999 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^(0|[1-9][0-9]{0,5})$/.test(t) ? Number(t) : null;
}

/** Legacy (≤ 2024) `depth_charts.depth_team` "1".."9" (text) → the rank 1–9; else null. */
export function legacyDepthRank(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 9 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^[1-9]$/.test(t) ? Number(t) : null;
}

const SNAPSHOT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * A depth-chart snapshot stamp (the 2025+ schema's `dt`, always `YYYY-MM-DDTHH:MM:SSZ` — 441
 * distinct stamps in 2025–2026) → epoch ms; any other shape or an impossible date → null.
 */
export function depthSnapshotMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = SNAPSHOT_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1999 || y > 2999 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  return back.getUTCDate() === d && back.getUTCMonth() === mo - 1 ? ms : null;
}

/** One validated row of a 2025+ depth-chart snapshot (the derivations already applied). */
export interface DepthSnapshotRow {
  readonly team: string;
  readonly espn_id: number;
  readonly gsis_id: string | null;
  readonly player_name: string | null;
  readonly pos_grp_id: number;
  readonly pos_grp: string;
  readonly pos_id: number;
  readonly pos_abb: string;
  readonly pos_slot: number;
  readonly pos_rank: number;
  /** `depthSnapshotMs(dt)`. */
  readonly dt_ms: number;
}

/** One `ds_depth_charts` row: an occupant's unbroken run in one slot across a team's snapshots. */
export interface DepthRun extends Omit<DepthSnapshotRow, "dt_ms"> {
  /** The first snapshot of the run. */
  readonly valid_from_ms: number;
  /** The last snapshot of the run that still shows this occupant. */
  readonly last_seen_ms: number;
  /** The team's next snapshot after `last_seen_ms` (exclusive end); null = still in the newest one. */
  readonly valid_to_ms: number | null;
  /** How many of the team's snapshots the run spans. */
  readonly snapshots: number;
}

/** What `depthChartRuns` returns: the runs plus how many duplicate slot rows it dropped. */
export interface DepthRuns {
  readonly runs: readonly DepthRun[];
  /** Rows naming a (team, snapshot, pos_grp_id, pos_slot, pos_rank) already taken (none observed). */
  readonly duplicates: number;
}

const occupantKey = (r: DepthSnapshotRow): string =>
  JSON.stringify([r.espn_id, r.gsis_id, r.player_name, r.pos_grp, r.pos_id, r.pos_abb]);

/**
 * Compresses the 2025+ depth-chart file — one full snapshot of every team per day (~220 a season,
 * 613,196 rows in 2026) — into runs: a slot (team, pos_grp_id, pos_slot, pos_rank) keeps a row while
 * the same occupant holds it in CONSECUTIVE snapshots of its team (12,046 rows in 2026; the chart as
 * of any instant T is `valid_from_ms ≤ T < valid_to_ms`, the current chart `valid_to_ms IS NULL`).
 * Deterministic for any input order; a second row for a taken slot in one snapshot is dropped (the
 * lowest espn_id wins) and counted. Pure: no I/O, no clock.
 */
export function depthChartRuns(rows: Iterable<DepthSnapshotRow>): DepthRuns {
  const teamSnaps = new Map<string, Set<number>>();
  const slots = new Map<string, Map<number, DepthSnapshotRow>>();
  let duplicates = 0;
  for (const r of rows) {
    let ts = teamSnaps.get(r.team);
    if (!ts) teamSnaps.set(r.team, (ts = new Set<number>()));
    ts.add(r.dt_ms);
    const slotKey = JSON.stringify([r.team, r.pos_grp_id, r.pos_slot, r.pos_rank]);
    let bySnap = slots.get(slotKey);
    if (!bySnap) slots.set(slotKey, (bySnap = new Map<number, DepthSnapshotRow>()));
    const prior = bySnap.get(r.dt_ms);
    if (prior === undefined) bySnap.set(r.dt_ms, r);
    else {
      duplicates++;
      if (
        r.espn_id < prior.espn_id ||
        (r.espn_id === prior.espn_id && occupantKey(r) < occupantKey(prior))
      )
        bySnap.set(r.dt_ms, r);
    }
  }
  const order = new Map<string, number[]>();
  for (const [team, set] of teamSnaps)
    order.set(
      team,
      [...set].sort((a, b) => a - b),
    );
  const runs: DepthRun[] = [];
  const emit = (
    row: DepthSnapshotRow,
    from: number,
    last: number,
    n: number,
    to: number | null,
  ) => {
    runs.push({
      team: row.team,
      espn_id: row.espn_id,
      gsis_id: row.gsis_id,
      player_name: row.player_name,
      pos_grp_id: row.pos_grp_id,
      pos_grp: row.pos_grp,
      pos_id: row.pos_id,
      pos_abb: row.pos_abb,
      pos_slot: row.pos_slot,
      pos_rank: row.pos_rank,
      valid_from_ms: from,
      last_seen_ms: last,
      valid_to_ms: to,
      snapshots: n,
    });
  };
  for (const bySnap of slots.values()) {
    const first = bySnap.values().next().value;
    if (first === undefined) continue;
    const snaps = order.get(first.team) ?? [];
    let cur: DepthSnapshotRow | null = null;
    let curKey = "";
    let from = 0;
    let last = 0;
    let n = 0;
    for (const ms of snaps) {
      const row = bySnap.get(ms);
      const key = row === undefined ? null : occupantKey(row);
      if (cur !== null && key !== curKey) {
        emit(cur, from, last, n, ms);
        cur = null;
      }
      if (row === undefined || key === null) continue;
      if (cur === null) {
        cur = row;
        curKey = key;
        from = ms;
        n = 0;
      }
      last = ms;
      n++;
    }
    if (cur !== null) emit(cur, from, last, n, null);
  }
  runs.sort(
    (a, b) =>
      (a.team < b.team ? -1 : a.team > b.team ? 1 : 0) ||
      a.pos_grp_id - b.pos_grp_id ||
      a.pos_slot - b.pos_slot ||
      a.pos_rank - b.pos_rank ||
      a.valid_from_ms - b.valid_from_ms,
  );
  return { runs, duplicates };
}

/** A Sleeper `player_id`: decimal digits (a person) or a 2–3 letter team code (a defence); else null. */
export function sleeperPlayerId(v: unknown): string | null {
  const t = emptyToNull(v);
  return t !== null && (/^[0-9]{1,10}$/.test(t) || /^[A-Z]{2,3}$/.test(t)) ? t : null;
}

/** A non-negative safe integer (a JSON count) → itself; else null. */
export function nonNegativeInt(v: unknown): number | null {
  const n = wholeNumber(v);
  return n !== null && n >= 0 ? n : null;
}

/** The RSS sources a `ds_news` file holds (plan 07 D6 `sources`; one dataset file each). */
export const NEWS_SOURCES = Object.freeze(["rotowire", "espn", "cbs"] as const);
export type NewsSource = (typeof NEWS_SOURCES)[number];

/** Items older than this before the fetch are not carried into the next file (plan 06 `store prune`). */
export const NEWS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The deterministic player-match methods of `ds_news_players` (plan 07 D6; never a model). */
export const NEWS_MATCH_METHODS = Object.freeze([
  "full_name_team",
  "full_name",
  "last_name_team",
] as const);
export type NewsMatchMethod = (typeof NEWS_MATCH_METHODS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ZONES: Readonly<Record<string, number>> = Object.freeze({
  GMT: 0,
  UT: 0,
  UTC: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
});
const RFC822_RE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([A-Z]{1,3}|[+-]\d{4})$/;
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function utcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  offsetMin: number,
): number | null {
  if (y < 1999 || y > 2999 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59)
    return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;
  return wall - offsetMin * 60_000;
}

/**
 * An RSS `pubDate` (RFC 822/1123: "Tue, 29 Sep 2026 14:50:00 EST", "+0000" offsets, the US zone
 * abbreviations and GMT/UT/UTC/Z) or an Atom ISO-8601 instant → epoch ms; anything else (an
 * unknown zone, an impossible date, a year outside 1999–2999) → null.
 */
export function rssDateMs(v: unknown): number | null {
  if (typeof v !== "string" || v.length > 64) return null;
  const t = v.trim().replace(/\s+/g, " ");
  const r = RFC822_RE.exec(t);
  if (r) {
    const mo = MONTHS.indexOf(r[2] ?? "") + 1;
    const z = r[7] ?? "";
    let off: number | undefined;
    if (/^[+-]\d{4}$/.test(z)) {
      const hh = Number(z.slice(1, 3));
      const mm = Number(z.slice(3, 5));
      if (hh > 14 || mm > 59) return null;
      off = (z.startsWith("-") ? -1 : 1) * (hh * 60 + mm);
    } else off = Object.hasOwn(ZONES, z) ? ZONES[z] : undefined;
    if (mo === 0 || off === undefined) return null;
    return utcMs(
      Number(r[3]),
      mo,
      Number(r[1]),
      Number(r[4]),
      Number(r[5]),
      Number(r[6] ?? "0"),
      off,
    );
  }
  const i = ISO_RE.exec(t);
  if (!i) return null;
  const z = i[8] ?? "Z";
  let off = 0;
  if (z !== "Z") {
    const hh = Number(z.slice(1, 3));
    const mm = Number(z.slice(4, 6));
    if (hh > 14 || mm > 59) return null;
    off = (z.startsWith("-") ? -1 : 1) * (hh * 60 + mm);
  }
  const base = utcMs(
    Number(i[1]),
    Number(i[2]),
    Number(i[3]),
    Number(i[4]),
    Number(i[5]),
    Number(i[6] ?? "0"),
    off,
  );
  return base === null ? null : base + Number((i[7] ?? "0").padEnd(3, "0"));
}

/**
 * `ds_news.link`: an absolute http(s) URL of ≤ 2 048 chars with a host and no whitespace, quote,
 * angle bracket or control character → the trimmed string; else null. Stored as text: never
 * fetched, never rendered as a link (plan 02 §6.2).
 */
export function httpUrlOrNull(v: unknown): string | null {
  const t = emptyToNull(v);
  if (t === null || t.length > 2048 || !/^https?:\/\/[^\s"'<>`\\\u0000-\u001f\u007f]+$/i.test(t))
    return null;
  try {
    const u = new URL(t);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" ? t : null;
  } catch {
    return null;
  }
}

/**
 * Third-party free text for storage: `emptyToNull`, then at most `max` code points (a storage
 * ceiling only — the `untrusted_text` wrapper strips and caps again at output, plan 02 §6.2).
 * Never interprets the text.
 */
export function capText(v: unknown, max: number): string | null {
  const t = emptyToNull(v);
  if (t === null || !Number.isInteger(max) || max < 1) return null;
  const cps = Array.from(t);
  return cps.length <= max ? t : cps.slice(0, max).join("");
}

/**
 * `ds_news.item_id`: the first 32 hex chars of sha256(`<source>\n<guid or, absent, link>`) — stable
 * across refreshes, so a re-fetched item dedups onto its first sighting; null when the source is
 * not a NEWS_SOURCE or both guid and link are empty.
 */
export function newsItemId(source: unknown, guid: unknown, link: unknown): string | null {
  if (typeof source !== "string" || !(NEWS_SOURCES as readonly string[]).includes(source))
    return null;
  const key = emptyToNull(guid) ?? emptyToNull(link);
  if (key === null) return null;
  return createHash("sha256").update(`${source}\n${key}`).digest("hex").slice(0, 32);
}
