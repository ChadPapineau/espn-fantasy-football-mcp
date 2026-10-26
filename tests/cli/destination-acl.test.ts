// destination-acl.test.ts — `eff backup --to <file>` and `eff uninstall --export-log <file>` write a
// NEW file that is private by ACL as well as by mode (plan 02 §2.2: refused if group/other can
// access; plan 03 §8 step 3; plan 06 §1.3). Stage C finding paths-export-destination-acl-inherited:
// the destination's directory was checked by mode bits only, and the 0600 file took the directory's
// inheritable ACL entry, so a file listed as -rw------- (a full store copy, or the export with its
// league ids and the recommendation log) was readable — or writable — by every account in a group.
// The rule runs on every runner through a stub ACL access; the darwin block uses real `chmod +a`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import {
  aclWritableAncestors,
  copyToNewPrivateFile,
  privatizeNewFile,
  resolveBackupDestination,
} from "../../src/cli/maintenance.js";
import { loadLenientRuntime } from "../../src/cli/runtime.js";
import { openStore } from "../../src/cli/store-access.js";
import {
  assertSecureFile,
  foreignAclEntries,
  PathSecurityError,
  type AclAccess,
  type AclEntry,
} from "../../src/config/paths.js";
import { ROOT, makeIo, sandbox, type Sandbox } from "./helpers.js";
import { closeSync, existsSync, openSync } from "node:fs";

let sb: Sandbox;
afterEach(() => {
  if (process.platform === "darwin") {
    try {
      execFileSync("/bin/chmod", ["-R", "-N", sb.dir]);
    } catch {
      // none set
    }
  }
  sb.cleanup();
});

const READ: AclEntry = {
  principal: "group:staff",
  inherited: false,
  kind: "allow",
  perms: ["read", "readattr", "readextattr", "readsecurity", "file_inherit"],
};
const WRITE: AclEntry = {
  principal: "group:staff",
  inherited: false,
  kind: "allow",
  perms: ["add_file", "add_subdirectory", "delete_child", "file_inherit"],
};

/** An ACL access answering `entries` for the paths listed; strips are recorded (and remove them). */
function stub(
  entries: Map<string, readonly AclEntry[]>,
  opts: { strip?: boolean; unreadable?: string } = {},
): AclAccess & { strips: string[] } {
  const strips: string[] = [];
  return {
    strips,
    read: (p) => (p === opts.unreadable ? null : (entries.get(p) ?? [])),
    strip: (p) => {
      strips.push(p);
      if (opts.strip === false) return false;
      entries.delete(p);
      return true;
    },
    owner: () => "eff-owner",
  };
}

describe("the destination directory: 'others can write' includes ACL grants", () => {
  it("a directory (or one above it) whose ACL lets someone else add or delete entries is refused; a read grant is not", () => {
    sb = sandbox();
    const d = path.join(sb.dir, "d");
    mkdirSync(d, { mode: 0o755 });
    const to = path.join(d, "eff-store.sqlite");
    const ok = stub(new Map([[d, [READ]]]));
    expect(resolveBackupDestination(to, sb.home, ROOT, undefined, ok)).toBe(to);
    const writable = stub(new Map([[d, [WRITE]]]));
    expect(() => resolveBackupDestination(to, sb.home, ROOT, undefined, writable)).toThrow(
      /writable by others/,
    );
    expect(aclWritableAncestors(to, writable)).toEqual([d]);
    // an ancestor's grant counts too; a deny entry never does
    const above = stub(new Map([[sb.dir, [WRITE]]]));
    expect(aclWritableAncestors(to, above)).toEqual([sb.dir]);
    const deny = stub(new Map([[d, [{ ...WRITE, kind: "deny" as const }]]]));
    expect(aclWritableAncestors(to, deny)).toEqual([]);
    // an ACL that cannot be read cannot be shown safe (fail closed)
    expect(aclWritableAncestors(to, stub(new Map(), { unreadable: d }))).toEqual([d]);
  });
});

describe("the new file: private before a byte is written", () => {
  it("an entry it took from its directory is removed and checked; a removal that fails leaves no file", () => {
    sb = sandbox();
    const src = path.join(sb.dir, "src.bin");
    writeFileSync(src, Buffer.alloc(5000, 7));
    const dest = path.join(sb.dir, "copy.sqlite");
    const acl = stub(new Map());
    // the new file inherits READ the moment it exists
    const inherit: AclAccess & { strips: string[] } = {
      ...acl,
      read: (p) => (p === dest && !acl.strips.includes(p) ? [{ ...READ, inherited: true }] : []),
    };
    expect(copyToNewPrivateFile(src, dest, inherit)).toBe(5000);
    expect(acl.strips).toEqual([dest]);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    // stripping fails: refused, and the empty file removed
    const dest2 = path.join(sb.dir, "copy2.sqlite");
    const stuck: AclAccess = {
      read: (p) => (p === dest2 ? [READ] : []),
      strip: () => false,
      owner: () => "eff-owner",
    };
    expect(() => copyToNewPrivateFile(src, dest2, stuck)).toThrow(PathSecurityError);
    expect(existsSync(dest2)).toBe(false);
    // privatizeNewFile on an open fd: a path renamed over mid-check is unverifiable
    const dest3 = path.join(sb.dir, "copy3");
    const fd = openSync(dest3, "wx", 0o600);
    try {
      const swapped: AclAccess = {
        read: () => {
          writeFileSync(`${dest3}.other`, "x");
          execFileSync("/bin/mv", ["-f", `${dest3}.other`, dest3]);
          return [];
        },
        strip: () => true,
        owner: () => "eff-owner",
      };
      expect(() => {
        privatizeNewFile(fd, dest3, swapped);
      }).toThrow(/access control list/);
    } finally {
      closeSync(fd);
    }
  });
});

describe.runIf(process.platform === "darwin")("macOS, real ACLs (the finding's repro)", () => {
  it("backup --to and uninstall --export-log under a staff read+file_inherit directory: neither file carries the entry", async () => {
    sb = sandbox();
    const d = path.join(sb.dir, "D");
    mkdirSync(d, { mode: 0o755 });
    execFileSync("/bin/chmod", [
      "+a",
      "group:staff allow read,readattr,readextattr,readsecurity,file_inherit",
      d,
    ]);
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadLenientRuntime(io);
    openStore(config, io.clock, log, { migrate: true }).close();
    const copy = path.join(d, "eff-store.sqlite");
    const b = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["backup", "--to", copy], b)).toBe(0);
    expect(foreignAclEntries(copy)).toEqual([]);
    expect(() => {
      assertSecureFile(copy);
    }).not.toThrow();
    const exp = path.join(d, "eff-export.json");
    const u = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["uninstall", "--yes", "--keep-config", "--export-log", exp], u)).toBe(0);
    expect(foreignAclEntries(exp)).toEqual([]);
    expect(JSON.parse(readFileSync(exp, "utf8"))).toHaveProperty("recommendation_log");
  });

  it("a directory staff may add files to is refused for backup --to (exit 2), nothing written", async () => {
    sb = sandbox();
    const d = path.join(sb.dir, "W");
    mkdirSync(d, { mode: 0o755 });
    execFileSync("/bin/chmod", [
      "+a",
      "group:staff allow add_file,add_subdirectory,delete_child,file_inherit",
      d,
    ]);
    const io = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    const { config, log } = await loadLenientRuntime(io);
    openStore(config, io.clock, log, { migrate: true }).close();
    const copy = path.join(d, "eff-store.sqlite");
    const b = makeIo(sb, { env: { ESPN_LEAGUE_ID: "0" } });
    expect(await main(["backup", "--to", copy], b)).toBe(2);
    expect(b.err.text).toContain("writable by others");
    expect(existsSync(copy)).toBe(false);
  });
});
