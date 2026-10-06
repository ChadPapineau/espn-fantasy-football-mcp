// log.ts — the stderr-only JSON-lines logger (plan 01 §2 "protocol on stdout, everything else on
// stderr", §8 fields + redaction; plan 02 §2.3; plan 05 §2 `cli/log`, a 100 %-coverage module).
// Every field passes through redaction: registered secret values — the stored espn_s2 in BOTH its
// pasted (URL-encoded) and its decodeURIComponent form (ADV OBJ-15) — Cookie/Set-Cookie headers
// wholesale, `espn_s2=`/`SWID=` assignments, every brace-GUID → `{guid:<6 hex>}`, IPv4/IPv6 →
// `[ip]`, registered league ids and ESPN league paths → `[league]`, generic token shapes, URL
// query strings; strings are truncated (bodies to 500). Linear-time: every string is pre-cut before
// the patterns run, and every quantifier is bounded. Nothing is ever written to stdout.
// Ported from sibling @d72e03b, adapted (ESPN rules; league-id identifiers; GUID pseudonyms).
import { createHash } from "node:crypto";
import type { LogLevel } from "../config/schema.js";

/** Level order, most severe first. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Default cap for one string field (plan 01 §8: upstream bodies truncated to 500). */
export const DEFAULT_MAX_STRING = 500;
/** The `X-Fantasy-Filter` log cap (plan 01 §8). */
export const LOG_FILTER_MAX_CHARS = 200;
/** Strings longer than this are dropped whole rather than scanned (bounds CPU per line). */
export const HARD_MAX_STRING = 8 * 1024 * 1024;
/** Registered values shorter than this are ignored (redacting 1–3 chars would shred logs). */
export const MIN_SECRET_LENGTH = 4;
/** Slack kept past the cap before redaction, so a pattern straddling the cut still matches. */
export const PRECUT_SLACK = 4096;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_KEY_CHARS = 64;
const RESERVED = new Set(["ts", "level", "event"]);
const EVENT_RE = /^[a-z0-9_.:-]{1,64}$/;
const KIND_RE = /^[a-z_0-9]{1,32}$/;

/** Structured fields attached to one log line (plan 01 §8: request_id, tool, ms, cache, view, …). */
export type LogFields = Readonly<Record<string, unknown>>;

/** A logger. Every method writes at most one JSON line to stderr and never throws. */
export interface Logger {
  readonly level: LogLevel;
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  /** A logger that adds `bound` to every line; shares the registries. */
  child(bound: LogFields): Logger;
  /** A secret value (espn_s2, an API key) → `[redacted:<kind>]`, in its pasted, encoded and decoded forms. */
  registerSecret(kind: string, value: string): void;
  /** An identifier (the configured league ids) → `[league]`; other kinds → `[redacted:<kind>]`. */
  registerIdentifier(kind: string, value: string): void;
}

/** Options for `createLogger`. */
export interface LoggerOptions {
  readonly level: LogLevel;
  /** Where each finished line (without newline) goes; default: process.stderr. Never stdout. */
  readonly sink?: (line: string) => void;
  readonly now?: () => string;
  readonly maxStringChars?: number;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A registry of secret and identifier values, longest first so overlapping values redact fully. */
export class SecretRegistry {
  private readonly entries: { kind: string; value: string; replace: string; numeric: boolean }[] =
    [];

  private push(kind: string, value: string, replace: string): void {
    if (value.length < MIN_SECRET_LENGTH || this.entries.some((e) => e.value === value)) return;
    this.entries.push({ kind, value, replace, numeric: /^[0-9]+$/.test(value) });
    this.entries.sort((a, b) => b.value.length - a.value.length);
  }

  /** Adds a secret in its pasted, URL-encoded and URL-decoded forms (ADV OBJ-15). */
  add(kind: string, value: string): void {
    const k = KIND_RE.test(kind) ? kind : "secret";
    for (const v of new Set([value, encodeURIComponent(value), safeDecode(value)]))
      this.push(k, v, `[redacted:${k}]`);
  }

  /** Adds an identifier; a numeric one is replaced only as a whole digit run. */
  addIdentifier(kind: string, value: string): void {
    const k = KIND_RE.test(kind) ? kind : "identifier";
    this.push(k, value, k === "league" ? "[league]" : `[redacted:${k}]`);
  }

  /** Replaces every registered value in `s`. */
  apply(s: string): string {
    let out = s;
    for (const e of this.entries) {
      if (!out.includes(e.value)) continue;
      out = e.numeric
        ? out.replace(new RegExp(`(?<![0-9])${escapeRe(e.value)}(?![0-9])`, "g"), e.replace)
        : out.split(e.value).join(e.replace);
    }
    return out;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Length of the longest registered value — bounds the redaction pre-cut. */
  get longest(): number {
    return this.entries[0]?.value.length ?? 0;
  }
}

/** `{guid:<6 hex of sha256>}` — a stable pseudonym; the GUID cannot be recovered from it. */
export function guidPseudonym(guid: string): string {
  const norm = guid.replace(/^(?:\{|%7B)|(?:\}|%7D)$/gi, "").toUpperCase();
  return `{guid:${createHash("sha256").update(norm).digest("hex").slice(0, 6)}}`;
}

/** One pattern-based redaction. */
interface PatternRule {
  readonly id: string;
  readonly re: RegExp;
  readonly replace: string | ((match: string, ...groups: string[]) => string);
}

const HEX = "[0-9A-Fa-f]";
const GUID = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`;

/** The pattern rules, applied in order to every string after registered values. */
export const REDACTION_PATTERNS: readonly PatternRule[] = Object.freeze([
  {
    id: "private_key",
    re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
    replace: "[redacted:private_key]",
  },
  {
    // Cookie / Set-Cookie headers wholesale, to the end of the line (plan 01 §8).
    id: "cookie_header",
    re: /\b((?:set-)?cookie)(["']?\s{0,8}[:=]\s{0,8})[^\r\n]*/gi,
    replace: "$1$2[redacted:cookie]",
  },
  {
    id: "espn_s2",
    re: /\b(espn[_-]?s2)(["']?\s{0,8}[:=]\s{0,8}["']?)[^;\s&"',}]{1,8192}/gi,
    replace: "$1$2[redacted:espn_s2]",
  },
  {
    id: "swid",
    re: /\b(swid)(["']?\s{0,8}[:=]\s{0,8}["']?)[^;\s&"',}]{1,512}/gi,
    replace: "$1$2[redacted:swid]",
  },
  {
    // every member id is a brace-GUID (research 03 §B.3); URL-encoded braces too
    id: "brace_guid",
    re: new RegExp(`(?:\\{|%7B)${GUID}(?:\\}|%7D)`, "gi"),
    replace: (m: string) => guidPseudonym(m),
  },
  {
    id: "authorization",
    re: /\b(authorization["']?\s{0,8}[:=]\s{0,8}["']?)(?:(?:bearer|basic|token)\s{1,8})?[^\s"',;}]{1,4096}/gi,
    replace: "$1[redacted:authorization]",
  },
  {
    id: "bearer",
    re: /\b(bearer|basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,4096}/gi,
    replace: "$1 [redacted:token]",
  },
  {
    // ESPN league paths and assignments carry the league id (plan 01 §8 `[league]`)
    id: "league_id",
    re: /(\bleagues\/|\bleagueHistory\/|\bleague[_-]?id["']?\s{0,8}[:=]\s{0,8}["']?)[0-9]{1,12}/gi,
    replace: "$1[league]",
  },
  {
    id: "url_query",
    re: /\b([a-z][a-z0-9+.-]{1,15}:\/\/)(?:[^\s/@"'<>]{0,256}@)?([^\s/?#"'<>]{1,256})([^\s?#"'<>]{0,2048})(?:[?#][^\s"'<>]{0,4096})?/gi,
    replace: "$1$2$3",
  },
  {
    id: "param",
    re: /\b(code|state|access_token|refresh_token|id_token|client_secret|password|passwd|token|api_key|apikey|apiKey|secret)=([^&\s"',;]{1,4096})/gi,
    replace: "$1=[redacted]",
  },
  {
    id: "json_secret",
    re: /("(?:access_token|refresh_token|id_token|client_secret|password|passwd|api_key|apikey|token|secret|authorization|cookie|espn_s2|swid)"\s{0,8}:\s{0,8}")[^"]{0,8192}(")/gi,
    replace: "$1[redacted]$2",
  },
  {
    id: "email",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/g,
    replace: "[redacted:email]",
  },
  {
    id: "ipv4",
    re: /(?<![0-9.])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?![0-9.])/g,
    replace: "[ip]",
  },
  {
    // full 8-group form, or any `::` form; never a clock time (`12:34:56` has neither)
    id: "ipv6",
    re: /(?<![0-9A-Za-z:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4})(?![0-9A-Za-z:])/g,
    replace: "[ip]",
  },
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,4096}\.eyJ[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{10,4096}/g,
    replace: "[redacted:token]",
  },
  {
    id: "github_token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})/g,
    replace: "[redacted:token]",
  },
  { id: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,255}/g, replace: "[redacted:api_key]" },
  { id: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,255}/g, replace: "[redacted:api_key]" },
  { id: "aws_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[redacted:api_key]" },
  { id: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,255}/g, replace: "[redacted:token]" },
  { id: "google_key", re: /\bAIza[0-9A-Za-z_-]{35}/g, replace: "[redacted:api_key]" },
]);

/** Object keys whose values are always redacted whole (a component match, not a substring). */
const SECRET_KEY_RE =
  /(?:^|[_-])(?:authorization|cookie|set[_-]?cookie|password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|espn[_-]?s2|swid|email)(?:$|[_-])/i;

/** Redacts one string: registered values, then every pattern. */
export function redactString(s: string, secrets: SecretRegistry): string {
  let out = secrets.apply(s);
  for (const rule of REDACTION_PATTERNS)
    out =
      typeof rule.replace === "string"
        ? out.replace(rule.re, rule.replace)
        : out.replace(rule.re, rule.replace);
  return out;
}

/** Truncates to `max` UTF-16 units without splitting a surrogate pair, noting the dropped length. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…[truncated ${String(s.length - cut)} chars]`;
}

/**
 * Redacts then truncates to `max`, pre-cutting first so the work is linear in `max`: a value
 * ending inside the kept prefix starts at most `longest + PRECUT_SLACK` earlier than the cut.
 */
export function redactAndTruncate(s: string, secrets: SecretRegistry, max: number): string {
  const keep = max + secrets.longest + PRECUT_SLACK;
  if (s.length <= keep) return truncate(redactString(s, secrets), max);
  const red = redactString(s.slice(0, keep), secrets);
  let cut = Math.min(red.length, max);
  const code = red.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${red.slice(0, cut)}…[truncated ${String(s.length - cut)} chars]`;
}

/** Strips HTML from an upstream body before it is logged (plan 05 §2: truncated after stripping). */
export function stripHtmlForLog(body: string): string {
  return body
    .slice(0, HARD_MAX_STRING)
    .replace(/<(script|style)\b[^>]{0,1024}>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^<>]{0,4096}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deep-redacts any value into a JSON-safe structure (bounded depth, items, keys; cycles inert). */
export function redactValue(
  v: unknown,
  secrets: SecretRegistry,
  maxString: number = DEFAULT_MAX_STRING,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof v === "string") {
    if (v.length > HARD_MAX_STRING) return `[dropped ${String(v.length)} chars]`;
    return redactAndTruncate(v, secrets, maxString);
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return v === undefined ? null : `[${typeof v}]`;
  if (seen.has(v)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth limit]";
  seen.add(v);
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "[invalid date]";
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)
    return `[binary ${String(v.byteLength)} bytes]`;
  if (v instanceof Error) {
    const out: Record<string, unknown> = {
      name: redactValue(v.name, secrets, maxString, depth + 1, seen),
      message: redactValue(v.message, secrets, maxString, depth + 1, seen),
    };
    const code = (v as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number")
      out.code = redactValue(code, secrets, maxString, depth + 1, seen);
    return out;
  }
  if (Array.isArray(v)) {
    const items = v
      .slice(0, MAX_ARRAY_ITEMS)
      .map((x) => redactValue(x, secrets, maxString, depth + 1, seen));
    if (v.length > MAX_ARRAY_ITEMS) items.push(`[+${String(v.length - MAX_ARRAY_ITEMS)} more]`);
    return items;
  }
  if (v instanceof Map || v instanceof Set)
    return `[${v instanceof Map ? "Map" : "Set"} of ${String(v.size)}]`;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v);
  for (const k of keys.slice(0, MAX_OBJECT_KEYS)) {
    const safeKey = redactAndTruncate(k, secrets, MAX_KEY_CHARS);
    const child = (v as Record<string, unknown>)[k];
    out[safeKey] =
      SECRET_KEY_RE.test(k) && child !== null && child !== undefined
        ? "[redacted]"
        : redactValue(child, secrets, maxString, depth + 1, seen);
  }
  if (keys.length > MAX_OBJECT_KEYS) out["[more_keys]"] = keys.length - MAX_OBJECT_KEYS;
  return out;
}

let stderrGuarded = false;

/** The default sink: process.stderr, guarded so a closed pipe (EPIPE) cannot crash. */
function stderrSink(line: string): void {
  if (!stderrGuarded) {
    stderrGuarded = true;
    process.stderr.on("error", () => undefined);
  }
  process.stderr.write(`${line}\n`);
}

/** Creates a logger: `{"ts","level","event",...fields}` JSON, one per line, on stderr only. */
export function createLogger(opts: LoggerOptions): Logger {
  return makeLogger(opts, new SecretRegistry(), {});
}

function makeLogger(opts: LoggerOptions, secrets: SecretRegistry, bound: LogFields): Logger {
  const sink = opts.sink ?? stderrSink;
  const now = opts.now ?? (() => new Date().toISOString());
  const maxString = opts.maxStringChars ?? DEFAULT_MAX_STRING;
  const threshold = LEVEL_RANK[opts.level];

  const emit = (level: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (LEVEL_RANK[level] > threshold) return;
    try {
      const line: Record<string, unknown> = {
        ts: now(),
        level,
        event: EVENT_RE.test(event) ? event : "invalid_event",
      };
      for (const src of [bound, fields ?? {}]) {
        const red = redactValue(src, secrets, maxString) as Record<string, unknown>;
        for (const [k, val] of Object.entries(red)) if (!RESERVED.has(k)) line[k] = val;
      }
      sink(JSON.stringify(line));
    } catch {
      // logging must never break a tool call (a throwing sink, a hostile getter): drop the line
    }
  };

  return {
    level: opts.level,
    error: (e, f) => {
      emit("error", e, f);
    },
    warn: (e, f) => {
      emit("warn", e, f);
    },
    info: (e, f) => {
      emit("info", e, f);
    },
    debug: (e, f) => {
      emit("debug", e, f);
    },
    child: (more) => makeLogger(opts, secrets, { ...bound, ...more }),
    registerSecret: (kind, value) => {
      secrets.add(kind, value);
    },
    registerIdentifier: (kind, value) => {
      secrets.addIdentifier(kind, value);
    },
  };
}
