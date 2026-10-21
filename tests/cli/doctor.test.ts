// doctor.test.ts — `eff doctor` (plan 03 §5 rows #1–#25; plan 10 A17b: every row has a passing and
// a failing case; offline mode makes zero network calls and reads the secret only in #7; the exit
// code is the worst finding: 1 fail · 2 config · 3 credentials · 4 drift). The keychain is the
// in-memory fake; the client configs and logs are temp files; launchctl/lsof are fake.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid, fakeLeagueId } from "../../scripts/ci/secret-fixtures.mjs";
import {
  MIN_NODE,
  backupsPresent,
  checkClientLog,
  checkStore,
  checkClientSecrecy,
  checkDrift,
  checkHealthChecks,
  checkLaunchConfig,
  checkNode,
  checkNpmrc,
  checkStaleBuild,
  checkWriteFlag,
  doctor,
  entryProblems,
  isCheckout,
  isDataless,
  isOurs,
  nodeAtLeastMin,
  parseNodeVersion,
  plannedFixes,
  quickCheckFile,
  renderDoctor,
  runDoctor,
  scanClientConfig,
  tailLines,
} from "../../src/cli/doctor.js";
import { clockSkewRow, hostRow } from "../../src/cli/doctor-online.js";
import { exitCodeFor, exitOfStatus, row } from "../../src/cli/doctor-rows.js";
import { SecretRegistry } from "../../src/cli/log.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore, restoreSteps, type StoreOpenReason } from "../../src/cli/store-access.js";
import { metaFor } from "../../src/auth/upgrade.js";
import { MIGRATIONS } from "../../src/store/index.js";
import { sessionFileBody } from "../../src/auth/file.js";
import { TLS_VERIFICATION_OFF_WARNING } from "../../src/config/schema.js";
import { fakeCookies, stateRow } from "../auth/helpers.js";
import {
  FakeKeyring,
  ROOT,
  fakeExec,
  fakeXattr,
  makeIo,
  noNetwork,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

const COOKIES = fakeCookies("cli-doctor");

function byId(rows: readonly { id: string }[], id: string) {
  const r = rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r as ReturnType<typeof row>;
}

function writeSession(sb: Sandbox, mode = 0o600): string {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  const f = path.join(sb.configDir, "session.json");
  writeFileSync(f, sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")), {
    mode,
  });
  chmodSync(f, mode);
  return f;
}

describe("rows #1–#3, #12, #13, #24, #25 (pure)", () => {
  it("#1 node version", () => {
    sb = sandbox();
    expect(parseNodeVersion("v24.15.0")).toEqual([24, 15, 0]);
    expect(parseNodeVersion("garbage")).toBeNull();
    expect(nodeAtLeastMin([...MIN_NODE])).toBe(true);
    expect(nodeAtLeastMin([24, 14, 9])).toBe(false);
    expect(nodeAtLeastMin([25, 0, 0])).toBe(true);
    expect(checkNode("24.21.0", "/n").status).toBe("ok");
    expect(checkNode("22.23.2", "/n").status).toBe("fail");
  });
  it("#2 launch config: absolute existing paths pass; relative/missing/no serve/old node fail; dataless and file-provider fail", async () => {
    sb = sandbox();
    const desktop = path.join(sb.dir, "desktop.json");
    const dist = path.join(ROOT, "dist", "cli.js");
    writeFileSync(
      desktop,
      JSON.stringify({
        mcpServers: {
          "espn-fantasy-football": { command: process.execPath, args: [dist, "serve"] },
          "fantasy-football": { command: "/x", args: [] },
          other: { command: "/y" },
        },
      }),
    );
    const scan = scanClientConfig("desktop", desktop);
    expect(scan.entries).toHaveLength(1);
    expect(scan.siblingInstalled).toBe(true);
    expect(scan.others).toBe(2);
    const io = makeIo(sb);
    const p = await entryProblems(io, { command: "node", args: ["dist/cli.js"] });
    expect(p.hard).toEqual(
      expect.arrayContaining([
        "`command` is not an absolute path (GUI clients have no shell PATH)",
        "`args[0]` is not an absolute path to dist/cli.js",
        "`args` does not contain `serve`",
      ]),
    );
    const missing = await entryProblems(io, {
      command: path.join(sb.dir, "nope"),
      args: [path.join(sb.dir, "nope.js"), "serve"],
    });
    expect(missing.hard.join(" ")).toMatch(/does not exist/);
    const oldNode = await entryProblems(
      makeIo(sb, { exec: fakeExec(() => ({ stdout: "v22.1.0\n" })).exec }),
      { command: "/bin/sh", args: ["x"] },
    );
    expect(oldNode.hard).toEqual(["`args` does not contain `serve`"]);
    const other = await entryProblems(
      makeIo(sb, { exec: fakeExec(() => ({ stdout: "v22.1.0\n" })).exec }),
      { command: "/bin/ls", args: [desktop, "serve"] },
    );
    expect(other.hard.join(" ")).toContain("below 24.15.0");
    expect(other.soft.join(" ")).toContain("re-run `eff print-config`");
    const fp = await entryProblems(
      makeIo(sb, { xattr: fakeXattr({ [sb.dir]: ["com.apple.fileprovider.x"] }) }),
      { command: process.execPath, args: [desktop, "serve"] },
    );
    expect(fp.hard.join(" ")).toContain("file provider");
    // the fix is the locked release install, never `npm install -g` (Stage C finding
    // ci-release-workflow-missing: npm would not read the tarball's npm-shrinkwrap.json)
    expect(fp.hard.join(" ")).toContain("`npm ci --omit=dev --ignore-scripts`");
    expect(fp.hard.join(" ")).not.toMatch(/npm install -g|npm i -g|--global/);
    const r = await checkLaunchConfig(
      makeIo(sb, {
        exec: fakeExec(() => ({ code: 1, stderr: "eff-launch: no Node.js >= 24.15 found\n" })).exec,
      }),
      [
        scanClientConfig("desktop", path.join(sb.dir, "none.json")),
        scanClientConfig("code", desktop),
      ],
    );
    expect(r.details.join("\n")).toContain(
      "plugin shim failed: eff-launch: no Node.js >= 24.15 found",
    );
    expect(r.details.join("\n")).toContain("also installed");
    writeFileSync(path.join(sb.dir, "bad.json"), "{");
    expect(scanClientConfig("desktop", path.join(sb.dir, "bad.json")).state).toBe("invalid");
    expect(
      (await checkLaunchConfig(io, [scanClientConfig("desktop", path.join(sb.dir, "bad.json"))]))
        .status,
    ).toBe("warn");
    expect(isOurs("x", { args: ["/a/scripts/eff-launch.sh", "serve"] })).toBe(true);
    expect(isOurs("fantasy-football", { args: ["/a/dist/cli.js", "serve"] })).toBe(false);
    expect(isDataless(path.join(sb.dir, "none"))).toBe(false);
  });
  it("#3 client secrecy: a cookie-shaped env value or a SWID-named key is a config finding (exit 2), never echoed", () => {
    sb = sandbox();
    const s2 = fakeEspnS2("doctor-env", 220);
    const f = path.join(sb.dir, "c.json");
    writeFileSync(
      f,
      JSON.stringify({
        mcpServers: { a: { command: "/x", env: { TOKEN_X: s2 } }, b: { env: { SWID: "x" } } },
      }),
    );
    const r = checkClientSecrecy([scanClientConfig("code", f)]);
    expect(r.status).toBe("config");
    expect(JSON.stringify(r)).not.toContain(s2.slice(0, 16));
    writeFileSync(f, JSON.stringify({ mcpServers: { a: { env: { ESPN_LEAGUE_ID: "0" } } } }));
    expect(checkClientSecrecy([scanClientConfig("code", f)]).status).toBe("ok");
    expect(checkClientSecrecy([]).status).toBe("skip");
  });
  it("#2/#3 also read Claude Code's LOCAL-scope entries (projects[dir].mcpServers, the `claude mcp add` default)", () => {
    sb = sandbox();
    const s2 = fakeEspnS2("doctor-local-scope", 220);
    const f = path.join(sb.dir, "claude.json");
    writeFileSync(
      f,
      JSON.stringify({
        projects: {
          "/some/dir": {
            mcpServers: {
              "espn-fantasy-football": {
                command: "/x/node",
                args: ["/x/dist/cli.js", "serve"],
                env: { ESPN_LEAGUE_ID: "0", PASTED: s2 },
              },
            },
          },
          "/other": { allowedTools: [] },
        },
      }),
    );
    const scan = scanClientConfig("code", f);
    expect(scan.entries.map((e) => e.name)).toEqual(["espn-fantasy-football"]);
    const r = checkClientSecrecy([scan]);
    expect(r.status).toBe("config");
    expect(JSON.stringify(r)).not.toContain(s2.slice(0, 16));
    // the same entry at the top level is found the same way
    writeFileSync(f, JSON.stringify({ mcpServers: { x: { env: { PASTED: s2 } } } }));
    expect(checkClientSecrecy([scanClientConfig("code", f)]).status).toBe("config");
  });
  it("#12 npmrc, #24 stale dist (checkout only)", () => {
    sb = sandbox();
    expect(checkNpmrc(sb.dir).status).toBe("na");
    expect(checkStaleBuild(sb.dir).status).toBe("na");
    const repo = path.join(sb.dir, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    expect(isCheckout(repo)).toBe(true);
    expect(checkNpmrc(repo).status).toBe("warn");
    writeFileSync(path.join(repo, ".npmrc"), "ignore-scripts=true\nsave-exact=true # pinned\n");
    expect(checkNpmrc(repo).status).toBe("ok");
    expect(checkStaleBuild(repo).status).toBe("warn");
    writeFileSync(path.join(repo, "src", "a.ts"), "x");
    mkdirSync(path.join(repo, "dist"));
    writeFileSync(path.join(repo, "dist", "cli.js"), "x");
    const old = new Date("2020-01-01");
    utimesSync(path.join(repo, "dist", "cli.js"), old, old);
    expect(checkStaleBuild(repo).status).toBe("fail");
    const nw = new Date("2030-01-01");
    utimesSync(path.join(repo, "dist", "cli.js"), nw, nw);
    expect(checkStaleBuild(repo).status).toBe("ok");
  });
  it("#13 write flag: off is ok; requested is a warning naming the reach-session signals", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_ENABLE_WRITES: "true", ESPN_LEAGUE_ID: "0" } });
    const { config } = await loadLenientRuntime(io);
    const f = path.join(sb.dir, "c.json");
    writeFileSync(
      f,
      JSON.stringify({
        mcpServers: {
          "espn-fantasy-football": { command: "/x", args: ["/d/dist/cli.js", "serve"] },
          shell: { command: "/y" },
        },
      }),
    );
    const r = checkWriteFlag(config, null, { CLAUDECODE: "1" }, [scanClientConfig("code", f)]);
    expect(r.status).toBe("warn");
    expect(r.details.join("\n")).toMatch(/CLAUDECODE[\s\S]*other MCP server/);
    const off = await loadLenientRuntime(makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } }));
    expect(checkWriteFlag(off.config, stateRow({ state: "validated" }), {}, []).status).toBe("ok");
    expect(checkWriteFlag(null, null, {}, []).status).toBe("skip");
  });
  it("#25 client log tail: redacted (league id, GUIDs), control characters dropped, errors flagged", () => {
    sb = sandbox();
    const league = fakeLeagueId("doctor-log", 8);
    const guid = `{${fakeGuid("doctor-log")}}`;
    const f = path.join(sb.dir, "mcp.log");
    writeFileSync(
      f,
      `${"x\n".repeat(60)}info ok\nerror: leagues/${league} member ${guid} \u001b[31mfailed\n`,
    );
    const secrets = new SecretRegistry();
    secrets.addIdentifier("league", league);
    const r = checkClientLog(f, secrets);
    expect(r.status).toBe("warn");
    expect(r.details).toHaveLength(40);
    const text = r.details.join("\n");
    expect(text).not.toContain(league);
    expect(text).not.toContain(guid);
    expect(text).not.toContain("\u001b");
    writeFileSync(f, "fine\n");
    expect(checkClientLog(f, secrets).status).toBe("ok");
    expect(checkClientLog(path.join(sb.dir, "nope"), secrets).status).toBe("skip");
    expect(tailLines(sb.dir)).toBeNull();
  });
  it("online rows #14/#15 judged from the probe; exit-code rule and rendering", () => {
    sb = sandbox();
    const base = {
      name: "host" as const,
      views: ["proTeamSchedules_wl" as const],
      upstream_status: 200,
      reason: null,
      signals: [],
    };
    const now = Date.parse("2026-10-06T18:00:00Z");
    expect(
      clockSkewRow({ ...base, status: "green", server_time_ms: now + 10_000 }, now).status,
    ).toBe("ok");
    expect(
      clockSkewRow({ ...base, status: "green", server_time_ms: now + 100_000 }, now).status,
    ).toBe("warn");
    expect(
      clockSkewRow({ ...base, status: "green", server_time_ms: now - 400_000 }, now).status,
    ).toBe("fail");
    expect(clockSkewRow({ ...base, status: "green", server_time_ms: null }, now).status).toBe(
      "warn",
    );
    expect(hostRow({ ...base, status: "green", server_time_ms: null }, true).message).toContain(
      "override",
    );
    expect(hostRow({ ...base, status: "additive", server_time_ms: null }, false).status).toBe("ok");
    expect(hostRow({ ...base, status: "red", server_time_ms: null }, false).status).toBe("drift");
    expect(hostRow({ ...base, status: "host_moved", server_time_ms: null }, false).fix).toContain(
      "EFF_ESPN_READ_HOST",
    );
    expect(hostRow({ ...base, status: "unreachable", server_time_ms: null }, false).status).toBe(
      "fail",
    );
    expect(exitOfStatus("warn")).toBe(0);
    expect(
      exitCodeFor([
        row(1, "a", "A", "fail", "m"),
        row(2, "b", "B", "credentials", "m"),
        row(3, "c", "C", "config", "m"),
      ]),
    ).toBe(3);
    expect(
      exitCodeFor([row(1, "a", "A", "drift", "m"), row(2, "b", "B", "credentials", "m")]),
    ).toBe(4);
    const lines = renderDoctor({
      version: "0",
      node: "24",
      generated_at: "t",
      online: true,
      exit_code: 4,
      rows: [row(9, "drift", "Drift", "drift", "red", "run eff probe", ["d"])],
    });
    expect(lines.join("\n")).toMatch(
      /\[DRFT\]  9 Drift — red[\s\S]*→ run eff probe[\s\S]*exit 4: drift detected/,
    );
  });
});

describe("runDoctor over a sandbox", () => {
  it("a fresh install: exit 3 (no credential), zero network calls, no keychain read for the file store", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    const io = makeIo(sb, { fetch: noNetwork, keyring, env: { EFF_CREDENTIAL_STORE: "file" } });
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    expect(r.exit_code).toBe(3);
    expect(keyring.calls).toEqual([]);
    expect(byId(r.rows, "config").status).toBe("warn");
    expect(byId(r.rows, "config_dir").status).toBe("warn");
    expect(byId(r.rows, "store").status).toBe("warn");
    expect(byId(r.rows, "credential_store").status).toBe("credentials");
    for (const id of [
      "clock_skew",
      "host_probe",
      "credential_validity",
      "league_reachability",
      "own_team",
      "sources_online",
    ])
      expect(byId(r.rows, id).status).toBe("skip");
    expect(r.rows.map((x) => x.n)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    ]);
  });
  it("a configured file store: #6 ok, #7 one read, #8 format ok; a loose 0644 session.json fails #6", async () => {
    sb = sandbox();
    writeSession(sb);
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file", ESPN_LEAGUE_ID: "0" } });
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    expect(byId(r.rows, "credential_store").status).toBe("ok");
    expect(byId(r.rows, "credential_read").status).toBe("ok");
    expect(byId(r.rows, "credential_format").status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(COOKIES.espn_s2.slice(0, 20));
    chmodSync(path.join(sb.configDir, "session.json"), 0o644);
    const r2 = await runDoctor(
      makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file", ESPN_LEAGUE_ID: "0" } }),
      { json: false, online: false, fix: false, yes: false },
    );
    expect(byId(r2.rows, "credential_store").status).toBe("fail");
    expect(byId(r2.rows, "credential_store").message).toContain("group/other");
  });
  it("two stores (keychain meta AND session.json) fail #6; a disagreeing env value fails #6", async () => {
    sb = sandbox();
    writeSession(sb);
    const keyring = new FakeKeyring();
    keyring.plant("espn-fantasy-football-mcp", "meta", "{}");
    const io = makeIo(sb, { keyring, env: { ESPN_LEAGUE_ID: "0" } });
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    expect(byId(r.rows, "credential_store").message).toContain("two stores");
    mkdirSync(sb.configDir, { recursive: true });
    writeFileSync(
      path.join(sb.configDir, "config.json"),
      JSON.stringify({ EFF_CREDENTIAL_STORE: "file", ESPN_LEAGUE_ID: "0" }),
    );
    const r2 = await runDoctor(makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "keychain" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    expect(byId(r2.rows, "credential_store").message).toContain("disagrees");
  });
  it("a keychain store with a value that fails the format rules: #7 read, #8 fail", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    const bad = { ...COOKIES, swid: "{nope}" };
    keyring.plant("espn-fantasy-football-mcp", "espn_s2", bad.espn_s2);
    keyring.plant("espn-fantasy-football-mcp", "SWID", bad.swid);
    keyring.plant(
      "espn-fantasy-football-mcp",
      "meta",
      JSON.stringify(metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    );
    const io = makeIo(sb, { keyring, env: { ESPN_LEAGUE_ID: "0" } });
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    expect(byId(r.rows, "credential_format").status).toBe("fail");
    keyring.failOn = { op: "get", account: "espn_s2" };
    const r2 = await runDoctor(makeIo(sb, { keyring, env: { ESPN_LEAGUE_ID: "0" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    expect(["fail", "ok"]).toContain(byId(r2.rows, "credential_read").status);
  });
  it("#9 drift red is exit 4; #21–#23 open checks; --ack acknowledges; #5 store ok with quick_check", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" } });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    store.repos.driftState.put({
      status: "red",
      since: "2026-10-06T00:00:00.000Z",
      last_probe_at: null,
      manifest_hash: null,
      manifest_version: null,
      host: "lm-api-reads.fantasy.espn.com",
      host_moved_at: null,
      diff_json: JSON.stringify([
        { view: "mSettings", removed: ["$.settings.x"], added: [], enums: [] },
      ]),
      additive_json: "[]",
      updated_at: "2026-10-06T00:00:00.000Z",
    });
    store.repos.leagueSettings.raiseCheck({
      id: "ir_invalid",
      status: "fail",
      detail: { invalid_players: 1 },
      raised_at: "2026-10-06T01:00:00.000Z",
      settings_hash: null,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by: null,
    });
    expect(checkDrift(store, io.clock.nowMs()).status).toBe("drift");
    expect(checkHealthChecks(store).find((r) => r.id === "ir_invalid")?.status).toBe("fail");
    store.close();
    const r = await runDoctor(
      makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" } }),
      { json: false, online: false, fix: false, yes: false, ack: "ir_invalid" },
    );
    expect(r.exit_code).toBe(4);
    expect(byId(r.rows, "store").status).toBe("ok");
    expect(byId(r.rows, "drift").details.join(" ")).toContain("mSettings: removed $.settings.x");
    const after = await runDoctor(
      makeIo(sb, { env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" } }),
      { json: false, online: false, fix: false, yes: false },
    );
    expect(byId(after.rows, "ir_invalid").status).toBe("ok");
    expect(quickCheckFile(path.join(sb.cacheDir, "store.sqlite"))).toBe("ok");
    expect(quickCheckFile(path.join(sb.dir, "none.sqlite"))).toBe("unreadable");
    expect(checkDrift(null, 0).status).toBe("skip");
    expect(checkHealthChecks(null).every((x) => x.status === "skip")).toBe(true);
  });
  it("#9 a probe older than 36 h warns; a fresh one is ok", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    expect(checkDrift(store, io.clock.nowMs()).status).toBe("warn");
    store.repos.probeLog.record({
      at: "2026-10-04T00:00:00.000Z",
      kind: "host",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
    expect(checkDrift(store, io.clock.nowMs()).message).toContain("older than 36 h");
    store.repos.probeLog.record({
      at: "2026-10-06T17:00:00.000Z",
      kind: "host",
      ok: true,
      status: "green",
      upstream_status: 200,
      error: null,
    });
    expect(checkDrift(store, io.clock.nowMs()).status).toBe("ok");
    store.close();
  });
  it("row 0 flags certificate verification off (exit 2, the fix named, nothing sent); other spellings stay ok (Stage C finding espn-tls-verify-disabled-unguarded)", async () => {
    sb = sandbox();
    const off = makeIo(sb, {
      fetch: noNetwork,
      env: { EFF_CREDENTIAL_STORE: "file", ESPN_LEAGUE_ID: "0", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });
    const r = await runDoctor(off, { json: false, online: false, fix: false, yes: false });
    const c = byId(r.rows, "config");
    expect(c.status).toBe("config");
    expect(c.message).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(c.fix).toContain("NODE_EXTRA_CA_CERTS");
    expect(c.details).toContain(TLS_VERIFICATION_OFF_WARNING);
    expect(r.exit_code).toBeGreaterThanOrEqual(2);
    for (const v of ["false", "1"]) {
      const on = makeIo(sb, {
        fetch: noNetwork,
        env: { EFF_CREDENTIAL_STORE: "file", ESPN_LEAGUE_ID: "0", NODE_TLS_REJECT_UNAUTHORIZED: v },
      });
      const ok = await runDoctor(on, { json: false, online: false, fix: false, yes: false });
      expect(byId(ok.rows, "config").status, v).toBe("ok");
    }
  });
  it("#4/#5 an iCloud-marked config or cache dir fails; a config error is row 0 'config' (exit 2)", async () => {
    sb = sandbox({ create: true });
    const io = makeIo(sb, {
      xattr: fakeXattr({ [sb.configDir]: ["com.apple.icloud.itemName"] }),
      env: { EFF_CREDENTIAL_STORE: "file" },
    });
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    expect(byId(r.rows, "config").status).toBe("config");
    expect(r.exit_code).toBeGreaterThanOrEqual(2);
    const bad = await runDoctor(makeIo(sb, { env: { ESPN_LEAGUE_ID: "x1" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    expect(byId(bad.rows, "config").status).toBe("config");
    expect(byId(bad.rows, "config_dir").status).toBe("skip");
    expect(bad.exit_code).toBeGreaterThanOrEqual(2);
  });
  it("--fix --yes creates the dirs 0700 and tightens session.json; without --yes on a pipe nothing is applied", async () => {
    sb = sandbox();
    writeSession(sb, 0o644);
    chmodSync(sb.configDir, 0o755);
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config } = await loadLenientRuntime(io);
    expect(plannedFixes(config).map((f) => f.description)).toEqual(
      expect.arrayContaining([
        `chmod 700 ${sb.configDir}`,
        `create cache dir ${sb.cacheDir} (0700)`,
        `chmod 600 ${path.join(sb.configDir, "session.json")}`,
      ]),
    );
    const no = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    await runDoctor(no, { json: false, online: false, fix: true, yes: false });
    expect(no.err.text).toContain("not applied (add --yes)");
    const yes = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    await runDoctor(yes, { json: false, online: false, fix: true, yes: true });
    expect(yes.err.text).toContain("fixed:");
    expect(plannedFixes(config)).toEqual([]);
  });
  it("--json is the stable report; launchd on macOS reads launchctl print; the setup port row", async () => {
    sb = sandbox();
    const { exec, calls } = fakeExec((c) => ({ code: c.args[0] === "print" ? 113 : 0 }));
    mkdirSync(path.join(sb.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      path.join(
        sb.home,
        "Library",
        "LaunchAgents",
        "io.github.espn-fantasy-football-mcp.eff.probe.plist",
      ),
      "<plist/>",
    );
    const io = makeIo(sb, { platform: "darwin", exec, env: { EFF_CREDENTIAL_STORE: "file" } });
    expect(await doctor(io, { json: true, online: false, fix: false, yes: false })).toBe(3);
    const doc = JSON.parse(io.out.text) as {
      rows: { id: string; status: string; details: string[] }[];
      exit_code: number;
    };
    expect(doc.exit_code).toBe(3);
    const l = doc.rows.find((x) => x.id === "launchd")!;
    expect(l.status).toBe("warn");
    expect(l.details.join("\n")).toContain("probe: NOT loaded");
    expect(calls.some((c) => c.args[0] === "print")).toBe(true);
    expect(doc.rows.find((x) => x.id === "setup_port")?.status).toMatch(/ok|warn/);
    const text = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    await doctor(text, { json: false, online: false, fix: false, yes: false });
    expect(text.out.text).toContain("eff doctor — espn-fantasy-football-mcp");
  });
});

describe("the keychain rows (#6–#8) over the in-memory keyring", () => {
  it("a keychain holding a valid value: #6 ok (one store), #7 ok, #8 ok — and the value is never printed", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    keyring.plant("espn-fantasy-football-mcp", "espn_s2", COOKIES.espn_s2);
    keyring.plant("espn-fantasy-football-mcp", "SWID", COOKIES.swid);
    keyring.plant(
      "espn-fantasy-football-mcp",
      "meta",
      JSON.stringify(metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    );
    const io = makeIo(sb, { keyring, env: { ESPN_LEAGUE_ID: "0" } });
    const r = await runDoctor(io, { json: true, online: false, fix: false, yes: false });
    expect(byId(r.rows, "credential_store")).toMatchObject({ status: "ok" });
    expect(byId(r.rows, "credential_read").status).toBe("ok");
    expect(byId(r.rows, "credential_format").status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(COOKIES.espn_s2.slice(0, 16));
    expect(JSON.stringify(r)).not.toContain(COOKIES.swid);
  });
  it("a keychain that cannot be read fails #6; an addon that did not load fails #6 naming it", async () => {
    sb = sandbox();
    const keyring = new FakeKeyring();
    keyring.failOn = { op: "get", account: "meta", times: 5 };
    const r = await runDoctor(makeIo(sb, { keyring, env: { ESPN_LEAGUE_ID: "0" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    expect(byId(r.rows, "credential_store").status).toBe("fail");
    const none = await runDoctor(
      makeIo(sb, {
        loadKeyring: () => Promise.reject(new Error("no addon")),
        env: { ESPN_LEAGUE_ID: "0" },
      }),
      { json: false, online: false, fix: false, yes: false },
    );
    // a broken native addon is a broken install, never "no credential is stored … run eff setup"
    const six = byId(none.rows, "credential_store");
    expect(six.status).toBe("fail");
    expect(six.message).toContain("native keyring addon did not load");
    expect(six.message).not.toContain("no credential is stored");
    expect(six.fix).toContain("eff setup --storage file");
    expect(six.details.join("\n")).toContain("keychain item: unavailable");
    expect(none.exit_code).toBe(1);
    // with the file store recorded and a session.json beside it, the unloadable keychain is only
    // reported (it holds nothing we wrote): not the two-stores failure, not this failure
    writeSession(sb);
    const fileIo = makeIo(sb, {
      loadKeyring: () => Promise.reject(new Error("no addon")),
      env: { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file" },
    });
    const file = byId(
      (await runDoctor(fileIo, { json: false, online: false, fix: false, yes: false })).rows,
      "credential_store",
    );
    expect(file.status).toBe("ok");
    expect(file.message).not.toContain("two stores");
    expect(file.details.join("\n")).toContain("keychain item: unavailable");
  });
});

// Stage C findings doctor-fix-skips-cache-subdirs and store-restore-advice-stale-wal
describe("row 5: the cache's own directories, and the restore procedure", () => {
  const sub = (d: string) => path.join(sb.cacheDir, d);
  const modeOf = (p: string) => statSync(p).mode & 0o777;
  it("datasets/, backups/, tmp/ copied with default modes: row 5 names them (never the healthy store), --fix repairs the tree", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config, log } = await loadLenientRuntime(io);
    const backup = path.join(sub("backups"), "store-2026-10-06.sqlite");
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      await store.backup(backup);
    } finally {
      store.close();
    }
    mkdirSync(sub("tmp"), { mode: 0o700 });
    writeFileSync(path.join(sb.cacheDir, "job-state.json"), "{}\n");
    // the cache restored with default modes (cp -R under umask 022, rsync without -p)
    for (const d of ["datasets", "backups", "tmp"]) chmodSync(sub(d), 0o755);
    chmodSync(backup, 0o644);
    chmodSync(path.join(sb.cacheDir, "job-state.json"), 0o644);
    // every store open now refuses — the store file itself is fine
    expect(() => openStore(config, io.clock, log, { migrate: true })).toThrow(
      /dataset directory: group\/other permission bits are set/,
    );
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    const s = byId(r.rows, "store");
    expect(s.status).toBe("fail");
    expect(s.message).toContain("a path rule, not damage to the store");
    for (const d of ["datasets", "backups", "tmp"])
      expect(s.details).toContain(
        `${sub(d)}: group/other permission bits are set (directories must be 0700, files 0600); run \`eff doctor --fix\``,
      );
    expect(s.fix).toContain("`eff doctor --fix`");
    expect(JSON.stringify(s)).not.toMatch(/move it aside|restore a backup|start a new store/);
    expect(plannedFixes(config).map((f) => f.description)).toEqual(
      expect.arrayContaining([
        `chmod 700 ${sub("datasets")}`,
        `chmod 700 ${sub("backups")}`,
        `chmod 700 ${sub("tmp")}`,
        `chmod 600 ${backup}`,
        `chmod 600 ${path.join(sb.cacheDir, "job-state.json")}`,
      ]),
    );
    const fix = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    await runDoctor(fix, { json: false, online: false, fix: true, yes: true });
    expect(fix.err.text).toContain(`eff doctor: fixed: chmod 700 ${sub("datasets")}`);
    expect(plannedFixes(config)).toEqual([]);
    for (const d of ["datasets", "backups", "tmp"]) expect(modeOf(sub(d))).toBe(0o700);
    expect(modeOf(backup)).toBe(0o600);
    openStore(config, io.clock, log, { migrate: true }).close();
    const after = await runDoctor(makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    expect(byId(after.rows, "store").status).toBe("ok");
  });
  it("an open store with a refused backups/ still fails row 5 (eff backup would), naming it", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config, log } = await loadLenientRuntime(io);
    openStore(config, io.clock, log, { migrate: true }).close();
    mkdirSync(sub("backups"), { mode: 0o755 });
    chmodSync(sub("backups"), 0o755);
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    const s = byId(r.rows, "store");
    expect(s.status).toBe("fail");
    expect(s.message).toBe(`1 directory(ies) of ours refused: ${sub("backups")}`);
    expect(s.details.some((d) => d.startsWith("schema v"))).toBe(true);
  });
  it("row 5's advice follows why the store did not open: never 'restore' for a busy, read-only or refused one", async () => {
    sb = sandbox({ create: true });
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config } = await loadLenientRuntime(io);
    const at = (reason: StoreOpenReason, path?: string) =>
      checkStore(io, config, {
        kind: "error",
        message: "x",
        reason,
        ...(path === undefined ? {} : { path }),
      });
    const restore = /restore a backup/;
    expect(at("busy").fix).toContain("retry once the running job or server is done");
    expect(at("readonly").fix).toContain("restores 0600 on our own file");
    expect(at("unsupported_node").fix).toBe("upgrade Node (row 1)");
    expect(at("cannot_open").fix).toContain("rows 4–5");
    for (const r of ["busy", "readonly", "unsupported_node", "cannot_open"] as const) {
      expect(JSON.stringify(at(r)), r).not.toMatch(restore);
      expect(at(r).status, r).toBe("fail");
    }
    const refused = at("insecure_path", path.join(sb.cacheDir, "store.sqlite"));
    expect(refused.message).toBe(
      `store.sqlite could not be opened (insecure_path): ${path.join(sb.cacheDir, "store.sqlite")} is refused — a path rule, not damage to the store`,
    );
    expect(JSON.stringify(refused)).not.toMatch(restore);
    for (const r of ["corrupt", "not_a_database", "other"] as const) {
      expect(at(r).fix, r).toMatch(restore);
      expect(at(r).details, r).toEqual(
        expect.arrayContaining([
          ...restoreSteps(sb.cacheDir, { kind: "newest" }),
          `no backup in ${sub("backups")}`,
        ]),
      );
    }
  });
  it("several refused directories are counted; a pending store reports them; only our backups are listed and fixed", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config, log } = await loadLenientRuntime(io);
    openStore(config, io.clock, log, { migrate: true }).close();
    for (const d of ["backups", "tmp"]) {
      mkdirSync(sub(d), { mode: 0o700 });
      chmodSync(sub(d), 0o755);
    }
    // a store whose migration is pending (one version behind the binary): the refused directories come first
    const raw = new DatabaseSync(path.join(sb.cacheDir, "store.sqlite"));
    try {
      raw.prepare("DELETE FROM schema_version WHERE version = ?").run(MIGRATIONS.length);
    } finally {
      raw.close();
    }
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    const s = byId(r.rows, "store");
    expect(s.message).toBe(`2 directory(ies) of ours refused: ${sub("backups")} …`);
    // in backups/: our copies only — a foreign file and a directory are neither listed nor fixed
    chmodSync(sub("backups"), 0o700);
    chmodSync(sub("tmp"), 0o700);
    writeFileSync(path.join(sub("backups"), "store-2026-10-06.sqlite"), "x", { mode: 0o644 });
    chmodSync(path.join(sub("backups"), "store-2026-10-06.sqlite"), 0o644);
    writeFileSync(path.join(sub("backups"), "notes.txt"), "mine", { mode: 0o644 });
    chmodSync(path.join(sub("backups"), "notes.txt"), 0o644);
    mkdirSync(path.join(sub("backups"), "store-2026-10-07.sqlite"), { mode: 0o700 });
    expect(backupsPresent(sb.cacheDir)).toEqual([
      expect.stringMatching(/^backup: .*store-2026-10-06\.sqlite \(/),
    ]);
    const fixes = plannedFixes(config).map((f) => f.description);
    expect(fixes).toContain(`chmod 600 ${path.join(sub("backups"), "store-2026-10-06.sqlite")}`);
    expect(fixes.join("\n")).not.toContain("notes.txt");
    // a backups "directory" that is a file: nothing listed, nothing planned inside it
    rmSync(sub("backups"), { recursive: true, force: true });
    writeFileSync(sub("backups"), "not a directory", { mode: 0o600 });
    expect(backupsPresent(sb.cacheDir)).toEqual([`no backup in ${sub("backups")}`]);
    expect(
      plannedFixes(config)
        .map((f) => f.description)
        .join("\n"),
    ).not.toContain("backups");
  });
  it("a symlinked datasets/ is refused and named; --fix never follows it", async () => {
    sb = sandbox({ create: true });
    const elsewhere = path.join(sb.dir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, sub("datasets"));
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config } = await loadLenientRuntime(io);
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    const s = byId(r.rows, "store");
    expect(s.status).toBe("fail");
    expect(s.message).toBe(`1 directory(ies) of ours refused: ${sub("datasets")}`);
    expect(s.fix).toContain("never follows a symlink");
    expect(
      plannedFixes(config)
        .map((f) => f.description)
        .join("\n"),
    ).not.toContain("datasets");
  });
  it("restoreSteps: stop everything, move the store WITH its -wal and -shm, then copy the backup", () => {
    sb = sandbox();
    const steps = restoreSteps(sb.cacheDir, { kind: "newest" }).join("\n");
    expect(steps).toContain("quit the MCP clients");
    expect(steps).toContain("`eff uninstall-launchd`");
    expect(steps).toContain(
      "store.sqlite, store.sqlite-wal, store.sqlite-shm and store.sqlite-journal (those present)",
    );
    expect(steps).toContain("never leave one behind: SQLite replays a leftover -wal");
    expect(steps).toContain(`chmod 600 ${path.join(sb.cacheDir, "store.sqlite")}`);
    expect(
      restoreSteps(sb.cacheDir, { kind: "pre_migration", binaryVersion: 2 }).join("\n"),
    ).toContain(`${path.join(sb.cacheDir, "backups")}/store.sqlite.bak-v2`);
  });
  it("a damaged store: row 5 gives the whole restore and lists the backups; a newer one the pre-upgrade copy", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config, log } = await loadLenientRuntime(io);
    const store = openStore(config, io.clock, log, { migrate: true });
    try {
      await store.backup(path.join(sub("backups"), "store-2026-10-06.sqlite"));
    } finally {
      store.close();
    }
    writeFileSync(path.join(sb.cacheDir, "store.sqlite"), "not a database at all".repeat(300));
    const r = await runDoctor(io, { json: false, online: false, fix: false, yes: false });
    const s = byId(r.rows, "store");
    expect(s.status).toBe("fail");
    expect(s.fix).toContain("restore a backup — the steps below");
    expect(s.details).toEqual(
      expect.arrayContaining(restoreSteps(sb.cacheDir, { kind: "newest" })),
    );
    expect(s.details.join("\n")).toContain(
      `backup: ${path.join(sub("backups"), "store-2026-10-06.sqlite")}`,
    );
    expect(JSON.stringify(s)).not.toContain("move it aside");
    // a store a newer binary migrated: the restore takes the copy made before that migration
    rmSync(path.join(sb.cacheDir, "store.sqlite"), { force: true });
    openStore(config, io.clock, log, { migrate: true }).close();
    const raw = new DatabaseSync(path.join(sb.cacheDir, "store.sqlite"));
    try {
      raw
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(MIGRATIONS.length + 1, "2026-10-07T00:00:00.000Z");
    } finally {
      raw.close();
    }
    const n = await runDoctor(makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    const newer = byId(n.rows, "store");
    expect(newer.status).toBe("fail");
    expect(newer.fix).toContain("restore the backup taken before the upgrade: the steps below");
    expect(newer.details).toEqual(
      expect.arrayContaining(
        restoreSteps(sb.cacheDir, { kind: "pre_migration", binaryVersion: MIGRATIONS.length }),
      ),
    );
    expect(newer.details.join("\n")).toContain(`store.sqlite.bak-v${String(MIGRATIONS.length)}`);
  });
  it("following the steps restores the backup's contents; the old advice (store.sqlite alone moved) replays a leftover -wal", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } });
    const { config, log } = await loadLenientRuntime(io);
    const file = path.join(sb.cacheDir, "store.sqlite");
    const backup = path.join(sub("backups"), "store-2026-10-06.sqlite");
    let store = openStore(config, io.clock, log, { migrate: true });
    try {
      await store.backup(backup);
    } finally {
      store.close();
    }
    // a writer adds a table after the backup and is killed before any checkpoint: its WAL stays
    const killedWriter = (): void => {
      const w = new DatabaseSync(file);
      try {
        w.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
        w.exec("CREATE TABLE after_backup (x INTEGER); INSERT INTO after_backup VALUES (1);");
        // what a SIGKILL leaves: the -wal and -shm as they are now (closing would checkpoint them)
        for (const side of ["-wal", "-shm"]) copyFileSync(`${file}${side}`, `${file}${side}.kept`);
      } finally {
        w.close();
      }
      for (const side of ["-wal", "-shm"]) renameSync(`${file}${side}.kept`, `${file}${side}`);
    };
    const tables = (): string[] => {
      const db = new DatabaseSync(file);
      try {
        return (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((t) => t.name);
      } finally {
        db.close();
      }
    };
    killedWriter();
    // the old advice: move store.sqlite aside, copy the backup in — the leftover -wal is replayed
    renameSync(file, `${file}.moved`);
    copyFileSync(backup, file);
    let naive: string[] | string;
    try {
      naive = tables();
    } catch (e) {
      naive = String(e);
    }
    expect(Array.isArray(naive) && !naive.includes("after_backup")).toBe(false);
    // again, by the steps: steps 2–3 move all three files, then copy the backup
    for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}.moved`])
      rmSync(f, { force: true });
    store = openStore(config, io.clock, log, { migrate: true });
    store.close();
    killedWriter();
    const aside = path.join(sb.dir, "moved-aside");
    mkdirSync(aside, { mode: 0o700 });
    for (const n of ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"])
      renameSync(path.join(sb.cacheDir, n), path.join(aside, n));
    copyFileSync(backup, file);
    chmodSync(file, 0o600);
    expect(tables()).not.toContain("after_backup");
    store = openStore(config, io.clock, log, { migrate: true });
    store.close();
    const after = await runDoctor(makeIo(sb, { env: { EFF_CREDENTIAL_STORE: "file" } }), {
      json: false,
      online: false,
      fix: false,
      yes: false,
    });
    expect(byId(after.rows, "store").status).toBe("ok");
  });
});
