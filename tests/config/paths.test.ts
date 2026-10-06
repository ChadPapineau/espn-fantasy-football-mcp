// paths.test.ts — src/config/paths.ts (plan 01 D16: one config + one cache dir, no XDG; plan 02
// §2.2: never relative, never inside the repo, 0700 dirs / 0600 files, refuse group/other bits,
// never follow a symlink, refuse file-provider (iCloud) directories by xattr). Adversarial:
// relative paths, `~user`, control characters, `..`, symlinks into the repo and into synced
// folders, group-writable dirs, wrong owner, oversize files, FIFOs, pre-placed links, hostile xattr
// output. Ported from sibling @d72e03b, adapted.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DIR_NAME,
  FILE_PROVIDER_XATTR_RE,
  GATE_KEY_FILE_NAME,
  PathSecurityError,
  SOURCE_ID_RE,
  assertNotFileProvider,
  assertNotSynced,
  assertOutsideRepo,
  assertNotInAnyRepo,
  gitWorkTreeOf,
  GIT_WALK_MAX_LEVELS,
  assertSecureFile,
  backupDir,
  configFilePath,
  datasetDir,
  datasetFilePath,
  datasetFileStem,
  datasetTempPath,
  defaultCredentialFilePath,
  ensureSecureDir,
  expandHome,
  fileProviderMarks,
  gateKeyPath,
  insecureAncestors,
  isInside,
  isInsideOnFs,
  locationRefusals,
  packageRoot,
  parseXattrOutput,
  pathKey,
  readSecureFile,
  realpathOfExistingPrefix,
  resolveAbsolute,
  resolveCacheDir,
  resolveConfigDir,
  runTempDir,
  storePath,
  syncedFolders,
  systemXattrReader,
  writeSecureFileAtomic,
  xattrCheckChain,
  type PathRefusal,
  type XattrReader,
} from "../../src/config/paths.js";
import { ROOT, brokenXattrs, noXattrs, tempDir, xattrsOn } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => {
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

const mode = (p: string) => lstatSync(p).mode & 0o777;
const HOME = "/home/<you>";

describe("expandHome / resolveAbsolute", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/x/y", HOME)).toBe(`${HOME}/x/y`);
    expect(expandHome("/abs", HOME)).toBe("/abs");
    expect(expandHome("rel", HOME)).toBe("rel");
  });
  it("refuses the ~user form", () => {
    expect(refusal(() => expandHome("~root/.ssh", HOME))).toBe("home_user_form");
  });
  it("normalises . and .. and trailing slashes", () => {
    expect(resolveAbsolute("/a/b/../c/./d/", HOME)).toBe("/a/c/d");
    expect(resolveAbsolute("~/../<other>", HOME)).toBe("/home/<other>");
  });
  it.each([
    ["relative", "relative/path"],
    ["relative", "./here"],
    ["relative", "../up"],
    ["empty", ""],
    ["control_char", "/tmp/a\0b"],
    ["control_char", "/tmp/a\nb"],
    ["control_char", "/tmp/a\rb"],
    ["control_char", "/tmp/a\u001bb"],
    ["control_char", "/tmp/a\u007fb"],
    ["home_user_form", "~bob"],
  ] as const)("refuses %s (%j)", (reason, p) => {
    expect(refusal(() => resolveAbsolute(p, HOME))).toBe(reason);
  });
  it("never puts a control-character path in the error; `detail` never shows any path", () => {
    try {
      resolveAbsolute("/tmp/a\nforged line", HOME, "EFF_CACHE_DIR");
      expect.unreachable();
    } catch (e) {
      const err = e as PathSecurityError;
      expect(err).toBeInstanceOf(PathSecurityError);
      expect(err.message).not.toContain("forged");
      expect(err.message).toContain("EFF_CACHE_DIR");
      expect(err.path).toBe("<redacted>");
      expect(err.detail).not.toContain("/tmp");
      expect(err.effCode).toBe("INTERNAL");
    }
  });
  it("keeps the offending path out of the message for every refusal", () => {
    const err = (() => {
      try {
        resolveAbsolute("relative/secret-dir", HOME, "EFF_CONFIG_DIR");
      } catch (e) {
        return e as PathSecurityError;
      }
      return null;
    })();
    expect(err?.message).not.toContain("secret-dir");
    expect(err?.path).toBe("relative/secret-dir");
  });
});

describe("resolveConfigDir / resolveCacheDir (no XDG — plan 01 D16, changelog G2)", () => {
  it("defaults to ~/.config and ~/.cache", () => {
    expect(resolveConfigDir({}, HOME)).toBe(`${HOME}/.config/${APP_DIR_NAME}`);
    expect(resolveCacheDir({}, HOME)).toBe(`${HOME}/.cache/${APP_DIR_NAME}`);
  });
  it("IGNORES XDG_*_HOME so every entry point agrees on one location", () => {
    const env = { XDG_CONFIG_HOME: "/xdg/conf", XDG_CACHE_HOME: "/xdg/cache" };
    expect(resolveConfigDir(env, HOME)).toBe(`${HOME}/.config/${APP_DIR_NAME}`);
    expect(resolveCacheDir(env, HOME)).toBe(`${HOME}/.cache/${APP_DIR_NAME}`);
  });
  it("EFF_* overrides win; whitespace-only is unset; ~ expands", () => {
    const env = { EFF_CONFIG_DIR: " ~/effconf ", EFF_CACHE_DIR: "   " };
    expect(resolveConfigDir(env, HOME)).toBe(`${HOME}/effconf`);
    expect(resolveCacheDir(env, HOME)).toBe(`${HOME}/.cache/${APP_DIR_NAME}`);
    expect(resolveCacheDir({ EFF_CACHE_DIR: "/explicit/" }, HOME)).toBe("/explicit");
  });
  it("a relative override is refused, never resolved against cwd", () => {
    expect(refusal(() => resolveConfigDir({ EFF_CONFIG_DIR: "conf" }, HOME))).toBe("relative");
    expect(refusal(() => resolveCacheDir({ EFF_CACHE_DIR: "cache" }, HOME))).toBe("relative");
  });
});

describe("isInside / assertOutsideRepo", () => {
  it("is exact about path segments", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
    expect(isInside("/a/b/../c", "/a/b")).toBe(false);
  });
  it("pathKey folds case and normalisation on darwin only", () => {
    expect(pathKey("/A/José", "darwin")).toBe("/a/josé");
    expect(pathKey("/A/B", "linux")).toBe("/A/B");
    expect(isInsideOnFs("/X/DOCUMENTS/f", "/x/Documents", "darwin")).toBe(true);
    expect(isInsideOnFs("/X/DOCUMENTS/f", "/x/Documents", "linux")).toBe(false);
  });
  it("packageRoot() is this checkout", () => {
    expect(packageRoot()).toBe(ROOT);
  });
  it("refuses the repo itself, anything under it, and a symlink that resolves into it", () => {
    const repo = path.join(tmp.dir, "repo");
    mkdirSync(path.join(repo, "sub"), { recursive: true });
    const link = path.join(tmp.dir, "sneaky");
    symlinkSync(path.join(repo, "sub"), link);
    expect(
      refusal(() => {
        assertOutsideRepo(repo, repo);
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(repo, "sub", "x"), repo);
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(link, "not-yet", "session.json"), repo);
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(tmp.dir, "repo-sibling"), repo);
      }),
    ).toBe("no-throw");
  });
  it("realpathOfExistingPrefix keeps the missing tail and survives a fully missing path", () => {
    expect(realpathOfExistingPrefix(path.join(tmp.dir, "a", "b"))).toBe(
      path.join(tmp.dir, "a", "b"),
    );
    expect(realpathOfExistingPrefix("/definitely/not/here")).toBe("/definitely/not/here");
  });
  it("refuses this real checkout for a config dir", () => {
    expect(
      refusal(() => {
        assertOutsideRepo(path.join(ROOT, "fixtures", "x"), packageRoot());
      }),
    ).toBe("inside_repo");
  });
});

describe("M7: assertNotInAnyRepo — any git working tree, not only this checkout", () => {
  it("refuses a path inside another repository (a .git dir or a worktree's .git file)", () => {
    const other = path.join(tmp.dir, "other-repo");
    mkdirSync(path.join(other, ".git"), { recursive: true });
    mkdirSync(path.join(other, "deep", "er"), { recursive: true });
    expect(gitWorkTreeOf(path.join(other, "deep", "er", "config.json"))).toBe(
      realpathOfExistingPrefix(other),
    );
    expect(
      refusal(() => {
        assertNotInAnyRepo(path.join(other, "deep", "not-yet", "session.json"));
      }),
    ).toBe("inside_repo");
    const wt = path.join(tmp.dir, "worktree");
    mkdirSync(wt);
    writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere\n");
    expect(
      refusal(() => {
        assertNotInAnyRepo(path.join(wt, "cache"));
      }),
    ).toBe("inside_repo");
    expect(
      refusal(() => {
        assertNotInAnyRepo(path.join(tmp.dir, "plain", "cache"));
      }),
    ).toBe("no-throw");
  });
  it("follows a symlink that leads into a repository", () => {
    const other = path.join(tmp.dir, "repo2");
    mkdirSync(path.join(other, ".git"), { recursive: true });
    mkdirSync(path.join(other, "data"));
    const link = path.join(tmp.dir, "innocent");
    symlinkSync(path.join(other, "data"), link);
    expect(
      refusal(() => {
        assertNotInAnyRepo(path.join(link, "store.sqlite"));
      }),
    ).toBe("inside_repo");
  });
  it("this real checkout (and the case-changed spelling on darwin) is a working tree", () => {
    expect(gitWorkTreeOf(path.join(ROOT, "src", "x"))).not.toBeNull();
    if (process.platform === "darwin")
      expect(gitWorkTreeOf(path.join(ROOT.toUpperCase(), "src", "x"))).not.toBeNull();
  });
  it("the walk is bounded and fails closed past the bound", () => {
    let calls = 0;
    const deep =
      "/" + Array.from({ length: GIT_WALK_MAX_LEVELS + 10 }, (_, i) => `d${String(i)}`).join("/");
    const r = gitWorkTreeOf(deep, () => {
      calls++;
      return false;
    });
    expect(calls).toBe(GIT_WALK_MAX_LEVELS);
    expect(r).not.toBeNull();
    expect(gitWorkTreeOf("/a/b", () => false)).toBeNull();
  });
  it("locationRefusals reports a foreign repository once, as inside_repo", () => {
    const reasons = locationRefusals(path.join(tmp.dir, "x"), {
      home: path.join(tmp.dir, "h"),
      repoRoot: path.join(tmp.dir, "elsewhere"),
      xattr: noXattrs,
      gitEntry: (d) => d === realpathOfExistingPrefix(tmp.dir),
    }).map((r) => r.reason);
    expect(reasons).toEqual(["inside_repo"]);
  });
});

describe("assertNotSynced (iCloud Desktop & Documents, iCloud Drive, CloudStorage)", () => {
  it("lists the synced roots", () => {
    expect(syncedFolders("/no/such/<home>")).toEqual([
      "/no/such/<home>/Documents",
      "/no/such/<home>/Desktop",
      "/no/such/<home>/Library/Mobile Documents",
      "/no/such/<home>/Library/CloudStorage",
      "/no/such/<home>/Dropbox",
      "/no/such/<home>/Google Drive",
      "/no/such/<home>/OneDrive",
    ]);
  });
  it("adds every ~/OneDrive* folder", () => {
    mkdirSync(path.join(tmp.dir, "OneDrive - Example Org"));
    mkdirSync(path.join(tmp.dir, "MyOneDrive"));
    const roots = syncedFolders(tmp.dir);
    expect(roots).toContain(path.join(tmp.dir, "OneDrive - Example Org"));
    expect(roots).not.toContain(path.join(tmp.dir, "MyOneDrive"));
  });
  it.each([
    "Documents/eff",
    "Desktop",
    "Library/Mobile Documents/com~apple~CloudDocs/eff",
    "Library/CloudStorage/GoogleDrive/eff",
    "Dropbox/eff",
    "Google Drive/eff",
    "OneDrive/eff",
  ])("refuses %s", (rel) => {
    expect(
      refusal(() => {
        assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
      }),
    ).toBe("synced_folder");
  });
  it("refuses a path that reaches Documents through a symlink", () => {
    mkdirSync(path.join(tmp.dir, "Documents"));
    symlinkSync(path.join(tmp.dir, "Documents"), path.join(tmp.dir, "docs-link"));
    expect(
      refusal(() => {
        assertNotSynced(path.join(tmp.dir, "docs-link", "eff"), tmp.dir);
      }),
    ).toBe("synced_folder");
  });
  it("allows ~/.config, ~/.cache and a lookalike name", () => {
    for (const rel of [".config/eff", ".cache/eff", "DocumentsArchive/eff"])
      expect(
        refusal(() => {
          assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
        }),
      ).toBe("no-throw");
  });
  it.runIf(process.platform === "darwin")("refuses a differently-cased synced folder", () => {
    for (const rel of ["documents/eff", "DESKTOP", "Library/cloudstorage/x"])
      expect(
        refusal(() => {
          assertNotSynced(path.join(tmp.dir, rel), tmp.dir);
        }),
      ).toBe("synced_folder");
  });
});

describe("file-provider xattr check (plan 02 §2.2 iCloud check)", () => {
  it("the attribute pattern covers file-provider and iCloud names and nothing benign", () => {
    for (const a of [
      "com.apple.file-provider-domain-id",
      "com.apple.fileprovider.fpfs#P",
      "com.apple.icloud.desktop",
      "COM.APPLE.ICLOUD.X",
    ])
      expect(FILE_PROVIDER_XATTR_RE.test(a), a).toBe(true);
    for (const a of [
      "com.apple.quarantine",
      "com.apple.provenance",
      "com.apple.FinderInfo",
      "user.x",
    ])
      expect(FILE_PROVIDER_XATTR_RE.test(a), a).toBe(false);
  });

  it("parses single-path and multi-path xattr output, longest path first", () => {
    expect(
      parseXattrOutput(["/a"], "com.apple.quarantine\n\ncom.apple.icloud.x\n").get("/a"),
    ).toEqual(["com.apple.quarantine", "com.apple.icloud.x"]);
    const m = parseXattrOutput(
      ["/a", "/a/b c"],
      "/a: com.apple.provenance\n/a/b c: com.apple.icloud.y\n/zzz: stray\n",
    );
    expect(m.get("/a")).toEqual(["com.apple.provenance"]);
    expect(m.get("/a/b c")).toEqual(["com.apple.icloud.y"]);
    expect(parseXattrOutput([], "anything").size).toBe(0);
  });

  it("checks the existing prefix and its ancestors up to, not including, home", () => {
    const home = tmp.dir;
    mkdirSync(path.join(home, ".config"), { recursive: true });
    const chain = xattrCheckChain(path.join(home, ".config", "eff", "deep"), home);
    expect(chain).toEqual([path.join(home, ".config")]);
    mkdirSync(path.join(home, ".config", "eff"));
    expect(xattrCheckChain(path.join(home, ".config", "eff"), home)).toEqual([
      path.join(home, ".config", "eff"),
      path.join(home, ".config"),
    ]);
    expect(xattrCheckChain(home, home)).toEqual([home]);
  });

  it("outside home the chain stops below the filesystem root", () => {
    const chain = xattrCheckChain(path.join(tmp.dir, "x"), "/no/such/<home>");
    expect(chain[0]).toBe(tmp.dir);
    expect(chain).not.toContain("/");
    expect(xattrCheckChain("/", "/no/such/<home>")).toEqual(["/"]);
  });

  it("refuses a directory carrying a file-provider attribute, or an ancestor carrying one", () => {
    const home = tmp.dir;
    const synced = path.join(home, "Cloudish");
    mkdirSync(path.join(synced, "eff"), { recursive: true });
    const reader = xattrsOn(synced, ["com.apple.file-provider-domain-id"]);
    expect(fileProviderMarks(path.join(synced, "eff"), home, reader)).toEqual([
      { path: path.join(synced, "eff"), attr: "com.apple.file-provider-domain-id" },
      { path: synced, attr: "com.apple.file-provider-domain-id" },
    ]);
    expect(
      refusal(() => {
        assertNotFileProvider(path.join(synced, "eff", "new"), home, reader);
      }),
    ).toBe("file_provider");
    expect(
      refusal(() => {
        assertNotFileProvider(path.join(home, "plain"), home, reader);
      }),
    ).toBe("no-throw");
  });

  it("ignores benign attributes", () => {
    const reader: XattrReader = (ps) => new Map(ps.map((p) => [p, ["com.apple.quarantine"]]));
    expect(fileProviderMarks(tmp.dir, "/no/such/<home>", reader)).toEqual([]);
  });

  it("fails CLOSED when the attributes cannot be read", () => {
    expect(
      refusal(() => {
        assertNotFileProvider(tmp.dir, tmp.dir, brokenXattrs);
      }),
    ).toBe("xattr_unverifiable");
  });

  it("the system reader maps every path to [] off darwin and an empty list to an empty map", () => {
    expect(systemXattrReader([])?.size).toBe(0);
    if (process.platform !== "darwin")
      expect(systemXattrReader([tmp.dir])?.get(tmp.dir)).toEqual([]);
  });

  it.runIf(process.platform === "darwin")(
    "the real reader sees an iCloud attribute set with xattr(1), and fails closed on a missing path",
    () => {
      const d = path.join(tmp.dir, "marked dir");
      mkdirSync(d);
      expect(fileProviderMarks(d, tmp.dir)).toEqual([]);
      execFileSync("/usr/bin/xattr", ["-w", "com.apple.icloud.itemName", "x", d]);
      expect(fileProviderMarks(d, tmp.dir)).toEqual([
        { path: d, attr: "com.apple.icloud.itemName" },
      ]);
      expect(systemXattrReader([path.join(tmp.dir, "missing")])).toBeNull();
    },
  );

  it("locationRefusals collects every refusal and turns a reader crash into xattr_unverifiable", () => {
    const repo = path.join(tmp.dir, "repo");
    const home = tmp.dir;
    const p = path.join(repo, "Documents", "x");
    mkdirSync(repo);
    const reasons = locationRefusals(p, { home: repo, repoRoot: repo, xattr: noXattrs }).map(
      (r) => r.reason,
    );
    expect(reasons).toEqual(["inside_repo", "synced_folder"]);
    const crash: XattrReader = () => {
      throw new Error("boom");
    };
    expect(
      locationRefusals(path.join(home, "ok"), { home, repoRoot: repo, xattr: crash }).map(
        (r) => r.reason,
      ),
    ).toEqual(["xattr_unverifiable"]);
    expect(
      locationRefusals(path.join(home, "ok"), { home, repoRoot: repo, xattr: noXattrs }),
    ).toEqual([]);
  });
});

describe("derived locations and dataset naming (plan 01 §5.1, §5.5)", () => {
  const cache = "/c";
  it("builds the fixed layout", () => {
    expect(storePath(cache)).toBe("/c/store.sqlite");
    expect(datasetDir(cache)).toBe("/c/datasets");
    expect(backupDir(cache)).toBe("/c/backups");
    expect(runTempDir(cache)).toBe("/c/tmp");
    expect(configFilePath("/k")).toBe("/k/config.json");
    expect(defaultCredentialFilePath("/k")).toBe("/k/session.json");
    expect(gateKeyPath("/k")).toBe(`/k/${GATE_KEY_FILE_NAME}`);
  });
  it("maps a source id to a stable file and a unique, contained temp name", () => {
    expect(datasetFileStem("nflverse:stats_player_week")).toBe("nflverse__stats_player_week");
    expect(datasetFilePath(cache, "espn:pro_schedule")).toBe(
      "/c/datasets/espn__pro_schedule.sqlite",
    );
    const t1 = datasetTempPath(cache, "nflverse:injuries", "2026-09-30T14:03:00Z");
    const t2 = datasetTempPath(cache, "nflverse:injuries", "2026-09-30T14:03:00Z");
    expect(t1).toMatch(
      /^\/c\/datasets\/nflverse__injuries\.2026-09-30T14_03_00Z\.[0-9a-f]{12}\.tmp$/,
    );
    expect(t1).not.toBe(t2);
    expect(path.dirname(datasetTempPath(cache, "nflverse:injuries", "../../../etc/passwd"))).toBe(
      "/c/datasets",
    );
    expect(datasetTempPath(cache, "nflverse:injuries", "")).toMatch(/\.v\.[0-9a-f]{12}\.tmp$/);
  });
  it.each([
    "",
    "nflverse",
    "NFLverse:x",
    "nflverse:",
    ":x",
    "a:b:c",
    "../x:y",
    "a:b c",
    "n\u0000:x",
  ])("rejects source id %j", (bad) => {
    expect(SOURCE_ID_RE.test(bad)).toBe(false);
    expect(() => datasetFileStem(bad)).toThrow(RangeError);
  });
});

describe("ensureSecureDir (0700, no symlink, owner only)", () => {
  it("creates a missing dir (and parents) 0700", () => {
    const d = path.join(tmp.dir, "a", "b", "conf");
    ensureSecureDir(d, { create: true });
    expect(statSync(d).isDirectory()).toBe(true);
    expect(mode(d)).toBe(0o700);
    expect(mode(path.join(tmp.dir, "a"))).toBe(0o700);
  });
  it("accepts an existing 0700 dir; refuses a missing dir without create", () => {
    const d = path.join(tmp.dir, "ok");
    mkdirSync(d, { mode: 0o700 });
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("no-throw");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "nope"), { create: false });
      }),
    ).toBe("missing");
  });
  it.each([0o750, 0o705, 0o770, 0o777, 0o701])("refuses mode %o and does not chmod it", (m) => {
    const d = path.join(tmp.dir, "loose");
    mkdirSync(d);
    chmodSync(d, m);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: true });
      }),
    ).toBe("insecure_mode");
    expect(mode(d)).toBe(m);
  });
  it("refuses a symlink to a good dir and a regular file", () => {
    const real = path.join(tmp.dir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, path.join(tmp.dir, "link"));
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "link"), { create: true });
      }),
    ).toBe("symlink");
    writeFileSync(path.join(tmp.dir, "file"), "x");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(tmp.dir, "file"), { create: true });
      }),
    ).toBe("not_directory");
  });
  it("refuses a dir owned by another uid; skips the owner check without getuid", () => {
    const d = path.join(tmp.dir, "theirs");
    mkdirSync(d, { mode: 0o700 });
    const spy = vi.spyOn(process, "getuid").mockReturnValue(424242);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("wrong_owner");
    spy.mockRestore();
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      expect(
        refusal(() => {
          ensureSecureDir(d, { create: false });
        }),
      ).toBe("no-throw");
    } finally {
      Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
  });
  it("a path through a regular file reads as missing (ENOTDIR)", () => {
    const f = path.join(tmp.dir, "plain");
    writeFileSync(f, "x");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(f, "child"), { create: false });
      }),
    ).toBe("missing");
  });
  it("propagates an unexpected lstat error", () => {
    const d = path.join(tmp.dir, "locked");
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root bypasses permissions
      expect(() => {
        ensureSecureDir(path.join(d, "inner"), { create: false });
      }).toThrow(/EACCES/);
    } finally {
      chmodSync(d, 0o700);
    }
  });
});

describe("assertSecureFile (0600, regular, no symlink)", () => {
  it("accepts 0600 and 0400; refuses group/other bits", () => {
    const f = path.join(tmp.dir, "session.json");
    writeFileSync(f, "x", { mode: 0o600 });
    expect(
      refusal(() => {
        assertSecureFile(f);
      }),
    ).toBe("no-throw");
    chmodSync(f, 0o400);
    expect(
      refusal(() => {
        assertSecureFile(f);
      }),
    ).toBe("no-throw");
    for (const m of [0o644, 0o640, 0o604, 0o660]) {
      chmodSync(f, m);
      expect(
        refusal(() => {
          assertSecureFile(f);
        }),
      ).toBe("insecure_mode");
    }
  });
  it("refuses a symlink, a directory and a missing file", () => {
    const f = path.join(tmp.dir, "t");
    writeFileSync(f, "x", { mode: 0o600 });
    symlinkSync(f, path.join(tmp.dir, "l"));
    expect(
      refusal(() => {
        assertSecureFile(path.join(tmp.dir, "l"));
      }),
    ).toBe("symlink");
    expect(
      refusal(() => {
        assertSecureFile(tmp.dir);
      }),
    ).toBe("not_regular_file");
    expect(
      refusal(() => {
        assertSecureFile(path.join(tmp.dir, "none"));
      }),
    ).toBe("missing");
  });
});

describe("readSecureFile (O_NOFOLLOW | O_NONBLOCK, checks on the open descriptor)", () => {
  it("returns null for a missing file and the text for a private one", () => {
    expect(readSecureFile(path.join(tmp.dir, "none"), { requirePrivate: true })).toBeNull();
    const f = path.join(tmp.dir, "config.json");
    writeFileSync(f, '{"EFF_TOOLSET":"core"}', { mode: 0o600 });
    expect(readSecureFile(f, { requirePrivate: true })).toBe('{"EFF_TOOLSET":"core"}');
  });
  it("enforces 0600 only when asked (config.json holds no secrets)", () => {
    const f = path.join(tmp.dir, "config.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o644);
    expect(readSecureFile(f, { requirePrivate: false })).toBe("{}");
    expect(refusal(() => readSecureFile(f, { requirePrivate: true }))).toBe("insecure_mode");
  });
  it("refuses a symlink even to a good file, and a directory", () => {
    const f = path.join(tmp.dir, "real.json");
    writeFileSync(f, "x", { mode: 0o600 });
    symlinkSync(f, path.join(tmp.dir, "link.json"));
    expect(
      refusal(() => readSecureFile(path.join(tmp.dir, "link.json"), { requirePrivate: false })),
    ).toBe("symlink");
    expect(refusal(() => readSecureFile(tmp.dir, { requirePrivate: false }))).toBe(
      "not_regular_file",
    );
  });
  it("refuses an oversize file", () => {
    const f = path.join(tmp.dir, "big");
    writeFileSync(f, "x".repeat(2048), { mode: 0o600 });
    expect(refusal(() => readSecureFile(f, { requirePrivate: true, maxBytes: 1024 }))).toBe(
      "too_large",
    );
    expect(readSecureFile(f, { requirePrivate: true, maxBytes: 2048 })).toHaveLength(2048);
  });
  it("propagates other open errors (a path through a file)", () => {
    const f = path.join(tmp.dir, "plain");
    writeFileSync(f, "x");
    expect(() => readSecureFile(path.join(f, "child"), { requirePrivate: false })).toThrow(
      /ENOTDIR/,
    );
  });
  it("reads multi-byte UTF-8 intact", () => {
    const f = path.join(tmp.dir, "u.json");
    writeFileSync(f, '{"x":"Équipe 😀"}', { mode: 0o600 });
    expect(readSecureFile(f, { requirePrivate: true })).toBe('{"x":"Équipe 😀"}');
  });
  it("a FIFO planted at the path is refused without blocking", () => {
    const f = path.join(tmp.dir, "session.json");
    execFileSync("mkfifo", [f]);
    const started = Date.now();
    expect(refusal(() => readSecureFile(f, { requirePrivate: true }))).toBe("not_regular_file");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("writeSecureFileAtomic (wx temp + fsync + rename, 0600)", () => {
  const dirOf = () => {
    const d = path.join(tmp.dir, "conf");
    mkdirSync(d, { mode: 0o700 });
    return d;
  };
  it("writes a 0600 file and replaces an existing one, leaving no temp files", () => {
    const d = dirOf();
    const f = path.join(d, "session.json");
    writeSecureFileAtomic(f, "one");
    expect(readFileSync(f, "utf8")).toBe("one");
    expect(mode(f)).toBe(0o600);
    writeSecureFileAtomic(f, new TextEncoder().encode("two"));
    expect(readFileSync(f, "utf8")).toBe("two");
    expect(readdirSync(d)).toEqual(["session.json"]);
  });
  it("refuses to write through a pre-placed symlink at the target", () => {
    const d = dirOf();
    const victim = path.join(tmp.dir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path.join(d, "session.json"));
    expect(
      refusal(() => {
        writeSecureFileAtomic(path.join(d, "session.json"), "evil");
      }),
    ).toBe("symlink");
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });
  it("refuses an insecure parent directory and writes nothing", () => {
    const d = path.join(tmp.dir, "open");
    mkdirSync(d);
    chmodSync(d, 0o755);
    expect(
      refusal(() => {
        writeSecureFileAtomic(path.join(d, "x"), "y");
      }),
    ).toBe("insecure_mode");
    expect(existsSync(path.join(d, "x"))).toBe(false);
  });
  it("on a failed rename, removes the temp file and leaves the target untouched", () => {
    const d = dirOf();
    const target = path.join(d, "is-a-dir");
    mkdirSync(target);
    writeFileSync(path.join(target, "inner"), "x");
    expect(() => {
      writeSecureFileAtomic(target, "data");
    }).toThrow();
    expect(readdirSync(d)).toEqual(["is-a-dir"]);
  });
});

describe("insecure ancestors (ssh StrictModes)", () => {
  it("refuses a dir under a world-writable, non-sticky ancestor and creates nothing there", () => {
    const shared = path.join(tmp.dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const d = path.join(shared, "conf");
    mkdirSync(d, { mode: 0o700 });
    expect(insecureAncestors(d)).toEqual([shared]);
    expect(
      refusal(() => {
        ensureSecureDir(d, { create: false });
      }),
    ).toBe("insecure_ancestor");
    expect(
      refusal(() => {
        ensureSecureDir(path.join(shared, "new", "x"), { create: true });
      }),
    ).toBe("insecure_ancestor");
    expect(readdirSync(shared)).toEqual(["conf"]);
  });
  it("follows a symlinked component to its real ancestors", () => {
    const shared = path.join(tmp.dir, "shared");
    mkdirSync(path.join(shared, "mine"), { recursive: true });
    chmodSync(shared, 0o777);
    chmodSync(path.join(shared, "mine"), 0o700);
    symlinkSync(path.join(shared, "mine"), path.join(tmp.dir, "link"));
    const viaLink = path.join(tmp.dir, "link", "cache");
    mkdirSync(viaLink, { mode: 0o700 });
    expect(insecureAncestors(viaLink)).toContain(shared);
  });
  it("the sticky bit makes a shared ancestor safe; the dir is not its own ancestor", () => {
    const g = path.join(tmp.dir, "grp");
    mkdirSync(g);
    chmodSync(g, 0o1777);
    const d = path.join(g, "conf");
    mkdirSync(d, { mode: 0o700 });
    expect(insecureAncestors(d)).toEqual([]);
    expect(insecureAncestors("/")).toEqual([]);
  });
});
