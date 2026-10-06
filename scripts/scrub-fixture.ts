#!/usr/bin/env -S npx tsx
// scrub-fixture.ts — offline, deterministic anonymisation of a raw recording run into the committed
// fixtures: research 03 §F.3 (the rules, determinism, the deny-list verification, the manifest after
// anonymisation), plan 05 §3.1 steps 2–4 (refuses to write unless the deny-list check passes; byte-
// identical reruns; provenance hashes). The rules live in scripts/espn-fixture/scrub.ts.
//
// Usage:  scripts/dev/with-node.sh npx tsx scripts/scrub-fixture.ts --raw-dir <dir outside the repo>
//                                     [--out <fixtures/espn>] [--prune <key,…>] [--dry-run]
//                                     [--withhold-denylisted]
// It reads only the raw directory (written by record-fixture.ts) and makes no network request.
// --withhold-denylisted: when the repo scanner's only findings are local deny-list matches, remove
// the smallest self-contained unit holding each matched line (pipeline.ts withholdUnit), re-scan,
// and list the removed units by path in the manifest; any other finding still refuses the run.
// Exit: 0 written · 1 refused (the deny-list abort or another problem, each listed by path) · 2 usage.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rawDirRefusal } from "./espn-fixture/guards.js";
import { REPO_ROOT } from "./espn-fixture/http.js";
import { scrubRun, type ScrubRunResult } from "./espn-fixture/pipeline.js";
import { ScrubAbort } from "./espn-fixture/scrub.js";

export interface ScrubCliOptions {
  rawDir: string;
  outRoot: string;
  prune: string[];
  dryRun: boolean;
  withholdDenylisted: boolean;
}

export function parseScrubArgs(argv: readonly string[]): ScrubCliOptions {
  let rawDir: string | null = null;
  let outRoot = path.join(REPO_ROOT, "fixtures", "espn");
  let prune: string[] = [];
  let dryRun = false;
  let withholdDenylisted = false;
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
    else if (a === "--withhold-denylisted") withholdDenylisted = true;
    else throw new Error(`unknown argument #${String(i + 1)}`);
  }
  if (rawDir === null) throw new Error("--raw-dir is required");
  if (rawDirRefusal(rawDir, REPO_ROOT) !== null)
    throw new Error("the raw directory must be outside the repository and any git working tree");
  return { rawDir, outRoot, prune, dryRun, withholdDenylisted };
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
    withholdDenylisted: o.withholdDenylisted,
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
