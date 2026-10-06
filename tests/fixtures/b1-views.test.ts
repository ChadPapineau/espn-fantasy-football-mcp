// b1-views.test.ts — the B1 extensions of the keyless recorder and the scrub run against the synthetic
// fake ESPN: plan 05 §3.1 (mMatchupScore current + final, solo mNav, kona_player_info and
// kona_playercard by filterIds ≤ 25 ids, players_wl, the keyless 401; synthetic ONLY for error
// bodies — the fixture law), plan 07 A4/B2/C1 (the request shapes), research 03 §A.1–§A.4, CAT-12
// (a public player's name replaced, never the whole unit; a root-array row withheld value-free).
// No network: every fetch is the synthetic fake; every identifier-shaped value is built at run time.
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalize,
  stableStringify,
  type Json,
  type JsonObject,
} from "../../scripts/espn-fixture/canonical.js";
import {
  API_ROOT,
  READ_HOST,
  WRITE_HOST,
  communicationUrl,
  playersUrl,
} from "../../scripts/espn-fixture/http.js";
import {
  CARD_IDS_MAX,
  CARD_ROSTERED_IDS,
  PLAYERS_WL_FILTER,
  ROOT_ARRAY,
  cardIds,
  cardPlan,
  deriveIncomplete,
  idRange,
  leagueRequestPath,
  planSplit,
  readRaw,
  replaceableNameLeaves,
  requestUrl,
  rosteredPlayerIds,
  scrubRun,
  splitArrayKey,
  syntheticOutputs,
  withArray,
  withholdUnit,
  writeRaw,
  type RequestSpec,
} from "../../scripts/espn-fixture/pipeline.js";
import { SYNTHETIC_ERRORS, espnErrorBody } from "../../scripts/espn-fixture/synthetic.js";
import { parseArgs, plannedRequests } from "../../scripts/record-fixture.js";
import { tempDir } from "../lint/helpers.js";
import { NOW, inProcessScan, makeRawRun } from "./helpers/run.js";

let tmp: ReturnType<typeof tempDir> | undefined;
beforeEach(() => {
  tmp = tempDir("eff-b1-");
  vi.stubEnv("EFF_SCAN_DENYLIST", "/dev/null");
});
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
  vi.unstubAllEnvs();
});
const dir = () => tmp?.dir ?? "";

describe("record(): the B1 captures, keyless, on the read host only", () => {
  it("adds mMatchupScore current + final, solo mNav, two filterIds captures, players_wl and the 401", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 2 });
    const o = parseArgs(
      ["--public", "--raw-dir", path.join(dir(), "x")],
      { EFF_PROBE_LEAGUE_IDS: run.leagues.map((l) => l.leagueId).join(",") },
      NOW,
    );
    expect(run.fake.calls).toHaveLength(plannedRequests(o));
    const calls = run.fake.calls.map((c) => ({
      u: new URL(c.url),
      f: c.headers["x-fantasy-filter"],
      h: Object.keys(c.headers),
    }));
    for (const c of calls) {
      expect(c.u.hostname).toBe(READ_HOST);
      expect(c.u.hostname).not.toBe(WRITE_HOST);
      expect(c.h.every((h) => ["accept", "user-agent", "x-fantasy-filter"].includes(h))).toBe(true);
    }
    const view = (v: string) => calls.filter((c) => c.u.searchParams.getAll("view").includes(v));

    // mMatchupScore as plan 07 A4 requests it: no filter; the current week and the last final week
    const score = view("mMatchupScore");
    expect(score).toHaveLength(4);
    expect(score.every((c) => c.f === undefined)).toBe(true);
    expect(score.map((c) => c.u.searchParams.get("scoringPeriodId"))).toEqual(["5", "3", "5", "3"]);

    // mNav alone, once per league
    const nav = view("mNav").filter((c) => c.u.searchParams.getAll("view").length === 1);
    expect(nav).toHaveLength(2);

    // kona_player_info by filterIds (no limit, so no sort is needed) and kona_playercard
    const byIds = view("kona_player_info").filter((c) => c.f?.includes("filterIds"));
    const cards = view("kona_playercard");
    expect(byIds).toHaveLength(2);
    expect(cards).toHaveLength(2);
    for (const [i, c] of byIds.entries()) {
      const f = JSON.parse(c.f ?? "{}") as { players: { filterIds: { value: number[] } } };
      const ids = f.players.filterIds.value;
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThanOrEqual(CARD_IDS_MAX);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(Object.keys(f.players)).toEqual(["filterIds"]);
      const card = JSON.parse(cards[i]?.f ?? "{}") as {
        players: {
          filterIds: { value: number[] };
          filterStatsForTopScoringPeriodIds: { value: number; additionalValue: string[] };
        };
      };
      expect(card.players.filterIds.value).toEqual(ids); // the same players: cross-checkable
      expect(card.players.filterStatsForTopScoringPeriodIds).toEqual({
        value: 17,
        additionalValue: ["002026", "102026", "002025"],
      });
      // the league's rostered players are among them (the synthetic roster ids are team*100+k)
      expect(ids.filter((id) => id >= 100 && id < 1000).length).toBeGreaterThan(0);
    }

    // players_wl: the season /players route, root-level filterActive, no league id
    const pl = calls.filter((c) => c.u.pathname.endsWith("/players"));
    expect(pl).toHaveLength(1);
    expect(pl[0]?.u.pathname).toBe("/apis/v3/games/ffl/seasons/2026/players");
    expect(pl[0]?.u.searchParams.getAll("view")).toEqual(["players_wl"]);
    expect(JSON.parse(pl[0]?.f ?? "null")).toEqual(PLAYERS_WL_FILTER);

    // the keyless 401: the first league's board route, once
    const comm = calls.filter((c) => c.u.pathname.endsWith("/communication/"));
    expect(comm).toHaveLength(1);
    expect(comm[0]?.u.pathname).toContain(`/leagues/${run.leagues[0]?.leagueId ?? "x"}/`);
    const env = readRaw(run.rawDir, "errors", "401-communication-not-visible");
    expect(env?.status).toBe(401);
    expect(env?.route).toBe("communication");
  });

  it("the full run writes the new fixtures, a synthetic 401 marked as such, and no identifier", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const r = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir(), "out"),
      scan: inProcessScan(),
      dryRun: true,
    });
    const paths = r.manifest.files.map((f) => f.path);
    for (const p of [
      "recorded/season/players_wl.json",
      "recorded/errors/401-communication-not-visible.json",
      "recorded/league-a/mMatchupScore.sp5.json",
      "recorded/league-a/mMatchupScore.sp3.json",
      "recorded/league-a/mNav.json",
      "recorded/league-a/kona_player_info.ids.json",
      "recorded/league-a/kona_playercard.json",
    ])
      expect(paths, p).toContain(p);
    const byPath = (p: string) => r.manifest.files.find((f) => f.path === p);
    expect(byPath("recorded/league-a/mMatchupScore.sp3.json")?.stats_official).toBe(true);
    expect(byPath("recorded/league-a/mMatchupScore.sp5.json")?.stats_official).toBe(false);
    expect(byPath("recorded/season/players_wl.json")?.request).toEqual({
      route: "players",
      path: "/apis/v3/games/ffl/seasons/2026/players",
      query: "view=players_wl",
      filter: PLAYERS_WL_FILTER,
    });
    expect(byPath("recorded/errors/401-communication-not-visible.json")?.request.path).toBe(
      "/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0/communication/",
    );
    // kona_playercard keeps every key (shape evidence): nothing pruned
    expect(byPath("recorded/league-a/kona_playercard.json")?.pruned).toEqual([]);
    expect(byPath("recorded/league-a/mNav.json")?.pruned).toEqual(["rankings"]);
    // players_wl is a root array, sorted by id (the canonical order)
    const pw = JSON.parse(
      r.outputs.find((o) => o.rel === "recorded/season/players_wl.json")?.text ?? "{}",
    ) as JsonObject[];
    expect(Array.isArray(pw)).toBe(true);
    const ids = pw.map((p) => p.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(byPath("recorded/season/players_wl.json")?.top_level_keys).toEqual([]);
    // the synthetic 401 is listed apart, marked synthetic, error-only, no scoring field
    expect(r.manifest.synthetic_files).toHaveLength(SYNTHETIC_ERRORS.length);
    const syn = r.manifest.synthetic_files?.[0];
    expect(syn).toMatchObject({
      path: "synthetic/errors/401-league-not-visible.json",
      synthetic: true,
      kind: "error",
      status: 401,
      scoring: { entries: 0 },
      top_level_keys: ["details", "messages"],
    });
    expect(syn?.basis).toMatch(/research 03 §A\.4/);
    expect(r.outputs.some((o) => o.rel === syn?.path)).toBe(true);
    // no identifier of the synthetic league anywhere
    const all = r.outputs.map((o) => o.text).join("\n");
    for (const l of run.leagues)
      for (const s of [l.leagueId, l.leagueName, ...l.members.map((m) => m.displayName)])
        expect(all).not.toContain(s);
  });
});

describe("cardIds / cardPlan — the deterministic ≤ 25-id set", () => {
  const roster = (ids: number[]) => ({
    teams: [
      {
        id: 1,
        roster: {
          entries: ids.slice(0, Math.ceil(ids.length / 2)).map((playerId) => ({ playerId })),
        },
      },
      {
        id: 2,
        roster: { entries: ids.slice(Math.ceil(ids.length / 2)).map((playerId) => ({ playerId })) },
      },
    ],
  });
  const kona = (ids: number[]) => ({ players: ids.map((id) => ({ id })) });

  it("spreads over the rostered ids (the most negative first), then adds the kona page in its order", () => {
    const rostered = Array.from({ length: 160 }, (_, i) => (i < 10 ? -16_001 - i : 1000 + i * 7));
    const ids = cardIds(roster(rostered), kona([77, 66, 55, 44, 33, 22]));
    expect(ids).toHaveLength(CARD_IDS_MAX);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toContain(Math.min(...rostered)); // a D/ST-shaped id is covered
    expect(ids.filter((i) => rostered.includes(i))).toHaveLength(CARD_ROSTERED_IDS);
    expect(ids.filter((i) => [77, 66, 55, 44, 33].includes(i))).toHaveLength(5);
    expect(ids).not.toContain(22); // the page is cut at the cap
    expect(cardIds(roster(rostered), kona([77, 66, 55, 44, 33, 22]))).toEqual(ids); // deterministic
  });

  it("dedups, ignores non-integer ids, and survives hostile or empty bodies", () => {
    expect(rosteredPlayerIds(roster([3, 3, 1.5, 2] as number[]))).toEqual([2, 3]);
    expect(rosteredPlayerIds(null)).toEqual([]);
    expect(rosteredPlayerIds({ teams: [{ roster: { entries: "x" } }, 7, null] })).toEqual([]);
    expect(cardIds(roster([5, 6]), kona([6, 7, Number.NaN, 2 ** 60]))).toEqual([5, 6, 7]);
    expect(cardIds(null, null)).toEqual([]);
    expect(cardIds({ teams: "x" }, { players: [{ id: "9" }] })).toEqual([]);
    for (const bad of [0, 26, 1.5]) expect(() => cardIds(roster([1]), kona([]), bad)).toThrow();
  });

  it("property: ≤ max ids, sorted, unique, a subset of the inputs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -20_000, max: 5_000_000 }), { maxLength: 300 }),
        fc.array(fc.integer({ min: -20_000, max: 5_000_000 }), { maxLength: 60 }),
        fc.integer({ min: 1, max: CARD_IDS_MAX }),
        (r, k, max) => {
          const ids = cardIds(roster(r), kona(k), max);
          expect(ids.length).toBeLessThanOrEqual(max);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids).toEqual([...ids].sort((a, b) => a - b));
          for (const id of ids) expect(r.includes(id) || k.includes(id)).toBe(true);
        },
      ),
    );
  });

  it("cardPlan: the two filterIds requests; refuses an empty, oversized or non-integer id list", () => {
    const settings = { status: { latestScoringPeriod: 6, finalScoringPeriod: 18 } };
    const [info, card] = cardPlan("league-a", [1, 2], settings, 2026) as [RequestSpec, RequestSpec];
    expect(info).toMatchObject({
      name: "kona_player_info.ids",
      views: ["kona_player_info"],
      params: { scoringPeriodId: "6" },
      filter: { players: { filterIds: { value: [1, 2] } } },
    });
    expect(card.filter).toEqual({
      players: {
        filterIds: { value: [1, 2] },
        filterStatsForTopScoringPeriodIds: {
          value: 18,
          additionalValue: ["002026", "102026", "002025"],
        },
      },
    });
    expect(cardPlan("x", [1], {}, 2026)[0]?.params).toEqual({});
    expect((cardPlan("x", [1], {}, 2026)[1]?.filter as JsonObject).players).toMatchObject({
      filterStatsForTopScoringPeriodIds: { value: 17 },
    });
    expect(() => cardPlan("x", [], settings, 2026)).toThrow(/player ids/);
    expect(() =>
      cardPlan(
        "x",
        Array.from({ length: 26 }, (_, i) => i),
        settings,
        2026,
      ),
    ).toThrow();
    expect(() => cardPlan("x", [1.5], settings, 2026)).toThrow();
  });
});

describe("routes and request paths", () => {
  it("builds the players and communication routes; the league id stays digits only", () => {
    expect(playersUrl(2026, ["players_wl"])).toBe(
      `${API_ROOT}/seasons/2026/players?view=players_wl`,
    );
    const u = new URL(communicationUrl(2026, "0", ["kona_league_communication"]));
    expect(u.hostname).toBe(READ_HOST);
    expect(u.pathname).toBe("/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0/communication/");
    for (const bad of ["../1", "1?view=x", "1/../../x", "", "1 "])
      expect(() => communicationUrl(2026, bad, ["kona_league_communication"])).toThrow();
    const spec = (route: RequestSpec["route"]): RequestSpec => ({
      slot: "s",
      name: "n",
      kind: "season",
      route,
      views: ["v"],
      params: {},
      filter: null,
      expect: "ok",
    });
    expect(requestUrl(spec("players"), 2026, null)).toContain("/seasons/2026/players?");
    expect(() => requestUrl(spec("communication"), 2026, null)).toThrow(/league id/);
    expect(requestUrl(spec("communication"), 2026, "4")).toContain("/leagues/4/communication/?");
    expect(leagueRequestPath(2026, "season")).toBe("/apis/v3/games/ffl/seasons/2026");
    expect(leagueRequestPath(2026, "players")).toBe("/apis/v3/games/ffl/seasons/2026/players");
    expect(leagueRequestPath(2026, "league")).toBe(
      "/apis/v3/games/ffl/seasons/2026/segments/0/leagues/0",
    );
  });
});

describe("root-array bodies (players_wl): split, withhold, replace — value-free", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: 100 + i,
      fullName: `Player ${String(100 + i)}`,
      firstName: "Player",
      lastName: String(100 + i),
      eligibleSlots: [2, 3, 23],
    })) as Json[];

  it("splitArrayKey / withArray / idRange / planSplit treat the body itself as the array", async () => {
    expect(splitArrayKey(rows(3))).toBe(ROOT_ARRAY);
    expect(splitArrayKey(rows(1))).toBeNull();
    expect(splitArrayKey({ a: [1, 2], b: [1, 2, 3] })).toBe("b");
    expect(splitArrayKey(7)).toBeNull();
    expect(withArray(rows(3), ROOT_ARRAY, [1])).toEqual([1]);
    expect(withArray({ a: [1, 2], z: 1 }, "a", [9])).toEqual({ a: [9], z: 1 });
    expect(idRange(rows(4))).toEqual({ first: 100, last: 103 });
    expect(idRange([{ id: 1 }, { x: 2 }] as Json[])).toBeNull();
    expect(idRange([])).toBeNull();
    const body = rows(200);
    const ranges = await planSplit(body, ROOT_ARRAY, 6000);
    expect(ranges).not.toBeNull();
    const r = ranges ?? [];
    expect(r[0]?.from).toBe(0);
    expect(r[r.length - 1]?.to).toBe(200);
    for (let i = 1; i < r.length; i++) expect(r[i]?.from).toBe(r[i - 1]?.to);
    expect(await planSplit(body, ROOT_ARRAY, 50)).toBeNull(); // one row alone is over the cap
    expect(await planSplit({ a: 1 }, "a", 5000)).toBeNull();
  });

  it("a scrub run splits an oversized index along `$` with id ranges, losslessly", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "season", "players_wl");
    if (!env) throw new Error("missing capture");
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify(rows(400).reverse()) });
    const whole = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir(), "w"),
      scan: inProcessScan(),
      dryRun: true,
    });
    const roster = whole.manifest.files.filter((f) => f.path.includes("mRoster"));
    const cap = Math.max(
      Math.min(...roster.map((f) => f.bytes)) - 1,
      // every non-index body must still fit one element per part; the index rows are small
      1,
    );
    const split = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir(), "s"),
      scan: inProcessScan(),
      dryRun: true,
      maxBytes: cap,
    });
    const parts = split.manifest.files
      .filter((f) => f.path.startsWith("recorded/season/players_wl.p"))
      .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
    expect(parts.length).toBeGreaterThan(1);
    const bodies = parts.map(
      (p) => JSON.parse(split.outputs.find((o) => o.rel === p.path)?.text ?? "[]") as JsonObject[],
    );
    parts.forEach((p, i) => {
      const b = bodies[i] ?? [];
      expect(p.part).toEqual({
        index: i + 1,
        of: parts.length,
        array: "$",
        id_range: { first: b[0]?.id, last: b[b.length - 1]?.id },
      });
      expect(p.bytes).toBeLessThanOrEqual(cap);
    });
    const merged = bodies.flat();
    const original = JSON.parse(
      whole.outputs.find((o) => o.rel === "recorded/season/players_wl.json")?.text ?? "[]",
    ) as Json;
    expect(stableStringify(merged as Json)).toBe(stableStringify(original));
  });

  it("a deny-listed name in a one-line index row replaces that row's name leaves; the row stays", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "season", "players_wl");
    if (!env) throw new Error("missing capture");
    const body = rows(5);
    const term = ["Gridiron", "Hero"].join(" ");
    const row = body[2] as JsonObject;
    row.fullName = term;
    row.firstName = "Gridiron";
    row.lastName = "Hero";
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify(body) });
    const r = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir(), "out"),
      scan: inProcessScan([term]),
      withholdDenylisted: true,
      dryRun: true,
    });
    const e = r.manifest.files.find((f) => f.path === "recorded/season/players_wl.json");
    expect(e?.withheld).toEqual([]);
    expect(e?.replaced).toEqual(["$[2].firstName", "$[2].fullName", "$[2].lastName"]);
    expect(e?.incomplete).toBeNull();
    const text = r.outputs.find((o) => o.rel === "recorded/season/players_wl.json")?.text ?? "";
    expect(text).not.toContain(term);
    expect((JSON.parse(text) as JsonObject[])[2]).toMatchObject({
      id: 102,
      fullName: "Player 102",
      firstName: "Player 102",
      lastName: "Player 102",
      eligibleSlots: [2, 3, 23],
    });
  });

  it("a deny-listed NON-name value in an index row withholds the row; the count is recorded, never the id", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const env = readRaw(run.rawDir, "season", "players_wl");
    if (!env) throw new Error("missing capture");
    const body = rows(5);
    const term = ["Zephyr", "Quokka"].join("");
    (body[3] as JsonObject).note = term; // not a name leaf: replacing the names cannot clear it
    writeRaw(run.rawDir, { ...env, bodyText: JSON.stringify(body) });
    const r = await scrubRun({
      rawDir: run.rawDir,
      outRoot: path.join(dir(), "out"),
      scan: inProcessScan([term]),
      withholdDenylisted: true,
      dryRun: true,
    });
    const e = r.manifest.files.find((f) => f.path === "recorded/season/players_wl.json");
    expect(e?.withheld).toEqual(["$[3]"]);
    expect(e?.replaced).toEqual([]); // the failed replacement is not reported as a replacement
    expect(e?.incomplete).toEqual({ team_ids: [], matchups_missing: 0, rows_missing: 1 });
    const text = r.outputs.find((o) => o.rel === "recorded/season/players_wl.json")?.text ?? "";
    expect(text).not.toContain(term);
    expect((JSON.parse(text) as unknown[]).length).toBe(4);
    expect(JSON.stringify(r.manifest)).not.toContain(term);
  });

  it("replaceableNameLeaves / withholdUnit / deriveIncomplete on root rows and one-line players", () => {
    const body = canonicalize({
      players: [{ id: 7, player: { id: 70, fullName: "A B", firstName: "A", lastName: "B" } }],
    });
    expect(replaceableNameLeaves(body, ["players", 0, "player"]).map((u) => u.segs)).toEqual([
      ["players", 0, "player", "firstName"],
      ["players", 0, "player", "fullName"],
      ["players", 0, "player", "lastName"],
    ]);
    expect(replaceableNameLeaves(body, ["players", 0, "player", "fullName"])).toEqual([
      { segs: ["players", 0, "player", "fullName"], action: "replace", value: "Player 70" },
    ]);
    expect(replaceableNameLeaves(body, ["players", 0])).toEqual([]); // not a player object
    expect(replaceableNameLeaves(rows(2), [1]).map((u) => u.value)).toEqual([
      "Player 101",
      "Player 101",
    ]); // fullName already reads "Player 101": only first/last are replaced
    expect(replaceableNameLeaves([{ fullName: "x" }] as Json, [0])).toEqual([]); // no id
    expect(replaceableNameLeaves(rows(2), [5])).toEqual([]);
    expect(withholdUnit("players_wl", [4, "fullName"])).toEqual({ segs: [4], action: "omit" });
    expect(withholdUnit("kona_playercard", ["players", 2, "player", "x"])).toEqual({
      segs: ["players", 2],
      action: "omit",
    });
    expect(deriveIncomplete(rows(2), ["$[1]", "$[4]"])).toEqual({
      team_ids: [],
      matchups_missing: 0,
      rows_missing: 2,
    });
    expect(deriveIncomplete({ players: [] }, ["$.players[0]"])).toEqual({
      team_ids: [],
      matchups_missing: 0,
      rows_missing: 1,
    });
  });
});

describe("synthetic error bodies (the fixture law: error bodies only)", () => {
  it("the shipped list is error-only, ESPN-shaped, typed and carries no scoring field", async () => {
    const problems: string[] = [];
    const out = await syntheticOutputs(SYNTHETIC_ERRORS, inProcessScan(), problems);
    expect(problems).toEqual([]);
    for (const e of out.entries) {
      expect(e.status).toBeGreaterThanOrEqual(400);
      expect(e.scoring.entries).toBe(0);
      expect(e.path).toMatch(/^synthetic\/errors\/[\w.-]+\.json$/);
    }
    const body = SYNTHETIC_ERRORS[0]?.body as { details: { type: string }[] };
    expect(body.details[0]?.type).toBe("AUTH_LEAGUE_NOT_VISIBLE");
  });

  it("refuses a non-error status, a scoring field, a bad or duplicate name, and a scanner finding", async () => {
    const problems: string[] = [];
    const base = { views: ["mSettings"], basis: "test", body: espnErrorBody("X_Y", "m") };
    await syntheticOutputs(
      [
        { ...base, name: "ok-200", status: 200 },
        { ...base, name: "scored", status: 401, body: { appliedTotal: 3 } },
        { ...base, name: "../evil", status: 401 },
        { ...base, name: "dup", status: 401 },
        { ...base, name: "dup", status: 401 },
      ],
      inProcessScan(),
      problems,
    );
    expect(problems.join("\n")).toMatch(/must be an error/);
    expect(problems.join("\n")).toMatch(/never carry a scoring field/);
    expect(problems.join("\n")).toMatch(/bad or duplicate synthetic name/);
    expect(problems.filter((p) => p.includes("duplicate"))).toHaveLength(2);
    const p2: string[] = [];
    await syntheticOutputs(
      [{ ...base, name: "secret", status: 401, body: { messages: ["x"] } }],
      () => ({ clean: false, findings: ["f"] }),
      p2,
    );
    expect(p2.join("\n")).toMatch(/scanner refused/);
    expect(() => espnErrorBody("lower", "m")).toThrow(/UPPER_SNAKE/);
  });
});
