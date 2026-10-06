// file.ts — the 0600 file credential store (plan 02 §2.2 file column; plan 01 §10; plan 03 §2.1
// step 4): `EFF_CREDENTIAL_FILE` (default `<config>/session.json`), `0600` in a `0700` directory,
// written `<file>.<pid>.<rand>.tmp` wx + fsync + rename (src/config/paths.ts writeSecureFileAtomic);
// every read refuses a symlink, a non-regular file, foreign ownership and group/other bits; the
// location rule (outside every repository, not a synced folder, no iCloud/file-provider xattr) runs
// before every write and before the first read. Read-only after setup (changelog V5).
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  PathSecurityError,
  ensureSecureDir,
  locationRefusals,
  readSecureFile,
  writeSecureFileAtomic,
  type XattrReader,
} from "../config/paths.js";
import { CredentialStoreError, type CredentialStoreErrorReason } from "./errors.js";
import { validateCookies } from "./format.js";
import type { CredentialStore, EspnCookies, StoredCredential, StoredSecretMeta } from "./types.js";
import { metaMatches, parseMeta } from "./upgrade.js";

/** Largest session.json read (two cookies and three metadata fields fit in well under 8 KiB). */
export const SESSION_FILE_MAX_BYTES = 64 * 1024;

/** Where the file store lives and how its location is checked. */
export interface FileStoreOptions {
  /** The absolute file path (`Config.credentialFile`). */
  readonly path: string;
  /** The user's home (synced-folder names are resolved against it). */
  readonly home: string;
  /** The package checkout (the file must be outside it, and outside every repository). */
  readonly repoRoot: string;
  /** The file-provider xattr reader (tests stub it; default: /usr/bin/xattr on macOS). */
  readonly xattr?: XattrReader;
  /** Injectable `.git` probe for the any-repository rule (tests). */
  readonly gitEntry?: (dir: string) => boolean;
}

/** The file store: the CredentialStore seam plus the location check the server runs at start. */
export interface FileCredentialStore extends CredentialStore {
  readonly kind: "file";
  /** Throws `insecure_location` when the path breaks the location rule (plan 02 §2.2 iCloud check). */
  verifyLocation(): void;
}

function wrap(e: unknown, fallback: CredentialStoreErrorReason): CredentialStoreError {
  if (e instanceof PathSecurityError)
    return new CredentialStoreError("file", "insecure_location", e.reason);
  return new CredentialStoreError("file", fallback);
}

/** Whether `p` has a directory entry (any type) — a stat, never a read (plan 03 §1.1 step 4). */
export function fileStoreExistsSync(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new CredentialStoreError("file", "read_failed");
  }
}

/** The session.json body: metadata first, then the two values exactly as given (no decoding). */
export function sessionFileBody(cookies: EspnCookies, meta: StoredSecretMeta): string {
  return `${JSON.stringify({
    format_version: meta.format_version,
    storedAt: meta.storedAt,
    fingerprint: meta.fingerprint,
    espn_s2: cookies.espn_s2,
    SWID: cookies.swid,
  })}\n`;
}

/** Parses a session.json body (JSON text) into the stored credential; throws a typed error. */
export function parseSessionFile(text: string): StoredCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CredentialStoreError("file", "corrupt");
  }
  const meta = parseMeta(raw);
  if (!meta.ok) throw new CredentialStoreError("file", meta.reason);
  const obj = raw as Record<string, unknown>;
  const s2 = Object.prototype.hasOwnProperty.call(obj, "espn_s2") ? obj.espn_s2 : undefined;
  const swid = Object.prototype.hasOwnProperty.call(obj, "SWID") ? obj.SWID : undefined;
  if (typeof s2 !== "string" || typeof swid !== "string")
    throw new CredentialStoreError("file", "corrupt");
  const cookies: EspnCookies = { espn_s2: s2, swid };
  if (!validateCookies(cookies).ok) throw new CredentialStoreError("file", "invalid_format");
  if (!metaMatches(meta.meta, cookies)) throw new CredentialStoreError("file", "corrupt");
  return { cookies, meta: meta.meta };
}

/** Creates the file store. Nothing touches the disk until a method is called. */
export function createFileCredentialStore(opts: FileStoreOptions): FileCredentialStore {
  const file = opts.path;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tempRe = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{1,10}\\.[0-9a-f]{12}\\.tmp$`,
  );
  let verified = false;

  const verifyLocation = (): void => {
    const refusals = locationRefusals(file, {
      home: opts.home,
      repoRoot: opts.repoRoot,
      what: "credential file",
      ...(opts.xattr === undefined ? {} : { xattr: opts.xattr }),
      ...(opts.gitEntry === undefined ? {} : { gitEntry: opts.gitEntry }),
    });
    const first = refusals[0];
    if (first !== undefined)
      throw new CredentialStoreError("file", "insecure_location", first.reason);
    verified = true;
  };

  const load = (): StoredCredential | null => {
    if (!verified) verifyLocation();
    let text: string | null;
    try {
      ensureSecureDir(dir, { create: false, what: "credential directory" });
      text = readSecureFile(file, {
        requirePrivate: true,
        maxBytes: SESSION_FILE_MAX_BYTES,
        what: "credential file",
      });
    } catch (e) {
      if (e instanceof PathSecurityError && e.reason === "missing") return null;
      throw wrap(e, "read_failed");
    }
    return text === null ? null : parseSessionFile(text);
  };

  return {
    kind: "file",
    verifyLocation,
    read: () => Promise.resolve().then(load),
    readMeta: () => Promise.resolve().then(() => load()?.meta ?? null),
    exists: () => Promise.resolve().then(() => fileStoreExistsSync(file)),
    write: (cookies, meta) =>
      Promise.resolve().then(() => {
        if (!validateCookies(cookies).ok) throw new CredentialStoreError("file", "invalid_format");
        if (!parseMeta(meta).ok || !metaMatches(meta, cookies))
          throw new CredentialStoreError("file", "corrupt");
        verifyLocation();
        try {
          ensureSecureDir(dir, { create: true, what: "credential directory" });
          writeSecureFileAtomic(file, sessionFileBody(cookies, meta), "credential file");
        } catch (e) {
          throw wrap(e, "write_failed");
        }
      }),
    delete: () =>
      Promise.resolve().then(() => {
        try {
          // rm never follows a symlink: a planted link is removed, its target untouched
          rmSync(file, { force: true });
          let names: string[] = [];
          try {
            names = readdirSync(dir);
          } catch {
            names = [];
          }
          for (const n of names) if (tempRe.test(n)) rmSync(path.join(dir, n), { force: true });
        } catch {
          throw new CredentialStoreError("file", "delete_failed");
        }
      }),
  };
}
