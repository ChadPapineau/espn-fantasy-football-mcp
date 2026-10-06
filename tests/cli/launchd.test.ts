// launchd.test.ts — the job table, the plist generator, install/uninstall (plan 06 J1, §2; plan 03 L4)
// and the notification channel (plan 06 §2 "Notifications"). Every plist path is absolute, the env
// holds non-secret keys only (never EFF_CREDENTIAL_STORE/FILE, never a key), no kickoff or waiver
// time is baked in, and launchctl/osascript run only through the injected executor.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import {
  availableJobs,
  installLaunchd,
  jobsFor,
  uninstallLaunchd,
} from "../../src/cli/install-launchd.js";
import {
  JOBS,
  JOB_NAMES,
  LABEL_PREFIX,
  LAUNCHCTL,
  ensurePlainDir,
  installJobs,
  installedPlists,
  jobEnv,
  labelOf,
  launchAgentsDir,
  logDir,
  nextCredentialCheckAt,
  nextOccurrence,
  plistPath,
  removeJobs,
  renderPlist,
  selectJobs,
  writePlist,
  xmlEscape,
} from "../../src/cli/launchd.js";
import {
  NOTIFY_RATE_LIMIT_MS,
  OSASCRIPT,
  appleScriptString,
  createNotifier,
  failureText,
  jobToken,
  safeNotificationText,
} from "../../src/cli/notify.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { fakeExec, fakePackage, fakeXattr, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

describe("job table", () => {
  it("names are unique, labels generic, every job has a calendar and an eff argv", () => {
    sb = sandbox();
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
    for (const j of JOBS) {
      expect(j.calendar.length).toBeGreaterThan(0);
      expect(labelOf(j)).toBe(`${LABEL_PREFIX}.${j.name}`);
      expect(labelOf(j)).not.toMatch(/papineau|chad/i);
      for (const c of j.calendar) {
        if (c.Weekday !== undefined) expect(c.Weekday).toBeGreaterThanOrEqual(0);
        if (c.Hour !== undefined) expect(c.Hour).toBeLessThan(24);
        expect(c.Minute ?? 0).toBeLessThan(60);
      }
    }
    // the cookie jobs exist and the credential check is the only one exempt by name
    expect(JOBS.filter((j) => j.cookies).map((j) => j.name)).toContain("credential-check");
  });
  it("availableJobs: every refresh job of this build is installable (the ESPN season jobs included)", () => {
    sb = sandbox();
    const names = availableJobs().map((j) => j.name);
    expect(names).toContain("refresh-espn-schedule");
    expect(names).toContain("refresh-espn-players");
    expect(names).toContain("refresh-nflverse-daily");
    expect(names).toContain("probe");
    expect(jobsFor("refresh-espn-schedule").map((j) => j.name)).toEqual(["refresh-espn-schedule"]);
    expect(() => jobsFor("nope")).toThrow(/unknown job/);
    expect(jobsFor("probe, probe ,store-prune").map((j) => j.name)).toEqual([
      "probe",
      "store-prune",
    ]);
    expect(selectJobs("all").length).toBe(JOBS.length);
    expect(selectJobs("   ").length).toBe(JOBS.length);
  });
  it("the Phase-2 jobs (plan 06 §1.3; plan 10 §3.2): cadence, keyless, their sources and refresh job", () => {
    sb = sandbox();
    const by = new Map(JOBS.map((j) => [j.name, j]));
    const snaps = by.get("refresh-nflverse-snaps");
    expect(snaps?.argv).toEqual(["refresh", "nflverse:snaps", "--notify"]);
    expect(snaps?.calendar.map((c) => `${String(c.Hour)}:${String(c.Minute)}`)).toEqual([
      "1:30",
      "7:30",
      "13:30",
      "19:30",
    ]);
    expect(by.get("refresh-ffopportunity")?.calendar).toEqual([{ Hour: 8, Minute: 30 }]);
    expect(by.get("refresh-sleeper-trending")?.calendar).toEqual([{ Minute: 0 }, { Minute: 30 }]);
    expect(by.get("refresh-news")?.calendar.map((c) => c.Minute)).toEqual([0, 15, 30, 45]);
    expect(by.get("refresh-news")?.sources).toEqual(["news:rotowire", "news:espn", "news:cbs"]);
    expect(by.get("refresh-nflverse-stats")?.sources).toEqual([
      "nflverse:stats_player_week",
      "nflverse:stats_team_week",
      "nflverse:pbp",
    ]);
    expect(by.get("refresh-nflverse-daily")?.sources).toContain("nflverse:depth_charts");
    for (const n of [
      "refresh-nflverse-snaps",
      "refresh-ffopportunity",
      "refresh-sleeper-trending",
      "refresh-news",
    ]) {
      expect(by.get(n)?.cookies, n).toBe(false);
      expect(
        availableJobs().map((j) => j.name),
        n,
      ).toContain(n);
    }
  });

  it("nextOccurrence walks local time; the credential check's next run is 09:00 or Sun 08:00", () => {
    sb = sandbox();
    const at = new Date(2026, 9, 6, 10, 0, 0).getTime(); // a Tuesday, local
    const n = nextOccurrence([{ Hour: 9, Minute: 0 }], at);
    expect(n).toBe(new Date(2026, 9, 7, 9, 0, 0).getTime());
    expect(nextOccurrence([{ Minute: 30 }], at)).toBe(new Date(2026, 9, 6, 10, 30).getTime());
    expect(nextOccurrence([], at)).toBeNull();
    expect(nextOccurrence([{ Hour: 1 }], Number.NaN)).toBeNull();
    const sat = new Date(2026, 9, 10, 23, 0).toISOString();
    expect(nextCredentialCheckAt(sat)).toBe(new Date(2026, 9, 11, 8, 0).toISOString());
    expect(nextCredentialCheckAt("not a date")).toBeNull();
  });
});

describe("plists", () => {
  it("renders absolute ProgramArguments, the env, logs, Background, no RunAtLoad, the calendar", () => {
    sb = sandbox();
    const job = JOBS.find((j) => j.name === "probe")!;
    const xml = renderPlist({
      job,
      node: "/opt/node/bin/node",
      entry: "/opt/apps/My App/dist/cli.js",
      env: { B: "2", A: "1&<" },
      home: "/var/empty-home",
    });
    expect(xml).toContain("<string>/opt/node/bin/node</string>");
    expect(xml).toContain("<string>/opt/apps/My App/dist/cli.js</string>");
    expect(xml).toContain("<string>probe</string>");
    expect(xml.indexOf("<key>A</key>")).toBeLessThan(xml.indexOf("<key>B</key>"));
    expect(xml).toContain("1&amp;&lt;");
    expect(xml).toContain("Library/Logs/espn-fantasy-football-mcp/probe.log");
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(xml).toMatch(/<key>Hour<\/key>\s*<integer>5<\/integer>/);
    expect(() => renderPlist({ job, node: "node", entry: "/e", env: {}, home: "/h" })).toThrow(
      /absolute/,
    );
    expect(() => xmlEscape("a\u0001b")).toThrow(/control/);
  });
  it("jobEnv copies env-sourced non-secret keys only — never the credential keys or a secret", async () => {
    sb = sandbox();
    const io = makeIo(sb, {
      env: {
        ESPN_LEAGUE_ID: "0",
        ESPN_SEASON: "2026",
        EFF_LOG_LEVEL: "debug",
        EFF_CREDENTIAL_STORE: "file",
        EFF_CREDENTIAL_FILE: path.join(sb.configDir, "session.json"),
        ODDS_API_KEY: "k".repeat(32),
        EFF_FIXTURE_DIR: "/x",
      },
    });
    const { config } = await loadLenientRuntime(io);
    const env = jobEnv(config);
    expect(env).toEqual({
      EFF_CONFIG_DIR: sb.configDir,
      EFF_CACHE_DIR: sb.cacheDir,
      ESPN_LEAGUE_ID: "0",
      ESPN_SEASON: "2026",
      EFF_LOG_LEVEL: "debug",
    });
  });
  it("writePlist is atomic 0644 and refuses a symlink; ensurePlainDir refuses a non-directory", () => {
    sb = sandbox();
    const file = path.join(sb.home, "Library", "LaunchAgents", "x.plist");
    writePlist(file, "<plist/>");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    writePlist(file, "<plist>2</plist>");
    expect(readFileSync(file, "utf8")).toBe("<plist>2</plist>");
    const link = path.join(path.dirname(file), "y.plist");
    symlinkSync(file, link);
    expect(() => {
      writePlist(link, "x");
    }).toThrow(/symlink/);
    const notDir = path.join(sb.dir, "f");
    writeFileSync(notDir, "x");
    expect(() => {
      ensurePlainDir(notDir, 0o755);
    }).toThrow(/not a plain directory/);
  });
  it("installJobs writes each plist and boots it (bootout then bootstrap); removeJobs reverses it", async () => {
    sb = sandbox();
    const { exec, calls } = fakeExec((c) => ({
      code: c.args[0] === "bootstrap" && c.args[2]?.includes("store-prune") ? 5 : 0,
    }));
    const jobs = selectJobs("probe,store-prune");
    const steps = await installJobs({
      jobs,
      home: sb.home,
      node: "/n/node",
      entry: "/p/dist/cli.js",
      env: {},
      uid: 501,
      exec,
    });
    expect(steps.filter((s) => s.kind === "write")).toHaveLength(2);
    expect(steps.find((s) => s.detail.includes("store-prune") && s.kind === "launchctl")?.ok).toBe(
      false,
    );
    expect(calls.every((c) => c.file === LAUNCHCTL)).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap", "bootout", "bootstrap"]);
    expect(statSync(logDir(sb.home)).mode & 0o777).toBe(0o700);
    expect(installedPlists(sb.home).map((p) => p.job)).toEqual(["probe", "store-prune"]);
    const dry = await removeJobs({ home: sb.home, uid: 501, exec, dryRun: true });
    expect(dry).toHaveLength(4);
    expect(existsSync(plistPath(sb.home, "probe"))).toBe(true);
    const real = await removeJobs({ home: sb.home, uid: 501, exec, dryRun: false });
    expect(real.filter((s) => s.kind === "remove").every((s) => s.ok)).toBe(true);
    expect(installedPlists(sb.home)).toEqual([]);
    expect(installedPlists(path.join(sb.dir, "no-home"))).toEqual([]);
  });
});

describe("install-launchd / uninstall-launchd", () => {
  it("--dry-run prints every available plist and the launchctl commands, writes nothing, on any platform", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const io = makeIo(sb, { packageRoot: root, env: { ESPN_LEAGUE_ID: "0" } });
    const { config } = await loadLenientRuntime(io);
    expect(await installLaunchd(io, config, { jobs: undefined, dryRun: true })).toBe(0);
    expect(io.out.text).toContain("<plist");
    expect(io.out.text).toContain("# would run: /bin/launchctl bootstrap gui/501");
    expect(io.err.text).not.toContain("not available in this build");
    expect(io.out.text).toContain("refresh-espn-schedule");
    expect(existsSync(launchAgentsDir(sb.home))).toBe(false);
  });
  it("refuses off macOS (2), without a build (1), and under a file-provider directory (1)", async () => {
    sb = sandbox();
    const unbuilt = fakePackage(sb, { built: false });
    const io = makeIo(sb, { packageRoot: unbuilt });
    const { config } = await loadLenientRuntime(io);
    expect(await installLaunchd(io, config, { jobs: undefined, dryRun: false })).toBe(2);
    const mac = makeIo(sb, { packageRoot: unbuilt, platform: "darwin" });
    expect(await installLaunchd(mac, config, { jobs: undefined, dryRun: false })).toBe(1);
    expect(mac.err.text).toContain("npm run build");
    const dryUnbuilt = makeIo(sb, { packageRoot: unbuilt });
    expect(await installLaunchd(dryUnbuilt, config, { jobs: "probe", dryRun: true })).toBe(0);
    expect(dryUnbuilt.err.text).toContain("does not exist yet");
    const built = fakePackage(sb);
    const icloud = makeIo(sb, {
      packageRoot: built,
      platform: "darwin",
      xattr: fakeXattr({ [path.join(built, "dist")]: ["com.apple.file-provider-domain-id"] }),
    });
    expect(await installLaunchd(icloud, config, { jobs: "probe", dryRun: false })).toBe(1);
    expect(icloud.err.text).toContain("refused");
    expect(existsSync(launchAgentsDir(sb.home))).toBe(false);
    const noUid = makeIo(sb, { packageRoot: built, platform: "darwin", uid: null });
    expect(await installLaunchd(noUid, config, { jobs: "probe", dryRun: false })).toBe(1);
  });
  it("installs on macOS through launchctl and reports a failed bootstrap", async () => {
    sb = sandbox();
    const root = fakePackage(sb);
    const { exec, calls } = fakeExec((c) => ({ code: c.args[0] === "bootstrap" ? 37 : 0 }));
    const io = makeIo(sb, { packageRoot: root, platform: "darwin", exec });
    const { config } = await loadLenientRuntime(io);
    expect(await installLaunchd(io, config, { jobs: "probe", dryRun: false })).toBe(1);
    expect(io.out.text).toContain("FAIL launchctl bootstrap");
    expect(calls.length).toBe(2);
    const ok = makeIo(sb, { packageRoot: root, platform: "darwin", exec: fakeExec().exec });
    expect(await installLaunchd(ok, config, { jobs: "probe", dryRun: false })).toBe(0);
    expect(ok.out.text).toContain("installed 1 job(s)");
    const un = makeIo(sb, { platform: "darwin", exec: fakeExec().exec });
    expect(await uninstallLaunchd(un, { dryRun: true })).toBe(0);
    expect(un.out.text).toContain("would remove");
    expect(await uninstallLaunchd(un, { dryRun: false })).toBe(0);
    expect(await uninstallLaunchd(makeIo(sb, { platform: "darwin" }), { dryRun: false })).toBe(0);
    expect(await uninstallLaunchd(makeIo(sb), { dryRun: false })).toBe(0);
  });
});

describe("notify", () => {
  it("escapes AppleScript, redacts GUIDs, strips control/bidi characters and caps the text", () => {
    sb = sandbox();
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
    const g = `{${fakeGuid("notify")}}`;
    const t = safeNotificationText(`member ${g} ‮\u0007 ${"x".repeat(400)}`);
    expect(t).not.toContain(g);
    expect(t).toContain("{guid:");
    expect(t).not.toMatch(/[‮\u0007]/);
    expect(t.length).toBeLessThan(260);
    expect(failureText("bad job!", "not a code!")).toBe("job failed: error — run `eff status`");
    expect(jobToken("probe")).toBe("probe");
  });
  it("failures are rate-limited per job to one per 6 h; alarms and info never are", async () => {
    sb = sandbox();
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { platform: "darwin", exec });
    const n = createNotifier({ platform: "darwin", exec, clock: io.clock, cacheDir: sb.cacheDir });
    expect(await n.failure("probe", "network")).toBe("shown");
    expect(await n.failure("probe", "network")).toBe("rate_limited");
    expect(await n.failure("refresh-weather", "x")).toBe("shown");
    io.clock.advance(NOTIFY_RATE_LIMIT_MS + 1);
    expect(await n.failure("probe", "network")).toBe("shown");
    expect(await n.alarm("ESPN drift: mSettings: removed $.settings.x")).toBe("shown");
    expect(await n.alarm("again")).toBe("shown");
    expect(await n.info("Your roster changed")).toBe("shown");
    expect(calls.every((c) => c.file === OSASCRIPT && c.args[0] === "-e")).toBe(true);
    expect(calls).toHaveLength(6);
  });
  it("off macOS nothing is shown; a failing osascript is reported, never thrown", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    const linux = createNotifier({
      platform: "linux",
      exec: fakeExec().exec,
      clock: io.clock,
      cacheDir: sb.cacheDir,
    });
    expect(await linux.failure("probe", "x")).toBe("unsupported");
    expect(await linux.alarm("x")).toBe("unsupported");
    const failing = createNotifier({
      platform: "darwin",
      exec: fakeExec(() => ({ code: 1 })).exec,
      clock: io.clock,
      cacheDir: sb.cacheDir,
    });
    expect(await failing.info("x")).toBe("failed");
    expect(await failing.failure("probe", "x")).toBe("failed");
    const throwing = createNotifier({
      platform: "darwin",
      exec: () => Promise.reject(new Error("no")),
      clock: io.clock,
      cacheDir: sb.cacheDir,
    });
    expect(await throwing.alarm("x")).toBe("failed");
    mkdirSync(path.join(sb.dir, "c2"), { mode: 0o700 });
    expect(lstatSync(path.join(sb.dir, "c2")).isDirectory()).toBe(true);
  });
});
