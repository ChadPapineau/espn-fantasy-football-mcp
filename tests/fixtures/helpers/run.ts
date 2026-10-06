// run.ts — builds raw recording runs for the scrubber/recorder tests by driving the REAL recorder
// (scripts/record-fixture.ts) against the synthetic fake ESPN (synthetic.ts) with a fake clock, so
// nothing touches the network and every test is fast and hermetic.
import { parseArgs, record, type RecordDeps } from "../../../scripts/record-fixture.js";
import { denylistLines, parseDenylist, scanText } from "../../../scripts/dev/scan-secrets.mjs";
import { fakeEspn, syntheticLeague, type SyntheticLeague } from "./synthetic.js";

export const SEASON = 2026;
export const NOW = new Date("2026-10-05T12:00:00Z");

/** The repo scanner's rules and deny-list semantics, in process (fast; same output format). */
export function inProcessScan(denyTerms: string[] = []) {
  const deny = parseDenylist(denyTerms.join("\n"));
  return (text: string, label: string) => {
    const findings = scanText(label, text, deny);
    return { clean: findings.length === 0, findings };
  };
}

export { denylistLines };

export interface RawRun {
  rawDir: string;
  leagues: SyntheticLeague[];
  fake: ReturnType<typeof fakeEspn>;
  waits: number[];
}

/** Records `count` synthetic leagues into `rawDir` (no scrub). */
export async function makeRawRun(
  rawDir: string,
  opts: {
    count?: number;
    seeds?: number[];
    finalWeeks?: number[];
    extraArgs?: string[];
    deps?: RecordDeps;
  } = {},
): Promise<RawRun> {
  const seeds = opts.seeds ?? Array.from({ length: opts.count ?? 2 }, (_, i) => 31 + i);
  const leagues = seeds.map((s, i) => syntheticLeague(s, 4 + (i % 2) * 2));
  const fake = fakeEspn(new Map(leagues.map((l) => [l.leagueId, l])), SEASON, opts.finalWeeks);
  const env = { EFF_PROBE_LEAGUE_IDS: leagues.map((l) => l.leagueId).join(",") };
  const o = parseArgs(
    [
      "--public",
      "--season",
      String(SEASON),
      "--raw-dir",
      rawDir,
      "--no-scrub",
      ...(opts.extraArgs ?? []),
    ],
    env,
    NOW,
  );
  let t = 0;
  const waits: number[] = [];
  await record(o, {
    fetch: fake.fetch,
    sleep: (ms) => {
      waits.push(ms);
      t += ms;
      return Promise.resolve();
    },
    now: () => new Date(NOW.getTime() + t),
    clock: () => t,
    log: () => undefined,
    ...opts.deps,
  });
  return { rawDir, leagues, fake, waits };
}
