// fixture-roster.test.ts — fixtures/players/fixture-roster.json, the shared fixture roster every
// Phase-1 fixture is built from (plan 05 §3; plan 10 §3.1a fixtures, A6a crosswalk cases): its shape,
// that every ESPN field is really in the recorded ESPN fixtures (ids, names, positions, teams and the
// box-score weeks), that the ESPN and nflverse sides line up on ids and team spellings, and that the
// edge cases it promises are really in it. Ported from sibling @5302d5c, adapted (ESPN-first).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GSIS_ID_RE, isNflTeam } from "../../../src/config/schema.js";
import { ESPN_POSITION_TO_NFLVERSE } from "../../../src/domain/crosswalk/types.js";
import {
  ESPN_DST_PLAYER_ID_BASE,
  ESPN_PRO_TEAMS,
  ESPN_TQB_PLAYER_ID_BASE,
} from "../../../src/providers/espn/types.js";
import { espnAbbrevToNflverse } from "../../../src/store/datasets/derive.js";

interface FixturePlayer {
  kind: "player";
  espn_id: number;
  espn_name: string;
  espn_position_id: number;
  espn_pro_team_id: number;
  espn_team: string;
  gsis_id: string;
  nflverse_name: string;
  first_name: string;
  last_name: string;
  position: string;
  team: string;
  jersey: number | null;
  sleeper_id: string | null;
  pfr_id: string | null;
  rookie_year: number;
  status: string;
  roster_week: number | null;
  id_source: "nflverse:roster_weekly" | "nflverse:players";
  stat_weeks: number[];
  box_weeks: Record<string, number[]>;
  tags: string[];
}
interface FixtureUnit {
  kind: "dst" | "tqb";
  espn_id: number;
  espn_name: string;
  espn_position_id: number;
  espn_pro_team_id: number;
  espn_team: string;
  team: string;
  box_weeks: Record<string, number[]>;
  tags: string[];
}
interface FixtureDecoy {
  kind: "nflverse_only";
  collides_with_espn_id: number;
  gsis_id: string;
  nflverse_name: string;
  position: string;
  team: string;
  espn_id: number | null;
  rookie_year: number;
  tags: string[];
}
interface FixtureRoster {
  season: number;
  stat_weeks: number[];
  players: FixturePlayer[];
  team_units: FixtureUnit[];
  decoys: FixtureDecoy[];
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const rosterText = readFileSync(path.join(ROOT, "fixtures/players/fixture-roster.json"), "utf8");
const roster = JSON.parse(rosterText) as FixtureRoster;
const { players, team_units: units, decoys } = roster;
const tagged = (t: string): FixturePlayer[] => players.filter((p) => p.tags.includes(t));

const KNOWN_TAGS = new Set([
  "same_surname",
  "initials_name",
  "rookie_2026",
  "espn_name_suffix",
  "nflverse_name_suffix",
  "reserve_status",
  "free_agent",
  "players_fallback",
  "name_collision",
  "apostrophe_name",
  "punctuated_name",
  "hyphenated_name",
  "nickname_differs",
  "stat_week_gap",
  "roster_only",
  "espn_abbrev_differs",
]);
const SUFFIX_RE = /\s(Jr\.|Sr\.|II|III|IV|V)$/;

// --- what the recorded ESPN fixtures actually hold ------------------------------------------------------

interface Seen {
  names: Set<string>;
  positions: Set<number>;
  teams: Set<number>;
  box: Map<string, Set<number>>;
}
const recorded = new Map<number, Seen>();
const RECORDED = path.join(ROOT, "fixtures/espn/recorded");
for (const league of ["league-a", "league-b", "league-c"]) {
  for (const f of readdirSync(path.join(RECORDED, league)).filter((x) => x.endsWith(".json"))) {
    const sp = /^mBoxscore\.sp(\d)\.json$/.exec(f)?.[1];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) {
        for (const v of x) walk(v);
        return;
      }
      if (x === null || typeof x !== "object") return;
      const o = x as Record<string, unknown>;
      const p = o.player as Record<string, unknown> | undefined;
      if (p && typeof p === "object" && typeof p.id === "number" && "defaultPositionId" in p) {
        const s: Seen = recorded.get(p.id) ?? {
          names: new Set(),
          positions: new Set(),
          teams: new Set(),
          box: new Map(),
        };
        if (typeof p.fullName === "string") s.names.add(p.fullName);
        if (typeof p.defaultPositionId === "number") s.positions.add(p.defaultPositionId);
        if (typeof p.proTeamId === "number") s.teams.add(p.proTeamId);
        if (sp !== undefined) {
          const weeks = s.box.get(league) ?? new Set<number>();
          weeks.add(Number(sp));
          s.box.set(league, weeks);
        }
        recorded.set(p.id, s);
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(JSON.parse(readFileSync(path.join(RECORDED, league, f), "utf8")));
  }
}
const boxOf = (s: Seen | undefined): Record<string, number[]> =>
  Object.fromEntries(
    [...(s?.box ?? new Map<string, Set<number>>())]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([lg, w]) => [lg, [...w].sort((x, y) => x - y)]),
  );

// -------------------------------------------------------------------------------------------------

describe("fixture roster shape", () => {
  it("is the 2026 season with nflverse stat weeks 1–3", () => {
    expect(roster.season).toBe(2026);
    expect(roster.stat_weeks).toEqual([1, 2, 3]);
  });

  it("has 4 QB, 6 RB, 7 WR, 4 TE, 3 K, 4 D/ST + 1 TQB, and one collision decoy", () => {
    const count = (pos: string): number => players.filter((p) => p.position === pos).length;
    expect([count("QB"), count("RB"), count("WR"), count("TE"), count("K")]).toEqual([
      4, 6, 7, 4, 3,
    ]);
    expect(players).toHaveLength(24);
    expect(units.filter((u) => u.kind === "dst")).toHaveLength(4);
    expect(units.filter((u) => u.kind === "tqb")).toHaveLength(1);
    expect(decoys).toHaveLength(1);
  });

  it.each(players.map((p) => [p.espn_name, p] as const))("%s: well-formed", (_n, p) => {
    expect(p.kind).toBe("player");
    expect(Number.isSafeInteger(p.espn_id) && p.espn_id > 0).toBe(true);
    expect(p.gsis_id).toMatch(GSIS_ID_RE);
    for (const n of [p.espn_name, p.nflverse_name]) {
      expect(n.trim()).toBe(n);
      expect(n.length).toBeGreaterThan(3);
    }
    expect(p.last_name.length).toBeGreaterThan(0);
    expect(ESPN_POSITION_TO_NFLVERSE[p.espn_position_id]).toBe(p.position);
    expect(isNflTeam(p.team)).toBe(true);
    expect(ESPN_PRO_TEAMS[p.espn_pro_team_id]).toBe(p.espn_team);
    if (p.espn_pro_team_id !== 0) expect(espnAbbrevToNflverse(p.espn_team)).toBe(p.team);
    expect(
      p.jersey === null || (Number.isInteger(p.jersey) && p.jersey >= 0 && p.jersey <= 99),
    ).toBe(true);
    if (p.sleeper_id !== null) expect(p.sleeper_id).toMatch(/^\d+$/);
    expect(p.rookie_year).toBeGreaterThanOrEqual(2000);
    expect(p.rookie_year).toBeLessThanOrEqual(2026);
    expect(["nflverse:roster_weekly", "nflverse:players"]).toContain(p.id_source);
    if (p.id_source === "nflverse:roster_weekly") expect(p.roster_week).toBe(4);
    else expect(p.roster_week).toBeNull();
    for (const w of p.stat_weeks) expect(roster.stat_weeks).toContain(w);
    expect(p.stat_weeks).toEqual([...p.stat_weeks].sort((a, b) => a - b));
    for (const t of p.tags) expect(KNOWN_TAGS.has(t), t).toBe(true);
  });

  it("has unique ESPN ids and gsis ids", () => {
    const espnIds = [...players, ...units].map((p) => p.espn_id);
    expect(new Set(espnIds).size).toBe(espnIds.length);
    const gsis = [...players.map((p) => p.gsis_id), ...decoys.map((d) => d.gsis_id)];
    expect(new Set(gsis).size).toBe(gsis.length);
  });

  it("holds no fantasy-league identifiers (public NFL data only)", () => {
    expect(rosterText).not.toMatch(/\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-/); // member GUIDs
    expect(rosterText).not.toMatch(/Example League|Member \d|"Team [A-Z]"|leagueId|memberId/);
    expect(rosterText).not.toMatch(/espn_s2|SWID/i);
  });
});

describe("the ESPN side is really in the recorded fixtures", () => {
  it.each([...players, ...units].map((p) => [p.espn_name, p] as const))(
    "%s: id, name, position, team and every claimed box-score week are in the recordings",
    (_n, p) => {
      const s = recorded.get(p.espn_id);
      expect(s, `ESPN id ${String(p.espn_id)} not in fixtures/espn/recorded`).toBeDefined();
      expect([...(s?.names ?? [])]).toContain(p.espn_name);
      expect([...(s?.positions ?? [])]).toEqual([p.espn_position_id]);
      expect([...(s?.teams ?? [])]).toContain(p.espn_pro_team_id);
      // A claim, checked against the recordings (a re-recording that closes a withheld hole may add
      // appearances, which is fine; one that removes a claimed appearance fails here).
      const seen = boxOf(s);
      for (const [league, weeks] of Object.entries(p.box_weeks)) {
        expect(weeks).toEqual([...weeks].sort((a, b) => a - b));
        for (const w of weeks)
          expect(seen[league] ?? [], `${league} week ${String(w)}`).toContain(w);
      }
    },
  );

  it("team units carry ESPN's unit ids: −(16000 + proTeamId) for D/ST, −(15000 + id) for TQB", () => {
    for (const u of units) {
      const base = u.kind === "dst" ? ESPN_DST_PLAYER_ID_BASE : ESPN_TQB_PLAYER_ID_BASE;
      expect(u.espn_id).toBe(base - u.espn_pro_team_id);
      expect(u.espn_position_id).toBe(u.kind === "dst" ? 16 : 15);
      expect(ESPN_PRO_TEAMS[u.espn_pro_team_id]).toBe(u.espn_team);
      expect(espnAbbrevToNflverse(u.espn_team)).toBe(u.team);
      expect(Object.keys(u)).not.toContain("gsis_id");
      expect(Object.keys(u.box_weeks).length).toBeGreaterThan(0);
    }
  });

  it("every rostered player has a recorded box score in week 1–3, except the tagged exceptions", () => {
    for (const p of players) {
      if (p.tags.includes("free_agent") || p.tags.includes("roster_only")) {
        expect(p.box_weeks, p.espn_name).toEqual({});
        continue;
      }
      expect(Object.keys(p.box_weeks).length, p.espn_name).toBeGreaterThan(0);
    }
  });
});

describe("the edge cases the roster promises (plan 10 A6a; research 04 §C)", () => {
  it("has 2026 rookies, incl. a rookie kicker", () => {
    const rookies = tagged("rookie_2026");
    expect(rookies.length).toBeGreaterThanOrEqual(3);
    for (const p of rookies) expect(p.rookie_year).toBe(2026);
    expect(rookies.some((p) => p.position === "K")).toBe(true);
    expect(players.filter((p) => p.rookie_year === 2026)).toEqual(rookies);
  });

  it("has an exact full-name collision: same name, different player, team and position", () => {
    const [d] = decoys;
    expect(d).toBeDefined();
    const p = players.find((x) => x.espn_id === d?.collides_with_espn_id);
    expect(p?.tags).toContain("name_collision");
    expect(d?.nflverse_name).toBe(p?.nflverse_name);
    expect(d?.gsis_id).not.toBe(p?.gsis_id);
    expect(d?.team).not.toBe(p?.team);
    expect(d?.position).not.toBe(p?.position);
    expect(d?.espn_id).not.toBe(p?.espn_id);
    expect(recorded.has(d?.espn_id ?? 0)).toBe(false); // an IDP: not in any recorded ESPN league
  });

  it("has same-surname players on different teams", () => {
    const bySurname = new Map<string, FixturePlayer[]>();
    for (const p of tagged("same_surname"))
      bySurname.set(p.last_name, [...(bySurname.get(p.last_name) ?? []), p]);
    expect(bySurname.size).toBeGreaterThanOrEqual(3);
    for (const g of bySurname.values()) {
      expect(g.length).toBeGreaterThanOrEqual(2);
      expect(new Set(g.map((p) => p.team)).size).toBe(g.length);
    }
  });

  it("has names that differ between ESPN and nflverse (suffix either side, nickname)", () => {
    for (const p of tagged("espn_name_suffix")) {
      expect(p.espn_name).toMatch(SUFFIX_RE);
      expect(p.espn_name.replace(SUFFIX_RE, "")).toBe(p.nflverse_name);
    }
    for (const p of tagged("nflverse_name_suffix")) {
      expect(p.nflverse_name).toMatch(SUFFIX_RE);
      expect(p.nflverse_name.replace(SUFFIX_RE, "")).toBe(p.espn_name);
    }
    const [nick] = tagged("nickname_differs");
    expect(nick?.espn_name).not.toBe(nick?.nflverse_name);
    expect(nick?.espn_name.split(" ").at(-1)).toBe(nick?.nflverse_name.split(" ").at(-1));
    expect(tagged("espn_name_suffix").length).toBeGreaterThanOrEqual(2);
    expect(tagged("nflverse_name_suffix").length).toBeGreaterThanOrEqual(1);
  });

  it("has punctuation the matcher must normalise", () => {
    expect(tagged("apostrophe_name").every((p) => p.espn_name.includes("'"))).toBe(true);
    expect(tagged("hyphenated_name").every((p) => p.espn_name.includes("-"))).toBe(true);
    expect(tagged("punctuated_name").every((p) => p.espn_name.includes("."))).toBe(true);
    expect(tagged("initials_name").every((p) => /^[A-Z]\.[A-Z]\. /.test(p.espn_name))).toBe(true);
    expect(tagged("apostrophe_name").some((p) => p.position === "K")).toBe(true);
  });

  it("has a free agent resolvable only through the nflverse players fallback", () => {
    const fa = tagged("free_agent");
    expect(fa.length).toBe(1);
    for (const p of fa) {
      expect(p.tags).toContain("players_fallback");
      expect(p.espn_pro_team_id).toBe(0);
      expect(p.espn_team).toBe("FA");
      expect(p.id_source).toBe("nflverse:players");
      expect(p.stat_weeks).toEqual([]);
    }
    expect(tagged("players_fallback")).toEqual(fa);
  });

  it("has an ESPN box-score week with no nflverse stat line (the E8 cross-check must cope)", () => {
    const [gap] = tagged("stat_week_gap");
    expect(gap).toBeDefined();
    const boxWeeks = new Set(Object.values(gap?.box_weeks ?? {}).flat());
    expect([...boxWeeks].some((w) => !(gap?.stat_weeks ?? []).includes(w))).toBe(true);
  });

  it("has a reserve-list player and D/STs whose ESPN spelling differs (LAR, WSH)", () => {
    expect(tagged("reserve_status").every((p) => p.status === "RES")).toBe(true);
    expect(tagged("reserve_status").length).toBeGreaterThan(0);
    const differs = units.filter((u) => u.tags.includes("espn_abbrev_differs"));
    expect(differs.map((u) => u.espn_team).sort()).toEqual(["LAR", "WSH"]);
    for (const u of differs) expect(u.team).not.toBe(u.espn_team);
  });

  it("has at least two QBs, a K and D/ST team units", () => {
    expect(players.filter((p) => p.position === "QB").length).toBeGreaterThanOrEqual(2);
    expect(players.filter((p) => p.position === "K").length).toBeGreaterThanOrEqual(1);
    expect(units.filter((u) => u.kind === "dst").length).toBeGreaterThanOrEqual(2);
  });
});
