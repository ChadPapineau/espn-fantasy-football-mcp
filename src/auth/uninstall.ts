// uninstall.ts — credential cleanup for `eff uninstall` (plan 03 §8 step 2, L8; plan 02 §2.2
// "Removal", §8 #21; ADV OBJ-05): delete BOTH stores' items — the three keychain items and
// session.json — always, whichever store config.json records (a stale second copy must never
// survive), plus a self-test throwaway item a crashed setup may have left, and clear the
// store.sqlite observations. Every target is attempted even when another fails. The CLI asks first
// and prints what it will not touch (the ESPN session itself is not invalidated by this).
import { CredentialStoreError } from "./errors.js";
import type { CredentialStateRepository, CredentialStore } from "./types.js";

/** What each target ended as. `unavailable`: the backend cannot be reached, so it holds nothing we wrote. */
export type CleanupOutcome = "removed" | "unavailable" | "failed";

/** The cleanup report (no values; safe to print). */
export interface CredentialCleanupReport {
  readonly keychain: CleanupOutcome;
  readonly file: CleanupOutcome;
  readonly selftestItem: CleanupOutcome | "skipped";
  readonly credentialState: "cleared" | "failed" | "skipped";
  /** True when nothing failed. */
  readonly ok: boolean;
}

/** What uninstall touches. */
export interface CredentialCleanupDeps {
  /** The keychain store under the REAL service name. */
  readonly keychain: CredentialStore;
  /** The file store at the recorded (or default) path. */
  readonly file: CredentialStore;
  /** Deletes the `<service>-selftest` throwaway item, if one is left (optional). */
  readonly deleteSelftestItem?: () => Promise<unknown>;
  /** store.sqlite's repository (null when the store is absent). */
  readonly credentialState: CredentialStateRepository | null;
}

async function attempt(fn: () => Promise<unknown>): Promise<CleanupOutcome> {
  try {
    await fn();
    return "removed";
  } catch (e) {
    return e instanceof CredentialStoreError && e.reason === "unavailable"
      ? "unavailable"
      : "failed";
  }
}

/** Removes every stored credential item and the observations (plan 03 §8 step 2). Never throws. */
export async function removeAllCredentials(
  deps: CredentialCleanupDeps,
): Promise<CredentialCleanupReport> {
  const keychain = await attempt(() => deps.keychain.delete());
  const file = await attempt(() => deps.file.delete());
  const selftestItem =
    deps.deleteSelftestItem === undefined ? "skipped" : await attempt(deps.deleteSelftestItem);
  let credentialState: CredentialCleanupReport["credentialState"] = "skipped";
  if (deps.credentialState !== null) {
    try {
      deps.credentialState.clear();
      credentialState = "cleared";
    } catch {
      credentialState = "failed";
    }
  }
  const ok =
    keychain !== "failed" &&
    file !== "failed" &&
    selftestItem !== "failed" &&
    credentialState !== "failed";
  return { keychain, file, selftestItem, credentialState, ok };
}
