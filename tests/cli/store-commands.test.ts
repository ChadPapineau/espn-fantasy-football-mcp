// store-commands.test.ts — the store-backed subcommands over a real temp store.sqlite: `eff prune`
// and `eff backup` (plan 06 §1.3; plan 03 §7 VACUUM INTO, keep 4, `--to` a NEW 0600 file never in a
// synced folder or the checkout), `eff status` (plan 06 J2; plan 10 A2b: no value, length or
// fingerprint of a credential — labels and timestamps only), and `eff crosswalk rebuild`.
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeEspnS2, fakeGuid } from "../../scripts/ci/secret-fixtures.mjs";
import { main } from "../../src/cli/main.js";
import {
  backup,
  copyToNewPrivateFile,
  prune,
  resolveBackupDestination,
} from "../../src/cli/maintenance.js";
import { runCrosswalkRebuild, rosteredIds } from "../../src/cli/crosswalk.js";
import { loadLenientRuntime, loadRuntime } from "../../src/cli/runtime.js";
import {
  collectStatus,
  credentialStatus,
  formatAge,
  renderStatus,
  sourceStatus,
  status,
} from "../../src/cli/status.js";
import { openStore } from "../../src/cli/store-access.js";
import { stateRow } from "../auth/helpers.js";
import { fakeExec, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  sb.cleanup();
});

async function withStore(env: Record<string, string> = { ESPN_LEAGUE_ID: "0" }) {
  const io = makeIo(sb, { env });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  return { io, config, log, store };
}

describe("prune and backup", () => {
  it("prune reports the rows per table and the never-pruned list", async () => {
    sb = sandbox();
    const { io, config, log, store } = await withStore();
    store.close();
    expect(await prune(io, config, log, { notify: false })).toBe(0);
    expect(io.out.text).toMatch(/pruned rows: espn_cache 0, points_cache 0/);
    expect(io.out.text).toContain("Never pruned: recommendation log");
  });
  it("prune failing (a store that is not a database) is exit 1 plus a rate-limited notification", async () => {
    sb = sandbox({ create: true });
    writeFileSync(path.join(sb.cacheDir, "store.sqlite"), "garbage".repeat(400), { mode: 0o600 });
    const { exec, calls } = fakeExec();
    const io = makeIo(sb, { platform: "darwin", exec });
    const { config, log } = await loadLenientRuntime(io);
    expect(await prune(io, config, log, { notify: true })).toBe(1);
    expect(io.err.text).toContain("eff prune:");
    expect(calls).toHaveLength(1);
    const io2 = makeIo(sb, { platform: "darwin", exec });
    expect(await backup(io2, config, log, { to: undefined, notify: true })).toBe(1);
  });
  it("backup writes a weekly VACUUM INTO copy (0600) and keeps 4", async () => {
    sb = sandbox();
    const { io, config, log, store } = await withStore();
    store.close();
    for (let i = 0; i < 6; i++) {
      const run = makeIo(sb, { clock: io.clock });
      expect(await backup(run, config, log, { to: undefined, notify: false })).toBe(0);
      io.clock.advance(7 * 86_400_000);
    }
    const dir = path.join(sb.cacheDir, "backups");
    const weekly = readdirSync(dir).filter((n) => n.startsWith("store-"));
    expect(weekly).toHaveLength(4);
    for (const n of weekly) expect(statSync(path.join(dir, n)).mode & 0o777).toBe(0o600);
  });
  it("backup --to writes a NEW 0600 file; an existing destination, a relative path, a directory are refused", async () => {
    sb = sandbox();
    const { io, config, log, store } = await withStore();
    store.close();
    const dest = path.join(sb.dir, "out", "copy.sqlite");
    mkdirSync(path.dirname(dest), { mode: 0o700 });
    expect(await backup(io, config, log, { to: dest, notify: false })).toBe(0);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(await backup(makeIo(sb), config, log, { to: dest, notify: false })).toBe(1);
    expect(() => resolveBackupDestination("rel/x.sqlite", sb.home, sb.dir + "/repo")).toThrow(
      /absolute/,
    );
    expect(() => resolveBackupDestination(`${sb.dir}/out/`, sb.home, sb.dir + "/repo")).toThrow(
      /name a file/,
    );
    expect(() =>
      resolveBackupDestination(`${sb.dir}/missing/x.sqlite`, sb.home, sb.dir + "/repo"),
    ).toThrow(/does not exist/);
    mkdirSync(path.join(sb.home, "Documents"), { recursive: true });
    expect(() =>
      resolveBackupDestination(
        path.join(sb.home, "Documents", "x.sqlite"),
        sb.home,
        sb.dir + "/repo",
      ),
    ).toThrow(/cloud-synced/);
    expect(() =>
      resolveBackupDestination(path.join(sb.dir, "out", "x.sqlite"), sb.home, sb.dir),
    ).toThrow(/git working tree|inside/);
    writeFileSync(path.join(sb.dir, "afile"), "x");
    expect(() =>
      resolveBackupDestination(path.join(sb.dir, "afile", "x.sqlite"), sb.home, sb.dir + "/repo"),
    ).toThrow();
    const link = path.join(sb.dir, "out", "link.sqlite");
    symlinkSync(path.join(sb.dir, "nowhere"), link);
    expect(() => copyToNewPrivateFile(dest, link)).toThrow(/already exists/);
  });
});

describe("status", () => {
  it("a fresh install: store missing, every source never loaded, launchd not available", async () => {
    sb = sandbox();
    const io = makeIo(sb);
    const { config, log } = await loadLenientRuntime(io);
    const r = collectStatus(io, config, log);
    expect(r.store.state).toBe("missing");
    expect(r.credential).toBeNull();
    expect(r.sources.every((s) => s.state === "never_loaded")).toBe(true);
    const text = renderStatus(r).join("\n");
    expect(text).toContain("NOT CONFIGURED (ESPN_LEAGUE_ID)");
    expect(text).toContain("launchd: not available");
    expect(text).toContain("run `eff refresh all`");
  });
  it("plan 10 B1: every source line shows its license and age; full lists the Phase-2 sources", async () => {
    sb = sandbox();
    const core = makeIo(sb);
    const a = await loadLenientRuntime(core);
    const r1 = collectStatus(core, a.config, a.log);
    expect(r1.sources.map((s) => s.source)).not.toContain("nflverse:pbp");
    for (const s of r1.sources) expect(s.license.length).toBeGreaterThan(0);
    const io = makeIo(sb, { env: { EFF_TOOLSET: "full" } });
    const { config, log } = await loadLenientRuntime(io);
    const r = collectStatus(io, config, log);
    const ids = r.sources.map((s) => s.source);
    for (const id of [
      "nflverse:stats_team_week",
      "nflverse:pbp",
      "nflverse:snap_counts",
      "nflverse:depth_charts",
      "ffopportunity:ep_weekly",
      "sleeper:trending",
      "news:rotowire",
      "news:espn",
      "news:cbs",
    ])
      expect(ids).toContain(id);
    const lic = new Map(r.sources.map((s) => [s.source, s.license]));
    expect(lic.get("ffopportunity:ep_weekly")).toBe("CC-BY-SA-4.0");
    expect(lic.get("sleeper:trending")).toBe("non-commercial");
    expect(lic.get("nflverse:pbp")).toBe("CC-BY-4.0");
    const text = renderStatus(r).join("\n");
    expect(text).toContain("license");
    expect(text).toMatch(/ffopportunity:ep_weekly\s+NEVER LOADED\s+\S+\s+CC-BY-SA-4\.0/);
  });

  it("rejected cookies: since and next probe shown; never a value, a length or a fingerprint", async () => {
    sb = sandbox();
    const { io, config, log, store } = await withStore();
    const s2 = fakeEspnS2("status", 220);
    store.repos.credentialState.put(
      stateRow({
        state: "rejected",
        rejected_since: "2026-10-06T09:00:00.000Z",
        last_rejected_at: "2026-10-06T09:00:00.000Z",
        next_probe_at: "2026-10-07T09:00:00.000Z",
      }),
    );
    store.close();
    const out = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" }, platform: "darwin" });
    expect(await status(out, config, log, { json: false })).toBe(0);
    expect(out.out.text).toContain(
      "REJECTED since 2026-10-06T09:00:00.000Z; next probe 2026-10-07T09:00:00.000Z",
    );
    expect(out.out.text).not.toContain(s2.slice(0, 12));
    expect(out.out.text).not.toMatch(/fingerprint|chars\)/);
    const j = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await status(j, config, log, { json: true })).toBe(0);
    const doc = JSON.parse(j.out.text) as {
      credential: Record<string, unknown>;
      store: { state: string };
    };
    expect(doc.store.state).toBe("ok");
    expect(Object.keys(doc.credential).sort()).toEqual([
      "last_accepted_at",
      "last_rejected_at",
      "next_probe_at",
      "rejected_since",
      "state",
      "store",
      "stored_age_days",
      "stored_at",
    ]);
    expect(doc.credential.state).toBe("rejected");
    expect(io.out.text).toBe("");
  });
  it("credentialStatus: another league's row reads stored; validated hides rejection fields", async () => {
    sb = sandbox();
    const { io, config, store } = await withStore();
    store.repos.credentialState.put(stateRow({ league_id: "99" }));
    expect(credentialStatus(store, config, io.clock.nowMs())?.state).toBe("stored");
    store.repos.credentialState.put(
      stateRow({
        state: "validated",
        next_probe_at: "2026-10-07T09:00:00.000Z",
        stored_at: "2026-09-06T18:00:00.000Z",
      }),
    );
    const c = credentialStatus(store, config, io.clock.nowMs());
    expect(c).toMatchObject({ state: "validated", next_probe_at: null, stored_age_days: 30 });
    store.close();
  });
  it("sourceStatus judges age and a missing file; formatAge", () => {
    sb = sandbox();
    const now = Date.parse("2026-10-06T18:00:00Z");
    const row = {
      source: "nflverse:injuries" as const,
      file: "/x",
      file_version: "v1",
      release_updated_at: null,
      seasons: [2026],
      rows: 3,
      columns_hash: null,
      started_at: "2026-10-06T17:00:00.000Z",
      finished_at: "2026-10-06T17:00:00.000Z",
      ok: false,
      error: "UPSTREAM_UNAVAILABLE" as const,
      checked_at: "2026-10-06T17:00:00.000Z",
    };
    const s = sourceStatus("nflverse:injuries", { ...row, ok: true }, row, 2, sb.cacheDir, now);
    expect(s.state).toBe("file_missing");
    expect(s.last_error?.error).toBe("UPSTREAM_UNAVAILABLE");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(30)).toBe("30s");
    expect(formatAge(600)).toBe("10m");
    expect(formatAge(7200)).toBe("2h");
    expect(formatAge(86400 * 3)).toBe("3d");
  });
  it("status exits 1 when the store cannot be read", async () => {
    sb = sandbox({ create: true });
    writeFileSync(path.join(sb.cacheDir, "store.sqlite"), "garbage".repeat(400), { mode: 0o600 });
    const io = makeIo(sb);
    const { config, log } = await loadLenientRuntime(io);
    expect(await status(io, config, log, { json: false })).toBe(1);
    expect(io.out.text).toContain("store   ERROR");
  });
});

describe("crosswalk rebuild", () => {
  it("skips on a cold store (roster_weekly never loaded) and writes nothing", async () => {
    sb = sandbox();
    const { io, config, log, store } = await withStore();
    const r = await runCrosswalkRebuild(io, config, store, log, null);
    expect(r).toMatchObject({ code: 0, alert: false });
    expect(r.lines[0]).toContain("skipped: roster_weekly_never_loaded");
    expect(rosteredIds(store, null).size).toBe(0);
    expect(rosteredIds(store, 3).size).toBe(0);
    store.close();
    const cli = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["crosswalk", "rebuild"], cli)).toBe(0);
    expect(cli.out.text).toContain("skipped");
  });
  it("loadRuntime with a member GUID in config.json is refused (no secret in config)", async () => {
    sb = sandbox({ create: true });
    writeFileSync(
      path.join(sb.configDir, "config.json"),
      JSON.stringify({ ESPN_LEAGUE_ID: "0", EFF_PROBE_LEAGUE_ID: `{${fakeGuid("cfg-status")}}` }),
    );
    const io = makeIo(sb);
    await expect(loadRuntime(io)).rejects.toThrow();
    expect(existsSync(path.join(sb.cacheDir, "store.sqlite"))).toBe(false);
  });
});
