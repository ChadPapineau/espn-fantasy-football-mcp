// acl.test.ts — the ACL half of src/config/paths.ts's privacy rule (Stage C finding
// paths-acl-bypasses-private-check; plan 02 §2.2: the file store is 0600 in a 0700 directory and
// refused if group/other can access it; §8 #1: cookie theft from disk). On macOS an extended ACL
// grants access the mode bits do not show: an entry inherited from ~/.config or ~/.cache made every
// directory and file the product created list as drwx------ / -rw------- while another local user
// could read it, and every check passed. The rule's logic runs on every runner through a stub
// AclAccess; the darwin block reproduces the finding with real ACLs (`chmod +a`), as its repro did.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PathSecurityError,
  assertSecureFile,
  ensureSecureDir,
  foreignAclEntries,
  isForeignGrant,
  parseLsAcl,
  readSecureFile,
  stripForeignAcl,
  systemAcl,
  writeSecureFileAtomic,
  type AclAccess,
  type AclEntry,
  type PathRefusal,
} from "../../src/config/paths.js";
import { tempDir } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir("eff-acl-");
});
afterEach(() => {
  // a test's own ACL entries never outlive it (a deny entry could block the cleanup)
  if (process.platform === "darwin") execFileSync("/bin/chmod", ["-R", "-N", tmp.dir]);
  tmp.cleanup();
});

function refusal(fn: () => unknown): PathRefusal | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    if (e instanceof PathSecurityError) return e.reason;
    throw e;
  }
}

const OWNER = "eff-owner";
const entry = (
  principal: string,
  kind: AclEntry["kind"],
  perms: string[],
  inherited = false,
): AclEntry => ({ principal, kind, perms, inherited });
/** The finding's entry: inherited from ~/.config, read for every local account. */
const STAFF_READ = entry(
  "group:staff",
  "allow",
  ["list", "search", "readattr", "file_inherit"],
  true,
);
const EVERYONE_DENY = entry("group:everyone", "deny", ["delete"]);
const OWN_ALLOW = entry(`user:${OWNER}`, "allow", ["readattr"]);

/** A stub access: `entriesOf` answers reads; strips are recorded (and succeed unless told not to). */
function stub(
  entriesOf: (p: string) => readonly AclEntry[] | null,
  opts: { strip?: boolean; owner?: string | null } = {},
): AclAccess & { reads: string[]; strips: string[] } {
  const reads: string[] = [];
  const strips: string[] = [];
  return {
    reads,
    strips,
    read(p) {
      reads.push(p);
      return entriesOf(p);
    },
    strip(p) {
      strips.push(p);
      return opts.strip ?? true;
    },
    owner: () => (opts.owner === undefined ? OWNER : opts.owner),
  };
}

/** A stub where every path under `root` carries `e` until it is stripped (as inheritance does). */
function inheriting(root: string, e: AclEntry, opts: { strip?: boolean } = {}) {
  const stripped = new Set<string>();
  const s = stub((p) => (p.startsWith(`${root}${path.sep}`) && !stripped.has(p) ? [e] : []), opts);
  const strip = s.strip.bind(s);
  s.strip = (p) => {
    const ok = strip(p);
    if (ok) stripped.add(p);
    return ok;
  };
  return s;
}

const privateDir = (name: string): string => {
  const d = path.join(tmp.dir, name);
  mkdirSync(d, { mode: 0o700 });
  return d;
};

describe("parseLsAcl (`ls -ledq <path>` output)", () => {
  it("reads no entry from a listing without an ACL", () => {
    expect(parseLsAcl("drwx------  2 me  staff  64 Oct 20 04:37 /x\n")).toEqual([]);
  });
  it("reads every entry: principal, inherited, kind, names — empty names and spaced principals too", () => {
    const out = [
      "drwx------@ 3 me  staff  96 Oct 20 04:37 /x y",
      " 0: group:everyone deny delete",
      " 1: group:staff inherited allow list,search,readattr,file_inherit,directory_inherit",
      " 2: user:eff-owner allow readattr",
      " 3: group:EXAMPLE\\Domain Users allow ",
      " 4: 00000000-0000-4000-8000-000000000042 allow read",
      " 5: group:odd unknown",
      "",
    ].join("\n");
    expect(parseLsAcl(out)).toEqual([
      entry("group:everyone", "deny", ["delete"]),
      entry(
        "group:staff",
        "allow",
        ["list", "search", "readattr", "file_inherit", "directory_inherit"],
        true,
      ),
      entry("user:eff-owner", "allow", ["readattr"]),
      entry("group:EXAMPLE\\Domain Users", "allow", []),
      entry("00000000-0000-4000-8000-000000000042", "allow", ["read"]),
      entry("group:odd", "unknown", []),
    ]);
  });
  it.each([
    ["no output at all", ""],
    ["an empty first line", "\n 0: group:staff allow read\n"],
    ["a line that is not an entry", "-rw------- 1 me staff 2 Oct 20 /f\nsomething else\n"],
    ["an entry out of order", "-rw------- 1 me staff 2 Oct 20 /f\n 1: group:staff allow read\n"],
    [
      "an entry with no principal",
      "-rw------- 1 me staff 2 Oct 20 /f\n 0:  inherited allow read\n",
    ],
    [
      "a name outside the permission alphabet",
      "-rw------- 1 me staff 2 /f\n 0: group:staff allow READ\n",
    ],
  ])("fails closed (null) on %s", (_name, out) => {
    expect(parseLsAcl(out)).toBeNull();
  });
});

describe("isForeignGrant", () => {
  it("every allow (or unknown) entry but the owner's own grants someone else access; deny grants none", () => {
    expect(isForeignGrant(STAFF_READ, OWNER)).toBe(true);
    expect(isForeignGrant(entry("user:someone-else", "allow", ["read"]), OWNER)).toBe(true);
    expect(isForeignGrant(entry("group:everyone", "allow", []), OWNER)).toBe(true);
    expect(isForeignGrant(entry(`user:${OWNER}`, "unknown", []), OWNER)).toBe(true);
    expect(isForeignGrant(entry(`group:${OWNER}`, "allow", ["read"]), OWNER)).toBe(true);
    expect(isForeignGrant(EVERYONE_DENY, OWNER)).toBe(false);
    expect(isForeignGrant(OWN_ALLOW, OWNER)).toBe(false);
  });
  it("with the owner unknown no allow entry can be shown to be the owner's", () => {
    expect(isForeignGrant(OWN_ALLOW, null)).toBe(true);
    expect(isForeignGrant(EVERYONE_DENY, null)).toBe(false);
  });
});

describe("ensureSecureDir: an existing directory", () => {
  it("is refused (insecure_acl) when an entry gives another user or group access — and never changed", () => {
    const d = privateDir("cfg");
    const acl = stub(() => [EVERYONE_DENY, STAFF_READ]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: true, acl });
      }),
    ).toBe("insecure_acl");
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false, acl });
      }),
    ).toBe("insecure_acl");
    expect(acl.strips).toEqual([]);
  });
  it("passes with only deny entries and the owner's own entry", () => {
    const d = privateDir("cfg");
    const acl = stub(() => [EVERYONE_DENY, OWN_ALLOW]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false, acl });
      }),
    ).toBe("no-throw");
    expect(acl.reads).toEqual([d]);
  });
  it("is refused when the owner's name is unknown and an allow entry is there", () => {
    const d = privateDir("cfg");
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false, acl: stub(() => [OWN_ALLOW], { owner: null }) });
      }),
    ).toBe("insecure_acl");
  });
  it("fails CLOSED (acl_unverifiable) when the entries cannot be read", () => {
    const d = privateDir("cfg");
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false, acl: stub(() => null) });
      }),
    ).toBe("acl_unverifiable");
  });
  it("the mode and owner rules still come first: a 0755 dir is insecure_mode before any ACL read", () => {
    const d = privateDir("loose");
    chmodSync(d, 0o755);
    const acl = stub(() => [STAFF_READ]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false, acl });
      }),
    ).toBe("insecure_mode");
    expect(acl.reads).toEqual([]);
  });
});

describe("ensureSecureDir: a directory this call creates", () => {
  it("removes the inherited entry from every directory it made, and from nothing that was there", () => {
    const parent = privateDir("dot-config");
    const leaf = path.join(parent, "espn", "datasets");
    const acl = inheriting(parent, STAFF_READ);
    expect(
      refusal(() => {
        ensureSecureDir(leaf, { create: true, acl });
      }),
    ).toBe("no-throw");
    expect(acl.strips).toEqual([leaf, path.join(parent, "espn")]);
    expect(acl.strips).not.toContain(parent);
    expect(statSync(leaf).mode & 0o777).toBe(0o700);
  });
  it("refuses (insecure_acl) when the entry cannot be removed", () => {
    const parent = privateDir("dot-cache");
    const leaf = path.join(parent, "espn");
    const acl = inheriting(parent, STAFF_READ, { strip: false });
    expect(
      refusal(() => {
        ensureSecureDir(leaf, { create: true, acl });
      }),
    ).toBe("insecure_acl");
  });
  it("strips nothing when nothing was passed down (one read, no chmod)", () => {
    const leaf = path.join(tmp.dir, "plain", "espn");
    const acl = stub(() => [EVERYONE_DENY]);
    ensureSecureDir(leaf, { create: true, acl });
    expect(acl.strips).toEqual([]);
  });
  it("fails closed when a new directory's entries cannot be read", () => {
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "new"), { create: true, acl: stub(() => null) });
      }),
    ).toBe("acl_unverifiable");
  });
});

describe("assertSecureFile / readSecureFile / writeSecureFileAtomic", () => {
  it("assertSecureFile refuses a 0600 file with a foreign entry; deny-only passes; unreadable fails closed", () => {
    const f = path.join(tmp.dir, "store.sqlite");
    writeFileSync(f, "x", { mode: 0o600 });
    expect(
      refusal(() => {
        assertSecureFile(
          f,
          "store file",
          stub(() => [STAFF_READ]),
        );
      }),
    ).toBe("insecure_acl");
    expect(
      refusal(() => {
        assertSecureFile(
          f,
          "store file",
          stub(() => [EVERYONE_DENY]),
        );
      }),
    ).toBe("no-throw");
    expect(
      refusal(() => {
        assertSecureFile(
          f,
          "store file",
          stub(() => null),
        );
      }),
    ).toBe("acl_unverifiable");
  });
  it("readSecureFile(requirePrivate) refuses a foreign entry; config.json (requirePrivate: false) never reads the ACL", () => {
    const f = path.join(privateDir("cfg"), "session.json");
    writeFileSync(f, '{"placeholder":true}', { mode: 0o600 });
    expect(
      refusal(() => readSecureFile(f, { requirePrivate: true, acl: stub(() => [STAFF_READ]) })),
    ).toBe("insecure_acl");
    const acl = stub(() => [STAFF_READ]);
    expect(readSecureFile(f, { requirePrivate: false, acl })).toBe('{"placeholder":true}');
    expect(acl.reads).toEqual([]);
    expect(readSecureFile(f, { requirePrivate: true, acl: stub(() => []) })).toBe(
      '{"placeholder":true}',
    );
  });
  it("readSecureFile's verdict is about the open file: a path renamed over mid-check is acl_unverifiable", () => {
    const d = privateDir("cfg");
    const f = path.join(d, "session.json");
    const other = path.join(d, "other.json");
    writeFileSync(f, "first", { mode: 0o600 });
    writeFileSync(other, "second", { mode: 0o600 });
    const swapping = stub(() => {
      renameSync(other, f); // the descriptor still holds the first file
      return [];
    });
    expect(refusal(() => readSecureFile(f, { requirePrivate: true, acl: swapping }))).toBe(
      "acl_unverifiable",
    );
  });
  it("writeSecureFileAtomic checks the new file before a byte is written: refused, no temp left, target kept", () => {
    const d = privateDir("cfg");
    const f = path.join(d, "session.json");
    writeFileSync(f, "previous", { mode: 0o600 });
    const sizes: number[] = [];
    const acl = stub((p) => {
      if (!p.endsWith(".tmp")) return [];
      sizes.push(statSync(p).size);
      return [STAFF_READ];
    });
    expect(
      refusal(() => {
        writeSecureFileAtomic(f, "secret-shaped-placeholder", "credential file", acl);
      }),
    ).toBe("insecure_acl");
    expect(sizes).toEqual([0]);
    expect(readFileSync(f, "utf8")).toBe("previous");
    expect(readdirSync(d)).toEqual(["session.json"]);
  });
  it("writeSecureFileAtomic refuses a directory with a foreign entry and writes nothing", () => {
    const d = privateDir("cfg");
    const acl = stub((p) => (p === d ? [STAFF_READ] : []));
    expect(
      refusal(() => {
        writeSecureFileAtomic(path.join(d, "x"), "y", "file", acl);
      }),
    ).toBe("insecure_acl");
    expect(existsSync(path.join(d, "x"))).toBe(false);
  });
});

describe("foreignAclEntries / stripForeignAcl", () => {
  it("lists only the foreign grants and strips only when there is one", () => {
    const d = privateDir("cfg");
    expect(
      foreignAclEntries(
        d,
        "dir",
        stub(() => [EVERYONE_DENY, STAFF_READ, OWN_ALLOW]),
      ),
    ).toEqual([STAFF_READ]);
    const clean = stub(() => [EVERYONE_DENY]);
    expect(stripForeignAcl(d, "dir", clean)).toBe(false);
    expect(clean.strips).toEqual([]);
    const dirty = stub(() => [STAFF_READ]);
    expect(stripForeignAcl(d, "dir", dirty)).toBe(true);
    expect(dirty.strips).toEqual([d]);
    expect(
      refusal(() =>
        stripForeignAcl(
          d,
          "dir",
          stub(() => [STAFF_READ], { strip: false }),
        ),
      ),
    ).toBe("insecure_acl");
  });
  it("the refusal text names the fix and never a path", () => {
    const d = privateDir("secret-dir-name");
    try {
      ensureSecureDir(d, { create: false, what: "config dir", acl: stub(() => [STAFF_READ]) });
      expect.unreachable();
    } catch (e) {
      const err = e as PathSecurityError;
      expect(err.reason).toBe("insecure_acl");
      expect(err.message).toMatch(/^config dir: /);
      expect(err.detail).toContain("chmod -N");
      expect(`${err.message} ${err.detail}`).not.toContain("secret-dir-name");
      expect(err.path).toBe(d);
      expect(err.effCode).toBe("INTERNAL");
    }
  });
});

it.runIf(process.platform !== "darwin")(
  "off macOS the system access reads no entry and strips nothing",
  () => {
    expect(systemAcl.read(tmp.dir)).toEqual([]);
    expect(systemAcl.strip(tmp.dir)).toBe(true);
  },
);

// --- macOS, real ACLs: the finding's repro ----------------------------------------------------

/** The entries `ls -le` prints for `p` (the lines after the listing). */
const aclLines = (p: string): string[] =>
  execFileSync("/bin/ls", ["-ledq", p], { encoding: "utf8" }).trimEnd().split("\n").slice(1);
/** The finding's ACE, set on an XDG base directory (File Sharing, an admin, an MDM profile). */
const INHERITABLE_STAFF_READ =
  "group:staff allow list,search,read,readattr,readextattr,readsecurity,file_inherit,directory_inherit";

describe.runIf(process.platform === "darwin")("macOS: real ACLs", () => {
  it("the finding: under an inheritable staff-read ~/.config and ~/.cache, nothing the product creates carries the entry", () => {
    const home = privateDir("home");
    for (const base of [".config", ".cache"]) {
      mkdirSync(path.join(home, base), { mode: 0o755 });
      execFileSync("/bin/chmod", ["+a", INHERITABLE_STAFF_READ, path.join(home, base)]);
    }
    const config = path.join(home, ".config", "espn-fantasy-football-mcp");
    const cache = path.join(home, ".cache", "espn-fantasy-football-mcp");
    ensureSecureDir(config, { create: true, what: "config dir" });
    const session = path.join(config, "session.json");
    writeSecureFileAtomic(session, '{"placeholder":true}\n', "credential file");
    writeSecureFileAtomic(path.join(config, "config.json"), "{}\n", "config.json");
    // a cache sub-directory made first creates the cache dir itself on the way
    ensureSecureDir(path.join(cache, "backups"), { create: true, what: "backups directory" });
    for (const p of [
      config,
      session,
      path.join(config, "config.json"),
      cache,
      path.join(cache, "backups"),
    ])
      expect(aclLines(p), p.slice(home.length)).toEqual([]);
    // the base directories are not this program's: their entry stays
    expect(aclLines(path.join(home, ".config"))).toHaveLength(1);
    expect(readSecureFile(session, { requirePrivate: true })).toBe('{"placeholder":true}\n');
    ensureSecureDir(cache, { create: false });
  });

  it("an existing directory of ours that carries the entry is refused and left as it is", () => {
    const d = privateDir("cfg");
    execFileSync("/bin/chmod", ["+a", "group:staff allow list,search", d]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: true });
      }),
    ).toBe("insecure_acl");
    expect(aclLines(d)).toHaveLength(1);
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });

  it("a 0600 file with an entry is refused by assertSecureFile and readSecureFile(requirePrivate) — not by config.json's read", () => {
    const f = path.join(privateDir("cfg"), "session.json");
    writeFileSync(f, "x", { mode: 0o600 });
    execFileSync("/bin/chmod", ["+a", `group:staff allow read`, f]);
    expect(
      refusal(() => {
        assertSecureFile(f, "store file");
      }),
    ).toBe("insecure_acl");
    expect(refusal(() => readSecureFile(f, { requirePrivate: true }))).toBe("insecure_acl");
    expect(readSecureFile(f, { requirePrivate: false })).toBe("x");
  });

  it("the verdict follows every ACL edit (the inode-state cache is invalidated by chmod +a and -N)", () => {
    const d = privateDir("cfg");
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
    execFileSync("/bin/chmod", ["+a", "user:nobody allow list", d]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("insecure_acl");
    execFileSync("/bin/chmod", ["-N", d]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
  });

  it("deny entries and the owner's own entry pass", () => {
    const d = privateDir("cfg");
    execFileSync("/bin/chmod", ["+a", "group:everyone deny add_subdirectory", d]);
    execFileSync("/bin/chmod", ["+a", `user:${userInfo().username} allow readattr`, d]);
    expect(aclLines(d)).toHaveLength(2);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
  });

  it("stripForeignAcl removes the entry from our own directory (doctor --fix's step)", () => {
    const d = privateDir("cfg");
    execFileSync("/bin/chmod", ["+a", "group:staff allow list", d]);
    expect(stripForeignAcl(d, "config dir")).toBe(true);
    expect(aclLines(d)).toEqual([]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
  });
});
