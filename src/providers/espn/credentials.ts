// credentials.ts — the provider's side of the credential rules (plan 02 §2.1; plan 01 §10): the
// provider never reads a store — it asks the injected CredentialAuthority for the Cookie header and
// reports discriminating observations. Season routes are always keyless; a league known public is
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

/** The provider's cookie gate (one per provider instance). */
export class CookieGate {
  private publicity: boolean | null = null;
  private lastAcceptedObservedMs = Number.NEGATIVE_INFINITY;
  private swid: string | null = null;
  private readonly auth: CredentialAuthority | null;
  private readonly clock: Clock;
  private readonly observer: CredentialObserver;

  constructor(auth: CredentialAuthority | null, clock: Clock, observer: CredentialObserver) {
    this.auth = auth;
    this.clock = clock;
    this.observer = observer;
  }

  /** `settings.isPublic` as last learned: true, false, or null (unknown). */
  isPublic(): boolean | null {
    return this.publicity;
  }

  /** Records what a response proved (a keyless 401 proves private). */
  learnPublic(v: boolean): void {
    this.publicity = v;
  }

  /** Learns `settings.isPublic` from any league body that carries it. */
  learnFromBody(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    const s = (body as { settings?: unknown }).settings;
    if (typeof s !== "object" || s === null) return;
    const p = (s as { isPublic?: unknown }).isPublic;
    if (typeof p === "boolean") this.publicity = p;
  }

  /** Whether any credential is configured (no store read — the state label only). */
  configured(): boolean {
    return this.auth !== null && this.auth.state() !== "not_configured";
  }

  private requires(): never {
    throw new EspnCredentialError("ESPN_REQUIRES_COOKIES", "no_credential");
  }

  /**
   * The Cookie header for one request, or null for a keyless request; throws the short-circuit
   * (ESPN_AUTH_REJECTED) or ESPN_REQUIRES_COOKIES without any request being made.
   */
  async forRequest(use: CookieUse, route: EspnRoute): Promise<string | null> {
    if (use === "never" || route === "season" || route === "players") return null;
    if (this.auth === null || this.auth.state() === "not_configured") {
      if (use === "required" && this.publicity !== true) this.requires();
      return null;
    }
    if (use === "auto" && this.publicity === true) return null;
    const r = await this.auth.getCookieHeader();
    if (r.ok) {
      this.swid = swidFromHeader(r.header);
      return r.header;
    }
    if (r.reason === "not_configured") {
      if (use === "required" && this.publicity !== true) this.requires();
      return null;
    }
    if (r.reason === "rejected") {
      if (this.publicity === true && use === "auto") return null;
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
      if (this.publicity !== false) return;
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

  /** The stored SWID (read lazily through the header), or null when none is available. */
  async memberId(): Promise<string | null> {
    if (this.swid !== null) return this.swid;
    if (!this.configured() || this.auth === null) return null;
    const r = await this.auth.getCookieHeader();
    if (r.ok) this.swid = swidFromHeader(r.header);
    return this.swid;
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
