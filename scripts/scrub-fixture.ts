#!/usr/bin/env -S npx tsx
// scrub-fixture.ts — offline, deterministic anonymisation of a raw recording run into the committed
// fixtures: research 03 §F.3 (the rules, determinism, the deny-list verification, the manifest after
// anonymisation), plan 05 §3.1 steps 2–4 (refuses to write unless the deny-list check passes; byte-
// identical reruns; provenance hashes). The rules live in scripts/espn-fixture/scrub.ts.
//
// Usage:  scripts/dev/with-node.sh npx tsx scripts/scrub-fixture.ts --raw-dir <dir outside the repo>
//                                     [--out <fixtures/espn>] [--prune <key,…>] [--dry-run]
// It reads only the raw directory (written by record-fixture.ts) and makes no network request.
// The deny-list is a gate, never a filter: any finding of the repo scanner — a local deny-list
// match included — refuses the whole run and nothing is written (plan 05 §3.1 step 2). A match is
// never withheld or relabelled: in a scrubbed capture it is public ESPN data that coincides with a
// private term, and the gap would show which public unit it is (pipeline.ts DENY_LIST_GATE; the
// removed --withhold-denylisted is refused with that reason).
// Exit: 0 written · 1 refused (the deny-list abort or another problem, each listed by path) · 2 usage.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  rawDirRefusal,
  rawDirRefusalMessage,
  type RawDirGuardOptions,
} from "./espn-fixture/guards.js";
import { REPO_ROOT } from "./espn-fixture/http.js";
import { WITHHOLD_REMOVED, scrubRun, type ScrubRunResult } from "./espn-fixture/pipeline.js";
import { ScrubAbort } from "./espn-fixture/scrub.js";

export interface ScrubCliOptions {
  rawDir: string;
  outRoot: string;
  prune: string[];
  dryRun: boolean;
}

/**
 * Parses the arguments; throws (exit 2) on a usage error or a raw directory the location rules
 * refuse (guards.ts rawDirRefusal). `guard` injects the home, the xattr reader and the `.git` probe.
 */
export function parseScrubArgs(
  argv: readonly string[],
  guard: RawDirGuardOptions = {},
): ScrubCliOptions {
  let rawDir: string | null = null;
  let outRoot = path.join(REPO_ROOT, "fixtures", "espn");
  let prune: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${String(a)} needs a value`);
      return v;
    };
    if (a === "--raw-dir") rawDir = path.resolve(val());
    else if (a === "--out") outRoot = path.resolve(val());
    else if (a === "--prune") {
      prune = val()
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (prune.some((k) => !/^[A-Za-z_]\w{0,63}$/.test(k)))
        throw new Error("--prune takes key names");
    } else if (a === "--dry-run") dryRun = true;
    else if (a === "--withhold-denylisted") throw new Error(WITHHOLD_REMOVED);
    else throw new Error(`unknown argument #${String(i + 1)}`);
  }
  if (rawDir === null) throw new Error("--raw-dir is required");
  const refused = rawDirRefusal(rawDir, REPO_ROOT, guard);
  if (refused !== null) throw new Error(rawDirRefusalMessage(refused));
  return { rawDir, outRoot, prune, dryRun };
}

export async function runScrub(
  o: ScrubCliOptions,
  log: (s: string) => void,
): Promise<ScrubRunResult> {
  return scrubRun({
    rawDir: o.rawDir,
    outRoot: o.outRoot,
    prune: o.prune,
    dryRun: o.dryRun,
    log,
  });
}

async function main(): Promise<void> {
  const log = (s: string) => process.stderr.write(`scrub: ${s}\n`);
  let o: ScrubCliOptions;
  try {
    o = parseScrubArgs(process.argv.slice(2));
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return;
  }
  try {
    const r = await runScrub(o, log);
    if (r.blanked.length) log(`blanked unknown free-text fields: ${r.blanked.join(", ")}`);
    if (o.dryRun) log(`dry run: ${String(r.outputs.length)} file(s) would be written`);
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    if (e instanceof ScrubAbort) for (const w of e.where) log(`  ${w}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  void main();
