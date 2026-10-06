// lock.ts — the process-wide store lock (plan 03 L7 / §7: migrations and the `VACUUM INTO` backup run
// "under the process lock"; T-15(b)): `<store>.lock` created `O_EXCL | O_NOFOLLOW` holding the pid
// and the ISO time; broken when its pid is dead or it is older than STALE_LOCK_MS. Waits are bounded:
// the sync form (startup migrations) sleeps with Atomics.wait, the async form yields to the loop.
// Ported from sibling @cf3b015, adapted.
import {
  closeSync,
  constants as fsc,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** A lock older than this is abandoned (a migration or a backup takes seconds). */
export const STALE_LOCK_MS = 30_000;
/** How long an acquirer waits before giving up. */
export const LOCK_WAIT_MS = 5_000;
const POLL_MS = 25;

/** `<store>.lock`: the process-wide store lock file. */
export const lockPathOf = (storePath: string): string => `${storePath}.lock`;

/** The store lock could not be taken within the wait budget. */
export class StoreLockTimeoutError extends Error {
  readonly effCode = "INTERNAL" as const;
  constructor(readonly lockPath: string) {
    super("store: the process-wide store lock is held by another process");
    this.name = "StoreLockTimeoutError";
  }
}

/** Whether `pid` names a live process (EPERM = alive but not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, `${String(process.pid)} ${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Breaks the lock when its holder is dead or it is older than STALE_LOCK_MS; true when gone. */
function breakIfStale(lockPath: string): boolean {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(lockPath, { encoding: "utf8", flag: fsc.O_RDONLY | fsc.O_NOFOLLOW });
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ELOOP") {
      rmSync(lockPath, { force: true });
      return true;
    }
    throw e;
  }
  const pid = Number.parseInt(text.split(" ")[0] ?? "", 10);
  if (!pidAlive(pid) || Date.now() - mtimeMs > STALE_LOCK_MS) {
    rmSync(lockPath, { force: true });
    return true;
  }
  return false;
}

/** A held lock. */
export interface HeldLock {
  release(): void;
}

function held(lockPath: string): HeldLock {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}

const cell = new Int32Array(new SharedArrayBuffer(4));

/** Takes the lock, blocking at most `waitMs`. For the startup path only. */
export function acquireLockSync(lockPath: string, waitMs = LOCK_WAIT_MS): HeldLock {
  const start = Date.now();
  for (;;) {
    if (tryCreate(lockPath)) return held(lockPath);
    if (breakIfStale(lockPath)) continue;
    if (Date.now() - start >= waitMs) throw new StoreLockTimeoutError(lockPath);
    Atomics.wait(cell, 0, 0, POLL_MS);
  }
}

/** Takes the lock, yielding between attempts, for at most `waitMs`. */
export async function acquireLock(lockPath: string, waitMs = LOCK_WAIT_MS): Promise<HeldLock> {
  const start = Date.now();
  for (;;) {
    if (tryCreate(lockPath)) return held(lockPath);
    if (breakIfStale(lockPath)) continue;
    if (Date.now() - start >= waitMs) throw new StoreLockTimeoutError(lockPath);
    await sleep(POLL_MS);
  }
}
