// auth-gate.ts — the provider's side of the credential rules (plan 02 §2.1; plan 01 §10): the
// provider never reads a store — it asks the injected CredentialAuthority for the Cookie header and
// reports discriminating observations; the startup state label never stands in for that ask (a
// value stored by `eff setup` while the server runs is found on the next cookie-bearing call — plan
// 02 §2.2, plan 03 §1.1 step 4). Season routes are always keyless; a league known public is
// read keyless by the server (cookies cannot be tested there, and a 200 is not an acceptance) — but
// the credentialed launchd jobs read it with the stored cookie, as plan 06 §1.4 designs and budgets
// them (`keylessOnPublic`); `rejected` short-circuits with ESPN_AUTH_REJECTED and ZERO requests
// (unless the league is public and the read is one ESPN serves anyone there); a view that needs
// cookies with none stored is ESPN_REQUIRES_COOKIES, also with zero requests — an `auto` read with
// nothing stored included once the league is known private (changelog §R10, R10-23: only while the
// publicity is unknown does it go out keyless, the one read whose 401 teaches it). Changelog §R10, R10-10
// split the old `required` use in two: the league's transaction feed (`feed`, mTransactions2) is
// served to anyone on a public league, so it is read keyless there whenever no accepted cookie is
// at hand (nothing stored, or a rejected session); pending claims (`own`, mPendingTransactions) are
// the caller's own and are never read keyless, public or not. One publicity rule decides every
// keyless league read, in both credential branches: `known()` — what this process saw, else the
// value another process kept (see forRequest). Fixture mode holds no authority: there a variant's
// scripted label governs the caller's own pending claims (R10-21) and, on the one variant whose
// recorded league is private, every league read (R10-27) — never outside fixture mode. The SWID is
// read from the header only to compute `my_team` — it is never emitted.
import type {
  CookieHeaderResult,
  CredentialAuthority,
  CredentialObserver,
  CredentialState,
} from "../../auth/types.js";
import type { Clock } from "../../domain/clock.js";
import { PUBLICITY_MAX_AGE_MS } from "./cache.js";
import { EspnUpstreamError } from "./errors.js";
import type { EspnRoute } from "./path.js";
import type { CredentialProbeAccess, EspnView } from "./types.js";

/**
 * How a read uses cookies (changelog §R10, R10-10 split the old `required` in two):
 * - `never` — keyless routes and the anonymous reads that learn a league's publicity;
 * - `auto` — the cookie when one is at hand; a league known public keyless for the server
 *   (CookieGateOptions.keylessOnPublic) and, under a rejected session, for every process; with
 *   nothing stored, keyless while the publicity is unknown (the learning read) and refused once it
 *   is known private (changelog §R10, R10-23);
 * - `feed` — league-wide data ESPN serves anyone on a public league (mTransactions2): the cookie
 *   when one not rejected is at hand, else keyless on a league known public, else the refusal
 *   (ESPN_REQUIRES_COOKIES with nothing stored, ESPN_AUTH_REJECTED under a rejected session);
 * - `own` — the caller's own data (mPendingTransactions): only with a cookie, never keyless, public
 *   or not.
 */
export type CookieUse = "never" | "auto" | "feed" | "own";

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
  /**
   * When the value `load` answers was learned (epoch ms), or null when not known — a kept `false`
   * is trusted PUBLICITY_MAX_AGE_MS from it, then read again (changelog §R10, R10-23). A store
   * without it is trusted from the moment this process read it.
   */
  learnedAt?(): number | null;
  save(isPublic: boolean): void;
}

/** How the gate treats a league known public (one per provider instance). */
export interface CookieGateOptions {
  /**
   * Whether an `auto` read of a league known public goes keyless although a cookie is stored. True
   * for the server and every interactive command: the cookie cannot be tested there and a 200 is no
   * acceptance, so it is not sent. False for the credentialed launchd jobs (origin `job`): plan 06
   * §1.4 designs them cookie-bearing on the user's league whatever its publicity (§5: "designed as
   * cookie-bearing on the user's league regardless") and budgets them under the fleet's cookie cap
   * (≤ 40/day); the keyless cap (≤ 30/day) is the drift probe's and the season views' alone
   * (changelog V7). Sent keyless, their league reads spent the keyless cap on a public league and a
   * game day's late jobs were refused (Stage C finding jobs-public-league-keyless-cap). A rejected
   * cookie still reads a public league anonymously either way (plan 02 §2.1 "Short-circuit").
   */
  readonly keylessOnPublic?: boolean;
  /**
   * FIXTURE MODE ONLY (changelog §R10, R10-21, amending R9-3): the scripted credential state of a
   * derived variant (fixture-credential.ts, the same `harness.credential_state` espn_get_status
   * reports), a value-free label read for `own` reads, and only while no authority exists (fixture
   * mode builds the provider with none). `not_configured` → ESPN_REQUIRES_COOKIES; `rejected` → the
   * ESPN_AUTH_REJECTED short-circuit; `stored`/`validated` → the read goes out with no Cookie header
   * (none exists) and the fixture serves the variant's recording, as a session read would be. The
   * provider passes it only in fixture mode (index.ts createEspnProvider, and EspnProvider only
   * without an authority). On a public variant every `auto` and `feed` read ignores it; on the
   * private one (`fixturePrivateLeague`) it governs them too. Absent: `not_configured`.
   */
  readonly fixtureLabel?: () => CredentialState;
  /**
   * FIXTURE MODE ONLY (changelog §R10, R10-27): the variant's recorded league is private
   * (`settings.isPublic: false`, read from its recorded body before any request — fixture-league.ts
   * derivedLeaguePublicity). Then the scripted label (`fixtureLabel`) also governs `auto` and `feed`
   * reads, as it governs `own`: `stored`/`validated` serve the recording, `not_configured` refuses
   * with ESPN_REQUIRES_COOKIES, `rejected` with the ESPN_AUTH_REJECTED short-circuit — each with
   * zero requests and none of the call's budget (the pipeline asks the gate first: mayRefuse). A
   * fresh cache entry is still served first, as the real pipeline serves it before the gate. Read
   * only while no authority exists, like the label; every public variant is unchanged.
   */
  readonly fixturePrivateLeague?: boolean;
  /**
   * FIXTURE MODE ONLY (changelog §R10, R10-28): asked when the scripted label would serve a read
   * (`stored`/`validated`) that is about to go out (CookieGate.fixtureSend) — a read the cache did
   * not serve (a fresh entry is served first, as in the real pipeline) and its budget paid for,
   * never a cache-only check or the pending-claims pre-check. True once,
   * for a variant scripting `rejects: "first_uncached_read"`: the scripted session has just been rejected (the label
   * moved to `rejected`, recorded as a 401 is — fixture-credential.ts), and that read answers
   * ESPN_AUTH_REJECTED as ESPN's 401 would, with nothing sent; every later read meets the rejected
   * label (the short-circuit, R10-27). Read only while no authority exists, like the label.
   */
  readonly fixtureRejectsRead?: () => boolean;
}

/** The provider's cookie gate (one per provider instance). */
export class CookieGate {
  /** What THIS process saw ESPN answer (a league body, a keyless 401); null until it has. */
  private publicity: boolean | null = null;
  /** When this process last learned `publicity` (epoch ms): a `false` is trusted 7 days from it. */
  private publicityAtMs = Number.NEGATIVE_INFINITY;
  /** The value another process kept (PublicityStore), read lazily; null when none. */
  private kept: boolean | null = null;
  /** When the kept value was learned (the store's own stamp, else when this process read it). */
  private keptAtMs = Number.NEGATIVE_INFINITY;
  /** The persisted publicity was consulted (once per process, and again when a `false` expires). */
  private loaded = false;
  /** This process has written what it learned (once, and again on every change). */
  private saved = false;
  private lastAcceptedObservedMs = Number.NEGATIVE_INFINITY;
  private swid: string | null = null;
  private readonly auth: CredentialAuthority | null;
  private readonly clock: Clock;
  private readonly observer: CredentialObserver;
  private readonly store: PublicityStore | null;
  private readonly keylessOnPublic: boolean;
  private readonly fixtureLabel: (() => CredentialState) | null;
  private readonly fixturePrivate: boolean;
  private readonly fixtureRejectsRead: (() => boolean) | null;

  constructor(
    auth: CredentialAuthority | null,
    clock: Clock,
    observer: CredentialObserver,
    store: PublicityStore | null = null,
    opts: CookieGateOptions = {},
  ) {
    this.auth = auth;
    this.clock = clock;
    this.observer = observer;
    this.store = store;
    this.keylessOnPublic = opts.keylessOnPublic ?? true;
    // a label is a fixture-mode seam: with an authority present it is never read
    this.fixtureLabel = auth === null ? (opts.fixtureLabel ?? null) : null;
    this.fixturePrivate = auth === null && opts.fixturePrivateLeague === true;
    this.fixtureRejectsRead = auth === null ? (opts.fixtureRejectsRead ?? null) : null;
  }

  /**
   * What is known: learned in this process, else the persisted value (read once), else null. A
   * `false` — learned here or kept — is trusted PUBLICITY_MAX_AGE_MS (7 days) from when it was
   * learned (changelog §R10, R10-23): it is what refuses an `auto` read with nothing stored, with
   * zero requests, so once past its trust it is forgotten and the store read again, and with
   * nothing newer kept the next read re-learns it with one keyless request (a league that turned
   * public is then read keyless again, even in a process that lives for days). A `true` keeps its
   * rule: a league that has since gone private costs one keyless 401, which teaches `false`.
   */
  private known(): boolean | null {
    if (this.publicity !== null) {
      if (this.publicity || this.trusted(this.publicityAtMs)) return this.publicity;
      this.publicity = null;
      this.loaded = false;
    }
    if (this.loaded && this.kept === false && !this.trusted(this.keptAtMs)) this.loaded = false;
    if (!this.loaded) {
      this.loaded = true;
      this.kept = null;
      try {
        const v = this.store?.load() ?? null;
        if (typeof v === "boolean") {
          this.kept = v;
          const at = this.store?.learnedAt?.() ?? null;
          this.keptAtMs = at !== null && Number.isFinite(at) ? at : this.clock.nowMs();
        }
      } catch {
        // an unreadable store reads as unknown: the anonymous read learns it
      }
    }
    return this.kept;
  }

  /** Whether a publicity learned at `atMs` is still within its 7-day trust (R10-23). */
  private trusted(atMs: number): boolean {
    return this.clock.nowMs() - atMs <= PUBLICITY_MAX_AGE_MS;
  }

  /** Records a learned value, persisting it once per process and on every change. */
  private learn(v: boolean): void {
    const changed = this.publicity !== v;
    this.publicity = v;
    this.publicityAtMs = this.clock.nowMs();
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
    if (this.auth === null) {
      // fixture mode's scripted session: every league read of the private variant (R10-27), the
      // caller's own pending claims on any variant (R10-21)
      if (this.byScript(use)) return this.byLabel();
      return this.keyless(use, "ESPN_REQUIRES_COOKIES");
    }
    // a public league's `auto` read: keyless for the server, the stored cookie for the jobs
    // (CookieGateOptions.keylessOnPublic)
    if (use === "auto" && this.keylessOnPublic && this.known() === true) return null;
    const labelledNone = !this.configured();
    const r = await this.auth.getCookieHeader();
    if (r.ok) {
      this.swid = swidFromHeader(r.header);
      return r.header;
    }
    // nothing stored — or a store that cannot be read while nothing was ever recorded as stored (a
    // keychain that will not load on an install that never ran setup): no credential, as before
    // this call asked; an unreadable store behind a recorded value stays INTERNAL (doctor #6/#7)
    if (r.reason === "not_configured" || (labelledNone && r.reason === "unreadable"))
      return this.keyless(use, "ESPN_REQUIRES_COOKIES");
    // a rejected session: the authority answered from the stored metadata alone (the secret is not
    // loaded for a value already rejected — src/auth/state.ts), and the cookie is never sent again
    if (r.reason === "rejected") return this.keyless(use, "ESPN_AUTH_REJECTED");
    throw new EspnCredentialError("INTERNAL", `credential_${r.reason}`);
  }

  /**
   * The read with no accepted cookie at hand (nothing stored, or a rejected session — `why` names
   * which): keyless when ESPN serves it to anyone, else the zero-request refusal. `auto` and `feed`
   * reads of a league known public go keyless; `own` never does (changelog §R10, R10-10). With
   * nothing stored, an `auto` read of a league whose publicity is unknown goes keyless once — plan
   * 02 §2.1's learning read, whose 401 teaches `false` — and once `known()` is `false` (this
   * process saw the 401, or the kept value, each within its 7-day trust) it answers
   * ESPN_REQUIRES_COOKIES with zero requests and none of the call's budget, as `feed` and `own`
   * already do (changelog §R10, R10-23, R10-19): a read ESPN must refuse tells nothing new. Under a
   * rejected session it short-circuits unless the league is known public (plan 02 §2.1
   * "Short-circuit"); the anonymous settings read that learns an unknown publicity there is the
   * provider's (needsPublicity).
   *
   * The one publicity rule is `known()`: what this process saw ESPN answer, else the value another
   * process kept (PublicityStore). Plan 02 §2.1 has the server learn `settings.isPublic` once and
   * "remember it", and the kept value is that memory across processes (a launchd job and every
   * `eff` command is a new process). The in-process-only rule the `required` branch used guarded a
   * premise R10-10 withdrew (research 03 §B's "empty anonymously"): a stale kept value could have had
   * a cookie-only view read keyless and answer an empty list. The feed is now known to be served in
   * full anonymously, and the caller's own pending claims are never keyless, so no read depends on
   * it; a kept value the league has since outgrown costs one keyless 401, which learns `false` (the
   * request pipeline's learnPublic) and answers the refusal.
   */
  private keyless(
    use: Exclude<CookieUse, "never">,
    why: "ESPN_REQUIRES_COOKIES" | "ESPN_AUTH_REJECTED",
  ): null {
    const shared = use === "auto" || use === "feed";
    // `own` never reads the publicity: it is refused whatever it is
    const known = shared ? this.known() : null;
    if (known === true) return null;
    // the learning read (R10-23): nothing stored and the publicity unknown
    if (use === "auto" && why === "ESPN_REQUIRES_COOKIES" && known === null) return null;
    if (why === "ESPN_REQUIRES_COOKIES") this.requires();
    throw new EspnCredentialError("ESPN_AUTH_REJECTED", "short_circuit");
  }

  /**
   * A read in fixture mode under the scripted label (CookieGateOptions.fixtureLabel): an `own` read
   * on any variant (changelog §R10, R10-21), every league read on the private one (R10-27). The
   * refusal the label names, with zero requests, or null — the read goes out with no Cookie header
   * and the fixture serves the recording. No value exists to send. No label: `not_configured`.
   */
  private byLabel(): null {
    const state = this.fixtureLabel?.() ?? "not_configured";
    if (state === "rejected") throw new EspnCredentialError("ESPN_AUTH_REJECTED", "short_circuit");
    if (state === "stored" || state === "validated") return null;
    return this.requires();
  }

  /** Whether fixture mode's scripted label decides this read (R10-21 `own`; R10-27 every read). */
  private byScript(use: Exclude<CookieUse, "never">): boolean {
    return this.fixturePrivate || (use === "own" && this.fixtureLabel !== null);
  }

  /**
   * FIXTURE MODE ONLY (changelog §R10, R10-28): called by the read pipeline when a read is about to
   * go out — the cache did not serve it, the gate let it through and its budget paid for it — never
   * for a read only checked (the status snapshot's cache-only reads, whose zero budget sends
   * nothing; the pending-claims pre-check). Where the scripted label decides the read and still
   * serves it (`stored`/`validated`), a session scripted to be rejected (`rejects: "first_uncached_read"`) and not yet rejected is rejected here
   * (CookieGateOptions.fixtureRejectsRead moves the label to `rejected`, recorded as a 401 is) and
   * the read answers as ESPN's 401 to a cookie-bearing read does (errors.ts classifyAnswer:
   * ESPN_AUTH_REJECTED with `upstream_status` 401) — nothing is sent, no value or header exists. A
   * read whose verdict was taken while the label still served it, and that reaches here after the
   * label moved to `rejected` (a concurrent read the 401 overtook), is refused with the
   * short-circuit, as the real pipeline's after-acquire `rejectedNow` re-check refuses it (nothing
   * sent, so fetchFresh refunds its budget; the round-4c verifier's CR-2). A no-op outside fixture
   * mode (an authority present) and for every other read.
   */
  fixtureSend(use: CookieUse, route: EspnRoute, view: EspnView): void {
    if (this.auth !== null || this.fixtureRejectsRead === null) return;
    if (use === "never" || route === "season" || route === "players" || !this.byScript(use)) return;
    const state = this.fixtureLabel?.() ?? "not_configured";
    if (state === "rejected") throw new EspnCredentialError("ESPN_AUTH_REJECTED", "short_circuit");
    if ((state === "stored" || state === "validated") && this.fixtureRejectsRead())
      throw new EspnUpstreamError("auth_rejected", { upstream_status: 401, view });
  }

  /**
   * Whether the session the authority holds is rejected now: the label, or a rejection another
   * process recorded in the shared row for the value held (the authority's rejectedNow — one row
   * read, never a credential-store read; the round-4 verifier's V4-S1). A keyless read made because
   * of it that ESPN refuses (a league kept public that is private now) is the rejected session's to
   * report, as the anonymous settings read's refusal already is (provider.ts settingsRead).
   */
  rejectedNow(): boolean {
    if (this.auth === null) return false;
    return this.auth.rejectedNow?.() ?? this.auth.state() === "rejected";
  }

  /**
   * Whether forRequest may refuse this read with zero requests (ESPN_REQUIRES_COOKIES, the
   * ESPN_AUTH_REJECTED short-circuit), judged from labels alone (the row check of rejectedNow at
   * most; no credential-store read). False only when it cannot: a cookie-free read, a shared read
   * of a league known public, an `auto` read with nothing stored while the publicity is unknown
   * (the keyless learning read — R10-23), or a value held and not rejected. The read pipeline asks
   * forRequest itself, before any outage fallback, when this is
   * true, so a refusal is never answered from stale cache as an outage (changelog §R10, R10-18; the
   * round-4 verifier's V4-M1); forRequest decides, so a value `eff setup` stored since is still
   * found.
   */
  mayRefuse(use: CookieUse, route: EspnRoute): boolean {
    if (use === "never" || route === "season" || route === "players") return false;
    // the private fixture variant: the label decides every league read (R10-27)
    if (this.fixturePrivate) return true;
    const shared = use === "auto" || use === "feed";
    if (shared && this.known() === true) return false;
    // an `auto` read with nothing stored refuses once the league is known private (R10-23)
    const refusesNone = use !== "auto" || this.known() === false;
    if (this.auth === null) return refusesNone;
    if (this.rejectedNow()) return true;
    return !this.configured() && refusesNone;
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
