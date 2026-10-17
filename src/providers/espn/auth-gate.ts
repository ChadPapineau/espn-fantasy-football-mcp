// auth-gate.ts — the provider's side of the credential rules (plan 02 §2.1; plan 01 §10): the
// provider never reads a store — it asks the injected CredentialAuthority for the Cookie header and
// reports discriminating observations; the startup state label never stands in for that ask (a
// value stored by `eff setup` while the server runs is found on the next cookie-bearing call — plan
// 02 §2.2, plan 03 §1.1 step 4). Season routes are always keyless; a league known public is
// read keyless (cookies cannot be tested there, and a 200 is not an acceptance); `rejected`
// short-circuits with ESPN_AUTH_REJECTED and ZERO requests (unless the league is public); a view
// that needs cookies with none stored is ESPN_REQUIRES_COOKIES, also with zero requests. The SWID
// is read from the header only to compute `my_team` — it is never emitted.
import type {
  CookieHeaderResult,
  CredentialAuthority,
  CredentialObserver,
} from "../../auth/types.js";
import type { Clock } from "../../domain/clock.js";
import type { EspnRoute } from "./path.js";
import type { CredentialProbeAccess, EspnView } from "./types.js";

/** How a read uses cookies: never (keyless routes), auto (when available), required (private data). */
export type CookieUse = "never" | "auto" | "required";

/** A validated session acceptance is re-recorded at most this often (one row write per hour). */
export const ACCEPT_OBSERVE_INTERVAL_MS = 60 * 60 * 1000;

const SWID_IN_HEADER_RE =
  /(?:^|;\s*)SWID=(\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\})(?:;|$)/;

/** A credential refusal with a plan 01 §4.3 code and a fixed reason (never a value). */
export class EspnCredentialError extends Error {
  readonly effCode: "ESPN_AUTH_REJECTED" | "ESPN_REQUIRES_COOKIES" | "INTERNAL";
  readonly effDetails: { readonly reason: string };
  constructor(effCode: EspnCredentialError["effCode"], reason: string) {
    super(`espn credentials: ${reason}`);
    this.name = "EspnCredentialError";
    this.effCode = effCode;
    this.effDetails = Object.freeze({ reason });
  }
}

/** The SWID inside a Cookie header value, or null. */
export function swidFromHeader(header: string): string | null {
  return SWID_IN_HEADER_RE.exec(header)?.[1] ?? null;
}

/** Whether an authority also offers the probe's short-circuit-exempt access. */
export function hasProbeAccess(
  a: CredentialAuthority,
): a is CredentialAuthority & CredentialProbeAccess {
  return typeof (a as Partial<CredentialProbeAccess>).getCookieHeaderForProbe === "function";
}

/**
 * Where the league's publicity outlives a process (the provider's espn_cache row — Stage C finding
 * espn-missing-season-404-not-cached: every `eff check-auth` / `eff doctor --online` process
 * re-learned it with an anonymous mSettings read, and a private league's 401 was never kept).
 * `load` answers null when nothing usable is stored (absent, too old, unreadable).
 */
export interface PublicityStore {
  load(): boolean | null;
  save(isPublic: boolean): void;
}

/** The provider's cookie gate (one per provider instance). */
export class CookieGate {
  /** What THIS process saw ESPN answer (a league body, a keyless 401); null until it has. */
  private publicity: boolean | null = null;
  /** The value another process kept (PublicityStore), read once and lazily; null when none. */
  private kept: boolean | null = null;
  /** The persisted publicity was consulted (once per process, lazily). */
  private loaded = false;
  /** This process has written what it learned (once, and again on every change). */
  private saved = false;
  private lastAcceptedObservedMs = Number.NEGATIVE_INFINITY;
  private swid: string | null = null;
  private readonly auth: CredentialAuthority | null;
  private readonly clock: Clock;
  private readonly observer: CredentialObserver;
  private readonly store: PublicityStore | null;

  constructor(
    auth: CredentialAuthority | null,
    clock: Clock,
    observer: CredentialObserver,
    store: PublicityStore | null = null,
  ) {
    this.auth = auth;
    this.clock = clock;
    this.observer = observer;
    this.store = store;
  }

  /** What is known: learned in this process, else the persisted value (read once), else null. */
  private known(): boolean | null {
    if (this.publicity !== null) return this.publicity;
    if (!this.loaded) {
      this.loaded = true;
      try {
        const v = this.store?.load() ?? null;
        if (typeof v === "boolean") this.kept = v;
      } catch {
        // an unreadable store reads as unknown: the anonymous read learns it
      }
    }
    return this.kept;
  }

  /** Records a learned value, persisting it once per process and on every change. */
  private learn(v: boolean): void {
    const changed = this.publicity !== v;
    this.publicity = v;
    if (this.store === null || (!changed && this.saved)) return;
    this.saved = true;
    try {
      this.store.save(v);
    } catch {
      // best effort: an unwritten value is learned again by the next process
    }
  }

  /** `settings.isPublic` as last learned (or persisted): true, false, or null (unknown). */
  isPublic(): boolean | null {
    return this.known();
  }

  /** Records what a response proved (a keyless 401 proves private). */
  learnPublic(v: boolean): void {
    this.learn(v);
  }

  /** Learns `settings.isPublic` from any league body that carries it. */
  learnFromBody(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    const s = (body as { settings?: unknown }).settings;
    if (typeof s !== "object" || s === null) return;
    const p = (s as { isPublic?: unknown }).isPublic;
    if (typeof p === "boolean") this.learn(p);
  }

  /**
   * Whether a keyless read must first learn `settings.isPublic` (plan 02 §2.1: in `rejected`, "the
   * server tries anonymously once to learn settings.isPublic and remembers it"), so tools that work
   * anonymously on a public league keep working while the cookie is rejected.
   */
  needsPublicity(): boolean {
    return this.auth !== null && this.known() === null && this.auth.state() === "rejected";
  }

  /**
   * Whether the state label says a credential is configured (no store read). A label only: it is
   * set at startup from the store.sqlite row and corrected by the authority on its next store read,
   * so it is never the reason to skip asking the authority (see forRequest).
   */
  configured(): boolean {
    return this.auth !== null && this.auth.state() !== "not_configured";
  }

  private requires(): never {
    throw new EspnCredentialError("ESPN_REQUIRES_COOKIES", "no_credential");
  }

  /**
   * The Cookie header for one request, or null for a keyless request; throws the short-circuit
   * (ESPN_AUTH_REJECTED) or ESPN_REQUIRES_COOKIES without any request being made.
   *
   * A cookie-bearing request asks the authority even while the label reads `not_configured`: the
   * authority reads the stored `storedAt` on every ask, so a value `eff setup` stored in another
   * process (a fresh install, after `--reset`, or a wiped cache with the items still stored) is
   * picked up on this very call, no restart (plan 02 §2.2 "Multiple processes"; plan 03 §1.1 step 4
   * [A-3], §6 L6). Nothing stored → the authority says `not_configured` and the rules below apply.
   */
  async forRequest(use: CookieUse, route: EspnRoute): Promise<string | null> {
    if (use === "never" || route === "season" || route === "players") return null;
    // a `required` view is read keyless only on a league THIS process saw answer as public: the
    // kept value decides the probe and the `auto` reads, never that a cookie-only view (transactions,
    // pending claims — empty anonymously, research 03 §B) is read without one
    if (this.auth === null) {
      if (use === "required" && this.publicity !== true) this.requires();
      return null;
    }
    if (use === "auto" && this.known() === true) return null;
    const labelledNone = !this.configured();
    const r = await this.auth.getCookieHeader();
    if (r.ok) {
      this.swid = swidFromHeader(r.header);
      return r.header;
    }
    // nothing stored — or a store that cannot be read while nothing was ever recorded as stored (a
    // keychain that will not load on an install that never ran setup): no credential, as before
    // this call asked; an unreadable store behind a recorded value stays INTERNAL (doctor #6/#7)
    if (r.reason === "not_configured" || (labelledNone && r.reason === "unreadable")) {
      if (use === "required" && this.publicity !== true) this.requires();
      return null;
    }
    if (r.reason === "rejected") {
      if (this.known() === true && use === "auto") return null;
      throw new EspnCredentialError("ESPN_AUTH_REJECTED", "short_circuit");
    }
    throw new EspnCredentialError("INTERNAL", `credential_${r.reason}`);
  }

  /**
   * Reports an observation (plan 02 §2.1). A rejection always counts (any cookie-bearing 401/403);
   * an acceptance only when it discriminates — a cookie-bearing 200 on a league known PRIVATE — and
   * at most once an hour while already validated. A failed write never changes the result.
   */
  async observe(
    kind: "accepted" | "rejected",
    status: number | null,
    view: EspnView,
  ): Promise<void> {
    if (this.auth === null) return;
    if (kind === "accepted") {
      if (this.known() !== false) return;
      const now = this.clock.nowMs();
      if (
        this.auth.state() === "validated" &&
        now - this.lastAcceptedObservedMs < ACCEPT_OBSERVE_INTERVAL_MS
      )
        return;
      this.lastAcceptedObservedMs = now;
    }
    try {
      await this.auth.observe({
        kind,
        at: this.clock.nowIso(),
        by: this.observer,
        upstream_status: status,
        view,
      });
    } catch {
      // the state row is the auth module's; an unwritable row must not turn a result into a crash
    }
  }

  /**
   * The stored SWID (read lazily through the header), or null when none is available. Asks the
   * authority whatever the label says, as forRequest does: a value stored after startup is found.
   */
  async memberId(): Promise<string | null> {
    if (this.swid !== null) return this.swid;
    if (this.auth === null) return null;
    const r = await this.auth.getCookieHeader();
    if (r.ok) this.swid = swidFromHeader(r.header);
    return this.swid;
  }

  /**
   * Asks the authority once so its label and the `credential_state` row follow the store (a value
   * stored since startup is loaded and its row recreated when a wiped cache lost it — plan 03 §1.1
   * step 4 [A-3]); the answer itself is not used. Never throws.
   */
  async syncWithStore(): Promise<void> {
    if (this.auth === null) return;
    try {
      const r = await this.auth.getCookieHeader();
      if (r.ok) this.swid = swidFromHeader(r.header);
    } catch {
      // an unreadable store is the probe header's to report
    }
  }

  /** The probe's header (exempt from the short-circuit when the authority offers it). */
  async probeHeader(): Promise<CookieHeaderResult | null> {
    if (this.auth === null) return null;
    const r = hasProbeAccess(this.auth)
      ? await this.auth.getCookieHeaderForProbe()
      : await this.auth.getCookieHeader();
    if (r.ok) this.swid = swidFromHeader(r.header);
    return r;
  }

  /** Records a probe's observation with the probe's observer (`check_auth`, `doctor`, `daily_job`). */
  async observeProbe(
    kind: "accepted" | "rejected",
    by: CredentialObserver,
    status: number | null,
    view: EspnView,
  ): Promise<void> {
    if (this.auth === null) return;
    try {
      await this.auth.observe({ kind, at: this.clock.nowIso(), by, upstream_status: status, view });
    } catch {
      // see observe()
    }
  }
}
