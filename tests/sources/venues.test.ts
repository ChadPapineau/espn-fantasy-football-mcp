// venues.test.ts — src/sources/venues.ts (plan 01 §5.2 weather row; research 04 §B.7): every stadium
// of the real 2023–2026 schedules is present and resolves, zones are valid IANA names, coordinates
// are in range and agree with the zone's offset, the mis-coded and neutral-site games resolve to the
// real venue, every game of the recorded ESPN pro schedule gets a venue on the ESPN-driven weather
// path, hostile input yields null, and the ds_venues rows match the table contract. Ported from
// sibling @5302d5c, adapted (home-venue map, 2026 neutral sites, the ESPN pro-schedule path).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NFL_TEAMS, type NflTeam } from "../../src/config/schema.js";
import {
  GAME_VENUE_OVERRIDES,
  HOME_VENUES,
  VENUES,
  buildNameIndex,
  homeVenueOf,
  normalizeVenueName,
  resolveVenueId,
  venueById,
  venueByName,
  venueForGame,
  venueRows,
  type VenueReference,
} from "../../src/sources/venues.js";
import { espnAbbrevToNflverse, nflverseGameId } from "../../src/store/datasets/derive.js";
import { DS_VENUES } from "../../src/store/datasets/tables.js";

/** Every (stadium_id, stadium) pair in nflverse games.parquet for 2026 (read 2026-10-06). */
const PAIRS_2026: readonly (readonly [string, string])[] = [
  ["ATL97", "Mercedes-Benz Stadium"], ["BAL00", "M&T Bank Stadium"], ["BOS00", "Gillette Stadium"],
  ["BUF00", "Highmark Stadium"], ["CAR00", "Bank of America Stadium"], ["CHI98", "Soldier Field"],
  ["CIN00", "Paycor Stadium"], ["CLE00", "Huntington Bank Field"], ["DAL00", "AT&T Stadium"],
  ["DEN00", "Empower Field at Mile High"], ["DET00", "Ford Field"], ["GNB00", "Lambeau Field"],
  ["HOU00", "Reliant Stadium"], ["IND00", "Lucas Oil Stadium"], ["JAX00", "EverBank Stadium"],
  ["JAX00", "Tottenham Hotspur Stadium"], ["KAN00", "GEHA Field at Arrowhead Stadium"],
  ["LAX01", "SoFi Stadium"], ["LON00", "Wembley Stadium"], ["LON02", "Tottenham Hotspur Stadium"],
  ["MAD01", "Bernabeu"], ["MEL00", "Melbourne Cricket Ground"], ["MEX00", "Estadio Banorte"],
  ["MIA00", "Hard Rock Stadium"], ["MIN01", "U.S. Bank Stadium"],
  ["MUN01", "FC Bayern Munich Stadium"], ["NAS00", "Nissan Stadium"], ["NOR00", "Caesars Superdome"],
  ["NYC01", "MetLife Stadium"], ["PAR00", "Stade de France"], ["PHI00", "Lincoln Financial Field"],
  ["PHO00", "State Farm Stadium"], ["PIT00", "Acrisure Stadium"], ["RIO00", "Maracana Stadium"],
  ["SEA00", "Lumen Field"], ["SFO01", "Levi's Stadium"], ["TAM00", "Raymond James Stadium"],
  ["VEG00", "Allegiant Stadium"], ["WAS00", "Northwest Stadium"],
]; // prettier-ignore

/** The further pairs of 2023–2025 (the prior seasons the backtests load). */
const PAIRS_2023_2025: readonly (readonly [string, string])[] = [
  ["BUF00", "New Era Field"], ["CLE00", "FirstEnergy Stadium"], ["FRA00", "Deutsche Bank Park"],
  ["GER00", "Allianz Arena"], ["HOU00", "NRG Stadium"], ["JAX00", "TIAA Bank Stadium"],
  ["LON02", "Tottenham Stadium"], ["NOR00", "Mercedes-Benz Superdome"],
  ["SAO00", "Arena Corinthians"], ["WAS00", "FedExField"],
]; // prettier-ignore

/** Each 2026 game not at its home team's stadium (games.parquet, 2026-10-06): id, stadium_id, stadium. */
const AWAY_FROM_HOME_2026: readonly (readonly [string, string, string])[] = [
  ["2026_01_SF_LA", "MEL00", "Melbourne Cricket Ground"],
  ["2026_03_BAL_DAL", "RIO00", "Maracana Stadium"],
  ["2026_04_IND_WAS", "LON02", "Tottenham Hotspur Stadium"],
  ["2026_05_PHI_JAX", "JAX00", "Tottenham Hotspur Stadium"], // location Home — mis-coded id
  ["2026_06_HOU_JAX", "LON00", "Wembley Stadium"],
  ["2026_07_PIT_NO", "PAR00", "Stade de France"],
  ["2026_09_CIN_ATL", "MAD01", "Bernabeu"],
  ["2026_10_NE_DET", "MUN01", "FC Bayern Munich Stadium"],
  ["2026_11_MIN_SF", "MEX00", "Estadio Banorte"],
];

const offsetHours = (tz: string, at: Date): number => {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? "");
  if (!m) return 0; // "GMT" alone = UTC+0
  const h = Number(m[2]) + Number(m[3]) / 60;
  return m[1] === "-" ? -h : h;
};

describe("VENUES reference table", () => {
  it("has every 2023–2026 stadium_id", () => {
    const ids = new Set(VENUES.map((x) => x.stadium_id));
    const missing = [...PAIRS_2026, ...PAIRS_2023_2025]
      .map(([id]) => id)
      .filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it("is sorted, unique and frozen", () => {
    const ids = VENUES.map((x) => x.stadium_id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.isFrozen(VENUES)).toBe(true);
    expect(Object.isFrozen(HOME_VENUES)).toBe(true);
    expect(Object.isFrozen(GAME_VENUE_OVERRIDES)).toBe(true);
    for (const x of VENUES) {
      expect(Object.isFrozen(x)).toBe(true);
      expect(Object.isFrozen(x.names)).toBe(true);
    }
  });

  it.each(VENUES.map((x) => [x.stadium_id, x] as const))("%s: valid fields", (_id, x) => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: x.tz })).not.toThrow();
    expect(x.tz).toMatch(/^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z_]+){1,2}$/); // IANA Area/Location
    expect(x.lat).toBeGreaterThanOrEqual(-90);
    expect(x.lat).toBeLessThanOrEqual(90);
    expect(x.lon).toBeGreaterThanOrEqual(-180);
    expect(x.lon).toBeLessThanOrEqual(180);
    expect(Math.abs(x.lat) + Math.abs(x.lon)).toBeGreaterThan(1); // not (0, 0)
    expect(["outdoors", "dome", "closed", "open"]).toContain(x.roof_default);
    if (x.retractable) expect(x.roof_default).toBe("closed");
    expect(x.country).toMatch(/^[A-Z]{2}$/);
    expect(x.names.length).toBeGreaterThan(0);
    expect(x.name.length).toBeGreaterThan(0);
    expect(x.stadium_id).toMatch(/^[A-Z]{3}\d{2}$/);
    if (x.country === "US") {
      expect(x.tz.startsWith("America/")).toBe(true);
      expect(x.lat).toBeGreaterThan(24);
      expect(x.lat).toBeLessThan(49);
      expect(x.lon).toBeGreaterThan(-125);
      expect(x.lon).toBeLessThan(-66);
    }
    if (x.lat < 0) expect(["AU", "BR"]).toContain(x.country); // southern-hemisphere venues
    // Sign/axis-swap check: the zone's standard offset is within 2.5 h of longitude / 15.
    const jan = offsetHours(x.tz, new Date("2026-01-15T12:00:00Z"));
    const jul = offsetHours(x.tz, new Date("2026-07-15T12:00:00Z"));
    expect(Math.abs(Math.min(jan, jul) - x.lon / 15)).toBeLessThan(2.5);
  });

  it("keeps each normalised name on exactly one venue (and buildNameIndex refuses a clash)", () => {
    const seen = new Map<string, string>();
    for (const x of VENUES) {
      for (const n of x.names) {
        const k = normalizeVenueName(n);
        expect(seen.get(k) ?? x.stadium_id, n).toBe(x.stadium_id);
        seen.set(k, x.stadium_id);
      }
    }
    const [a, b] = VENUES as [VenueReference, VenueReference];
    expect(() =>
      buildNameIndex([a, { ...b, names: [...b.names, `  ${a.name.toUpperCase()} `] }]),
    ).toThrow(/two venues/);
    expect(buildNameIndex([a, a]).size).toBe(new Set(a.names.map(normalizeVenueName)).size);
  });

  it("marks only the venues nflverse never coded as local", () => {
    expect(VENUES.filter((x) => x.origin === "local").map((x) => x.stadium_id)).toEqual([
      "BER00",
      "DUB00",
    ]);
  });
});

describe("HOME_VENUES and GAME_VENUE_OVERRIDES", () => {
  it("names a known US venue for every NFL team (shared stadiums: SoFi, MetLife)", () => {
    expect(Object.keys(HOME_VENUES).sort()).toEqual([...NFL_TEAMS].sort());
    for (const t of NFL_TEAMS) {
      const v = venueById(HOME_VENUES[t]);
      expect(v, t).not.toBeNull();
      expect(v?.country).toBe("US");
      expect(v?.origin).toBe("nflverse");
    }
    expect(HOME_VENUES.LA).toBe(HOME_VENUES.LAC);
    expect(HOME_VENUES.NYG).toBe(HOME_VENUES.NYJ);
    expect(new Set(Object.values(HOME_VENUES)).size).toBe(30);
  });

  it("covers every 2026 game away from its home stadium, each agreeing with the name/id evidence", () => {
    const overrides2026 = Object.keys(GAME_VENUE_OVERRIDES).filter((k) => k.startsWith("2026_"));
    expect(overrides2026.sort()).toEqual(AWAY_FROM_HOME_2026.map(([g]) => g).sort());
    for (const [g, sid, name] of AWAY_FROM_HOME_2026) {
      const byEvidence = resolveVenueId("not-an-override", sid, name);
      expect(GAME_VENUE_OVERRIDES[g], g).toBe(byEvidence);
      const home = g.split("_")[3] as NflTeam;
      expect(GAME_VENUE_OVERRIDES[g]).not.toBe(HOME_VENUES[home]);
    }
    for (const sid of Object.values(GAME_VENUE_OVERRIDES)) expect(venueById(sid)).not.toBeNull();
  });

  it("homeVenueOf takes nflverse spellings only", () => {
    expect(homeVenueOf("WAS")).toBe("WAS00");
    expect(homeVenueOf("LA")).toBe("LAX01");
    for (const bad of ["WSH", "LAR", "FA", "__proto__", "constructor", "", null, 7])
      expect(homeVenueOf(bad)).toBeNull();
  });
});

describe("venueForGame — the ESPN-driven weather path (no nflverse stadium available)", () => {
  interface G {
    id: number;
    scoringPeriodId: number;
    homeProTeamId: number;
    awayProTeamId: number;
  }
  const j = JSON.parse(
    readFileSync(
      new URL("../../fixtures/espn/recorded/season/proTeamSchedules_wl.json", import.meta.url),
      "utf8",
    ),
  ) as {
    settings: {
      proTeams: { id: number; abbrev: string; proGamesByScoringPeriod?: Record<string, G[]> }[];
    };
  };
  const abbr = new Map(j.settings.proTeams.map((t) => [t.id, t.abbrev]));
  const games = new Map<number, G>();
  for (const t of j.settings.proTeams)
    for (const gs of Object.values(t.proGamesByScoringPeriod ?? {}))
      for (const g of gs) games.set(g.id, g);

  it("gives every recorded 2026 game a venue: the override for the 9 away-from-home games, else home", () => {
    expect(games.size).toBe(272);
    let overridden = 0;
    for (const g of games.values()) {
      const home = espnAbbrevToNflverse(abbr.get(g.homeProTeamId));
      const away = espnAbbrevToNflverse(abbr.get(g.awayProTeamId));
      const gameId = nflverseGameId(2026, g.scoringPeriodId, away, home);
      const v = venueForGame(gameId, home);
      expect(v, String(g.id)).not.toBeNull();
      if (gameId !== null && Object.hasOwn(GAME_VENUE_OVERRIDES, gameId)) {
        overridden++;
        expect(v?.stadium_id).toBe(GAME_VENUE_OVERRIDES[gameId]);
      } else {
        expect(v?.stadium_id).toBe(home === null ? undefined : HOME_VENUES[home]);
      }
    }
    expect(overridden).toBe(AWAY_FROM_HOME_2026.length);
  });

  it("returns null for an unknown game at an unknown team, and ignores prototype keys", () => {
    expect(venueForGame("2026_99_X_Y", "ZZZ")).toBeNull();
    expect(venueForGame(null, null)).toBeNull();
    expect(venueForGame("__proto__", "BUF")?.stadium_id).toBe("BUF00");
    expect(venueForGame("constructor", null)).toBeNull();
    expect(venueForGame("2026_06_HOU_JAX", "JAX")?.stadium_id).toBe("LON00");
  });
});

describe("resolveVenueId", () => {
  it.each([...PAIRS_2026, ...PAIRS_2023_2025])("resolves the real pair (%s, %s)", (id, name) => {
    const want = id === "JAX00" && name === "Tottenham Hotspur Stadium" ? "LON02" : id;
    expect(resolveVenueId("2026_xx", id, name)).toBe(want);
  });

  it("fixes the mis-coded games: the 2026 London JAX home game, 2025's international games", () => {
    expect(resolveVenueId("2026_05_PHI_JAX", "JAX00", "Tottenham Hotspur Stadium")).toBe("LON02");
    expect(resolveVenueId("2025_04_MIN_PIT", "PIT00", "Acrisure Stadium")).toBe("DUB00");
    expect(resolveVenueId("2025_10_ATL_IND", "IND00", "Lucas Oil Stadium")).toBe("BER00");
    expect(resolveVenueId("2025_01_KC_LAC", "LAX01", "SoFi Stadium")).toBe("SAO00");
  });

  it("falls back to the id when the name is unknown or absent; null when neither is known", () => {
    expect(resolveVenueId("g", "CLE00", "Some Future Naming-Rights Field")).toBe("CLE00");
    expect(resolveVenueId("g", "CLE00", null)).toBe("CLE00");
    expect(resolveVenueId(null, null, "Lambeau Field")).toBe("GNB00");
    expect(resolveVenueId("g", "ZZZ99", "Nowhere Park")).toBeNull();
    expect(resolveVenueId(undefined, undefined, undefined)).toBeNull();
  });

  it("normalises case, accents, punctuation and whitespace", () => {
    expect(venueByName("  MARACANÃ   stadium ")?.stadium_id).toBe("RIO00");
    expect(venueByName("levis stadium")?.stadium_id).toBe("SFO01");
    expect(venueByName("Levi’s Stadium")?.stadium_id).toBe("SFO01");
    expect(venueByName("u.s. bank stadium")?.stadium_id).toBe("MIN01");
    expect(venueByName("M&T Bank Stadium")?.stadium_id).toBe("BAL00");
    expect(venueByName("Bernabéu")?.stadium_id).toBe("MAD01");
    expect(venueByName("ＲＥＬＩＡＮＴ Stadium")?.stadium_id).toBe("HOU00"); // full-width → NFKC
    expect(venueByName("Lambeau​Field")?.stadium_id).toBe("GNB00"); // zero-width → separator
  });

  it.each([
    ["__proto__"],
    ["constructor"],
    ["toString"],
    ["hasOwnProperty"],
    [""],
    ["   "],
    ["\u0000"],
    ["x".repeat(1_000_000)],
    ["Lambeau Field".repeat(20)],
  ])("returns null for hostile input %#", (s) => {
    expect(venueById(s)).toBeNull();
    expect(venueByName(s)).toBeNull();
    expect(resolveVenueId(s, s, s)).toBeNull();
  });

  it("ignores non-string input", () => {
    for (const x of [42, {}, [], true, Symbol("x")] as const) {
      expect(venueById(x)).toBeNull();
      expect(venueByName(x)).toBeNull();
    }
    expect(resolveVenueId({ toString: () => "2025_04_MIN_PIT" }, "PIT00", null)).toBe("PIT00");
  });
});

describe("venueRows → ds_venues", () => {
  it("emits exactly the DS_VENUES columns, NOT NULL filled, typed", () => {
    const rows = venueRows();
    expect(rows).toHaveLength(VENUES.length);
    const cols = DS_VENUES.columns.map((c) => c.name).sort();
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(cols);
      for (const c of DS_VENUES.columns) {
        const val = r[c.name];
        expect(val, c.name).not.toBeNull();
        if (c.type === "TEXT") expect(typeof val).toBe("string");
        else expect(typeof val).toBe("number");
      }
      expect([0, 1]).toContain(r.retractable);
    }
  });
});
