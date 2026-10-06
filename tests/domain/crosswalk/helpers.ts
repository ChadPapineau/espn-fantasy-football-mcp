// helpers.ts — builders for the crosswalk tests over the shared fixture roster (fixtures/players,
// plan 10 A6a) and the recorded ESPN fixtures (fixtures/espn/recorded). Ported from sibling @8db206f,
// adapted (ESPN ids are the entry point; identities come from ESPN's own players_wl).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NflTeam } from "../../../src/config/schema.js";
import {
  buildNflPlayersIndex,
  buildRosterIndex,
  identityOf,
  resolveCrosswalk,
  type CrosswalkRun,
  type CrosswalkRunInput,
  type PersistedPairLookup,
} from "../../../src/domain/crosswalk/resolver.js";
import type {
  CrosswalkOverride,
  CrosswalkPair,
  EspnPlayerIdentity,
  NflPlayerRecord,
  NflRosterPlayer,
} from "../../../src/domain/crosswalk/types.js";
import { ESPN_PRO_TEAMS } from "../../../src/providers/espn/types.js";

/** One player of fixtures/players/fixture-roster.json. */
export interface FixturePlayer {
  readonly kind: "player";
  readonly espn_id: number;
  readonly espn_name: string;
  readonly espn_position_id: number;
  readonly espn_pro_team_id: number;
  readonly espn_team: string;
  readonly gsis_id: string;
  readonly nflverse_name: string;
  readonly position: string;
  readonly team: NflTeam;
  readonly jersey: number | null;
  readonly sleeper_id: string | null;
  readonly status: string;
  readonly roster_week: number | null;
  readonly id_source: "nflverse:roster_weekly" | "nflverse:players";
  readonly box_weeks: Readonly<Record<string, readonly number[]>>;
  readonly tags: readonly string[];
}

/** One team unit (D/ST, TQB) of the fixture roster. */
export interface FixtureUnit {
  readonly kind: "dst" | "tqb";
  readonly espn_id: number;
  readonly espn_name: string;
  readonly espn_position_id: number;
  readonly espn_pro_team_id: number;
  readonly espn_team: string;
  readonly team: NflTeam;
  readonly tags: readonly string[];
}

/** The nflverse-only decoy (same full name as a fixture player, other team and position). */
export interface FixtureDecoy {
  readonly kind: "nflverse_only";
  readonly collides_with_espn_id: number;
  readonly gsis_id: string;
  readonly nflverse_name: string;
  readonly position: string;
  readonly team: NflTeam;
  readonly jersey: number | null;
  readonly espn_id: number | null;
  readonly status: string;
  readonly roster_week: number;
}

interface FixtureFile {
  readonly season: number;
  readonly players: readonly FixturePlayer[];
  readonly team_units: readonly FixtureUnit[];
  readonly decoys: readonly FixtureDecoy[];
}

const ROOT = new URL("../../../", import.meta.url);

export const FIXTURE = JSON.parse(
  readFileSync(new URL("fixtures/players/fixture-roster.json", ROOT), "utf8"),
) as FixtureFile;

export const NOW = "2026-10-06T12:00:00.000Z";
export const LATER = "2026-10-13T12:00:00.000Z";
export const EARLIER = "2026-09-08T12:00:00.000Z";

/** The fixture player with this ESPN display name (throws when absent, so a typo fails loudly). */
export function fx(espnName: string): FixturePlayer {
  const p = FIXTURE.players.find((x) => x.espn_name === espnName);
  if (p === undefined) throw new Error(`no fixture player ${espnName}`);
  return p;
}

/** The fixture team unit with this ESPN id. */
export function fxUnit(espnId: number): FixtureUnit {
  const u = FIXTURE.team_units.find((x) => x.espn_id === espnId);
  if (u === undefined) throw new Error(`no fixture unit ${String(espnId)}`);
  return u;
}

/** A roster_weekly row for a fixture player (its latest week), with edits. */
export function rosterRow(p: FixturePlayer, edit: Partial<NflRosterPlayer> = {}): NflRosterPlayer {
  return {
    gsis_id: p.gsis_id,
    season: FIXTURE.season,
    week: p.roster_week ?? 4,
    full_name: p.nflverse_name,
    team: p.team,
    position: p.position,
    jersey_number: p.jersey,
    espn_id: p.espn_id,
    sleeper_id: p.sleeper_id,
    status: p.status,
    ...edit,
  };
}

/** The decoy's roster row. */
export function decoyRow(d: FixtureDecoy, edit: Partial<NflRosterPlayer> = {}): NflRosterPlayer {
  return {
    gsis_id: d.gsis_id,
    season: FIXTURE.season,
    week: d.roster_week,
    full_name: d.nflverse_name,
    team: d.team,
    position: d.position,
    jersey_number: d.jersey,
    espn_id: d.espn_id,
    sleeper_id: null,
    status: d.status,
    ...edit,
  };
}

/** An nflverse `players` record for a fixture player, with edits. */
export function playersRecord(
  p: FixturePlayer,
  edit: Partial<NflPlayerRecord> = {},
): NflPlayerRecord {
  return {
    gsis_id: p.gsis_id,
    espn_id: p.espn_id,
    display_name: p.nflverse_name,
    position: p.position,
    latest_team: p.team,
    jersey_number: p.jersey,
    status: p.status,
    last_season: 2025,
    ...edit,
  };
}

/** The fixture's roster_weekly rows: every roster_weekly-sourced player plus the decoy. */
export function fixtureRosterRows(): NflRosterPlayer[] {
  return [
    ...FIXTURE.players
      .filter((p) => p.id_source === "nflverse:roster_weekly")
      .map((p) => rosterRow(p)),
    ...FIXTURE.decoys.map((d) => decoyRow(d)),
  ];
}

/** The fixture's nflverse `players` rows (the players-fallback entries). */
export function fixturePlayersRecords(): NflPlayerRecord[] {
  return FIXTURE.players
    .filter((p) => p.id_source === "nflverse:players")
    .map((p) => playersRecord(p));
}

/** A fixture player's identity from the fixture roster's ESPN fields, with edits. */
export function identity(
  p: FixturePlayer | FixtureUnit,
  edit: Partial<EspnPlayerIdentity> = {},
): EspnPlayerIdentity {
  return {
    espn_id: p.espn_id,
    full_name: p.espn_name,
    position_id: p.espn_position_id,
    pro_team_id: p.espn_pro_team_id,
    pro_team: p.espn_team,
    percent_owned: 50,
    jersey: null,
    ...edit,
  };
}

/** A synthetic roster row (fictional people only), defaults WR on KC in week 4. */
export function synthRow(
  edit: Partial<NflRosterPlayer> & { gsis_id: string; full_name: string },
): NflRosterPlayer {
  return {
    season: FIXTURE.season,
    week: 4,
    team: "KC",
    position: "WR",
    jersey_number: null,
    espn_id: null,
    sleeper_id: null,
    status: "ACT",
    ...edit,
  };
}

/** A synthetic ESPN identity (fictional people only), defaults WR (3) on KC (12). */
export function synthIdentity(
  edit: Partial<EspnPlayerIdentity> & { espn_id: number; full_name: string },
): EspnPlayerIdentity {
  return {
    position_id: 3,
    pro_team_id: 12,
    pro_team: "KC",
    percent_owned: 0,
    jersey: null,
    ...edit,
  };
}

/** No persisted pairs. */
export const NO_PERSISTED: PersistedPairLookup = Object.freeze({ get: () => null });

/** A persisted-pair lookup over a list. */
export function persistedOf(pairs: readonly CrosswalkPair[]): PersistedPairLookup {
  const m = new Map(pairs.map((p) => [p.espn_id, p]));
  return { get: (id: number) => m.get(id) ?? null };
}

/** A persisted pair with defaults (method id, source roster_weekly, first/last seen EARLIER). */
export function pair(
  edit: Partial<CrosswalkPair> & { espn_id: number; gsis_id: string },
): CrosswalkPair {
  return {
    method: "id",
    source: "nflverse:roster_weekly",
    confidence: 1,
    first_seen: EARLIER,
    last_seen: EARLIER,
    ...edit,
  };
}

/** Options for `run`. */
export interface RunOptions {
  readonly rows?: readonly NflRosterPlayer[];
  readonly records?: readonly NflPlayerRecord[];
  readonly overrides?: readonly CrosswalkOverride[];
  readonly persisted?: PersistedPairLookup;
  readonly rostered?: ReadonlySet<number>;
  readonly now?: string;
  readonly extra?: Partial<CrosswalkRunInput<EspnPlayerIdentity>>;
}

/** One run over identities (defaults: the fixture's roster rows and players records, no overrides). */
export function run(
  players: readonly EspnPlayerIdentity[],
  opts: RunOptions = {},
): CrosswalkRun<EspnPlayerIdentity> {
  return resolveCrosswalk({
    players,
    identify: identityOf,
    roster: buildRosterIndex(opts.rows ?? fixtureRosterRows()),
    nflPlayers: buildNflPlayersIndex(opts.records ?? fixturePlayersRecords()),
    overrides: opts.overrides ?? [],
    persisted: opts.persisted ?? NO_PERSISTED,
    now: opts.now ?? NOW,
    ...(opts.rostered === undefined ? {} : { rostered: opts.rostered }),
    ...opts.extra,
  });
}

// --- the recorded ESPN fixtures ----------------------------------------------------------------

interface WlRow {
  readonly id: number;
  readonly fullName: string;
  readonly defaultPositionId: number;
  readonly proTeamId: number;
  readonly ownership?: { readonly percentOwned?: number };
}

const RECORDED = new URL("fixtures/espn/recorded/", ROOT);

let wlCache: ReadonlyMap<number, WlRow> | null = null;

function playersWl(): ReadonlyMap<number, WlRow> {
  wlCache ??= new Map(
    (
      JSON.parse(
        readFileSync(new URL("season/players_wl.json", RECORDED), "utf8"),
      ) as readonly WlRow[]
    ).map((r) => [r.id, r]),
  );
  return wlCache;
}

/** ESPN's own identity for an id, read from the recorded players_wl (throws when absent). */
export function recordedIdentity(espnId: number): EspnPlayerIdentity {
  const r = playersWl().get(espnId);
  if (r === undefined) throw new Error(`players_wl lacks ${String(espnId)}`);
  return {
    espn_id: r.id,
    full_name: r.fullName,
    position_id: r.defaultPositionId,
    pro_team_id: r.proTeamId,
    pro_team: ESPN_PRO_TEAMS[r.proTeamId] ?? null,
    percent_owned: r.ownership?.percentOwned ?? null,
    jersey: null,
  };
}

interface RosterFile {
  readonly teams: readonly {
    readonly roster: { readonly entries: readonly { readonly playerId: number }[] };
  }[];
}

/** Every ESPN player id on any fantasy roster in the recorded mRoster pages of league-a/b/c. */
export function recordedRosteredIds(): ReadonlySet<number> {
  const out = new Set<number>();
  for (const league of ["league-a", "league-b", "league-c"]) {
    const dir = fileURLToPath(new URL(`${league}/`, RECORDED));
    for (const f of readdirSync(dir).filter((n) => n.startsWith("mRoster."))) {
      const body = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as RosterFile;
      for (const t of body.teams) for (const e of t.roster.entries) out.add(e.playerId);
    }
  }
  return out;
}
