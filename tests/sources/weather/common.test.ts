// common.test.ts — the shared weather machinery: the roof rule, game selection from the ESPN pro
// schedule (nflverse game id derived, venue via venueForGame, TBD games skipped), unit conversion,
// the per-run temp file and its schema assertion, and the EFF_WEATHER_SOURCE switch (plan 01 §5.2;
// plan 06 §1.3). Adversarial: hostile JSON, truncated/oversized/foreign temp files, aborts.
// Ported from sibling @cf3b015, adapted.
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import type { SourceContext } from "../../../src/sources/source.js";
import { venueById, type VenueReference } from "../../../src/sources/venues.js";
import {
  buildRows,
  createWeatherSource,
  decodeJson,
  hourBucket,
  inRange,
  isoOrNull,
  MAX_WEATHER_FILE_BYTES,
  MAX_WEATHER_GAMES,
  needsWeather,
  num,
  own,
  percentToFraction,
  readWeatherFile,
  safeId,
  selectGames,
  toFahrenheit,
  toMph,
  WEATHER_FILE_FORMAT,
  type WeatherFile,
  type WeatherProvider,
} from "../../../src/sources/weather/common.js";
import { DEFAULT_WEATHER_SOURCE, weatherSourceFor } from "../../../src/sources/weather/index.js";
import { OPEN_METEO_PROVIDER } from "../../../src/sources/weather/open-meteo.js";
import { columnsHash } from "../../../src/store/datasets/tables.js";
import { fakeProSchedule, NO_DOWNLOAD, proGame, recordingWriter } from "../runner/helpers.js";
import { roofReader, T, WEATHER_NOW, weekFiveGames } from "./helpers.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eff-wx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(over: Partial<SourceContext> = {}): SourceContext {
  return {
    http: () => Promise.reject(new Error("no network")),
    download: NO_DOWNLOAD,
    signal: new AbortController().signal,
    clock: fixedClock(WEATHER_NOW),
    seasons: [2026],
    week: 5,
    datasets: { proSchedule: fakeProSchedule(weekFiveGames()), nflGames: roofReader() },
    tempDir: dir,
    notPublished: () => undefined,
    ...over,
  };
}

const venue = (id: string): VenueReference => {
  const v = venueById(id);
  if (v === null) throw new Error(id);
  return v;
};

describe("roof rule (the physical roof wins; retractable → the game's own roof, unknown → closed)", () => {
  it.each([
    ["CLE00", "outdoors", true],
    ["CLE00", null, true],
    ["CLE00", "dome", true],
    ["MEL00", "dome", true],
    ["MUN01", "dome", true],
    ["DET00", "outdoors", false],
    ["LAX01", "outdoors", false],
    ["HOU00", null, false],
    ["HOU00", "closed", false],
    ["HOU00", "dome", false],
    ["HOU00", "open", true],
    ["IND00", " Outdoors ", true],
  ])("%s with game roof %j → %s", (id, roof, expected) => {
    expect(needsWeather(roof, venue(id))).toBe(expected);
  });
});

describe("selectGames (from the ESPN pro schedule)", () => {
  const P = { usOnly: false, horizonHours: 168 };
  it("the target week's confirmed kickoffs inside [now − 1 h, now + horizon], deduplicated by ESPN id", () => {
    const sch = fakeProSchedule(weekFiveGames());
    const reader = roofReader();
    const s = selectGames(ctx({ datasets: { proSchedule: sch, nflGames: reader } }), P, {});
    expect(s.games.map((g) => g.game_id).sort()).toEqual([
      "2026_05_CHI_GB",
      "2026_05_DAL_CLE",
      "2026_05_JAX_IND",
      "2026_05_PHI_JAX",
    ]);
    expect([...s.venues.keys()].sort()).toEqual(["CLE00", "GNB00", "IND00", "LON02"]);
    expect(sch.queries).toEqual([{ season: 2026, weeks: [5] }]);
    expect(s.warnings).toEqual(["no nflverse game id for ESPN game 411"]);
    // only the retractable venues' games are looked up for a roof
    expect(reader.asked).toEqual([[403, 404]]);
    expect(s.games.find((g) => g.game_id === "2026_05_DAL_CLE")).toEqual({
      game_id: "2026_05_DAL_CLE",
      espn_game_id: 401,
      season: 2026,
      week: 5,
      venue_id: "CLE00",
      lat: 41.5061,
      lon: -81.6995,
      kickoff_utc: "2026-10-04T17:00:00.000Z",
    });
  });

  it("ESPN spellings map to nflverse (LAR → LA, WSH → WAS) before the game id is built", () => {
    const s = selectGames(ctx(), P, {
      games: () => [
        proGame(1, "2026-10-04T17:00:00.000Z", { away_pro_team_id: 28, home_pro_team_id: T.LAR }),
      ],
    });
    expect(s.games).toEqual([]); // SoFi is a fixed roof
    expect(s.warnings).toEqual([]);
    const teams = [
      { id: 28, abbrev: "WSH", bye_week: null },
      { id: 21, abbrev: "PHI", bye_week: null },
    ];
    const s2 = selectGames(
      ctx({ datasets: { proSchedule: fakeProSchedule([], true, teams) } }),
      P,
      {
        games: () => [
          proGame(2, "2026-10-04T17:00:00.000Z", { away_pro_team_id: 21, home_pro_team_id: 28 }),
        ],
      },
    );
    expect(s2.games.map((g) => [g.game_id, g.venue_id])).toEqual([["2026_05_PHI_WAS", "WAS00"]]);
  });

  it("US only drops London; the newest season is used; no seasons → nothing", () => {
    const s = selectGames(ctx({ seasons: [2025, 2026] }), { usOnly: true, horizonHours: 156 }, {});
    expect(s.games.map((g) => g.venue_id)).not.toContain("LON02");
    expect(s.games.length).toBe(3);
    expect(selectGames(ctx({ seasons: [] }), P, {}).games).toEqual([]);
  });

  it("week null asks for every week; the horizon drops the far week", () => {
    const sch = fakeProSchedule(weekFiveGames());
    const s = selectGames(ctx({ week: null, datasets: { proSchedule: sch } }), P, {});
    expect(sch.queries).toEqual([{ season: 2026, weeks: null }]);
    expect(s.games.map((g) => g.espn_game_id)).not.toContain(412);
  });

  it("an unloaded pro schedule (no teams) yields warnings, not games", () => {
    const s = selectGames(
      ctx({ datasets: { proSchedule: fakeProSchedule(weekFiveGames(), false) } }),
      P,
      {
        games: () => weekFiveGames(),
      },
    );
    expect(s.games).toEqual([]);
    expect(s.warnings.every((w) => w.startsWith("no nflverse game id for ESPN game "))).toBe(true);
  });

  it("an injected game list replaces the reader; garbage kickoffs are skipped; the list is capped", () => {
    const sch = fakeProSchedule([]);
    const s = selectGames(ctx({ datasets: { proSchedule: sch } }), P, {
      games: () => [
        proGame(1, "next sunday"),
        proGame(2, "2026-10-04T17:00:00.000Z", { home_pro_team_id: 5, away_pro_team_id: 5 }),
      ],
    });
    expect(s.games).toEqual([]);
    expect(s.warnings).toEqual(["no nflverse game id for ESPN game 2"]);
    expect(sch.queries).toEqual([]);
    const many = Array.from({ length: MAX_WEATHER_GAMES + 50 }, (_, i) =>
      proGame(i + 1, "2026-10-04T17:00:00.000Z", { away_pro_team_id: 99 }),
    );
    expect(selectGames(ctx(), P, { games: () => many }).warnings).toHaveLength(MAX_WEATHER_GAMES);
  });
});

describe("small readers and unit conversions", () => {
  it("own never walks the prototype; num only finite numbers", () => {
    expect(own({ a: 1 }, "a")).toBe(1);
    expect(own({}, "toString")).toBeUndefined();
    expect(own([1], "0")).toBeUndefined();
    expect(own(null, "a")).toBeUndefined();
    expect([num(1), num(Number.NaN), num("1"), num(Number.POSITIVE_INFINITY)]).toEqual([
      1,
      null,
      null,
      null,
    ]);
  });
  it("conversions and ranges", () => {
    expect(toFahrenheit(0, "°C")).toBe(32);
    expect(toFahrenheit(0, "wmoUnit:degC")).toBe(32);
    expect(toFahrenheit(70, null)).toBe(70);
    expect(toFahrenheit(70, "K")).toBeNull();
    expect(toFahrenheit(null, "F")).toBeNull();
    expect(toMph(10, "m/s")).toBe(22.37);
    expect(toMph(10, "kn")).toBe(11.51);
    expect(toMph(10, null)).toBe(10);
    expect(toMph(10, "__proto__")).toBeNull();
    expect(toMph(10, "constructor")).toBeNull();
    expect(toMph(null, "mph")).toBeNull();
    expect(percentToFraction(50)).toBe(0.5);
    expect(percentToFraction(-1)).toBeNull();
    expect(percentToFraction(null)).toBeNull();
    expect(inRange(Number.NaN, 0, 1)).toBeNull();
  });
  it("isoOrNull / decodeJson / safeId / hourBucket / columns hash", () => {
    expect(isoOrNull("2026-10-04T13:00:00-04:00")).toBe("2026-10-04T17:00:00.000Z");
    expect(isoOrNull("x".repeat(100))).toBeNull();
    expect(isoOrNull(5)).toBeNull();
    expect(decodeJson(new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 });
    expect(decodeJson(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(decodeJson(new TextEncoder().encode("[".repeat(100_000)))).toBeUndefined();
    expect(safeId("2026_05_A_B")).toBe("2026_05_A_B");
    expect(safeId(42)).toBe("42");
    expect(safeId(1.5)).toBe("?");
    expect(safeId("a b\n")).toBe("?");
    expect(hourBucket(Date.parse("2026-10-01T23:59:59.999Z"))).toBe("2026-10-01T23");
    expect(columnsHash("weather:open_meteo")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the temp file", () => {
  const src = createWeatherSource(OPEN_METEO_PROVIDER);
  const write = async (name: string, v: unknown): Promise<string> => {
    const p = join(dir, name);
    await writeFile(p, typeof v === "string" ? v : JSON.stringify(v));
    return p;
  };
  const valid = {
    format: WEATHER_FILE_FORMAT,
    provider: "open_meteo",
    fetched_at: WEATHER_NOW,
    games: [],
    responses: [],
    warnings: ["w", 5],
  };

  it("readWeatherFile validates format, provider and shape", async () => {
    expect((await readWeatherFile(await write("ok.json", valid), "open_meteo")).warnings).toEqual([
      "w",
    ]);
    await expect(readWeatherFile(await write("p.json", valid), "nws")).rejects.toThrow(
      /format or provider/,
    );
    await expect(
      readWeatherFile(await write("f.json", { ...valid, format: "v0" }), "open_meteo"),
    ).rejects.toThrow();
    await expect(
      readWeatherFile(await write("i.json", { ...valid, games: "nope" }), "open_meteo"),
    ).rejects.toThrow(/incomplete/);
    await expect(
      readWeatherFile(await write("t.json", '{"format":'), "open_meteo"),
    ).rejects.toThrow();
    await expect(readWeatherFile(dir, "open_meteo")).rejects.toThrow(/missing or too large/);
    const big = join(dir, "big.json");
    await writeFile(big, "{}");
    await truncate(big, MAX_WEATHER_FILE_BYTES + 1);
    await expect(readWeatherFile(big, "open_meteo")).rejects.toThrow(/too large/);
    expect(
      (await readWeatherFile(await write("nw.json", { ...valid, warnings: "x" }), "open_meteo"))
        .warnings,
    ).toEqual([]);
  });

  it("assertSchema: exactly one readable file; zero games is fine; games with no usable body fail", async () => {
    const bad = async (files: { path: string; bytes: number; season: null }[]) =>
      src.assertSchema(files);
    expect((await bad([])).ok).toBe(false);
    const p = await write("a.json", valid);
    expect(
      (
        await bad([
          { path: p, bytes: 1, season: null },
          { path: p, bytes: 1, season: null },
        ])
      ).ok,
    ).toBe(false);
    expect((await bad([{ path: join(dir, "missing"), bytes: 1, season: null }])).warnings).toEqual([
      "the weather file is unreadable",
    ]);
    expect(await bad([{ path: p, bytes: 1, season: null }])).toMatchObject({ ok: true, rows: 0 });
    const g = selectGames(ctx(), OPEN_METEO_PROVIDER, {}).games;
    const noBody = await write("nb.json", {
      ...valid,
      games: g,
      responses: [{ venue_id: "CLE00", body: null }],
    });
    const r = await bad([{ path: noBody, bytes: 1, season: null }]);
    expect(r.ok).toBe(false);
    expect(r.warnings).toContain("no venue returned a usable forecast");
  });

  it("buildRows tolerates hostile response entries (no prototype reads, no throw)", () => {
    const g = selectGames(ctx(), OPEN_METEO_PROVIDER, {}).games;
    const file: WeatherFile = {
      format: WEATHER_FILE_FORMAT,
      provider: "open_meteo",
      fetched_at: WEATHER_NOW,
      games: g,
      responses: [
        null,
        5,
        { venue_id: "CLE00" },
        JSON.parse('{"__proto__":{"venue_id":"GNB00","body":{}}}') as unknown,
      ] as never[],
      warnings: [],
    };
    const out = buildRows(file, OPEN_METEO_PROVIDER);
    expect(out.rows).toEqual([]);
    expect(out.warnings).toHaveLength(g.length);
  });

  it("publish: no file → throws; an empty game list → an empty table", async () => {
    const w = recordingWriter();
    await expect(src.publish([], w)).rejects.toThrow(/nothing to publish/);
    const stats = await src.publish(
      [{ path: await write("e.json", valid), bytes: 1, season: null }],
      w,
    );
    expect(stats).toMatchObject({
      rows: 0,
      seasons: [],
      tables: [{ name: "ds_weather_open_meteo", rows: 0 }],
    });
    expect(stats.columns_hash).toBe(columnsHash("weather:open_meteo"));
    expect(w.tables.map((t) => t.name)).toEqual(["ds_weather_open_meteo"]);
  });

  it("fetch writes the file 0600 and exclusively (a second run into the same dir refuses)", async () => {
    const empty = ctx({ datasets: { proSchedule: fakeProSchedule([]) } });
    const files = await src.fetch({ version: "v", released_at: null }, empty);
    expect(files).toHaveLength(1);
    expect(files[0]?.season).toBeNull();
    await expect(src.fetch({ version: "v", released_at: null }, empty)).rejects.toThrow(/EEXIST/);
  });
});

describe("fetch loop edge cases", () => {
  const provider = (fetchVenue: WeatherProvider["fetchVenue"]): WeatherProvider => ({
    ...OPEN_METEO_PROVIDER,
    fetchVenue,
  });
  it("an abort between venues stops the run", async () => {
    const ac = new AbortController();
    const s = createWeatherSource(
      provider(() => {
        ac.abort();
        return Promise.resolve({ hourly: { time: [] } });
      }),
    );
    await expect(
      s.fetch({ version: "v", released_at: null }, ctx({ signal: ac.signal })),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
  it("an aborted HttpError from a venue is rethrown even after successes", async () => {
    let n = 0;
    const s = createWeatherSource(
      provider(() => {
        n++;
        return n === 1 ? Promise.resolve({}) : Promise.reject(new HttpError({ kind: "aborted" }));
      }),
    );
    await expect(s.fetch({ version: "v", released_at: null }, ctx())).rejects.toBeInstanceOf(
      HttpError,
    );
  });
  it("before any success an outage fails the attempt (even a non-retryable one); a policy refusal only warns", async () => {
    const dns = createWeatherSource(
      provider(() => Promise.reject(new HttpError({ kind: "dns", causeCode: "ENOTFOUND" }))),
    );
    await expect(dns.fetch({ version: "v", released_at: null }, ctx())).rejects.toMatchObject({
      kind: "dns",
    });
    const policy = createWeatherSource(
      provider(() => Promise.reject(new HttpError({ kind: "host_not_allowed" }))),
    );
    const files = await policy.fetch({ version: "v", released_at: null }, ctx());
    const report = await policy.assertSchema(files);
    expect(report.ok).toBe(false);
    expect(report.warnings.some((w) => w.endsWith(": host_not_allowed"))).toBe(true);
  });
  it("a failure AFTER a success only warns; a non-HttpError failure warns 'invalid response'", async () => {
    let n = 0;
    const s = createWeatherSource(
      provider(() => {
        n++;
        if (n === 1) return Promise.resolve({ hourly: { time: [] } });
        if (n === 2) return Promise.reject(new HttpError({ kind: "reset" }));
        return Promise.reject(new Error("bad shape"));
      }),
    );
    const files = await s.fetch({ version: "v", released_at: null }, ctx());
    const report = await s.assertSchema(files);
    expect(report.warnings.filter((w) => w.startsWith("venue "))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(": reset"),
        expect.stringContaining(": invalid response"),
      ]),
    );
  });
  it("a non-JSON venue body is stored as unusable with a warning", async () => {
    const s = createWeatherSource(provider(() => Promise.resolve(undefined)));
    const files = await s.fetch({ version: "v", released_at: null }, ctx());
    const report = await s.assertSchema(files);
    expect(report.warnings.some((w) => w.endsWith("response is not valid JSON"))).toBe(true);
  });
});

describe("weatherSourceFor (EFF_WEATHER_SOURCE)", () => {
  it("open-meteo (the default) | nws", () => {
    expect(DEFAULT_WEATHER_SOURCE).toBe("open-meteo");
    expect(weatherSourceFor("open-meteo").id).toBe("weather:open_meteo");
    expect(weatherSourceFor("nws").id).toBe("weather:nws");
  });
});
