// faults.ts — fault injection for the degradation paths (plan 01 §7, plan 05 §2): a platform whose
// named reads throw a coded error (the cross-layer `effCode` the provider uses) or the per-call
// budget signal, everything else delegating to the real provider.
import type { McpServices } from "../../../src/mcp/services.js";
import { UpstreamBudgetExhausted, type FantasyPlatform } from "../../../src/providers/platform.js";

/** An Error carrying a plan 01 §4.3 code the way the provider throws one. */
export function coded(code: string, details: Record<string, unknown> = {}): Error {
  const e = new Error(`injected ${code}`);
  Object.assign(e, { effCode: code, effDetails: details });
  return e;
}

/** What a faulty read does: throw an error, the budget signal, or decide per call. */
export type Fault =
  | Error
  | "budget"
  | ((real: (...a: unknown[]) => Promise<unknown>, ...args: unknown[]) => Promise<unknown>);

/** The services with some platform reads replaced by faults. */
export function faulty(
  services: McpServices,
  faults: Partial<Record<keyof FantasyPlatform, Fault>>,
  extras: Partial<Record<"getSeasonPlayers", Fault>> = {},
): McpServices {
  const real = services.platform;
  const platform = new Proxy(real, {
    get(target, prop, receiver) {
      const f = (faults as Record<string | symbol, Fault | undefined>)[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      type Fn = (...a: unknown[]) => Promise<unknown>;
      const realFn: Fn | null = typeof v === "function" ? (v as Fn).bind(target) : null;
      if (f === undefined) return realFn ?? v;
      if (typeof f === "function") {
        if (realFn === null) return v;
        return (...args: unknown[]) => f(realFn, ...args);
      }
      const reason: Error = f === "budget" ? new UpstreamBudgetExhausted("mTeam", "budget") : f;
      return () => Promise.reject(reason);
    },
  });
  const espn = {
    getSeasonPlayers:
      extras.getSeasonPlayers === undefined
        ? services.espn.getSeasonPlayers.bind(services.espn)
        : () =>
            Promise.reject(
              extras.getSeasonPlayers === "budget"
                ? new UpstreamBudgetExhausted("players_wl", "budget")
                : (extras.getSeasonPlayers as Error),
            ),
    scoringRefusal: services.espn.scoringRefusal.bind(services.espn),
  };
  return { ...services, platform, espn };
}
