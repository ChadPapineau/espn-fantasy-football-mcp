// synthetic.ts — the hand-written ESPN error bodies a keyless recording cannot obtain: plan 05 §3
// fixture law (recorded = evidence; synthetic is allowed ONLY for error bodies — never a scoring
// field), research 03 §A.4 (the constant error shape) and §G.1 #1 (the private-league 401 type,
// community-sourced). Written under fixtures/espn/synthetic/ and listed as `synthetic: true`.
import type { Json } from "./canonical.js";

export interface SyntheticError {
  /** File stem under `synthetic/errors/`. */
  readonly name: string;
  readonly status: number;
  /** The views a request answered by this body would have asked for (documentation only). */
  readonly views: readonly string[];
  /** Where the shape comes from — never a recording. */
  readonly basis: string;
  readonly body: Json;
}

/** ESPN's constant error envelope (research 03 §A.4): `messages[]` + one typed `details[]` entry. */
export function espnErrorBody(type: string, message: string): Json {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(type)) throw new Error("an ESPN error type is UPPER_SNAKE");
  return {
    details: [{ message, metaData: null, resolution: null, shortMessage: message, type }],
    messages: [message],
  };
}

/**
 * The private-league 401 (stale or missing cookie — the classifier's `ESPN_AUTH_REJECTED` path,
 * plan 01 §4.3). Not reproducible keylessly: the public probe leagues answer 200, and no private
 * league id is ever used by this tooling. The type `AUTH_LEAGUE_NOT_VISIBLE` is [V-community]
 * (research 03 §A.4, §G.1 #1); the message prose is a placeholder, so a classifier must key on
 * the status and `details[].type`, never on the prose.
 */
export const SYNTHETIC_ERRORS: readonly SyntheticError[] = Object.freeze([
  {
    name: "401-league-not-visible",
    status: 401,
    views: ["mSettings"],
    basis:
      "research 03 §A.4 (the constant error envelope, recorded for 400/401/404) + §G.1 #1 (type AUTH_LEAGUE_NOT_VISIBLE, community-sourced); message prose is a placeholder",
    body: espnErrorBody("AUTH_LEAGUE_NOT_VISIBLE", "Synthetic: league not visible to this caller"),
  },
]);
