// serve.ts — `eff serve`, the server process lifecycle (plan 03 §1: startup touches neither the
// network nor the keychain; config errors exit 2; shutdown handlers are installed before anything is
// half-open; the store opened + migrated (a newer store or a pending migration exits 1); the
// composition root (src/services); the stdio transport in dual-era mode (plan 01 §3.1); stdin EOF —
// the primary signal — / SIGTERM / SIGINT / SIGHUP / stdout EPIPE / reparenting → one single-flight
// drain (reads ≤ 3 s) and close (WAL checkpoint, store closed, the secret dropped) under a 10 s hard
// ceiling → exit 5; a second SIGINT forces the close; a crash exits 1). stdout carries ONLY MCP
// frames: every log line is JSON on stderr. A stdin line the SDK transport would drop is answered
// (-32700 for a line that is not JSON, -32600 for an invalid request with a usable id), and a
// tools/call argument key `__proto__` reaches the tool's strict schema (plan 02 §5) instead of being
// dropped by the SDK's re-parse. A JSON-RPC batch (an array line; MCP 2025-03-26 §Batching: a
// server MUST support receiving them) is answered with ONE array of the responses, `[]` with a single
// -32600; the SDK's invalid-params replies (-32603 carrying a raw zod issue dump, or the URI-length
// refusal) become -32602 "Invalid params"; an open `subscriptions/listen` (a stream, answered only at
// teardown) never holds the drain; and the process resolves its exit code only once stdout has
// flushed every reply (a reply queued in the stream when `process.exit` runs is lost).
// Ported from sibling @5daa625 (src/cli/serve.ts), adapted.
import { homedir } from "node:os";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  deserializeMessage,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
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
import { newerStoreMessage as storeNewerMessage } from "./store-access.js";

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

/**
 * Plan 03 §7's message for a store written by a newer binary (exit 1) — the CLI's one message
 * (store-access.ts), which says where the restore steps are (Stage C finding
 * store-restore-advice-stale-wal).
 */
export function newerStoreMessage(storeVersion: number, binaryVersion: number): string {
  return storeNewerMessage(storeVersion, binaryVersion);
}

// --- malformed requests --------------------------------------------------------------------------

/**
 * The reply to a stdin line that is not JSON at all: -32700 Parse error (JSON-RPC 2.0 §5.1). Its id
 * cannot be read, so the reply carries none — MCP's error response makes `id` optional and its
 * RequestId has no null (the SDK's own message schema rejects `id: null`, the form JSON-RPC 2.0
 * alone would use). A fresh object per call.
 */
export function parseErrorReply(): JSONRPCErrorResponse {
  return { jsonrpc: "2.0", error: { code: PARSE_ERROR, message: "Parse error" } };
}

/**
 * The reply a stdin line deserves when the SDK transport would drop it silently (the transport hands
 * every line it cannot read to `onerror` and answers nothing): a line that is not JSON gets -32700
 * Parse error with no id (`parseErrorReply`); a line that parses as JSON but is not a valid JSON-RPC
 * message and is a REQUEST with a usable id (a string ≤ 256 chars, or a finite number) gets -32600
 * Invalid Request under that id. Everything else is null: a valid message (the SDK answers it), a
 * notification or a response, an array, a null/object id.
 */
export function stdinLineReply(line: string): JSONRPCErrorResponse | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return parseErrorReply();
  }
  return invalidRequestOf(raw, line);
}

/** `stdinLineReply` restricted to the -32600 case (null for an unparseable line). */
export function invalidRequestReply(line: string): JSONRPCErrorResponse | null {
  const r = stdinLineReply(line);
  return r !== null && r.error.code === INVALID_REQUEST ? r : null;
}

function invalidRequestOf(raw: unknown, line: string): JSONRPCErrorResponse | null {
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

/**
 * The name a tools/call argument key `__proto__` is carried under past the SDK. No tool declares it
 * (tests/mcp/serve.test.ts holds that for every tool of both toolsets), so the tool's strict input
 * schema reports it as an unknown key.
 */
export const PROTO_KEY_STANDIN = "__proto__ (own key)";

/**
 * A tools/call whose `arguments` carry an own `__proto__` key, with that key carried under
 * `PROTO_KEY_STANDIN` (its value and every other key unchanged). The SDK re-parses `arguments` as a
 * zod record before the handler runs, and zod never copies a `__proto__` key into the object it
 * builds, so the tool's strict schema (plan 01 §4; plan 02 §5: `__proto__` keys are rejected by the
 * schemas' `.strict()`) would never see it and the call would answer as if the key were absent.
 * Carried under a name no tool declares, it is an unknown key like any other: a coded VALIDATION
 * (`(root) (unknown key)`), the key never echoed. A deeper `__proto__` key needs no carrying: the
 * SDK passes argument values through untouched and the nested strict objects reject it. Every
 * other message is returned as is (the same object). The copies define own data properties only,
 * so no prototype is ever set.
 */
export function withProtoKeyCarried(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCRequest(message) || message.method !== "tools/call") return message;
  const params: unknown = message.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return message;
  if (!Object.prototype.hasOwnProperty.call(params, "arguments")) return message;
  const args: unknown = (params as Record<string, unknown>).arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return message;
  if (!Object.prototype.hasOwnProperty.call(args, "__proto__")) return message;
  const carried = Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k === "__proto__" ? PROTO_KEY_STANDIN : k, v] as const),
  );
  return { ...message, params: { ...(params as Record<string, unknown>), arguments: carried } };
}

/** The SDK's "unknown name" replies: `Tool <name> not found`, `Prompt <name> disabled`, … */
const ECHOED_NAME_RE = /^(Tool|Prompt|Resource template) [\s\S]* (not found|disabled)$/;

/**
 * The SDK's resources/read misses, each carrying the caller's URI: `Resource not found: <uri>`
 * (data `{ uri }`), `Resource URI <uri> is invalid` (data `{ uri, reason }`), `Resource <uri>
 * disabled`. Our own template misses say `not found` with the template URI and never match.
 */
const ECHOED_URI_RULES: readonly (readonly [RegExp, string])[] = [
  [/^Resource not found: [\s\S]*$/, "Resource not found"],
  [/^Resource URI [\s\S]* is invalid$/, "Resource URI is invalid"],
  [/^Resource (?!template )[\s\S]* disabled$/, "Resource disabled"],
];

/**
 * The error's `data` with an echoed `uri` emptied (its keys kept, so a client still reads `{ uri }`
 * as resource-not-found); `data` that is not an object could only be the echo, and goes.
 */
function withoutEchoedUri(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const o = data as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(o, "uri") ? { ...o, uri: "" } : o;
}

/**
 * The reply with the caller's string taken out of an SDK "unknown name" error. The SDK answers a
 * call to an unregistered tool or prompt (or an unknown resource template) with -32602 and the name
 * verbatim, and a resources/read miss with the URI twice (in the message and in `data.uri`), with
 * control characters and cookie-, GUID- or IP-shaped text included, at any size. The code and the
 * shape of `data` stay; the echo goes (the caller knows what it sent). Every other message passes
 * unchanged.
 */
export function withoutEchoedName(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCErrorResponse(message)) return message;
  const m = ECHOED_NAME_RE.exec(message.error.message);
  if (m !== null) {
    const text = `${m[1] ?? "Tool"} ${m[2] ?? "not found"}`;
    return { ...message, error: { ...message.error, message: text } };
  }
  const rule = ECHOED_URI_RULES.find(([re]) => re.test(message.error.message));
  if (rule === undefined) return message;
  const { data, ...rest } = message.error;
  const kept = withoutEchoedUri(data);
  return {
    ...message,
    error: { ...rest, message: rule[1], ...(kept === undefined ? {} : { data: kept }) },
  };
}

/** The SDK's refusal of an over-long resource URI (its message; the URI itself is not echoed). */
const URI_TOO_LONG_RE = /^URI exceeds maximum length of \d+ characters \(got \d+\)$/;

/**
 * Whether an SDK -32603 is really a refusal of the CALLER's parameters: its message is the raw zod
 * issue array of the request schema (every issue's path starts at `params`), or the URI-length
 * refusal. A server-side failure — anything else — stays -32603.
 */
export function isInvalidParamsDump(message: string): boolean {
  if (URI_TOO_LONG_RE.test(message)) return true;
  if (!message.startsWith("[")) return false;
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return false;
  }
  return (
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every(
      (i) =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as { code?: unknown }).code === "string" &&
        Array.isArray((i as { path?: unknown }).path) &&
        (i as { path: unknown[] }).path[0] === "params",
    )
  );
}

/**
 * The reply with the SDK's invalid-params errors coded as such (JSON-RPC 2.0 §5.1: -32602 is the
 * caller's invalid method parameters, -32603 the server's internal error): initialize without
 * `clientInfo`, prompts/get with a non-string argument, resources/read with a non-string or
 * over-long `uri` — all answered -32603 with a multi-line zod dump by the SDK — become -32602
 * "Invalid params", short and fixed (the dump's paths and expectations are dropped; tools/call
 * already answers -32602 itself). Every other message passes unchanged.
 */
export function withInvalidParamsCoded(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJSONRPCErrorResponse(message) || message.error.code !== INTERNAL_ERROR) return message;
  if (!isInvalidParamsDump(message.error.message)) return message;
  return { ...message, error: { code: INVALID_PARAMS, message: "Invalid params" } };
}

/** The single reply to an empty batch `[]` (JSON-RPC 2.0 §6), with no id (as for -32700). */
export function emptyBatchReply(): JSONRPCErrorResponse {
  return { jsonrpc: "2.0", error: { code: INVALID_REQUEST, message: "Invalid Request" } };
}

/** One element of a batch: a message to deliver, or the -32600 reply an invalid element gets. */
export type BatchElement =
  | { readonly kind: "message"; readonly message: JSONRPCMessage }
  | { readonly kind: "invalid"; readonly reply: JSONRPCErrorResponse };

/**
 * Splits a batch (JSON-RPC 2.0 §6): each element that is a valid JSON-RPC message is delivered as if
 * it had arrived alone; an invalid element is answered -32600 Invalid Request — under its id when it
 * is a request with a usable one, else with no id (never an echo of the element).
 */
export function batchElements(batch: readonly unknown[]): BatchElement[] {
  return batch.map((el): BatchElement => {
    const line = JSON.stringify(el);
    try {
      return { kind: "message", message: deserializeMessage(line) };
    } catch {
      return {
        kind: "invalid",
        reply: invalidRequestOf(el, line) ?? {
          jsonrpc: "2.0",
          error: { code: INVALID_REQUEST, message: "Invalid Request" },
        },
      };
    }
  });
}

/**
 * Collects the responses of open batches (JSON-RPC 2.0 §6: the server answers a batch with ONE
 * array holding a response per request, in no particular order; a batch of notifications only gets
 * nothing). `claim` takes a response whose id belongs to an open batch — it is then written with
 * its batch, not alone; `cancel` settles a cancelled request (the SDK answers it nothing); `flush`
 * writes every open batch's collected replies (the close sequence).
 */
export class BatchReplies {
  private readonly open: {
    readonly expect: Set<string | number>;
    readonly replies: JSONRPCMessage[];
  }[] = [];
  private readonly write: (replies: readonly JSONRPCMessage[]) => void;
  constructor(write: (replies: readonly JSONRPCMessage[]) => void) {
    this.write = write;
  }

  /** Opens a batch expecting `ids` (its requests), with `replies` already known (invalid elements). */
  begin(ids: readonly (string | number)[], replies: readonly JSONRPCMessage[]): void {
    const b = { expect: new Set(ids), replies: [...replies] };
    if (b.expect.size === 0) {
      if (b.replies.length > 0) this.write(b.replies);
      return;
    }
    this.open.push(b);
  }

  /** Whether `id` is awaited by an open batch. */
  has(id: string | number): boolean {
    return this.open.some((b) => b.expect.has(id));
  }

  /** Takes a response for an open batch (true) — written with the batch once it is complete. */
  claim(message: JSONRPCMessage): boolean {
    if (!(isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))) return false;
    const id = message.id;
    if (id === undefined) return false;
    const b = this.open.find((x) => x.expect.has(id));
    if (b === undefined) return false;
    b.expect.delete(id);
    b.replies.push(message);
    this.settle(b);
    return true;
  }

  /** A cancelled batched request: nothing will answer it. */
  cancel(id: string | number): void {
    const b = this.open.find((x) => x.expect.has(id));
    if (b === undefined) return;
    b.expect.delete(id);
    this.settle(b);
  }

  /** Writes every open batch's collected replies now (the close sequence: nothing more will come). */
  flush(): void {
    for (const b of this.open.splice(0)) if (b.replies.length > 0) this.write(b.replies);
  }

  /** Open batches. */
  get size(): number {
    return this.open.length;
  }

  private settle(b: (typeof this.open)[number]): void {
    if (b.expect.size > 0) return;
    this.open.splice(this.open.indexOf(b), 1);
    if (b.replies.length > 0) this.write(b.replies);
  }
}

/**
 * Resolves once `stream` has handed every queued byte to the OS (`writableLength` 0), it ended or
 * was destroyed (nothing more can be delivered). `process.exit` discards what is still queued in a
 * stdout pipe, so `serve` resolves its exit code only after this (bounded by the close deadline).
 */
export function whenFlushed(stream: NodeJS.WritableStream): Promise<void> {
  const w = stream as Partial<Writable>;
  const done = (): boolean =>
    w.destroyed === true || w.writableFinished === true || (w.writableLength ?? 0) === 0;
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (done()) {
        clearInterval(tick);
        resolve();
      }
    }, 10);
  });
}

/**
 * Watches stdin's lines beside the SDK transport and answers each one `stdinLineReply` answers (a
 * line over the read cap — the transport refuses it and closes — is never judged); a line that is a
 * JSON array (a batch, which the SDK transport drops) goes to `batch`, `[]` gets one -32600.
 * Returns the unsubscribe.
 */
export function watchInvalidRequests(
  stdin: NodeJS.ReadableStream,
  reply: (msg: JSONRPCErrorResponse) => void,
  logger: Logger,
  batch?: (elements: readonly unknown[]) => void,
): () => void {
  let buf = "";
  // inside a line longer than the read cap: its rest up to the next newline is not a line of its own
  let overflowed = false;
  // a multi-byte character split across two chunks is decoded whole
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (overflowed) {
        overflowed = false;
        continue;
      }
      // a line over the read cap is the transport's to refuse (it closes itself): never judged here
      if (line.length > STDIO_DEFAULT_MAX_BUFFER_SIZE) continue;
      if (line.trim() === "") continue;
      if (batch !== undefined && line.trimStart().startsWith("[")) {
        let arr: unknown = null;
        try {
          arr = JSON.parse(line);
        } catch {
          arr = null;
        }
        if (Array.isArray(arr)) {
          if (arr.length === 0) {
            logger.warn("transport.invalid_request", { code: INVALID_REQUEST, batch: 0 });
            reply(emptyBatchReply());
          } else batch(arr);
          continue;
        }
      }
      const r = stdinLineReply(line);
      if (r === null) continue;
      if (r.error.code === PARSE_ERROR)
        logger.warn("transport.parse_error", { bytes: line.length });
      else logger.warn("transport.invalid_request", { code: INVALID_REQUEST });
      reply(r);
    }
    if (buf.length > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
      buf = "";
      overflowed = true;
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
  /**
   * Request ids read from the wire and not yet answered (or cancelled): the drain waits for them. A
   * `subscriptions/listen` is not one: it is a stream the SDK answers only at teardown (inside
   * handle.close(), after the drain), so counting it held every close for the whole drain window.
   */
  const pending = new Set<string | number>();
  let batches: BatchReplies | null = null;
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
      const busy = (): boolean => inflight > 0 || pending.size > 0;
      while (busy() && Date.now() < drainUntil) await new Promise((r) => setTimeout(r, 20));
      if (busy())
        logger.warn("serve.drain_timeout", { inflight: Math.max(inflight, pending.size) });
      // a batch still missing a reply gets what it has: nothing more will be answered
      batches?.flush();
      try {
        await handle?.close();
      } catch {
        // the transport is already gone
      }
      batches?.flush();
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
      // every reply handed to stdout reaches the client before the exit code is resolved (the CLI
      // entry exits the process at once); a client that never reads is bounded by the deadline
      await whenFlushed(opts.stdout);
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
      // the message names which directory or file of ours is at fault ("dataset directory: …";
      // a fixed label, never the path) — `eff doctor` shows the path, `eff doctor --fix` repairs it
      logger.error("store.open_failed", { error: e.name, reason: e.detail, message: e.message });
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
    // The SDK transport reads a proxy of stdin that never ends by itself: on stdin EOF the transport
    // would close at once and drop the reply of a call still in flight. EOF runs the shutdown
    // (onEnd), whose drain lets that call answer before handle.close() ends the transport, as for
    // SIGTERM. The transport's own stdin error listener moves to the real stream.
    const input = new PassThrough();
    opts.stdin.pipe(input, { end: false });
    const onStdinError = (e: unknown): void => {
      logger.warn("transport.error", { error: e instanceof Error ? e.name : "unknown" });
    };
    opts.stdin.on("error", onStdinError);
    cleanups.push(() => {
      opts.stdin.unpipe(input);
      opts.stdin.off("error", onStdinError);
    });
    const transport = new StdioServerTransport(input, opts.stdout as unknown as Writable);
    const sdkSend = transport.send.bind(transport);
    const batchReplies = new BatchReplies((replies) => {
      // one line, one array (JSON-RPC 2.0 §6); written straight to stdout in arrival order
      try {
        opts.stdout.write(`${JSON.stringify(replies)}\n`);
      } catch {
        // stdout already gone: the shutdown path handles it
      }
    });
    batches = batchReplies;
    transport.send = (message) => {
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        message.id !== undefined
      )
        pending.delete(message.id);
      const outbound = withInvalidParamsCoded(withoutEchoedName(message));
      if (batchReplies.claim(outbound)) return Promise.resolve();
      return sdkSend(outbound);
    };
    handle = serveStdio(() => createServer(services, w.options), {
      transport,
      onerror: (e) => {
        logger.warn("transport.error", { error: e.name });
      },
    });
    // A request counts as in flight from the moment it is read, not from when its handler starts:
    // serveStdio queues each message and dispatches it from an async pump, so a request followed at
    // once by EOF would otherwise be uncounted when the drain looks (resources and prompts included).
    // A cancellation settles it (the SDK sends no reply to a cancelled request).
    // A tools/call argument named `__proto__` is carried past the SDK's re-parse so the tool's strict
    // schema rejects it like any unknown key (withProtoKeyCarried).
    const sdkOnMessage = transport.onmessage;
    transport.onmessage = (message) => {
      if (isJSONRPCRequest(message)) {
        if (message.method !== "subscriptions/listen") pending.add(message.id);
      } else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
        const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
        if (typeof id === "string" || typeof id === "number") {
          pending.delete(id);
          batchReplies.cancel(id);
        }
      }
      const carried = withProtoKeyCarried(message);
      if (carried !== message) logger.warn("transport.proto_key", { method: "tools/call" });
      sdkOnMessage?.(carried);
    };
    // the transport closes itself on a frame over its read cap and pauses stdin: run the close
    // sequence instead of idling deaf (serveStdio installs its own onclose; wrap it after the call)
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      sdkOnClose?.();
      void shutdown("transport_closed", EXIT.ok);
    };
    // a stdin that ended before serve() wired onEnd emits no `end` (the transport used to check)
    const raw = opts.stdin as Partial<Pick<Readable, "readableEnded" | "destroyed">>;
    if (raw.readableEnded === true || raw.destroyed === true) void shutdown("stdin", EXIT.ok);
    cleanups.push(
      watchInvalidRequests(
        opts.stdin,
        (msg) => {
          transport.send(msg).catch(() => {
            // stdout already gone: the shutdown path handles it
          });
        },
        logger,
        (elements) => {
          // a batch: each valid element goes through the same path as a line of its own (pending,
          // the __proto__ carry, the SDK); the responses come back as ONE array (BatchReplies)
          const split = batchElements(elements);
          const ids = split.flatMap((e) =>
            e.kind === "message" &&
            isJSONRPCRequest(e.message) &&
            e.message.method !== "subscriptions/listen" &&
            !batchReplies.has(e.message.id)
              ? [e.message.id]
              : [],
          );
          const invalid = split.flatMap((e) => (e.kind === "invalid" ? [e.reply] : []));
          logger.info("transport.batch", { size: elements.length, requests: ids.length });
          batchReplies.begin(ids, invalid);
          for (const e of split) if (e.kind === "message") transport.onmessage?.(e.message);
        },
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
