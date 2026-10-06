// serve.ts — `eff serve`, the server process lifecycle (plan 03 §1: startup touches neither the
// network nor the keychain; config errors exit 2; shutdown handlers are installed before anything is
// half-open; the store opened + migrated (a newer store or a pending migration exits 1); the
// composition root (src/services); the stdio transport in dual-era mode (plan 01 §3.1); stdin EOF —
// the primary signal — / SIGTERM / SIGINT / SIGHUP / stdout EPIPE / reparenting → one single-flight
// drain (reads ≤ 3 s) and close (WAL checkpoint, store closed, the secret dropped) under a 10 s hard
// ceiling → exit 5; a second SIGINT forces the close; a crash exits 1). stdout carries ONLY MCP
// frames: every log line is JSON on stderr. Ported from sibling @5daa625 (src/cli/serve.ts), adapted.
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  INVALID_REQUEST,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  deserializeMessage,
  type JSONRPCErrorResponse,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { openCredentialStores } from "../auth/stores.js";
import {
  backupDir,
  datasetDir,
  ensureSecureDir,
  packageRoot,
  PathSecurityError,
  storePath,
} from "../config/paths.js";
import {
  ConfigError,
  EXIT_CODES,
  identifierValues,
  loadConfigFromProcess,
  secretValues,
  type Config,
} from "../config/schema.js";
import { systemClock, type Clock } from "../domain/clock.js";
import { createServer } from "../mcp/server.js";
import { derivedLeagueClock, type FetchLike } from "../providers/espn/index.js";
import { buildServices, type Wiring } from "../services/index.js";
import { storeFactory } from "../store/index.js";
import {
  StoreMigrationPendingError,
  StoreVersionError,
  type Store,
  type StoreFactory,
} from "../store/types.js";
import { VERSION } from "../version.js";
import type { KeyringPort } from "../auth/keychain.js";
import { createLogger, type Logger } from "./log.js";

/** What `serve` is given (the CLI entry passes the real process streams). */
export interface ServeOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/** Test seams (never set by the CLI). */
export interface ServeInternals {
  readonly clock?: Clock;
  readonly factory?: StoreFactory;
  /** Parent-pid watchdog interval (plan 03 §1.3: 5 s). */
  readonly watchdogMs?: number;
  /** Hard close ceiling (plan 03 §1.3: 10 s → exit 5). */
  readonly closeDeadlineMs?: number;
  /** In-flight reads are waited for this long before closing (plan 03 §1.3: 3 s). */
  readonly drainMs?: number;
  /** Install process signal/crash handlers and the watchdog (default true; in-process tests pass false). */
  readonly signals?: boolean;
  /** The package root the Skill texts and the drift manifest are read from. */
  readonly packageRoot?: string;
  /** The provider's transport (tests inject; never used in fixture mode). */
  readonly fetch?: FetchLike;
  readonly loadKeyring?: () => Promise<KeyringPort>;
  /** Holds the close sequence this long before it starts (process tests: a second SIGINT path). */
  readonly closeDelayMs?: number;
}

/** Process exit codes (plan 03 §1.3, shared with the CLI). */
export const EXIT = EXIT_CODES;

/** Plan 03 §7's message for a store written by a newer binary (exit 1). */
export function newerStoreMessage(storeVersion: number, binaryVersion: number): string {
  return `store.sqlite was written by a newer version (v${String(storeVersion)}); this binary supports v${String(binaryVersion)}. Upgrade the package or restore the backup.`;
}

// --- malformed requests --------------------------------------------------------------------------

/**
 * The reply a stdin line deserves when the SDK transport would drop it silently: a line that parses
 * as JSON but is not a valid JSON-RPC message and is a REQUEST with a usable id (a string ≤ 256
 * chars, or a finite number) gets -32600 Invalid Request under that id. Everything else is null: a
 * valid message (the SDK answers it), a notification or a response, an array, a null/object id, and
 * an unparseable line (its id is unreadable; it is logged instead).
 */
export function invalidRequestReply(line: string): JSONRPCErrorResponse | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  try {
    deserializeMessage(line);
    return null;
  } catch {
    // not a valid message: answer it below when it is a request with a usable id
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, "method")) return null;
  const id = o.id;
  const usable =
    (typeof id === "string" && id.length <= 256) || (typeof id === "number" && Number.isFinite(id));
  if (!usable) return null;
  return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "Invalid Request" } };
}

/** Watches stdin's lines beside the SDK transport and answers each invalid request. */
function watchInvalidRequests(
  stdin: NodeJS.ReadableStream,
  reply: (msg: JSONRPCErrorResponse) => void,
  logger: Logger,
): () => void {
  let buf = "";
  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buf.length > STDIO_DEFAULT_MAX_BUFFER_SIZE) buf = "";
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (line.trim() === "") continue;
      const r = invalidRequestReply(line);
      if (r !== null) {
        logger.warn("transport.invalid_request", { code: INVALID_REQUEST });
        reply(r);
        continue;
      }
      try {
        JSON.parse(line);
      } catch {
        logger.warn("transport.parse_error", { bytes: line.length });
      }
    }
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
  };
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  try {
    stream.write(`${line}\n`);
  } catch {
    // a closed stderr must not crash startup or shutdown
  }
}

/** A coarse, value-free reason for a store that could not be opened. */
function storeOpenReason(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code.toLowerCase();
  return e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "unknown";
}

/** A clock that reads `atMs` now and runs on in real time (a derived fixture league's instant). */
export function offsetClock(atMs: number): Clock {
  const offset = atMs - systemClock.nowMs();
  const nowMs = (): number => systemClock.nowMs() + offset;
  return Object.freeze({ nowMs, nowIso: () => new Date(nowMs()).toISOString() });
}

/**
 * `eff serve`: resolves the exit code once the server has shut down (never earlier). Startup touches
 * no network and no keychain; the store is closed on every exit path.
 */
export async function serve(opts: ServeOptions, internals: ServeInternals = {}): Promise<number> {
  let clock = internals.clock ?? systemClock;
  const bootLog = createLogger({
    level: "info",
    sink: (l) => {
      writeLine(opts.stderr, l);
    },
  });
  try {
    parseArgs({ args: [...opts.argv], options: {}, strict: true, allowPositionals: false });
  } catch {
    bootLog.error("serve.usage", { reason: "serve takes no arguments" });
    return EXIT.usage;
  }

  const home = opts.env.HOME ?? homedir();
  const root = internals.packageRoot ?? packageRoot();
  let config: Config;
  try {
    config = loadConfigFromProcess({ env: opts.env, home, repoRoot: root, nowMs: clock.nowMs() });
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const i of e.issues) bootLog.error("config.invalid", { key: i.key, reason: i.reason });
      return EXIT.usage;
    }
    bootLog.error("config.unreadable", {
      reason: e instanceof PathSecurityError ? e.detail : "unknown",
    });
    return EXIT.usage;
  }
  // A derived fixture league carries its own frozen instant (fixtures/espn/fx-10h: Tuesday of week
  // 5, 21:00 ET); fixture mode only, and never over an injected clock. Time runs on from it, so the
  // limiter's windows and the cache TTLs behave as in production.
  const fixtureClockAt =
    internals.clock === undefined && config.fixtureDir !== null
      ? derivedLeagueClock(config.fixtureDir)
      : null;
  if (fixtureClockAt !== null) clock = offsetClock(fixtureClockAt);
  const logger = createLogger({
    level: config.logLevel,
    sink: (l) => {
      writeLine(opts.stderr, l);
    },
  });
  for (const s of secretValues(config)) logger.registerSecret(s.kind, s.value);
  for (const id of identifierValues(config)) logger.registerIdentifier(id.kind, id.value);
  for (const w of config.warnings) logger.warn("config.warning", { detail: w });

  // --- shutdown machinery first (plan 03 §1.1 step 2) ------------------------------------------------
  let store: Store | null = null;
  let wiring: Wiring | null = null;
  let handle: StdioServerHandle | null = null;
  let inflight = 0;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  let closing: Promise<void> | null = null;
  let forceNow: (() => void) | null = null;
  const cleanups: (() => void)[] = [];
  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch {
        // a failing cleanup must not keep the process alive
      }
    }
    resolveExit(code);
  };
  const shutdown = (reason: string, code: number): Promise<void> => {
    if (closing !== null) return closing;
    logger.info("serve.shutdown", { reason });
    const deadline = setTimeout(() => {
      logger.error("serve.forced_exit", { reason });
      finish(EXIT.forced);
    }, internals.closeDeadlineMs ?? 10_000);
    deadline.unref();
    forceNow = () => {
      clearTimeout(deadline);
      logger.error("serve.forced_exit", { reason: "second_signal" });
      finish(EXIT.forced);
    };
    closing = (async () => {
      if (internals.closeDelayMs !== undefined && internals.closeDelayMs > 0)
        await new Promise((r) => setTimeout(r, internals.closeDelayMs));
      const drainUntil = Date.now() + (internals.drainMs ?? 3000);
      while (inflight > 0 && Date.now() < drainUntil) await new Promise((r) => setTimeout(r, 20));
      if (inflight > 0) logger.warn("serve.drain_timeout", { inflight });
      try {
        await handle?.close();
      } catch {
        // the transport is already gone
      }
      try {
        wiring?.close();
      } catch {
        // dropping the secret never fails the close
      }
      try {
        store?.close();
      } catch (e) {
        logger.error("store.close_failed", { error: e instanceof Error ? e.name : "unknown" });
        code = code === EXIT.ok ? EXIT.error : code;
      }
      clearTimeout(deadline);
      finish(code);
    })();
    return closing;
  };

  const onEnd = (): void => void shutdown("stdin", EXIT.ok);
  opts.stdin.on("end", onEnd);
  opts.stdin.on("close", onEnd);
  cleanups.push(() => {
    opts.stdin.off("end", onEnd);
    opts.stdin.off("close", onEnd);
  });
  const onStdoutError = (e: unknown): void => {
    const code = (e as { code?: unknown } | null)?.code;
    void shutdown(code === "EPIPE" ? "epipe" : "stdout_error", EXIT.ok);
  };
  opts.stdout.on("error", onStdoutError);
  cleanups.push(() => opts.stdout.off("error", onStdoutError));
  if (internals.signals !== false) {
    const onSignal = (sig: NodeJS.Signals): void => {
      if (closing !== null) {
        if (sig === "SIGINT") forceNow?.();
        return;
      }
      void shutdown(sig.toLowerCase(), EXIT.ok);
    };
    const onCrash = (e: unknown): void => {
      logger.error("serve.crash", {
        error: e instanceof Error ? { name: e.name, message: e.message } : typeof e,
      });
      void shutdown("crash", EXIT.error);
    };
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, onSignal);
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    cleanups.push(() => {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(sig, onSignal);
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
    });
    const initialPpid = process.ppid;
    const watchdog = setInterval(() => {
      if (process.ppid !== initialPpid) void shutdown("orphaned", EXIT.ok);
    }, internals.watchdogMs ?? 5000);
    watchdog.unref();
    cleanups.push(() => {
      clearInterval(watchdog);
    });
  }

  // --- the store (plan 03 §1.1 step 3) -----------------------------------------------------------------
  try {
    ensureSecureDir(config.cacheDir, { create: true, what: "cache directory" });
    store = (internals.factory ?? storeFactory).open({
      path: storePath(config.cacheDir),
      datasetDir: datasetDir(config.cacheDir),
      backupDir: backupDir(config.cacheDir),
      clock,
      migrate: true,
      weatherSource: config.weatherSource,
      recordRawBodies: config.fixtureRecord,
      onWarning: (code) => {
        logger.warn("store.warning", { code });
      },
    });
  } catch (e) {
    let code: number = EXIT.error;
    if (e instanceof StoreVersionError) {
      logger.error("store.open_failed", {
        error: e.name,
        reason: "newer_version",
        store_version: e.storeVersion,
        binary_version: e.binaryVersion,
        message: newerStoreMessage(e.storeVersion, e.binaryVersion),
      });
    } else if (e instanceof StoreMigrationPendingError) {
      logger.error("store.open_failed", { error: e.name, reason: "migration_pending" });
    } else if (e instanceof PathSecurityError) {
      code = EXIT.usage;
      logger.error("store.open_failed", { error: e.name, reason: e.detail });
    } else {
      logger.error("store.open_failed", {
        error: e instanceof Error ? e.name : "unknown",
        reason: storeOpenReason(e),
        hint: "run `eff doctor`",
      });
    }
    finish(code);
    return exited;
  }

  // --- the server (plan 03 §1.1 steps 4–8) -----------------------------------------------------------
  try {
    if (config.fixtureDir === null && config.credentialStore === "file") {
      try {
        openCredentialStores({
          filePath: config.credentialFile,
          home,
          repoRoot: root,
        }).file.verifyLocation();
      } catch {
        logger.warn("auth.file_location_refused", { hint: "run `eff doctor`" });
      }
    }
    const w = buildServices({
      config,
      store,
      clock,
      logger,
      packageRoot: root,
      home,
      stderr: opts.stderr,
      ...(internals.fetch === undefined ? {} : { fetch: internals.fetch }),
      ...(internals.loadKeyring === undefined ? {} : { loadKeyring: internals.loadKeyring }),
    });
    wiring = w;
    const services = {
      ...w.services,
      inflight: {
        enter: () => {
          inflight++;
        },
        exit: () => {
          inflight = Math.max(0, inflight - 1);
        },
      },
    };
    const transport = new StdioServerTransport(
      opts.stdin as unknown as Readable,
      opts.stdout as unknown as Writable,
    );
    handle = serveStdio(() => createServer(services, w.options), {
      transport,
      onerror: (e) => {
        logger.warn("transport.error", { error: e.name });
      },
    });
    // the transport closes itself on a frame over its read cap and pauses stdin: run the close
    // sequence instead of idling deaf (serveStdio installs its own onclose; wrap it after the call)
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      sdkOnClose?.();
      void shutdown("transport_closed", EXIT.ok);
    };
    cleanups.push(
      watchInvalidRequests(
        opts.stdin,
        (msg) => {
          transport.send(msg).catch(() => {
            // stdout already gone: the shutdown path handles it
          });
        },
        logger,
      ),
    );
    logger.info("serve.ready", {
      version: VERSION,
      node: process.versions.node,
      schema_version: store.schemaVersion,
      toolset: config.toolset,
      fixture_mode: config.fixtureDir !== null,
      ...(fixtureClockAt === null ? {} : { fixture_clock: new Date(fixtureClockAt).toISOString() }),
      credential_state: w.services.auth.state(),
      drift: w.services.status.drift().status,
    });
  } catch (e) {
    logger.error("serve.start_failed", {
      error: e instanceof Error ? e.name : "unknown",
      code: (e as { effCode?: unknown } | null)?.effCode ?? null,
    });
    void shutdown("start_failed", EXIT.error);
  }
  return exited;
}
