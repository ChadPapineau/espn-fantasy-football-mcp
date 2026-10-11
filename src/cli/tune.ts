// tune.ts — `eff tune [--apply] [--revert] [--json]` (plan 10 §3.3 "the weekly re-fit of the
// projection parameters proposed by retro and applied only by a human-run `eff tune --apply`", C9;
// plan 01 §11 the `tune --apply` subcommand; plan 07 E13 "propose (never apply)"). Dry run by
// default: it reads the newest proposal set the retrospective stored for this league's season (the
// store's ParameterProposalRepository, opened read-only and never created or migrated), re-validates
// it against the registry (src/domain/reclog/tune.ts — the store is never trusted), and prints the
// diff against `<config>/tuned-parameters.json`. `--apply` writes that file — atomically, 0600, in
// the 0700 config dir outside every repository and synced folder — and only when a human runs it:
// stdin and stdout must be an interactive terminal, the shell must not belong to an agent session
// (CLAUDECODE) or a launchd job (XPC_SERVICE_NAME = one of our labels), and the human must type the
// confirmation word. `--revert` undoes the last applied change set under the same rules. Never
// dispatched by `serve` (the MCP layer cannot import src/cli — eslint's layer rule) and never in the
// launchd job list (src/cli/launchd.ts JOBS). Network: none. Keychain: none. New here.
import path from "node:path";
import {
  ensureSecureDir,
  locationRefusals,
  readSecureFile,
  writeSecureFileAtomic,
} from "../config/paths.js";
import type { LenientConfig } from "../config/schema.js";
import {
  TUNED_PARAMETERS_FILE_NAME,
  TUNED_PARAMETERS_MAX_BYTES,
  TuneDocumentError,
  emptyTunedParameters,
  parseTunedParameters,
  planApply,
  planRevert,
  renderPlan,
  serializeTunedParameters,
  validateProposalSet,
  type TunePlan,
  type TunedParameters,
} from "../domain/reclog/tune.js";
import type { ParameterProposalRepository, ParameterProposalSet } from "../domain/reclog/types.js";
import type { StoreFactory, StoreRepositories } from "../store/types.js";
import { EXIT } from "./exit.js";
import { isTty, writeLine, type CliIo } from "./io.js";
import { LABEL_PREFIX } from "./launchd.js";
import type { Logger } from "./log.js";
import { createTerminalPrompt } from "./prompt.js";
import { parseIso } from "../domain/clock.js";
import { errorText, openExistingStore } from "./store-access.js";

/** The word the human types to apply (anything else applies nothing). */
export const TUNE_CONFIRM_WORD = "apply";
/** How long the confirmation waits. */
export const TUNE_CONFIRM_TIMEOUT_MS = 5 * 60_000;
/** A proposal set older than this is shown but never applied (run the retro Skill again). */
export const PROPOSAL_MAX_AGE_DAYS = 14;

/** `eff tune` options. */
export interface TuneOptions {
  readonly apply: boolean;
  readonly revert: boolean;
  readonly json: boolean;
}

/** Where the newest proposal set came from (or why there is none). */
export type ProposalLookup =
  | { readonly kind: "found"; readonly set: ParameterProposalSet }
  | { readonly kind: "none" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "no_league" }
  | { readonly kind: "no_store" }
  | { readonly kind: "invalid" }
  | { readonly kind: "error"; readonly message: string };

/** Test seams (never reachable from argv). */
export interface TuneDeps {
  /** Overrides how the proposal set is read (default: the store, read-only). */
  readonly proposals?: (config: LenientConfig) => ProposalLookup;
  /** Overrides the confirmation prompt: resolves the typed line, or null on close / timeout. */
  readonly confirm?: (question: string) => Promise<string | null>;
}

/** The tuned-parameters file of a config dir. */
export function tunedParametersPath(configDir: string): string {
  return path.join(configDir, TUNED_PARAMETERS_FILE_NAME);
}

/**
 * The repository seam: the store's proposal table (migration 002). Read through `unknown`, because a
 * store opened from an older binary's repository set (or a narrow test fake) may lack it — then null.
 */
export function proposalRepositoryOf(repos: StoreRepositories): ParameterProposalRepository | null {
  const r: unknown = (repos as { readonly parameterProposals?: unknown }).parameterProposals;
  if (typeof r !== "object" || r === null) return null;
  const latest: unknown = (r as { readonly latest?: unknown }).latest;
  return typeof latest === "function" ? (r as ParameterProposalRepository) : null;
}

/** The default lookup: the existing store, opened without creating or migrating it. */
export function storeProposals(io: CliIo, log: Logger, factory?: StoreFactory) {
  return (config: LenientConfig): ProposalLookup => {
    if (config.leagueId === null) return { kind: "no_league" };
    const opened = openExistingStore(config, io.clock, log, factory);
    if (opened.kind === "missing") return { kind: "no_store" };
    if (opened.kind !== "open")
      return {
        kind: "error",
        message: opened.kind === "error" ? opened.message : `store is ${opened.kind}`,
      };
    try {
      const repo = proposalRepositoryOf(opened.store.repos);
      if (repo === null) return { kind: "unsupported" };
      const raw: unknown = repo.latest(config.leagueId, config.season);
      if (raw === null) return { kind: "none" };
      const set = validateProposalSet(raw);
      return set === null ? { kind: "invalid" } : { kind: "found", set };
    } catch (e) {
      return { kind: "error", message: errorText(e) };
    } finally {
      opened.store.close();
    }
  };
}

/**
 * Why `--apply` must not run here, or null: an agent session's shell, a launchd job, or a stream
 * that is not an interactive terminal. (A model can drive a shell; it cannot type into the owner's
 * terminal — the same reason `eff setup` reads the cookie only there.)
 */
export function applyContextRefusal(io: CliIo): string | null {
  if ((io.env.CLAUDECODE ?? "") !== "")
    return "this shell belongs to a Claude Code session (CLAUDECODE is set)";
  if ((io.env.XPC_SERVICE_NAME ?? "").startsWith(LABEL_PREFIX))
    return "it is running as a launchd job";
  if (!isTty(io.stdin) || !isTty(io.stdout))
    return "stdin and stdout must be an interactive terminal";
  return null;
}

/** The current document: absent → empty; unreadable or invalid → an error (never overwritten). */
export function readTunedParameters(file: string):
  | { readonly ok: true; readonly doc: TunedParameters; readonly present: boolean }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  let text: string | null;
  try {
    text = readSecureFile(file, {
      requirePrivate: true,
      maxBytes: TUNED_PARAMETERS_MAX_BYTES,
      what: TUNED_PARAMETERS_FILE_NAME,
    });
  } catch (e) {
    return { ok: false, reason: errorText(e) };
  }
  if (text === null) return { ok: true, doc: emptyTunedParameters(), present: false };
  try {
    return { ok: true, doc: parseTunedParameters(text), present: true };
  } catch (e) {
    return { ok: false, reason: e instanceof TuneDocumentError ? e.message : errorText(e) };
  }
}

/** The proposal set's age in whole days at `nowMs`. */
function ageDays(set: ParameterProposalSet, nowMs: number): number {
  return Math.floor((nowMs - parseIso(set.created_at)) / 86_400_000);
}

const LOOKUP_TEXT: Readonly<Record<Exclude<ProposalLookup["kind"], "found" | "error">, string>> =
  Object.freeze({
    none: "no proposal set stored yet for this season — run the retro Skill (espn_analyze_retrospective) on a final week first",
    unsupported:
      "this build's store keeps no proposal sets yet — the retrospective cannot have written one",
    no_league: "ESPN_LEAGUE_ID is not set, so no proposal set can be read",
    no_store: "no store yet (run `eff setup` and use the server first)",
    invalid: "the stored proposal set failed validation and is ignored",
  });

/** The JSON form of a run (numbers, parameter names and fixed words only). */
interface TuneReport {
  readonly mode: "dry_run" | "apply";
  readonly kind: "apply" | "revert";
  readonly file: { readonly path: string; readonly state: "absent" | "ok" | "invalid" };
  readonly proposal_set: {
    readonly hash: string;
    readonly created_at: string;
    readonly season: number;
    readonly week: number;
    readonly window: { readonly first_week: number; readonly last_week: number };
    readonly age_days: number;
  } | null;
  readonly changes: TunePlan["changes"];
  readonly refused: TunePlan["refused"];
  /** Always false: the JSON form is the dry run's (an apply is interactive). */
  readonly applied: false;
  readonly notes: readonly string[];
}

/** Runs `eff tune`. Exit 0 on a dry run or an applied change set; 1 nothing applied; 2 refused here. */
export async function tune(
  io: CliIo,
  config: LenientConfig,
  log: Logger,
  opts: TuneOptions,
  deps: TuneDeps = {},
): Promise<number> {
  const out = (l: string): Promise<void> => writeLine(io.stdout, l);
  const file = tunedParametersPath(config.configDir);
  const notes: string[] = [];

  if (opts.apply && opts.json) {
    await writeLine(io.stderr, "eff tune: --json is for the dry run; --apply asks in the terminal");
    return EXIT.usage;
  }
  // the context gate comes first: nothing is read for an --apply that may not run here
  if (opts.apply) {
    const why = applyContextRefusal(io);
    if (why !== null) {
      await writeLine(
        io.stderr,
        `eff tune --apply: refused — ${why}. Run it yourself in your own terminal (\`eff tune\` alone shows the diff). Nothing was changed.`,
      );
      log.warn("tune.apply_refused", { reason: why });
      return EXIT.usage;
    }
  }

  const current = readTunedParameters(file);
  let set: ParameterProposalSet | null = null;
  let plan: TunePlan;
  if (opts.revert) {
    plan = planRevert(current.ok ? current.doc : emptyTunedParameters(), io.clock.nowIso());
    if (current.ok && current.doc.history.length === 0)
      notes.push("nothing to revert: no change set was ever applied");
  } else {
    const lookup = (deps.proposals ?? storeProposals(io, log))(config);
    if (lookup.kind === "found") set = lookup.set;
    else
      notes.push(
        lookup.kind === "error"
          ? `the store could not be read: ${lookup.message}`
          : LOOKUP_TEXT[lookup.kind],
      );
    plan =
      set === null
        ? {
            kind: "apply",
            changes: [],
            refused: [],
            next: current.ok ? current.doc : emptyTunedParameters(),
            proposal_hash: null,
          }
        : planApply(current.ok ? current.doc : emptyTunedParameters(), set, io.clock.nowIso());
  }
  if (!current.ok)
    notes.push(
      `${TUNED_PARAMETERS_FILE_NAME} is unusable (${current.reason}); fix or remove it before applying`,
    );
  let blocked = !current.ok;
  if (set !== null) {
    const age = ageDays(set, io.clock.nowMs());
    if (set.season !== config.season) {
      notes.push(
        `the proposal set is for season ${String(set.season)}, not ${String(config.season)}: shown, never applied`,
      );
      blocked = true;
    }
    if (age > PROPOSAL_MAX_AGE_DAYS) {
      notes.push(
        `the proposal set is ${String(age)} days old (limit ${String(PROPOSAL_MAX_AGE_DAYS)}): run the retro Skill again before applying`,
      );
      blocked = true;
    }
    if (set.proposals.length === 0) notes.push("the retrospective proposed no change this week");
  }

  const report = (): TuneReport => ({
    mode: opts.apply ? "apply" : "dry_run",
    kind: plan.kind,
    file: { path: file, state: !current.ok ? "invalid" : current.present ? "ok" : "absent" },
    proposal_set:
      set === null
        ? null
        : {
            hash: set.hash,
            created_at: set.created_at,
            season: set.season,
            week: set.week,
            window: set.window,
            age_days: ageDays(set, io.clock.nowMs()),
          },
    changes: plan.changes,
    refused: plan.refused,
    applied: false,
    notes,
  });
  const print = async (): Promise<void> => {
    if (opts.json) {
      await out(JSON.stringify(report()));
      return;
    }
    await out(`eff tune${opts.revert ? " --revert" : ""}${opts.apply ? " --apply" : ""} — ${file}`);
    if (set !== null)
      await out(
        `proposal set ${set.hash.slice(0, 12)} (season ${String(set.season)}, week ${String(set.week)}, weeks ${String(set.window.first_week)}–${String(set.window.last_week)}, made ${set.created_at})`,
      );
    for (const n of notes) await out(`note: ${n}`);
    const lines = renderPlan(plan);
    if (lines.length === 0) await out("no change to write");
    else {
      await out(opts.revert ? "would restore:" : "would change:");
      for (const l of lines) await out(l);
    }
  };

  if (!opts.apply) {
    await print();
    if (!opts.json && plan.changes.length > 0)
      await out(
        `dry run — nothing written. To apply, run \`eff tune${opts.revert ? " --revert" : ""} --apply\` yourself in a terminal.`,
      );
    return EXIT.ok;
  }
  if (plan.changes.length === 0 || blocked) {
    await print();
    await out("nothing applied");
    return plan.changes.length === 0 && !blocked ? EXIT.ok : EXIT.error;
  }
  await print();
  const ask =
    deps.confirm ??
    (async (q: string): Promise<string | null> => {
      const prompt = createTerminalPrompt({ stdin: io.stdin, out: io.stdout });
      try {
        const a = await prompt.ask(q, { hidden: false, timeoutMs: TUNE_CONFIRM_TIMEOUT_MS });
        return a.kind === "answer" ? a.value : null;
      } finally {
        prompt.close();
      }
    });
  const n = plan.changes.length;
  const typed = await ask(
    `Type ${TUNE_CONFIRM_WORD} to write ${String(n)} change${n === 1 ? "" : "s"}: `,
  );
  if (typed?.trim() !== TUNE_CONFIRM_WORD) {
    await writeLine(io.stderr, "eff tune: not confirmed — nothing applied");
    return EXIT.error;
  }
  const refusal = locationRefusals(config.configDir, {
    home: io.home,
    repoRoot: io.packageRoot,
    what: "config dir",
    xattr: io.xattr,
  })[0];
  if (refusal !== undefined) {
    await writeLine(io.stderr, `eff tune: refused — ${refusal.detail}; nothing applied`);
    return EXIT.error;
  }
  try {
    ensureSecureDir(config.configDir, { create: true, what: "config dir" });
    writeSecureFileAtomic(file, serializeTunedParameters(plan.next), TUNED_PARAMETERS_FILE_NAME);
  } catch (e) {
    await writeLine(
      io.stderr,
      `eff tune: the file could not be written (${errorText(e)}); nothing applied`,
    );
    return EXIT.error;
  }
  log.info("tune.applied", { kind: plan.kind, changes: n, refused: plan.refused.length });
  await out(
    `applied ${String(n)} change${n === 1 ? "" : "s"} to ${file}; the server reads them when it next starts (\`eff tune --revert --apply\` undoes this)`,
  );
  return EXIT.ok;
}
