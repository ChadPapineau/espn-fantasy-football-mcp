// selftest.ts — the launchd-context keychain test that picks ONE store per install (plan 02 §2.2
// "One store per install", A-1; plan 03 §2.1 step 4; plan 06 §2; ADV OBJ-05, OBJ-25): write a
// throwaway item (service `<service>-selftest`, a random value — never a credential), have a
// one-shot launchd agent read it under a 10 s timeout, classify ok | timeout | error, and delete
// the item either way. The agent reports a digest of what it read, never the value. The launchd
// plumbing (plist, bootstrap, bootout) is the CLI's; it is injected here as `readUnderLaunchd`.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { KeychainSelftestOutcome } from "../config/schema.js";
import { safeCode } from "./errors.js";
import {
  SELFTEST_ACCOUNT,
  isAllowedServiceName,
  selftestServiceOf,
  type KeyringPort,
} from "./keychain.js";
import { SELFTEST_SERVICE_SUFFIX, SELFTEST_TIMEOUT_MS } from "./types.js";

/** Which item the agent reads. */
export interface SelftestTarget {
  readonly service: string;
  readonly account: string;
}

/** What the one-shot agent reports: a digest of the value it read, never the value. */
export type SelftestReadReport =
  | { readonly status: "read"; readonly digest: string }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly code: string };

/** Runs the read in a launchd context (the CLI's one-shot agent); should honour `signal`. */
export type LaunchdReader = (
  target: SelftestTarget,
  signal: AbortSignal,
) => Promise<SelftestReadReport>;

/** Why the test ended the way it did (fixed vocabulary; shown by `eff setup` and `doctor` #7). */
export type SelftestReason =
  | "ok"
  | "invalid_service"
  | "write_failed"
  | "read_timeout"
  | "read_failed"
  | "missing"
  | "mismatch";

/** The test's result: the outcome recorded in config.json, the reason, and the cleanup. */
export interface KeychainSelftestResult {
  readonly outcome: KeychainSelftestOutcome;
  readonly reason: SelftestReason;
  /** The agent's error code, sanitised (only with `read_failed`). */
  readonly code: string | null;
  readonly at: string;
  /** Whether the throwaway item is gone afterwards. */
  readonly cleanup: "deleted" | "failed";
}

/** What the test needs. */
export interface SelftestDeps {
  /** The base service (real or `eff-test-…`); the throwaway item goes under `<service>-selftest`. */
  readonly service: string;
  readonly keyring: KeyringPort;
  readonly readUnderLaunchd: LaunchdReader;
  readonly now: () => string;
  /** Default SELFTEST_TIMEOUT_MS (10 s). */
  readonly timeoutMs?: number;
  /** The throwaway value (default: 32 random bytes, hex). */
  readonly randomValue?: () => string;
}

/** sha256 hex of a value — what the agent reports instead of the value. */
export function selftestDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Per-keyring-call bound inside the test (the write and the delete, not the agent's read). */
const KEYRING_CALL_MS = 10_000;

/** The rejection `bounded` uses for an expired bound (distinct from anything a port throws). */
class BoundExpired extends Error {}

async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new BoundExpired("timeout"));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** The launchd-context test (plan 03 §2.1 step 4). Never throws; the item is deleted either way. */
export async function runKeychainSelftest(deps: SelftestDeps): Promise<KeychainSelftestResult> {
  const at = deps.now();
  if (!isAllowedServiceName(deps.service))
    return { outcome: "error", reason: "invalid_service", code: null, at, cleanup: "deleted" };
  const target: SelftestTarget = {
    service: selftestServiceOf(deps.service),
    account: SELFTEST_ACCOUNT,
  };
  const value = (deps.randomValue ?? (() => randomBytes(32).toString("hex")))();
  const timeoutMs = deps.timeoutMs ?? SELFTEST_TIMEOUT_MS;

  let outcome: KeychainSelftestOutcome;
  let reason: SelftestReason;
  let code: string | null = null;
  try {
    await bounded(
      (signal) => deps.keyring.setPassword(target.service, target.account, value, signal),
      KEYRING_CALL_MS,
    );
    let report: SelftestReadReport | "timeout";
    try {
      report = await bounded((signal) => deps.readUnderLaunchd(target, signal), timeoutMs);
    } catch (e) {
      report = e instanceof BoundExpired ? "timeout" : { status: "error", code: "agent_failed" };
    }
    if (report === "timeout") {
      outcome = "timeout";
      reason = "read_timeout";
    } else if (report.status === "read") {
      const ok = sameDigest(report.digest, selftestDigest(value));
      outcome = ok ? "ok" : "error";
      reason = ok ? "ok" : "mismatch";
    } else if (report.status === "missing") {
      outcome = "error";
      reason = "missing";
    } else {
      outcome = "error";
      reason = "read_failed";
      code = safeCode(report.code);
    }
  } catch {
    outcome = "error";
    reason = "write_failed";
  }

  let cleanup: "deleted" | "failed" = "deleted";
  try {
    await bounded(
      (signal) => deps.keyring.deletePassword(target.service, target.account, signal),
      KEYRING_CALL_MS,
    );
  } catch {
    cleanup = "failed";
  }
  return { outcome, reason, code, at, cleanup };
}

/**
 * The one-shot agent's side (`eff` runs it under launchd): read the throwaway item and report its
 * digest. Never throws, never returns or prints the value.
 */
export async function selftestReadOnce(
  keyring: KeyringPort,
  target: SelftestTarget,
  signal: AbortSignal,
): Promise<SelftestReadReport> {
  const base = target.service.slice(0, -SELFTEST_SERVICE_SUFFIX.length);
  if (
    !target.service.endsWith(SELFTEST_SERVICE_SUFFIX) ||
    !isAllowedServiceName(base) ||
    target.account !== SELFTEST_ACCOUNT
  )
    return { status: "error", code: "invalid_target" };
  try {
    const v = await keyring.getPassword(target.service, target.account, signal);
    return v === null ? { status: "missing" } : { status: "read", digest: selftestDigest(v) };
  } catch {
    return { status: "error", code: signal.aborted ? "timeout" : "read_failed" };
  }
}

/** The store a self-test outcome selects for the whole install (anything but ok → file). */
export function storeForSelftest(outcome: KeychainSelftestOutcome): "keychain" | "file" {
  return outcome === "ok" ? "keychain" : "file";
}
