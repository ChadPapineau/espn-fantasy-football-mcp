// derive.ts — the pure derivations the dataset contract names (tables.ts `derivation` fields; plan 01
// §5.2 schedules/pro-schedule rows, research 04 §B.1.6 the ESPN game-id join, §C the espn_id lookup).
// Shared by the sources that fill the tables and the store readers that read them; no I/O, no clock.
// Ported from sibling @5302d5c, adapted (ESPN id parsing, epoch-ms kickoffs, the nflverse game id
// derived from an ESPN pro game, ESPN team spellings).
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
