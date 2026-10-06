// inputs.ts — the fx-10h generator's only door to ESPN data (plan 05 §3 fixture law; plan 09 §4,
// [A-2]; ADV OBJ-21): every body is read through the golden's own path guard
// (tests/golden/recorded.ts readRecorded — inside fixtures/espn/recorded/, listed `derived: false`,
// re-hashed body and scoring fields), and nothing is generated unless the recorded golden is green
// (every recorded box-score line of every league reproduced by the engine within 0.005 per stat
// and 0.01 per total). The raw `stats{}` of every recorded player-week are collected per player;
// no recorded scoring field is ever copied into the derived league (the engine re-scores them).
import {
  normalizeSettings,
  statLineFromEspn,
  verify,
  type ScoringSettings,
} from "../../src/domain/scoring/index.js";
import {
  finalWeeks,
  LEAGUES,
  MANIFEST,
  readRecorded,
  recordedScoringSettings,
  recordedTeamWeeks,
  type LeagueSlot,
} from "../../tests/golden/recorded.js";
import { arr, clone, FixtureGenError, isObj, num, obj, type Json, type Obj } from "./json.js";

/** The fixture season (the recordings' season). */
export const SEASON = 2026;

const RECORDED_CACHE = new Map<string, Obj>();

/**
 * Reads one recorded body (path under fixtures/espn/recorded/) through the golden's path guard —
 * once per process (the guard re-hashes the body); callers get a deep copy, never the cached value.
 */
export function recorded(rel: string): Obj {
  let body = RECORDED_CACHE.get(rel);
  if (body === undefined) {
    body = obj(readRecorded(rel), rel);
    RECORDED_CACHE.set(rel, body);
  }
  return clone(body);
}

/** A response split along `teams` (or the root) re-assembled in part order. */
export function recordedParts(prefix: string): Obj {
  const parts = MANIFEST.files
    .filter((f) => f.path.startsWith(`recorded/${prefix}.`) || f.path === `recorded/${prefix}.json`)
    .map((f) => f.path)
    .sort();
  if (parts.length === 0) throw new FixtureGenError(`fx-10h: no recording for ${prefix}`);
  const bodies = parts.map((p) => recorded(p.slice("recorded/".length)));
  const first = bodies[0];
  if (first === undefined) throw new FixtureGenError(`fx-10h: no recording for ${prefix}`);
  if (bodies.length === 1) return first;
  const out = clone(first);
  out.teams = bodies.flatMap((b) => arr(b.teams, `${prefix}.teams`));
  return out;
}

/**
 * The golden gate (plan 09 §4: "the script refuses to run unless the recorded golden is green"):
 * every actual and projected line of every recorded final week, of every league, scored under that
 * league's own recorded settings, matches ESPN per stat (0.005) and per total (0.01).
 */
export function assertRecordedGoldenGreen(): { lines: number } {
  let lines = 0;
  for (const league of LEAGUES) {
    const settings = normalizeSettings(recordedScoringSettings(league));
    for (const week of finalWeeks(league)) {
      for (const team of recordedTeamWeeks(league, week)) {
        for (const p of team.players) {
          for (const entry of [p.actual, p.projected]) {
            if (entry === undefined) continue;
            const line = statLineFromEspn({ raw: entry.stats }, p.position).line;
            const v = verify(line, settings, {
              total: entry.appliedTotal,
              by_stat: entry.appliedStats,
            });
            if (!v.match)
              throw new FixtureGenError(
                `fx-10h: the recorded golden is red (${league} week ${String(week)} player ${String(p.player_id)}) — refusing to derive anything`,
              );
            lines++;
          }
        }
      }
    }
  }
  return { lines };
}

/** One player's recorded identity and raw stats, collected across the three leagues. */
export interface PlayerRecord {
  readonly id: number;
  /** The newest recorded `player` object, without `stats` (the template for every view). */
  player: Obj;
  /** The newest recorded pool-entry fields around it (keeperValue, ratings, …), without `player`. */
  poolEntry: Obj;
  /** Where `player` came from: a lower rank is newer/preferred. */
  rank: number;
  /** Weekly actual raw stats (statSourceId 0, split 1). */
  readonly actual: Map<number, Obj>;
  /** Weekly projected raw stats (statSourceId 1, split 1). */
  readonly projected: Map<number, Obj>;
  /** Season-level raw stats of this season, keyed `<source>:<split>` (0:0 to date, 1:0, 1:2). */
  readonly season: Map<string, Obj>;
  /** The derivations applied to this player (e.g. `actual 4 ← 3`), for the README counts. */
  readonly derived: string[];
}

function statEntries(player: Obj, what: string): Obj[] {
  return arr(player.stats ?? [], `${what}.stats`).map((s, i) =>
    obj(s, `${what}.stats[${String(i)}]`),
  );
}

/** Records one recorded `player` (plus its pool entry) into the table; `rank` orders preference. */
function absorb(
  table: Map<number, PlayerRecord>,
  player: Obj,
  poolEntry: Obj,
  rank: number,
  what: string,
): void {
  const id = num(player.id, `${what}.id`);
  let rec = table.get(id);
  const template = clone(player);
  delete template.stats;
  const entry = clone(poolEntry);
  delete entry.player;
  if (rec === undefined) {
    rec = {
      id,
      player: template,
      poolEntry: entry,
      rank,
      actual: new Map(),
      projected: new Map(),
      season: new Map(),
      derived: [],
    };
    table.set(id, rec);
  } else if (rank < rec.rank) {
    rec.player = template;
    rec.poolEntry = entry;
    rec.rank = rank;
  }
  for (const s of statEntries(player, what)) {
    if (s.seasonId !== SEASON) continue;
    const sp = num(s.scoringPeriodId, `${what}.scoringPeriodId`);
    const source = num(s.statSourceId, `${what}.statSourceId`);
    const split = num(s.statSplitTypeId, `${what}.statSplitTypeId`);
    const raw = obj(s.stats ?? {}, `${what}.stats{}`);
    if (sp === 0) {
      const key = `${String(source)}:${String(split)}`;
      if (!rec.season.has(key)) rec.season.set(key, clone(raw));
      continue;
    }
    if (split !== 1) continue;
    const map = source === 0 ? rec.actual : source === 1 ? rec.projected : null;
    if (map !== null && !map.has(sp)) map.set(sp, clone(raw));
  }
}

/** The leagues in preference order: league-b (the fx-10h league) first. */
export const LEAGUE_ORDER: readonly LeagueSlot[] = ["league-b", "league-a", "league-c"];

let PLAYERS_CACHE: Map<number, PlayerRecord> | null = null;

/** A deep copy of a player table (variants mutate their own). */
function copyTable(t: Map<number, PlayerRecord>): Map<number, PlayerRecord> {
  const out = new Map<number, PlayerRecord>();
  for (const [id, r] of t)
    out.set(id, {
      id,
      player: clone(r.player),
      poolEntry: clone(r.poolEntry),
      rank: r.rank,
      actual: new Map([...r.actual].map(([w, x]) => [w, clone(x)])),
      projected: new Map([...r.projected].map(([w, x]) => [w, clone(x)])),
      season: new Map([...r.season].map(([k, x]) => [k, clone(x)])),
      derived: [...r.derived],
    });
  return out;
}

/** Every player recorded anywhere, with their raw weekly stats (computed once per process). */
export function collectPlayers(): Map<number, PlayerRecord> {
  PLAYERS_CACHE ??= collectPlayersUncached();
  return copyTable(PLAYERS_CACHE);
}

function collectPlayersUncached(): Map<number, PlayerRecord> {
  const table = new Map<number, PlayerRecord>();
  LEAGUE_ORDER.forEach((league, li) => {
    // the newest first: kona (week 4) before the week-3 roster before older weeks
    for (const file of [
      "kona_player_info.json",
      "kona_player_info.ids.json",
      "kona_playercard.json",
    ]) {
      const body = recorded(`${league}/${file}`);
      for (const [i, pe] of arr(body.players, `${league}/${file}.players`).entries()) {
        const entry = obj(pe, `${league}/${file}.players[${String(i)}]`);
        absorb(table, obj(entry.player, `${file}.player`), entry, li * 10, `${league}/${file}`);
      }
    }
    for (const week of [3, 2, 1]) {
      const body = recordedParts(`${league}/mRoster.sp${String(week)}`);
      for (const t of arr(body.teams, "teams")) {
        const roster = obj(obj(t, "team").roster, "roster");
        for (const e of arr(roster.entries, "entries")) {
          const pe = obj(obj(e, "entry").playerPoolEntry, "playerPoolEntry");
          absorb(
            table,
            obj(pe.player, "player"),
            pe,
            li * 10 + (4 - week),
            `${league} sp${String(week)}`,
          );
        }
      }
    }
    for (const week of finalWeeks(league)) {
      const body = recorded(`${league}/mBoxscore.sp${String(week)}.json`);
      for (const m of arr(body.schedule, "schedule")) {
        for (const side of ["home", "away"] as const) {
          const s = (m as Obj)[side];
          if (!isObj(s)) continue;
          const r = s.rosterForCurrentScoringPeriod;
          if (!isObj(r)) continue;
          for (const e of arr(r.entries, "entries")) {
            const pe = obj(obj(e, "entry").playerPoolEntry, "playerPoolEntry");
            absorb(
              table,
              obj(pe.player, "player"),
              pe,
              li * 10 + 9,
              `${league} box ${String(week)}`,
            );
          }
        }
      }
    }
  });
  return table;
}

/** The pro teams' bye weeks of the season (proTeamSchedules_wl). */
export function byeWeeks(): Map<number, number> {
  const body = recorded("season/proTeamSchedules_wl.json");
  const out = new Map<number, number>();
  for (const t of arr(obj(body.settings, "settings").proTeams, "proTeams")) {
    const team = obj(t, "proTeam");
    const bye = team.byeWeek;
    if (typeof bye === "number" && bye >= 1) out.set(num(team.id, "proTeam.id"), bye);
  }
  return out;
}

/**
 * Fills the weeks the recordings do not hold (plan 09 [A-2]: derived, plumbing only): week 4's
 * actual and projected lines copy the newest earlier recorded week's raw stats, and week 5's
 * projection copies week 4's; a player whose pro team is on bye that week gets no line.
 */
export function fillDerivedWeeks(
  table: Map<number, PlayerRecord>,
  byes: Map<number, number>,
): void {
  for (const rec of table.values()) {
    const proTeam = typeof rec.player.proTeamId === "number" ? rec.player.proTeamId : 0;
    const bye = byes.get(proTeam) ?? null;
    const fill = (map: Map<number, Obj>, week: number, kind: string): void => {
      if (map.has(week)) {
        if (bye === week) map.delete(week);
        return;
      }
      if (bye === week || proTeam === 0) return;
      for (let w = week - 1; w >= 1; w--) {
        const src = map.get(w);
        if (src === undefined) continue;
        map.set(week, clone(src));
        rec.derived.push(`${kind} ${String(week)} ← ${String(w)}`);
        return;
      }
    };
    fill(rec.actual, 4, "actual");
    fill(rec.projected, 4, "projected");
    fill(rec.projected, 5, "projected");
  }
}

/** The reference format's settings body: league-b's scoring items with item 4 at 5 (05 §0). */
export function referenceScoringSettings(): Obj {
  const ss = clone(
    obj(
      obj(recorded("league-b/mSettings.json").settings, "settings").scoringSettings,
      "scoringSettings",
    ),
  );
  const items = arr(ss.scoringItems, "scoringItems");
  let found = false;
  for (const it of items) {
    const item = obj(it, "scoringItem");
    if (item.statId === 4) {
      item.points = 5;
      found = true;
    }
  }
  if (!found) throw new FixtureGenError("fx-10h: league-b's scoring has no passing-TD item 4");
  return ss;
}

/** The normalized reference settings (the engine's S for every derived scoring field). */
export function referenceSettings(): ScoringSettings {
  return normalizeSettings(referenceScoringSettings());
}

export type { Json, Obj };
