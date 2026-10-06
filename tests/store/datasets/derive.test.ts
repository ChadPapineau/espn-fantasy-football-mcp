// derive.test.ts — src/store/datasets/derive.ts (the derivations tables.ts names): the Eastern kickoff
// → UTC instant across both DST transitions and the real 2026 kickoff slots, malformed/hostile inputs
// never throwing, round-trip properties, the text/roof/date/implied-total normalisations, and the
// ESPN-side derivations — text ids → integers, epoch-ms dates, flags, byes, jerseys, ESPN team
// spellings and the nflverse game id derived from an ESPN pro game. Ported from sibling @5302d5c,
// adapted (ESPN derivations added).
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NFL_TEAMS } from "../../../src/config/schema.js";
import {
  NFLVERSE_KICKOFF_TZ,
  boolToInt,
  byeWeek,
  emptyToNull,
  epochMs,
  epochMsToIso,
  espnAbbrevToNflverse,
  impliedPoints,
  isoDate,
  jerseyNumber,
  kickoffUtcFromEastern,
  nflverseGameId,
  normalizeRoof,
  parseDecimalId,
  wallTimeToUtcIso,
  zoneOffsetMs,
} from "../../../src/store/datasets/derive.js";

describe("kickoffUtcFromEastern", () => {
  it.each([
    ["2026-10-01", "20:15", "2026-10-02T00:15:00.000Z"], // TNF, EDT, crosses the UTC date
    ["2026-09-13", "13:00", "2026-09-13T17:00:00.000Z"],
    ["2026-10-04", "09:30", "2026-10-04T13:30:00.000Z"], // London slot
    ["2026-12-27", "13:00", "2026-12-27T18:00:00.000Z"], // EST
    ["2026-11-01", "13:00", "2026-11-01T18:00:00.000Z"], // DST ends 02:00 that morning
    ["2026-10-31", "20:15", "2026-11-01T00:15:00.000Z"], // the evening before, still EDT
    ["2026-03-08", "13:00", "2026-03-08T17:00:00.000Z"], // DST began 02:00 that morning
    ["2027-01-10", "16:25", "2027-01-10T21:25:00.000Z"],
    ["2026-09-10", "20:35", "2026-09-11T00:35:00.000Z"], // Melbourne game, ET slot as filed
  ])("%s %s ET → %s", (d, t, want) => {
    expect(kickoffUtcFromEastern(d, t)).toBe(want);
  });

  it("resolves a spring-forward gap and a fall-back repeat deterministically", () => {
    expect(kickoffUtcFromEastern("2026-03-08", "02:30")).toMatch(/^2026-03-08T0[67]:30:00\.000Z$/);
    const fb = kickoffUtcFromEastern("2026-11-01", "01:30");
    expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(fb);
  });

  it.each([
    [null, "13:00"],
    ["2026-10-01", null],
    [undefined, undefined],
    [20261001, "13:00"],
    ["2026-13-01", "13:00"],
    ["2026-00-10", "13:00"],
    ["2026-02-30", "13:00"],
    ["2026-02-00", "13:00"],
    ["2026-10-01", "24:00"],
    ["2026-10-01", "12:60"],
    ["2026-10-01", "7:30"],
    ["2026-10-01", "13:00:00"],
    ["2026-10-01T13:00", "13:00"],
    ["", ""],
    [" 2026-10-01", "13:00"],
    ["２０２６-１０-０１", "13:00"], // full-width digits
    ["2026-10-01", "１３:００"],
    ["x".repeat(100_000), "13:00"],
  ])("returns null for malformed input %j %j", (d, t) => {
    expect(kickoffUtcFromEastern(d, t)).toBeNull();
  });

  it("round-trips: the UTC instant shows the same Eastern wall time (outside the 02:xx gap)", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: NFLVERSE_KICKOFF_TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2035-12-31T00:00:00Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 23 }).filter((h) => h !== 1 && h !== 2),
        fc.integer({ min: 0, max: 59 }),
        (date, h, m) => {
          const d = date.toISOString().slice(0, 10);
          const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          const iso = kickoffUtcFromEastern(d, t);
          expect(iso).not.toBeNull();
          const shown = fmt.format(new Date(iso ?? "")).replace(",", "");
          expect(shown).toBe(`${d} ${t}`);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("works for any IANA zone and throws on an unknown one (a programming error)", () => {
    expect(wallTimeToUtcIso("2026-10-04", "14:30", "Europe/London")).toBe(
      "2026-10-04T13:30:00.000Z",
    );
    expect(wallTimeToUtcIso("2026-09-10", "20:35", "Australia/Melbourne")).toBe(
      "2026-09-10T10:35:00.000Z",
    );
    expect(() => wallTimeToUtcIso("2026-10-04", "14:30", "Mars/Olympus")).toThrow();
    expect(() => zoneOffsetMs("Not/AZone", 0)).toThrow();
    expect(zoneOffsetMs("UTC", Date.UTC(2026, 0, 1))).toBe(0);
    expect(zoneOffsetMs(NFLVERSE_KICKOFF_TZ, Date.UTC(2026, 0, 1))).toBe(-5 * 3_600_000);
  });
});

describe("text, roof and date normalisation", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    [" \t\n", null],
    [5, null],
    [{}, null],
    [" 30977 ", "30977"],
    ["Ja'Marr Chase", "Ja'Marr Chase"],
    ["Maracanã", "Maracanã"],
  ])("emptyToNull(%j) = %j", (v, want) => {
    expect(emptyToNull(v)).toBe(want);
  });

  it("normalizeRoof: '' → null (retractable, state unknown), otherwise lower-cased", () => {
    expect(normalizeRoof("")).toBeNull();
    expect(normalizeRoof(null)).toBeNull();
    expect(normalizeRoof(" Dome ")).toBe("dome");
    expect(normalizeRoof("outdoors")).toBe("outdoors");
  });

  it("isoDate accepts a Date, an ISO date string or a day count; nothing else", () => {
    expect(isoDate(new Date("1983-12-02T00:00:00.000Z"))).toBe("1983-12-02");
    expect(isoDate("2001-02-03")).toBe("2001-02-03");
    expect(isoDate(0)).toBe("1970-01-01");
    expect(isoDate(new Date("nope"))).toBeNull();
    expect(isoDate("2001-02-30T00:00")).toBeNull();
    expect(isoDate("2001-13-45")).toBeNull();
    expect(isoDate("2001-02-30")).toBeNull();
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
    expect(isoDate(1.5)).toBeNull();
    expect(isoDate(1e12)).toBeNull(); // beyond Date's range
    expect(isoDate(-1_000_000)).toBeNull(); // year < 0 → extended ISO form
    expect(isoDate(null)).toBeNull();
  });
});

describe("impliedPoints (positive spread = home favoured)", () => {
  it("splits the total around the spread", () => {
    expect(impliedPoints(3, 44.5)).toEqual({ away: 20.75, home: 23.75 });
    expect(impliedPoints(-2.5, 38.5)).toEqual({ away: 20.5, home: 18 });
    expect(impliedPoints(0, 40)).toEqual({ away: 20, home: 20 });
  });

  it("is null for any missing or non-finite input", () => {
    for (const [s, t] of [
      [null, 40],
      [3, null],
      [Number.NaN, 40],
      [3, Number.POSITIVE_INFINITY],
      ["3", "40"],
    ] as const) {
      expect(impliedPoints(s, t)).toEqual({ away: null, home: null });
    }
  });

  it("property: the two implied totals sum to the total and differ by the spread", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: 20, max: 80, noNaN: true }),
        (s, t) => {
          const { away, home } = impliedPoints(s, t);
          expect((away ?? 0) + (home ?? 0)).toBeCloseTo(t, 9);
          expect((home ?? 0) - (away ?? 0)).toBeCloseTo(s, 9);
        },
      ),
    );
  });
});

describe("parseDecimalId (nflverse text ids → ESPN's integer ids)", () => {
  it.each([
    ["3918298", 3918298],
    [" 4262921 ", 4262921],
    ["15818", 15818],
    ["401872964", 401872964],
    [3918298, 3918298],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ] as const)("%j → %j", (v, want) => {
    expect(parseDecimalId(v)).toBe(want);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["0"],
    ["012"],
    ["-3"],
    ["+3"],
    ["1e5"],
    ["0x10"],
    ["12.0"],
    ["12 34"],
    ["3918298;DROP"],
    ["３９１８２９８"], // full-width digits
    ["٣٩١٨"], // Arabic-Indic digits
    ["9007199254740993"], // beyond the safe range
    ["12345678901234567"], // 17 digits
    [0],
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [2 ** 53],
    [{}],
    [[1]],
    [true],
    ["x".repeat(100_000)],
  ])("rejects %j", (v) => {
    expect(parseDecimalId(v)).toBeNull();
  });

  it("accepts a positive bigint in the safe range (hyparquet INT64) and nothing else", () => {
    expect(parseDecimalId(4262921n)).toBe(4262921);
    expect(parseDecimalId(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const b of [0n, -5n, 2n ** 64n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])
      expect(parseDecimalId(b)).toBeNull();
  });

  it("property: every positive safe integer round-trips through its decimal text", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (n) => {
        expect(parseDecimalId(String(n))).toBe(n);
        expect(parseDecimalId(n)).toBe(n);
        expect(parseDecimalId(BigInt(n))).toBe(n);
      }),
    );
  });

  it("property: any string it accepts is exactly the decimal text of the result", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (s) => {
        const n = parseDecimalId(s);
        if (n !== null) expect(String(n)).toBe(s.trim());
      }),
      { numRuns: 2000 },
    );
  });
});

describe("epochMs / epochMsToIso / boolToInt / byeWeek / jerseyNumber", () => {
  it("epochMs keeps a non-negative safe integer up to year 9999", () => {
    expect(epochMs(1790900100000)).toBe(1790900100000);
    expect(epochMs(0)).toBe(0);
    expect(epochMs(253_402_300_799_999)).toBe(253_402_300_799_999);
    for (const bad of [-1, 1.5, Number.NaN, Infinity, 253_402_300_800_000, "1790900100000", null])
      expect(epochMs(bad)).toBeNull();
  });

  it("epochMsToIso: the recorded PIT@CLE kickoff is 20:15 ET on 2026-10-01", () => {
    expect(epochMsToIso(1790900100000)).toBe("2026-10-02T00:15:00.000Z");
    expect(epochMsToIso(1790900100000)).toBe(kickoffUtcFromEastern("2026-10-01", "20:15"));
    expect(epochMsToIso("1790900100000")).toBeNull();
    expect(epochMsToIso(253_402_300_799_999)).toBe("9999-12-31T23:59:59.999Z");
  });

  it("boolToInt maps only booleans", () => {
    expect(boolToInt(true)).toBe(1);
    expect(boolToInt(false)).toBe(0);
    for (const v of [1, 0, "true", "false", null, undefined, {}]) expect(boolToInt(v)).toBeNull();
  });

  it("byeWeek: 1–22, the FA pseudo-team's 0 is no bye", () => {
    expect(byeWeek(11)).toBe(11);
    expect(byeWeek(1)).toBe(1);
    expect(byeWeek(22)).toBe(22);
    for (const v of [0, 23, -1, 5.5, "11", null]) expect(byeWeek(v)).toBeNull();
  });

  it("jerseyNumber: integers and 1–2 digit text in 0–99", () => {
    expect(jerseyNumber("28")).toBe(28);
    expect(jerseyNumber(" 0 ")).toBe(0);
    expect(jerseyNumber(99)).toBe(99);
    expect(jerseyNumber(0)).toBe(0);
    for (const v of ["100", "-1", "1.5", "", "x", "１２", 100, -1, 1.5, Number.NaN, null, {}])
      expect(jerseyNumber(v)).toBeNull();
  });
});

describe("espnAbbrevToNflverse (research 04 §C: WSH → WAS, LAR → LA)", () => {
  it("maps the two spellings that differ and passes the other 30 through", () => {
    expect(espnAbbrevToNflverse("WSH")).toBe("WAS");
    expect(espnAbbrevToNflverse("LAR")).toBe("LA");
    for (const t of NFL_TEAMS) {
      if (t === "WAS" || t === "LA") continue;
      expect(espnAbbrevToNflverse(t)).toBe(t);
    }
  });

  it.each([
    ["FA"],
    [""],
    ["wsh"],
    ["__proto__"],
    ["constructor"],
    ["toString"],
    [" BUF"],
    [null],
    [3],
  ])("returns null for %j", (v) => {
    expect(espnAbbrevToNflverse(v)).toBeNull();
  });
});

describe("nflverseGameId (derived from an ESPN pro game)", () => {
  it("formats season, 2-digit week and nflverse teams", () => {
    expect(nflverseGameId(2026, 4, "PIT", "CLE")).toBe("2026_04_PIT_CLE");
    expect(nflverseGameId(2026, 11, "MIN", "SF")).toBe("2026_11_MIN_SF");
    expect(nflverseGameId(2025, 22, "SEA", "NE")).toBe("2025_22_SEA_NE");
  });

  it.each([
    [2026, 0, "PIT", "CLE"],
    [2026, 23, "PIT", "CLE"],
    [2026, 4.5, "PIT", "CLE"],
    [1998, 4, "PIT", "CLE"],
    [3000, 4, "PIT", "CLE"],
    ["2026", 4, "PIT", "CLE"],
    [2026, "4", "PIT", "CLE"],
    [2026, 4, "WSH", "CLE"], // ESPN spelling — map it first
    [2026, 4, "PIT", "LAR"],
    [2026, 4, "PIT", "PIT"],
    [2026, 4, "FA", "CLE"],
    [2026, 4, null, "CLE"],
    [2026, 4, "PIT_CLE", "X"],
  ])("returns null for %j %j %j %j", (s, w, a, h) => {
    expect(nflverseGameId(s, w, a, h)).toBeNull();
  });

  it("is unique and well-formed for every game of the recorded 2026 pro schedule", () => {
    const j = JSON.parse(
      readFileSync(
        new URL("../../../fixtures/espn/recorded/season/proTeamSchedules_wl.json", import.meta.url),
        "utf8",
      ),
    ) as {
      settings: {
        proTeams: {
          id: number;
          abbrev: string;
          proGamesByScoringPeriod?: Record<
            string,
            { id: number; scoringPeriodId: number; homeProTeamId: number; awayProTeamId: number }[]
          >;
        }[];
      };
    };
    const abbr = new Map(j.settings.proTeams.map((t) => [t.id, t.abbrev]));
    const ids = new Map<number, string>();
    for (const t of j.settings.proTeams)
      for (const gs of Object.values(t.proGamesByScoringPeriod ?? {}))
        for (const g of gs) {
          const id = nflverseGameId(
            2026,
            g.scoringPeriodId,
            espnAbbrevToNflverse(abbr.get(g.awayProTeamId)),
            espnAbbrevToNflverse(abbr.get(g.homeProTeamId)),
          );
          expect(id, String(g.id)).toMatch(/^2026_(0[1-9]|1[0-8])_[A-Z]{2,3}_[A-Z]{2,3}$/);
          ids.set(g.id, id ?? "");
        }
    expect(ids.size).toBe(272);
    expect(new Set(ids.values()).size).toBe(272);
    // research 04 §B.1.6's week-4 example
    expect(ids.get(401872964)).toBe("2026_04_PIT_CLE");
  });
});
