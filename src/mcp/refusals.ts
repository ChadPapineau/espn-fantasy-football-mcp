// refusals.ts — a session refusal is never read as data unavailable (changelog §R10, R10-11, R10-12
// and R10-18's house form; the round-4c product account's E13 defect). Every ESPN read a tool call
// makes goes through its services' platform; this module wraps that platform once per services
// bundle so a read the session refuses — ESPN_AUTH_REJECTED (ESPN's 401 or the gate's
// short-circuit) or ESPN_REQUIRES_COOKIES — is recorded against the CALL whose budget it carried.
// A tool that absorbs such a refusal (an optional read, a comparator, a fallback) and answers
// anyway gets, from runTool, `partial: true` and one fixed line naming what was not read, why, and
// `eff setup` — unless the tool said that refusal in its own fixed line (E11's feed and league
// reads, espn_list_transactions' pending claims), which it marks with `said`. A refusal the tool
// propagates is the call's coded error, as before. Reads made with a budget of their own (the
// zero-request cache reads of espn_get_status and espn-ff://league) are not the call's and are not
// recorded: their tools report the session state itself. Fixed text only — never upstream text.
import type { FantasyPlatform, UpstreamBudget } from "../providers/platform.js";
import type { McpServices } from "./services.js";

/** Why the session could not make a read: nothing stored, or the stored session was rejected. */
export type SessionRefusal = "no_session" | "rejected";

/** The session refusal an error carries (ESPN_REQUIRES_COOKIES / ESPN_AUTH_REJECTED), else null. */
export function refusalOf(e: unknown): SessionRefusal | null {
  const code = (e as { effCode?: unknown } | null)?.effCode;
  if (code === "ESPN_REQUIRES_COOKIES") return "no_session";
  if (code === "ESPN_AUTH_REJECTED") return "rejected";
  return null;
}

/** What a platform read reads, as the session line names it (a fixed vocabulary). */
export const SESSION_READ_OF = Object.freeze({
  getLeague: "league settings",
  getScoringSettings: "league settings",
  getRosterSlots: "league settings",
  getLeagueRules: "league settings",
  resolveOwnTeam: "league settings",
  getRoster: "rosters",
  getRosters: "rosters",
  listPlayers: "player pool",
  getPlayers: "player cards",
  getPlayerOutlooks: "player outlooks",
  getPlayerStats: "player stats",
  getMatchups: "matchups",
  getLiveMatchups: "live scores",
  getBoxScores: "box scores",
  getNativeProjections: "projections",
  getStandings: "standings",
  listTransactions: "transaction feed",
  listPendingTransactions: "pending claims",
  getPositionalRatings: "positional ratings",
} as const satisfies Partial<Record<keyof FantasyPlatform, string>>);

/** One read the session line can name. */
export type SessionRead = (typeof SESSION_READ_OF)[keyof typeof SESSION_READ_OF] | "league data";

/** The line's order: the reads in SESSION_READ_OF's order, the catch-all last. */
const READ_ORDER: readonly SessionRead[] = [
  ...new Set(Object.values(SESSION_READ_OF)),
  "league data",
];

/** The reads named by a singular noun (the verb and pronoun agree with them). */
const SINGULAR: ReadonlySet<string> = new Set(["player pool", "transaction feed"]);

/** A method the session line never names: the explicit credential probe IS the session check. */
const NOT_A_READ: ReadonlySet<string> = new Set(["probeCredential"]);

/** `a`, `a and b`, `a, b and c` — the line's list. */
export function andList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1] ?? ""}`;
}

/** Whether a list of nouns takes a plural verb (more than one, or one plural noun). */
export function pluralList(xs: readonly string[], singular: ReadonlySet<string>): boolean {
  return xs.length !== 1 || !singular.has(xs[0] ?? "");
}

/**
 * The fixed line for reads the session refused that the tool did not say itself: what was not read,
 * why, and the one command. `reads` are labels (a season prefix for another season's read: "2025
 * standings"); pending claims are the user's own and need the session on any league, so they are
 * never said with "a league not known to be public".
 */
export function sessionReadsWarning(refusal: SessionRefusal, reads: readonly string[]): string {
  const league = reads.filter((r) => !r.endsWith("pending claims"));
  const own = reads.length - league.length;
  const parts: string[] = [];
  if (league.length > 0) {
    const plural = pluralList(league, singularOf(league));
    const what = `ESPN's ${andList(league)}`;
    const verb = plural ? "need" : "needs";
    const not = plural ? "they were not read" : "it was not read";
    parts.push(
      refusal === "rejected"
        ? `the stored ESPN session was rejected, and ${what} ${verb} one on a league not known to be public: ${not}`
        : `${what} ${verb} an ESPN session on a league not known to be public, and none is stored: ${not}`,
    );
  }
  if (own > 0)
    parts.push(
      refusal === "rejected"
        ? "your pending claims are read only with your ESPN session, and the stored session was rejected: they were not read"
        : "your pending claims are read only with your ESPN session, and none is stored: they were not read",
    );
  const fix =
    refusal === "rejected"
      ? "run `eff setup` in a terminal to replace it"
      : "run `eff setup` in a terminal to add one";
  return `partial: ${parts.join("; ")}; ${fix}`;
}

/** The singular nouns of a list, read through their season prefix ("2025 player pool"). */
function singularOf(reads: readonly string[]): ReadonlySet<string> {
  return new Set(reads.filter((r) => SINGULAR.has(r.replace(/^\d{4} /, ""))));
}

/** One call's refusals: what its reads met, and which of them the tool said itself. */
export interface SessionRefusals {
  /** Records a refusal a read of this call met (the platform wrapper). */
  record(read: string, refusal: SessionRefusal): void;
  /** The tool's own fixed line says these reads' refusals (E11, espn_list_transactions). */
  said(...reads: readonly string[]): void;
  /** The refusals not said, the strongest reason first (a rejection outranks nothing stored). */
  unsaid(): { readonly refusal: SessionRefusal; readonly reads: readonly string[] } | null;
  /** Whether any read of this call met a refusal (said or not). */
  any(): boolean;
}

/** A new, empty refusal record for one call. */
export function createSessionRefusals(): SessionRefusals {
  const seen = new Map<string, SessionRefusal>();
  const told = new Set<string>();
  const rank = (s: string): number => {
    const base = READ_ORDER.indexOf(s.replace(/^\d{4} /, "") as SessionRead);
    // this season's reads first, then another season's, each in READ_ORDER
    return (s === s.replace(/^\d{4} /, "") ? 0 : 100) + (base < 0 ? READ_ORDER.length : base);
  };
  return {
    record(read, refusal) {
      if (seen.get(read) !== "rejected") seen.set(read, refusal);
    },
    said(...reads) {
      for (const r of reads) told.add(r);
    },
    unsaid() {
      const left = [...seen.entries()].filter(([r]) => !told.has(r));
      if (left.length === 0) return null;
      const refusal: SessionRefusal = left.some(([, x]) => x === "rejected")
        ? "rejected"
        : "no_session";
      const reads = left.map(([r]) => r).sort((a, b) => rank(a) - rank(b));
      return { refusal, reads };
    },
    any: () => seen.size > 0,
  };
}

/** Each call's budget → its refusal record (toolContext registers it). */
const BY_BUDGET = new WeakMap<UpstreamBudget, SessionRefusals>();

/** Ties a call's refusal record to the budget its reads carry. */
export function registerRefusals(budget: UpstreamBudget, refusals: SessionRefusals): void {
  BY_BUDGET.set(budget, refusals);
}

/** The budget a read's arguments carry (its ReadOptions, always the last object with `budget`). */
function budgetIn(args: readonly unknown[]): UpstreamBudget | null {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (typeof a === "object" && a !== null && "budget" in a) {
      const b = (a as { budget?: unknown }).budget;
      return typeof b === "object" && b !== null ? (b as UpstreamBudget) : null;
    }
  }
  return null;
}

/** The league season a read's arguments name (a LeagueRef or a TeamRef), else null. */
function seasonIn(args: readonly unknown[]): number | null {
  for (const a of args) {
    if (typeof a !== "object" || a === null) continue;
    const s = (a as { season?: unknown }).season;
    if (typeof s === "number" && Number.isInteger(s)) return s;
  }
  return null;
}

/** The marker a wrapped services bundle answers with its unwrapped self. */
const RAW = Symbol("refusals.raw");

/** The unwrapped services bundle (its own self when it was never wrapped). */
export function rawServices(s: McpServices): McpServices {
  return ((s as unknown as Record<symbol, unknown>)[RAW] as McpServices | undefined) ?? s;
}

/**
 * The platform as built (its own self when it was never wrapped): a per-provider memo keys on it,
 * so every services bundle over one provider shares it (league.ts absentSeasons).
 */
export function rawPlatform(p: FantasyPlatform): FantasyPlatform {
  return ((p as unknown as Record<symbol, unknown>)[RAW] as FantasyPlatform | undefined) ?? p;
}

const WRAPPED = new WeakMap<McpServices, McpServices>();

/** A non-configurable, read-only own property: a Proxy must answer it unchanged. */
function fixed(o: object, prop: PropertyKey): boolean {
  const d = Object.getOwnPropertyDescriptor(o, prop);
  return d?.configurable === false && d.writable === false;
}

/**
 * The services bundle whose platform records session refusals into the calling read's budget — one
 * per bundle, so its identity (and its platform's) is stable across calls. Everything else is the
 * bundle's own (getters read on it).
 */
export function recordingServices(s: McpServices): McpServices {
  if (rawServices(s) !== s) return s;
  const kept = WRAPPED.get(s);
  if (kept !== undefined) return kept;
  // built at the first read of it (a narrow test bundle may carry no platform at all)
  let platform: FantasyPlatform | null = null;
  let wrappedOf: unknown = null;
  const out = new Proxy(s, {
    get(target, prop) {
      if (prop === RAW) return target;
      const v: unknown = Reflect.get(target, prop, target);
      if (prop !== "platform" || typeof v !== "object" || v === null || fixed(target, prop))
        return v;
      if (platform === null || wrappedOf !== v) {
        platform = recordingPlatform(v as FantasyPlatform, () => target.league.season);
        wrappedOf = v;
      }
      return platform;
    },
  });
  WRAPPED.set(s, out);
  return out;
}

/** The platform with every read's session refusal recorded against the budget it carried. */
export function recordingPlatform(p: FantasyPlatform, season: () => number): FantasyPlatform {
  const fns = new Map<PropertyKey, unknown>();
  const note = (prop: string, args: readonly unknown[], e: unknown): void => {
    const refusal = refusalOf(e);
    if (refusal === null) return;
    const budget = budgetIn(args);
    const rec = budget === null ? undefined : BY_BUDGET.get(budget);
    if (rec === undefined) return;
    const base: string = (SESSION_READ_OF as Record<string, string>)[prop] ?? "league data";
    const s = seasonIn(args);
    rec.record(s !== null && s !== season() ? `${String(s)} ${base}` : base, refusal);
  };
  return new Proxy(p, {
    get(target, prop) {
      if (prop === RAW) return target;
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== "function" || typeof prop !== "string" || NOT_A_READ.has(prop)) return v;
      // a frozen own property must be answered as it is (the Proxy invariant): not recorded
      if (fixed(target, prop)) return v;
      const kept = fns.get(prop);
      if (kept !== undefined) return kept;
      const fn = v as (...a: unknown[]) => unknown;
      const wrapped = (...args: unknown[]): unknown => {
        let r: unknown;
        try {
          r = fn.apply(target, args);
        } catch (e) {
          note(prop, args, e);
          throw e;
        }
        if (r instanceof Promise)
          return r.catch((e: unknown) => {
            note(prop, args, e);
            throw e;
          });
        return r;
      };
      fns.set(prop, wrapped);
      return wrapped;
    },
  });
}

/**
 * A tool's output with the refusals it absorbed and did not say: one fixed line and `partial: true`
 * (plan 01 §4.2's partial: the answer went without a read). Unchanged when none.
 */
export function sayRefusals<
  T extends { readonly warnings?: readonly string[]; readonly partial?: boolean },
>(out: T, refusals: SessionRefusals): T {
  const left = refusals.unsaid();
  if (left === null) return out;
  return {
    ...out,
    partial: true,
    warnings: [...(out.warnings ?? []), sessionReadsWarning(left.refusal, left.reads)],
  };
}
