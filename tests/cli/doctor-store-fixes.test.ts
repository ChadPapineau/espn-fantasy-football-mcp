// doctor-store-fixes.test.ts — `eff doctor` row 4/5 and `--fix` over the cache's real files, and
// `eff prune`'s reclaim (plan 03 §5 rows 4–5: "Cache dir + store: writable", the restore procedure;
// plan 02 §2.2: private means no group/other bits AND no ACL entry for anyone else; plan 06 §1.3
// "store prune … freed space"). Stage C findings:
//  - doctor-fix-dirs-inherit-acl: --fix created the config/cache dirs with a plain mkdir, keeping an
//    ACL entry the parent passed down; every command then refused them and rows 4/5 sent the owner
//    back to --fix, which never strips an ACL;
//  - doctor-fix-run-dirs-unrepaired: --fix repaired only the top-level tmp/ and recordings/, so run
//    directories copied with default modes stayed "not ours" for uninstall and prune;
//  - doctor-quick-check-corrupt-no-restore-steps: a store that opened but failed quick_check got
//    "store problems → see details" and no restore procedure;
//  - doctor-store-readonly-reported-ok: row 5 was ok for a read-only store.sqlite while every ESPN
//    request failed its limiter write;
//  - store-never-vacuumed: prune only moved pages to the freelist, so doctor's size warning outlived
//    its own advice; then (round 3) prune reclaimed only at ≥ 8 MiB and ≥ 20 % free pages while the
//    doctor warned "file > 500 MB — `eff prune` reclaims them" at any free share, so a 511 MB file
//    with 5.8 % free pages kept the warning through every prune — one rule now decides both.
// Sandboxes only: a temp HOME, config and cache; no network; no keychain (the file store).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupsPresent,
  cacheRunDirRefusals,
  checkStore,
  plannedFixes,
  refusalFix,
  runDoctor,
  storePages,
  storeUnwritable,
} from "../../src/cli/doctor.js";
import { main } from "../../src/cli/main.js";
import { reclaimFreePages } from "../../src/cli/maintenance.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openExistingStore, openStore, restoreSteps } from "../../src/cli/store-access.js";
import {
  liveBytes,
  MAX_STORE_BYTES,
  measureStoreSpace,
  reclaimDue,
  storeFileBytes,
  storeSpaceNotes,
  type StoreSpace,
} from "../../src/cli/store-space.js";
import {
  ensureSecureDir,
  foreignAclEntries,
  PathSecurityError,
  type AclAccess,
  type AclEntry,
} from "../../src/config/paths.js";
import { makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox;
afterEach(() => {
  if (process.platform === "darwin") {
    // a test's own flags and ACL entries never outlive it (they would block the cleanup)
    try {
      execFileSync("/usr/bin/chflags", ["-R", "nouchg", sb.dir]);
      execFileSync("/bin/chmod", ["-R", "-N", sb.dir]);
    } catch {
      // nothing set
    }
  }
  sb.cleanup();
});

const ENV = { EFF_CREDENTIAL_STORE: "file" };
const row5 = (rows: readonly { id: string }[]) =>
  rows.find((r) => r.id === "store") as unknown as {
    status: string;
    message: string;
    fix: string | null;
    details: string[];
  };
const row4 = (rows: readonly { id: string }[]) =>
  rows.find((r) => r.id === "config_dir") as unknown as {
    status: string;
    message: string;
    fix: string | null;
  };
const modeOf = (p: string): number => statSync(p).mode & 0o777;
const doctorRun = (fix = false) =>
  runDoctor(makeIo(sb, { env: ENV }), { json: false, online: false, fix, yes: fix });

/** The finding's inherited entry, read for every account in staff. */
const STAFF: AclEntry = {
  principal: "group:staff",
  inherited: true,
  kind: "allow",
  perms: ["list", "search", "readattr", "file_inherit", "directory_inherit"],
};

/** Every path under `root` carries STAFF until stripped (what inheritance does to what is created). */
function inheriting(root: string): AclAccess & { strips: string[] } {
  const clean = new Set<string>();
  const strips: string[] = [];
  return {
    strips,
    read: (p) => (p.startsWith(`${root}${path.sep}`) && !clean.has(p) ? [STAFF] : []),
    strip: (p) => {
      strips.push(p);
      clean.add(p);
      return true;
    },
    owner: () => "eff-owner",
  };
}

describe("--fix and an ACL its parent passes down (doctor-fix-dirs-inherit-acl)", () => {
  it("creates the missing dirs through ensureSecureDir: what it made carries no inherited entry", async () => {
    sb = sandbox();
    const { config } = await loadLenientRuntime(makeIo(sb, { env: ENV }));
    const acl = inheriting(sb.dir);
    const fixes = plannedFixes(config, acl);
    expect(fixes.map((f) => f.description)).toEqual(
      expect.arrayContaining([
        `create config dir ${sb.configDir} (0700)`,
        `create cache dir ${sb.cacheDir} (0700)`,
      ]),
    );
    for (const f of fixes) f.apply();
    // the directories --fix made pass every later check (a plain mkdir kept the entry: refused)
    for (const d of [sb.configDir, sb.cacheDir])
      expect(() => {
        ensureSecureDir(d, { create: false, acl });
      }).not.toThrow();
    expect(acl.strips).toEqual(expect.arrayContaining([sb.configDir, sb.cacheDir]));
  });

  it("an existing dir of ours with a foreign entry: --fix plans and applies the removal; rows 4/5 name it", async () => {
    sb = sandbox({ create: true });
    const { config } = await loadLenientRuntime(makeIo(sb, { env: ENV }));
    const acl = inheriting(sb.dir);
    const fixes = plannedFixes(config, acl);
    expect(fixes.map((f) => f.description)).toEqual(
      expect.arrayContaining([
        `remove the ACL entries that give others access to ${sb.configDir} (chmod -N)`,
        `remove the ACL entries that give others access to ${sb.cacheDir} (chmod -N)`,
      ]),
    );
    for (const f of fixes) f.apply();
    expect(plannedFixes(config, acl)).toEqual([]);
    expect(refusalFix(new PathSecurityError("insecure_acl", sb.cacheDir, "cache dir"))).toBe(
      "`eff doctor --fix` removes the ACL entries that give others access to our own directory or file",
    );
    // advice by reason: never "--fix tightens the mode" for what --fix does not repair
    expect(refusalFix(new PathSecurityError("symlink", "x", "x"))).toContain(
      "never follows a symlink",
    );
    expect(refusalFix(new PathSecurityError("wrong_owner", "x", "x"))).toContain("another user");
    expect(refusalFix(new PathSecurityError("insecure_ancestor", "x", "x"))).toContain(
      "a directory above it",
    );
    expect(refusalFix(new PathSecurityError("acl_unverifiable", "x", "x"))).toContain("ls -led");
    expect(refusalFix(new Error("x"))).toContain("fix it by hand");
  });

  it.runIf(process.platform === "darwin")(
    "macOS, real ACLs: under an inheritable staff entry --fix makes dirs every command accepts; an inherited one is stripped",
    async () => {
      sb = sandbox();
      execFileSync("/bin/chmod", [
        "+a",
        "group:staff allow list,search,readattr,file_inherit,directory_inherit",
        sb.dir,
      ]);
      const fixed = await doctorRun(true);
      expect(foreignAclEntries(sb.configDir)).toEqual([]);
      expect(foreignAclEntries(sb.cacheDir)).toEqual([]);
      expect(row4(fixed.rows).status).not.toBe("fail");
      expect(row5(fixed.rows).status).not.toBe("fail");
      // a cache dir made by a plain mkdir inherits the entry: row 5 names the removal, --fix does it
      rmSync(sb.cacheDir, { recursive: true, force: true });
      mkdirSync(sb.cacheDir, { mode: 0o700 });
      expect(foreignAclEntries(sb.cacheDir)).not.toEqual([]);
      const before = await doctorRun();
      expect(row5(before.rows).status).toBe("fail");
      expect(row5(before.rows).fix).toContain("removes the ACL entries");
      await doctorRun(true);
      expect(foreignAclEntries(sb.cacheDir)).toEqual([]);
      expect(row5((await doctorRun()).rows).status).not.toBe("fail");
    },
  );
});

describe("run directories under tmp/ and recordings/ (doctor-fix-run-dirs-unrepaired)", () => {
  it("copied with default modes: row 5 names them, --fix repairs each tree whole, uninstall then removes them", async () => {
    sb = sandbox();
    const { config, log } = await loadLenientRuntime(makeIo(sb, { env: ENV }));
    openStore(config, makeIo(sb).clock, log, { migrate: true }).close();
    const rec = path.join(sb.cacheDir, "recordings");
    const run = path.join(rec, "history-2026-10-01");
    mkdirSync(path.join(run, "2025"), { recursive: true });
    writeFileSync(path.join(run, "2025", "mTeam.json"), "{}");
    chmodSync(rec, 0o700);
    chmodSync(run, 0o755);
    chmodSync(path.join(run, "2025"), 0o755);
    chmodSync(path.join(run, "2025", "mTeam.json"), 0o644);
    const tmpRun = path.join(sb.cacheDir, "tmp", "backup-AbC123");
    mkdirSync(tmpRun, { recursive: true });
    chmodSync(path.join(sb.cacheDir, "tmp"), 0o700);
    chmodSync(tmpRun, 0o755);
    expect(cacheRunDirRefusals(sb.cacheDir).map((r) => r.path)).toEqual([tmpRun, run]);
    const r = await doctorRun();
    expect(row5(r.rows).status).toBe("fail");
    expect(row5(r.rows).details.join("\n")).toContain(run);
    const fixes = plannedFixes(config).map((f) => f.description);
    expect(fixes).toEqual(
      expect.arrayContaining([
        `repair the run directory ${run} (3 path(s) to 0700/0600)`,
        `repair the run directory ${tmpRun} (1 path(s) to 0700/0600)`,
      ]),
    );
    await doctorRun(true);
    expect([
      modeOf(run),
      modeOf(path.join(run, "2025")),
      modeOf(path.join(run, "2025", "mTeam.json")),
    ]).toEqual([0o700, 0o700, 0o600]);
    expect(modeOf(tmpRun)).toBe(0o700);
    expect(plannedFixes(config)).toEqual([]);
    expect(row5((await doctorRun()).rows).status).not.toBe("fail");
    // now uninstall recognises them as run directories this program made
    const un = makeIo(sb, { env: ENV });
    expect(await main(["uninstall", "--yes"], un)).toBe(0);
    expect(un.out.text).not.toContain("not a run directory this program made");
    expect(existsSync(run)).toBe(false);
  });
});

/** A store with `n` cache rows of `kb` KB each, and a backup beside it. */
async function bigStore(n: number, kb: number, fetchedMs = Date.parse("2026-01-01T00:00:00Z")) {
  const io = makeIo(sb, { env: ENV });
  const { config, log } = await loadLenientRuntime(io);
  const store = openStore(config, io.clock, log, { migrate: true });
  store.close();
  const db = new DatabaseSync(path.join(sb.cacheDir, "store.sqlite"));
  try {
    const ins = db.prepare(
      "INSERT INTO espn_cache (key, parsed_json, fetched_at, fetched_ms, http_status) VALUES (?, ?, ?, ?, 200)",
    );
    const pad = "x".repeat(kb * 1024);
    for (let i = 0; i < n; i++)
      ins.run(
        `k${String(i)}`,
        JSON.stringify({ pad }),
        new Date(fetchedMs).toISOString(),
        fetchedMs,
      );
  } finally {
    db.close();
  }
  return { io, config, log };
}

describe("a store that opens but fails quick_check (doctor-quick-check-corrupt-no-restore-steps)", () => {
  it("row 5 fails with the whole restore procedure and the backups to take", async () => {
    sb = sandbox();
    const { io, config, log } = await bigStore(80, 8);
    const store = openStore(config, io.clock, log, { migrate: false });
    try {
      mkdirSync(path.join(sb.cacheDir, "backups"), { mode: 0o700 });
      await store.backup(path.join(sb.cacheDir, "backups", "store-2026-10-18.sqlite"));
    } finally {
      store.close();
    }
    const file = path.join(sb.cacheDir, "store.sqlite");
    const pages = Math.floor(statSync(file).size / 4096);
    const fd = openSync(file, "r+");
    try {
      for (const k of [pages - 6, pages - 5, pages - 4, pages - 3])
        writeSync(
          fd,
          Buffer.from([0x0d, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
          0,
          8,
          k * 4096,
        );
    } finally {
      closeSync(fd);
    }
    const ex = openExistingStore(config, io.clock, log);
    expect(ex.kind).toBe("open");
    try {
      const r = checkStore(io, config, ex);
      expect(r.status).toBe("fail");
      expect(r.message).toBe("store.sqlite fails quick_check (corrupt): the file is damaged");
      expect(r.fix).toContain("restore a backup — the steps below");
      expect(r.details).toEqual(
        expect.arrayContaining([
          "store quick_check: corrupt",
          ...restoreSteps(sb.cacheDir, { kind: "newest" }),
          ...backupsPresent(sb.cacheDir),
        ]),
      );
      expect(r.details.join("\n")).toContain("store-2026-10-18.sqlite");
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
  });
});

describe("a store.sqlite SQLite can only read (doctor-store-readonly-reported-ok)", () => {
  it("mode 0400: row 5 fails 'not writable' with the fix; --fix restores 0600 and row 5 passes", async () => {
    sb = sandbox();
    const { io, config, log } = await bigStore(1, 1);
    const file = path.join(sb.cacheDir, "store.sqlite");
    chmodSync(file, 0o400);
    expect(storeUnwritable(file)).toMatchObject({ file, code: "EACCES" });
    const ex = openExistingStore(config, io.clock, log);
    try {
      const r = checkStore(io, config, ex);
      expect(r.status).toBe("fail");
      expect(r.message).toBe(
        `${file} is not writable by you (EACCES): every ESPN request and every job fails`,
      );
      expect(r.fix).toContain("`eff doctor --fix` restores 0600");
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
    expect(plannedFixes(config).map((f) => f.description)).toContain(`chmod 600 ${file}`);
    await doctorRun(true);
    expect(storeUnwritable(file)).toBeNull();
    expect(row5((await doctorRun()).rows).status).toBe("ok");
  });

  it.runIf(process.platform === "darwin")(
    "macOS: an immutable flag and an ACL denying write are named with their own fixes",
    async () => {
      sb = sandbox();
      await bigStore(1, 1);
      const file = path.join(sb.cacheDir, "store.sqlite");
      execFileSync("/usr/bin/chflags", ["uchg", file]);
      expect(storeUnwritable(file)).toMatchObject({ code: "EPERM" });
      expect(storeUnwritable(file)?.fix).toContain("chflags nouchg");
      execFileSync("/usr/bin/chflags", ["nouchg", file]);
      execFileSync("/bin/chmod", ["+a", "everyone deny write", file]);
      expect(storeUnwritable(file)?.fix).toContain(`chmod -N ${file}`);
      expect(row5((await doctorRun()).rows).status).toBe("fail");
    },
  );
});

describe("free pages are reclaimed and measured (store-never-vacuumed)", () => {
  it("eff prune gives the deleted rows' space back; doctor counts live data, not the freelist", async () => {
    sb = sandbox();
    const { io, config, log } = await bigStore(200, 100);
    const file = path.join(sb.cacheDir, "store.sqlite");
    const before = statSync(file).size;
    expect(before).toBeGreaterThan(19 * 1024 ** 2);
    // the rows deleted outside a prune: doctor reports the free pages and their remedy
    const raw = new DatabaseSync(file);
    try {
      raw.exec("DELETE FROM espn_cache WHERE key LIKE 'k1%'");
    } finally {
      raw.close();
    }
    const pages = storePages(file);
    expect(pages?.freeBytes ?? 0).toBeGreaterThan(5 * 1024 ** 2);
    const ex = openExistingStore(config, io.clock, log);
    try {
      expect(checkStore(io, config, ex).details.join("\n")).toMatch(
        /MB of the file are free pages \(`eff prune` reclaims them\)/,
      );
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
    const p = makeIo(sb, { env: ENV });
    expect(await main(["prune"], p)).toBe(0);
    expect(p.out.text).toMatch(/reclaimed \d+ MB of free pages/);
    const after = statSync(file).size;
    expect(after).toBeLessThan(before / 4);
    expect(storePages(file)?.freeBytes ?? 1).toBeLessThan(RECLAIM_THRESHOLD);
    // a store with nothing worth reclaiming is left alone
    expect(reclaimFreePages(file)).toEqual({ status: "not_needed" });
    expect(reclaimFreePages(path.join(sb.dir, "none.sqlite"))).toEqual({ status: "missing" });
  });

  it("a store another process holds for writing is reported busy, never forced", async () => {
    sb = sandbox();
    await bigStore(100, 100);
    const file = path.join(sb.cacheDir, "store.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM espn_cache");
    raw.exec("BEGIN IMMEDIATE");
    try {
      expect(reclaimFreePages(file)).toEqual({ status: "busy" });
    } finally {
      raw.exec("ROLLBACK");
      raw.close();
    }
  }, 30_000);
});

describe("one rule for prune's reclaim and doctor's advice (store-never-vacuumed, round 3)", () => {
  it("the verifier's store (511 MB file, 481 MB of data, 5.8 % free pages): prune reclaims it, so the warning's advice works", () => {
    const s: StoreSpace = {
      pageSize: 4096,
      pageCount: 130_764,
      freePages: 7_539,
      fileBytes: 535_609_344,
    };
    expect(reclaimDue(s)).toBe(true);
    expect(storeSpaceNotes(s)).toEqual({
      warn: true,
      details: [
        "29 MB of the file are free pages (`eff prune` reclaims them)",
        "store file 511 MB > 500 MB with 481 MB of data — `eff prune` reclaims the other 29 MB",
      ],
    });
    // the same share of free pages in a file under the limit: a routine prune leaves it, and the
    // doctor promises nothing
    const under: StoreSpace = {
      pageSize: 4096,
      pageCount: 100_000,
      freePages: 5_800,
      fileBytes: 409_600_000,
    };
    expect(reclaimDue(under)).toBe(false);
    expect(storeSpaceNotes(under)).toEqual({
      warn: false,
      details: [
        "23 MB of the file are free pages (later writes reuse them; `eff prune` reclaims them once they are 8 MB and 20 % of the file)",
      ],
    });
  });

  it("property: what the doctor says `eff prune` reclaims, prune's rule reclaims; after it no size warning is left unless the data itself is over the limit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1024, 4096, 65_536),
        fc.integer({ min: 1, max: 20_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 300 * 1024 ** 2 }),
        (pageSize, pageCount, share, walBytes) => {
          const freePages = Math.floor(pageCount * share);
          const s: StoreSpace = {
            pageSize,
            pageCount,
            freePages,
            fileBytes: pageCount * pageSize + walBytes,
          };
          const notes = storeSpaceNotes(s);
          if (notes.details.some((d) => /`eff prune` reclaims (?:them\)|the other )/.test(d)))
            expect(reclaimDue(s)).toBe(true);
          if (notes.warn && liveBytes(s) <= MAX_STORE_BYTES) expect(reclaimDue(s)).toBe(true);
          if (reclaimDue(s)) {
            // what a reclaim leaves: the live pages, no free page, an empty log
            const after: StoreSpace = {
              pageSize,
              pageCount: pageCount - freePages,
              freePages: 0,
              fileBytes: liveBytes(s),
            };
            expect(storeSpaceNotes(after).warn).toBe(liveBytes(s) > MAX_STORE_BYTES);
            expect(reclaimDue(after)).toBe(false);
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("a real store over its size limit with free pages under 8 MiB and 20 %: prune reclaims, and the warning is gone after it", async () => {
    sb = sandbox();
    const { io, config, log } = await bigStore(200, 100);
    const file = path.join(sb.cacheDir, "store.sqlite");
    const raw = new DatabaseSync(file);
    try {
      raw.exec("DELETE FROM espn_cache WHERE CAST(substr(key, 2) AS INTEGER) < 12");
    } finally {
      raw.close();
    }
    const space = measureStoreSpace(file);
    if (space === null) throw new Error("unmeasured");
    expect(space.freePages / space.pageCount).toBeLessThan(0.2);
    // under the real limit: nothing is due, and doctor row 5 promises no reclaim
    expect(reclaimDue(space)).toBe(false);
    const ex = openExistingStore(config, io.clock, log);
    try {
      const details = checkStore(io, config, ex).details.join("\n");
      expect(details).toMatch(/\d+ MB of the file are free pages \(later writes reuse them;/);
      expect(details).not.toContain("free pages (`eff prune` reclaims them)");
    } finally {
      if (ex.kind === "open") ex.store.close();
    }
    expect(reclaimFreePages(file)).toEqual({ status: "not_needed" });
    // against a limit the file is over and its data is not: the doctor warns, a prune clears it
    const limit = liveBytes(space) + 512 * 1024;
    const warned = storeSpaceNotes(space, limit);
    expect(warned.warn).toBe(true);
    expect(warned.details.join("\n")).toMatch(/`eff prune` reclaims the other \d+ MB/);
    expect(reclaimFreePages(file, limit)).toMatchObject({ status: "reclaimed", logHeld: false });
    const after = measureStoreSpace(file);
    if (after === null) throw new Error("unmeasured");
    expect(after.fileBytes).toBeLessThanOrEqual(limit);
    expect(after.freePages).toBe(0);
    expect(storeSpaceNotes(after, limit).warn).toBe(false);
  });

  it("a reader holding the log through the reclaim: prune says the space comes back when it closes the store, never 'reclaimed 0 MB'", async () => {
    sb = sandbox();
    await bigStore(200, 100);
    const file = path.join(sb.cacheDir, "store.sqlite");
    const reader = new DatabaseSync(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) AS n FROM espn_cache").get();
    const p = makeIo(sb, { env: ENV });
    try {
      expect(await main(["prune"], p)).toBe(0);
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
    expect(p.out.text).toContain(
      "free pages VACUUMed, but another process is reading the store, so its write-ahead log keeps the space until that process closes the store",
    );
    expect(p.out.text).not.toMatch(/reclaimed \d+ MB/);
    // the reader gone, the log is given back
    expect(storeFileBytes(file)).toBeLessThan(5 * 1024 ** 2);
  }, 30_000);
});

const RECLAIM_THRESHOLD = 1024 ** 2;
