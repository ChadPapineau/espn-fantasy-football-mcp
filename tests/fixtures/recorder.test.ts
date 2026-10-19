// recorder.test.ts — scripts/record-fixture.ts --public against the synthetic fake ESPN: CLAUDE.md
// "Security" (no live request carries a cookie; never the write host), plan 05 §3.1 step 1 (keyless
// recording, raw captures OUTSIDE the repo), plan 10 §3.0 Z7 (≥ 3 final mBoxscore weeks with the
// league's own mSettings; statsOfficial verified), research 03 §D.3 (≥ 1.2 s spacing, ≤ 60 requests,
// a limit always with a sort, no retry on a 4xx). No network.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_REQUESTS,
  HARD_REQUEST_CAP,
  Refusal,
  parseArgs,
  plannedRequests,
  record,
} from "../../scripts/record-fixture.js";
import { parseScrubArgs } from "../../scripts/scrub-fixture.js";
import { RECORDINGS_DIR_NAME as RAW_RUNS_DIR } from "../../scripts/espn-fixture/guards.js";
import { parseHistoryArgs } from "../../scripts/espn-fixture/history.js";
import { READ_HOST, WRITE_HOST } from "../../scripts/espn-fixture/http.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { RECORDINGS_DIR_NAME, uninstall } from "../../src/cli/uninstall.js";
import type { XattrReader } from "../../src/config/paths.js";
import { fakeXattr, makeIo, sandbox } from "../cli/helpers.js";
import { tempDir, ROOT } from "../lint/helpers.js";
import { inProcessScan, makeRawRun, NOW, SEASON } from "./helpers/run.js";
import { fakeEspn, realGuid, rng, syntheticLeague } from "./helpers/synthetic.js";

let tmp: ReturnType<typeof tempDir> | undefined;
beforeEach(() => {
  tmp = tempDir("eff-record-");
  vi.stubEnv("EFF_SCAN_DENYLIST", "/dev/null");
});
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
  vi.unstubAllEnvs();
});
const dir = () => tmp?.dir ?? "";
const ids = (...n: number[]) => n.map((x) => String(100_000 + x * 7919)).join(",");

describe("refuses to run with cookie material present (before any request)", () => {
  const s2 = ["espn", "s2"].join("_");
  const cookieEnvs: [string, NodeJS.ProcessEnv][] = [
    ["ESPN_S2", { ESPN_S2: "x".repeat(20) }],
    ["espn_s2 lower", { [s2]: "x" }],
    ["SWID", { SWID: "x" }],
    ["EFF_ESPN_SWID", { EFF_ESPN_SWID: "x" }],
    ["COOKIE", { COOKIE: "a=b" }],
    ["HTTP_COOKIE", { HTTP_COOKIE: "a=b" }],
    ["a value carrying espn_s2=", { SOMETHING: `${s2}=AEabc` }],
    ["a value that is a braced SWID", { SOMETHING: realGuid(rng(5)) }],
    ["a value with a URL-encoded SWID", { SOMETHING: `%7B${realGuid(rng(6), false)}%7D` }],
  ];
  it.each(cookieEnvs)("%s in the environment", (_n, env) => {
    expect(() => parseArgs(["--public"], { EFF_PROBE_LEAGUE_IDS: ids(1), ...env }, NOW)).toThrow(
      Refusal,
    );
    try {
      parseArgs(["--public"], { EFF_PROBE_LEAGUE_IDS: ids(1), ...env }, NOW);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/cookie material is present/);
      for (const v of Object.values(env)) expect(msg).not.toContain(v ?? "never"); // names, never values
    }
  });

  const cookieArgs: string[][] = [
    ["--cookies"],
    ["--cookie"],
    [`${["espn", "s2"].join("_")}=x`],
    ["SWID={x}"],
    ["--header", "Cookie: a=b"],
  ];
  it.each(cookieArgs)("argument %j", (...extra) => {
    expect(() => parseArgs(["--public", ...extra], { EFF_PROBE_LEAGUE_IDS: ids(1) }, NOW)).toThrow(
      /cookie material is present \(argument #\d/,
    );
  });

  it("no fetch happens when refused", () => {
    const l = syntheticLeague(41, 4);
    const f = fakeEspn(new Map([[l.leagueId, l]]), SEASON);
    let o;
    try {
      o = parseArgs(["--public", "--cookies"], { EFF_PROBE_LEAGUE_IDS: l.leagueId }, NOW);
    } catch {
      o = null;
    }
    expect(o).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("the developer's real environment trips nothing (no false positive on ordinary variables)", () => {
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: ["", "home", "someone"].join("/"), // assembled: the file stays clean for the scanner
      TERM_SESSION_ID: `w0t0p0:${realGuid(rng(7), false)}`,
      LANG: "en_US.UTF-8",
      EFF_PROBE_LEAGUE_IDS: ids(1),
    };
    expect(() => parseArgs(["--public"], env, NOW)).not.toThrow();
  });
});

describe("argument validation", () => {
  const env = { EFF_PROBE_LEAGUE_IDS: ids(1, 2) };
  const bad: [string[], NodeJS.ProcessEnv, RegExp][] = [
    [[], env, /only --public/],
    [["--public", "--season", "2017"], env, /--season/],
    [["--public", "--weeks", "0,1"], env, /--weeks/],
    [["--public", "--weeks", "1,1"], env, /--weeks/],
    [["--public", "--weeks", ""], env, /needs a value|--weeks/],
    [["--public", "--max-requests", String(HARD_REQUEST_CAP + 1)], env, /--max-requests/],
    [["--public", "--kona-limit", "51"], env, /--kona-limit/],
    [["--public", "--prune", "a.b"], env, /--prune/],
    [["--public", "--league", "abc"], {}, /--league/],
    [["--public", "--bogus"], env, /unknown argument #2/],
    [["--public"], {}, /no league/],
    [["--public"], { EFF_PROBE_LEAGUE_IDS: "12,x" }, /comma-separated/],
    [["--public"], { EFF_PROBE_LEAGUE_IDS: `${ids(1)},${ids(1)}` }, /twice/],
    [["--public"], { EFF_PROBE_LEAGUE_IDS: ids(1, 2, 3, 4, 5, 6) }, /at most 5/],
    [
      ["--public", "--raw-dir", path.join(ROOT, "fixtures", "tmp-raw")],
      env,
      /OUTSIDE the repository/,
    ],
    [["--public", "--raw-dir", ROOT], env, /OUTSIDE the repository/],
    [["--public"], { ...env, ESPN_SEASON: "1990" }, /ESPN_SEASON/],
  ];
  it.each(bad)("%j is refused", (argv, e, msg) => {
    expect(() => parseArgs(argv, e, NOW)).toThrow(msg);
  });

  it("defaults: weeks 1–3, cap 60, kona page 25, raw dir under ~/.cache (outside the repo)", () => {
    const o = parseArgs(["--public"], env, NOW);
    expect(o.weeks).toEqual([1, 2, 3]);
    expect(o.maxRequests).toBe(DEFAULT_MAX_REQUESTS);
    expect(DEFAULT_MAX_REQUESTS).toBe(60);
    expect(HARD_REQUEST_CAP).toBe(80);
    expect(o.konaLimit).toBe(25);
    expect(o.season).toBe(2026);
    expect(o.rawDir).toMatch(
      /\.cache[/\\]espn-fantasy-football-mcp[/\\]recordings[/\\]2026-10-05$/,
    );
    // 3 season + 3 error + 3 × 15 per league + 2 probe extras: within the default cap
    expect(
      plannedRequests(parseArgs(["--public"], { EFF_PROBE_LEAGUE_IDS: ids(1, 2, 3) }, NOW)),
    ).toBe(53);
  });
});

// Stage C findings scripts-raw-dir-synced-accepted (a --raw-dir in Documents, Desktop or iCloud Drive
// was accepted by all three tools) and uninstall-recordings-override-path (the tools wrote under
// ~/.cache whatever EFF_CACHE_DIR said, while uninstall purged only EFF_CACHE_DIR's recordings).
describe("the raw directory: the product's location rule, under the cache dir uninstall purges", () => {
  const env = { EFF_PROBE_LEAGUE_IDS: ids(1) };
  /** Every fixture tool that takes a raw directory, parsing `--raw-dir <d>` under `g`. */
  const tools = (d: string, g: { home: string; xattr: XattrReader }) =>
    [
      ["record-fixture", () => parseArgs(["--public", "--raw-dir", d], env, NOW, g)],
      [
        "record-fixture --history",
        () =>
          parseHistoryArgs(
            ["--public", "--history", "--projections", "none", "--raw-dir", d],
            env,
            NOW,
            g,
          ),
      ],
      ["scrub-fixture", () => parseScrubArgs(["--raw-dir", d], g)],
    ] as const;

  it("refuses a cloud-synced folder, a file-provider directory and one it cannot check — in every tool", () => {
    const home = path.join(dir(), "home");
    mkdirSync(home);
    const managed = path.join(dir(), "provider-managed");
    mkdirSync(managed);
    const marks = fakeXattr({ [managed]: ["com.apple.fileprovider.fpfs#P"] });
    const cases: [string, XattrReader, RegExp][] = [
      [path.join(home, "Documents", "eff-raw-probe"), marks, /cloud-synced folder/],
      [path.join(home, "Desktop", "eff-raw"), marks, /cloud-synced folder/],
      [
        path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "eff-raw-probe"),
        marks,
        /cloud-synced folder/,
      ],
      [path.join(home, "Library", "CloudStorage", "Dropbox", "raw"), marks, /cloud-synced folder/],
      [path.join(home, "Dropbox", "raw"), marks, /cloud-synced folder/],
      [path.join(managed, "raw"), marks, /managed by a file provider/],
      [path.join(dir(), "plain", "raw"), () => null, /could not check whether/],
    ];
    for (const [d, xattr, why] of cases)
      for (const [tool, parse] of tools(d, { home, xattr })) {
        expect(parse, `${tool} ${path.relative(dir(), d)}`).toThrow(why);
        try {
          parse();
        } catch (e) {
          expect((e as Error).message).not.toContain(dir()); // the path is never printed
        }
      }
    // a plain local directory outside every repository passes all three
    for (const [tool, parse] of tools(path.join(dir(), "plain", "raw"), { home, xattr: marks }))
      expect(parse, tool).not.toThrow();
  });

  it("the default is <EFF_CACHE_DIR>/recordings/<date> (and history-<date>): eff uninstall removes both", async () => {
    const sb = sandbox();
    try {
      const e = { ...env, EFF_CACHE_DIR: sb.cacheDir };
      const g = { home: sb.home, xattr: fakeXattr() };
      const rec = parseArgs(["--public"], e, NOW, g).rawDir;
      const hist = parseHistoryArgs(
        ["--public", "--history", "--projections", "none"],
        e,
        NOW,
        g,
      ).rawDir;
      expect(RAW_RUNS_DIR).toBe(RECORDINGS_DIR_NAME);
      expect(rec).toBe(path.join(sb.cacheDir, RECORDINGS_DIR_NAME, "2026-10-05"));
      expect(hist).toBe(path.join(sb.cacheDir, RECORDINGS_DIR_NAME, "history-2026-10-05"));
      // what a recording run leaves (record-fixture.ts bindSlots: 0700 directories, a 0600 run.json)
      for (const d of [rec, hist]) {
        mkdirSync(d, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(d, "run.json"), "{}\n", { mode: 0o600 });
      }
      const io = makeIo(sb);
      const { config, log } = await loadLenientRuntime(io);
      const opts = { yes: true, dryRun: false, keepConfig: false, exportLog: undefined };
      expect(await uninstall(io, config, log, opts), io.err.text).toBe(0);
      expect(existsSync(rec)).toBe(false);
      expect(existsSync(hist)).toBe(false);
      expect(existsSync(path.join(sb.home, ".cache"))).toBe(false); // nothing under the home's default
    } finally {
      sb.cleanup();
    }
  });

  it("without EFF_CACHE_DIR the default stays ~/.cache/espn-fantasy-football-mcp/recordings; an EFF_CACHE_DIR the product refuses is refused", () => {
    const home = path.join(dir(), "home");
    const g = { home, xattr: fakeXattr() };
    expect(parseArgs(["--public"], env, NOW, g).rawDir).toBe(
      path.join(home, ".cache", "espn-fantasy-football-mcp", RECORDINGS_DIR_NAME, "2026-10-05"),
    );
    for (const bad of ["relative/cache", "~someone/cache"]) {
      expect(() => parseArgs(["--public"], { ...env, EFF_CACHE_DIR: bad }, NOW, g)).toThrow(
        /^EFF_CACHE_DIR: /,
      );
      expect(() =>
        parseHistoryArgs(
          ["--public", "--history", "--projections", "none"],
          { ...env, EFF_CACHE_DIR: bad },
          NOW,
          g,
        ),
      ).toThrow(/^EFF_CACHE_DIR: /);
    }
    // an explicit --raw-dir needs no cache dir at all
    expect(
      parseArgs(
        ["--public", "--raw-dir", path.join(dir(), "r")],
        { ...env, EFF_CACHE_DIR: "relative" },
        NOW,
        g,
      ).rawDir,
    ).toBe(path.join(dir(), "r"));
  });
});

describe("record() end to end against the fake ESPN", () => {
  it("every request is a keyless GET to the read host, spaced ≥ 1.2 s, within the plan and the cap", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 2 });
    const o = parseArgs(
      ["--public", "--raw-dir", path.join(dir(), "x")],
      { EFF_PROBE_LEAGUE_IDS: run.leagues.map((l) => l.leagueId).join(",") },
      NOW,
    );
    expect(run.fake.calls).toHaveLength(plannedRequests(o));
    expect(run.fake.calls.length).toBeLessThanOrEqual(HARD_REQUEST_CAP);
    for (const c of run.fake.calls) {
      const u = new URL(c.url);
      expect(u.hostname).toBe(READ_HOST);
      expect(u.hostname).not.toBe(WRITE_HOST);
      expect(c.redirect).toBe("manual");
      expect(
        Object.keys(c.headers).every((h) =>
          ["accept", "user-agent", "x-fantasy-filter"].includes(h),
        ),
      ).toBe(true);
      expect(c.headers["user-agent"]).toMatch(
        /^espn-fantasy-football-mcp\/\S+ \(fixture recorder; keyless; \+https:\/\/github\.com\//,
      );
    }
    expect(run.waits.length).toBe(run.fake.calls.length - 1);
    expect(run.waits.every((w) => w === 1200)).toBe(true);
  });

  it("the kona page has a limit ≤ 50 WITH a sort; box scores filter one matchup period; rosters weeks 1–3", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const urls = run.fake.calls.map((c) => ({
      u: new URL(c.url),
      f: c.headers["x-fantasy-filter"],
    }));
    const kona = urls.filter(
      (x) =>
        x.u.searchParams.getAll("view").includes("kona_player_info") &&
        x.f?.includes("sortPercOwned"),
    );
    expect(kona).toHaveLength(1);
    const filter = JSON.parse(kona[0]?.f ?? "{}") as {
      players: { limit: number; sortPercOwned: unknown };
    };
    expect(filter.players.limit).toBeLessThanOrEqual(50);
    expect(filter.players.sortPercOwned).toBeDefined();
    const box = urls.filter((x) => x.u.searchParams.get("view") === "mBoxscore");
    expect(box.map((b) => b.u.searchParams.get("scoringPeriodId"))).toEqual(["1", "2", "3"]);
    expect(box.map((b) => JSON.parse(b.f ?? "{}") as unknown)).toEqual(
      [1, 2, 3].map((mp) => ({ schedule: { filterMatchupPeriodIds: { value: [mp] } } })),
    );
    const roster = urls
      .filter((x) => x.u.searchParams.get("view") === "mRoster")
      .map((x) => x.u.searchParams.get("scoringPeriodId"));
    expect(roster).toEqual(["1", "2", "3"]);
    const team = urls.find((x) => x.u.searchParams.getAll("view").includes("mStandings"));
    expect(team?.u.searchParams.getAll("view")).toEqual(["mTeam", "mStandings"]);
  });

  it("raw captures land outside the repo, 0600 in a 0700 dir; the run map holds the ids there only", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const runFile = JSON.parse(readFileSync(path.join(run.rawDir, "run.json"), "utf8")) as {
      slots: Record<string, string>;
    };
    expect(runFile.slots["league-a"]).toBe(run.leagues[0]?.leagueId);
    const f = path.join(run.rawDir, "league-a", "mSettings.json");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(run.rawDir, "league-a")).mode & 0o777).toBe(0o700);
    const env = JSON.parse(readFileSync(f, "utf8")) as {
      headers: Record<string, string>;
      url: string;
    };
    expect(env.url).toContain(`/leagues/${run.leagues[0]?.leagueId ?? "x"}?`);
  });

  it("a week whose NFL games are not all statsOfficial is refused before its box score is requested", async () => {
    const err = await makeRawRun(path.join(dir(), "raw"), { count: 1, finalWeeks: [1, 2] }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/scoring period 3 is not final/);
  });

  it("a re-run on the same raw dir sends ZERO requests and scrubs to byte-identical fixtures", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const l = run.leagues[0];
    if (!l) throw new Error("fixture");
    const f = fakeEspn(new Map([[l.leagueId, l]]), SEASON);
    const o1 = parseArgs(
      ["--public", "--season", "2026", "--raw-dir", run.rawDir, "--out", path.join(dir(), "o1")],
      { EFF_PROBE_LEAGUE_IDS: l.leagueId },
      NOW,
    );
    const o2 = { ...o1, outRoot: path.join(dir(), "o2") };
    const logs: string[] = [];
    await record(o1, {
      fetch: f.fetch,
      sleep: () => Promise.resolve(),
      log: (s) => logs.push(s),
      scan: inProcessScan(),
    });
    await record(o2, {
      fetch: f.fetch,
      sleep: () => Promise.resolve(),
      log: () => undefined,
      scan: inProcessScan(),
    });
    expect(f.calls).toHaveLength(0);
    expect(logs.some((s) => s.includes("reused stored capture"))).toBe(true);
    const list = (d: string) => readdirSync(d, { recursive: true }).map(String).sort();
    expect(list(path.join(dir(), "o1"))).toEqual(list(path.join(dir(), "o2")));
    for (const rel of list(path.join(dir(), "o1")).filter((r) => r.endsWith(".json")))
      expect(readFileSync(path.join(dir(), "o2", rel), "utf8")).toBe(
        readFileSync(path.join(dir(), "o1", rel), "utf8"),
      );
    expect(logs.some((s) => s.includes(l.leagueId) || s.includes(l.leagueName))).toBe(false);
  });

  it("a raw dir bound to other leagues or another season is refused", async () => {
    const run = await makeRawRun(path.join(dir(), "raw"), { count: 1 });
    const o = parseArgs(
      ["--public", "--raw-dir", run.rawDir],
      { EFF_PROBE_LEAGUE_IDS: ids(9) },
      NOW,
    );
    await expect(
      record(o, {
        fetch: fakeEspn(new Map(), SEASON).fetch,
        sleep: () => Promise.resolve(),
        log: () => undefined,
      }),
    ).rejects.toThrow(/different run/);
  });

  it("a plan over --max-requests is refused before the first request", async () => {
    const l = syntheticLeague(42, 4);
    const f = fakeEspn(new Map([[l.leagueId, l]]), SEASON);
    const o = parseArgs(
      ["--public", "--raw-dir", path.join(dir(), "raw"), "--max-requests", "5"],
      { EFF_PROBE_LEAGUE_IDS: l.leagueId },
      NOW,
    );
    await expect(
      record(o, { fetch: f.fetch, sleep: () => Promise.resolve(), log: () => undefined }),
    ).rejects.toThrow(/needs up to \d+ requests/);
    expect(f.calls).toHaveLength(0);
  });

  it("a 4xx on a league (private, unknown) stops the run without a retry", async () => {
    const l = syntheticLeague(43, 4);
    const f = fakeEspn(new Map(), SEASON); // the league is unknown → 404
    const o = parseArgs(
      ["--public", "--raw-dir", path.join(dir(), "raw")],
      { EFF_PROBE_LEAGUE_IDS: l.leagueId },
      NOW,
    );
    await expect(
      record(o, { fetch: f.fetch, sleep: () => Promise.resolve(), log: () => undefined }),
    ).rejects.toThrow(/league-a\/mSettings: unexpected HTTP 404 — stopping/);
    expect(f.calls.filter((c) => c.url.includes("/leagues/")).length).toBe(1);
  });

  it("the full run (record + scrub) writes fixtures and a manifest with no identifier of any league", async () => {
    const leagues = [syntheticLeague(44, 4), syntheticLeague(45, 6)];
    const f = fakeEspn(new Map(leagues.map((l) => [l.leagueId, l])), SEASON);
    const out = path.join(dir(), "out");
    const o = parseArgs(
      ["--public", "--raw-dir", path.join(dir(), "raw"), "--out", out],
      { EFF_PROBE_LEAGUE_IDS: leagues.map((l) => l.leagueId).join(",") },
      NOW,
    );
    const logs: string[] = [];
    await record(o, {
      fetch: f.fetch,
      sleep: () => Promise.resolve(),
      log: (s) => logs.push(s),
      scan: inProcessScan(),
    });
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as {
      leagues: Record<string, { format: { teams: number } }>;
      files: { path: string }[];
    };
    expect(Object.keys(manifest.leagues)).toEqual(["league-a", "league-b"]);
    expect(manifest.leagues["league-b"]?.format.teams).toBe(6);
    const texts = [
      readFileSync(path.join(out, "manifest.json"), "utf8"),
      ...manifest.files.map((x) => readFileSync(path.join(out, x.path), "utf8")),
    ].join("\n");
    for (const l of leagues) {
      expect(texts).not.toContain(l.leagueId);
      expect(texts).not.toContain(l.leagueName);
      for (const t of l.teams) expect(texts).not.toContain(t.name);
      for (const m of l.members) expect(texts).not.toContain(m.displayName);
    }
    expect(logs.join("\n")).toMatch(
      /league-b: 6 teams, PPR 0\.5, pass TD 4, faab, 1 FLEX, final box-score weeks 1,2,3/,
    );
    for (const l of leagues) expect(logs.join("\n")).not.toContain(l.leagueId);
    // headers kept are the allow-list only (no ETag fingerprint, no CDN POP)
    const m2 = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as {
      files: { headers: Record<string, string> }[];
    };
    for (const fe of m2.files)
      for (const h of Object.keys(fe.headers))
        expect([
          "cache-control",
          "content-type",
          "x-fantasy-filter-player-count",
          "x-fantasy-filter-schedule-count",
          "x-fantasy-filter-transaction-count",
          "x-fantasy-role",
        ]).toContain(h);
    writeFileSync(path.join(dir(), "done"), "1");
  });
});
