// probe.ts — the definitive credential check, shared by `eff setup`, `eff doctor --online` #16,
// `espn_check_auth` and the daily `credential check` job (plan 02 §2.1 "The definitive check", ADV
// OBJ-14, OBJ-26; changelog R-5, K1; R3 nit (c)): which request to send, what its status means,
// which ordinary 200s count as an acceptance, and the two rate limits (the tool ≤ 1/min; the job
// ≤ 1/day off-season, ≤ 2/day in season — plan 06 §1.4). Pure; the request itself is the caller's.
import {
  CHECK_AUTH_MIN_INTERVAL_MS,
  DAILY_PROBE_MAX,
  type CredentialObservation,
  type CredentialStateRow,
} from "./types.js";

/** The board probe's one view (plan 02 §2.1; src/providers/espn/types.ts COMMUNICATION_VIEWS). */
export const BOARD_PROBE_VIEW = "kona_league_communication";
/** The private-league probe view. */
export const SETTINGS_PROBE_VIEW = "mSettings";

/** Which request the definitive check sends. */
export interface ProbePlan {
  /** `settings` (private league), `board` (public), `rejected_view` (R3 nit (c) recovery). */
  readonly kind: "settings" | "board" | "rejected_view";
  readonly view: string;
  /** Whether a 200 tells accepted from rejected on this league (false → `accepted: null`). */
  readonly discriminates: boolean;
}

/**
 * The probe for a league (plan 02 §2.1): `mSettings` on a private league; on a public league the
 * board probe when its anonymous control answered 401; after a rejection on a public league whose
 * board does not discriminate, the view whose 401 caused the rejection (discriminating by
 * construction); otherwise the board probe, which can only answer `accepted: null`.
 */
export function planDefinitiveProbe(input: {
  readonly leaguePublic: boolean;
  readonly row: CredentialStateRow | null;
}): ProbePlan {
  if (!input.leaguePublic)
    return { kind: "settings", view: SETTINGS_PROBE_VIEW, discriminates: true };
  const row = input.row;
  if (row?.board_probe_discriminates === true)
    return { kind: "board", view: BOARD_PROBE_VIEW, discriminates: true };
  if (row?.state === "rejected" && row.rejected_view !== null)
    return { kind: "rejected_view", view: row.rejected_view, discriminates: true };
  return { kind: "board", view: BOARD_PROBE_VIEW, discriminates: false };
}

/** A probe's verdict: `accepted` (true/false/null) and the observation to record, if any. */
export interface ProbeVerdict {
  readonly accepted: boolean | null;
  readonly observation: CredentialObservation["kind"] | null;
}

/**
 * What one cookie-bearing probe response means. 401/403 is a rejection on any plan (plan 02 S3);
 * 200 — and 404 from a board probe (no board, cookies accepted) — is an acceptance only where the
 * plan discriminates; 404 from a league view means a wrong league id (`league_not_found`, which only
 * setup acts on); anything else (5xx, 429, a timeout) is not a credential event at all.
 */
export function probeVerdict(plan: ProbePlan, status: number): ProbeVerdict {
  if (status === 401 || status === 403) return { accepted: false, observation: "rejected" };
  if (status === 200 || (status === 404 && plan.kind === "board"))
    return plan.discriminates
      ? { accepted: true, observation: "accepted" }
      : { accepted: null, observation: null };
  if (status === 404) return { accepted: null, observation: "league_not_found" };
  return { accepted: null, observation: null };
}

/**
 * Whether the board probe discriminates on this league, from its ANONYMOUS control request (ADV
 * OBJ-26): only an anonymous 401 does; anything else (a board-less league's 404 to anyone) cannot
 * tell cookies apart. A failed control request decides nothing (null).
 */
export function boardControlDiscriminates(anonymousStatus: number | null): boolean | null {
  if (anonymousStatus === null) return null;
  return anonymousStatus === 401;
}

/**
 * Whether an ordinary cookie-bearing 200 records an acceptance (plan 02 §2.1; R-5, K1): on a
 * private league any 200; on a public league only the discriminating board probe, or — after a
 * rejection where the board does not discriminate — a 200 on the view whose 401 caused it.
 */
export function ordinaryAcceptanceCounts(input: {
  readonly leaguePublic: boolean;
  readonly view: string;
  readonly row: CredentialStateRow | null;
}): boolean {
  if (!input.leaguePublic) return true;
  const row = input.row;
  if (input.view === BOARD_PROBE_VIEW && row?.board_probe_discriminates === true) return true;
  return (
    row?.state === "rejected" &&
    row.board_probe_discriminates !== true &&
    row.rejected_view !== null &&
    row.rejected_view === input.view
  );
}

/** `espn_check_auth` rate limit: at most one probe per minute (plan 02 §2.1). */
export function checkAuthAllowed(
  lastProbeAtMs: number | null,
  nowMs: number,
): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number } {
  if (lastProbeAtMs === null) return { ok: true };
  const wait = lastProbeAtMs + CHECK_AUTH_MIN_INTERVAL_MS - nowMs;
  return wait <= 0 ? { ok: true } : { ok: false, retryAfterMs: Math.ceil(wait) };
}

/** The daily `credential check` cap (plan 06 §1.4): ≤ 1 probe/day off-season, ≤ 2/day in season. */
export function dailyProbeAllowed(probesToday: number, inSeason: boolean): boolean {
  const cap = inSeason ? DAILY_PROBE_MAX.in_season : DAILY_PROBE_MAX.off_season;
  return Number.isInteger(probesToday) && probesToday >= 0 && probesToday < cap;
}
