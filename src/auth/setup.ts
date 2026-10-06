// setup.ts — `eff setup` as orchestration over injected IO (plan 03 §2.1 steps 1–8 and its flags
// `--reset`, `--storage keychain|file`, `--service-name eff-test-…`; plan 02 §2.1 format rules and
// the definitive check, §2.2 one store per install; ADV OBJ-05, OBJ-14, OBJ-15, OBJ-25, OBJ-26;
// changelog V8; plan 10 A2b). The CLI wires the hidden-input prompt, the launchd self-test runner,
// the ESPN requests and config.json; this module decides. Every line it prints is fixed text plus
// counts — never a value, a SWID, a league id or a team name — and a failed step deletes what the
// earlier steps stored (step 8).
import {
  EXIT_CODES,
  type CredentialStoreKind,
  type ExitCode,
  type KeychainSelftestOutcome,
} from "../config/schema.js";
import { CredentialStoreError, safeCode } from "./errors.js";
import {
  ESPN_S2_SHORT_WARNING,
  buildCookieHeader,
  formatRefusalText,
  normalizePastedValue,
  validateEspnS2,
  validateSwid,
} from "./format.js";
import { isTestServiceName } from "./keychain.js";
import {
  BOARD_PROBE_VIEW,
  SETTINGS_PROBE_VIEW,
  boardControlDiscriminates,
  probeVerdict,
  type ProbePlan,
} from "./probe.js";
import { registerCredentialRedaction } from "./redact.js";
import { storeForSelftest, type KeychainSelftestResult } from "./selftest.js";
import {
  KEYCHAIN_SERVICE,
  STALE_CREDENTIAL_DAYS,
  applyObservation,
  type CookieHeader,
  type CredentialState,
  type CredentialStateRepository,
  type CredentialStateRow,
  type CredentialStore,
  type EspnCookies,
  type SecretRegistrar,
} from "./types.js";
import { metaFor } from "./upgrade.js";

/** Each prompt waits this long, then setup exits 1 with nothing stored (plan 03 §2.1 step 8). */
export const SETUP_PROMPT_TIMEOUT_MS = 10 * 60_000;
/** Attempts per field before setup gives up (exit 2). */
export const SETUP_MAX_ATTEMPTS = 3;
/** Largest team id accepted from team resolution (plan 02 A-2 says ≤ 20; generous). */
const TEAM_ID_MAX = 9999;

/** One answer from the terminal (the CLI's readline; `hidden` mutes the echo). */
export type PromptAnswer =
  | { readonly kind: "answer"; readonly value: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "closed" };

/** The terminal prompt (hidden input for espn_s2 — plan 03 §2.1 step 3). */
export interface SetupPrompt {
  ask(
    question: string,
    opts: { readonly hidden: boolean; readonly timeoutMs: number },
  ): Promise<PromptAnswer>;
}

/** One ESPN request's outcome: an HTTP status, or a fixed error code (timeout, network, host_moved). */
export type HttpProbeResult = { readonly status: number } | { readonly error: string };

/** The user's team from `mTeam` (plan 03 §2.1 step 6): the team whose `owners[]` holds the SWID. */
export type TeamResolution =
  | { readonly kind: "one"; readonly teamId: number }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly count: number }
  | { readonly kind: "error"; readonly code: string };

/** The ESPN requests setup makes (under the limiter; the CLI implements them over src/http). */
export interface SetupNetwork {
  /** Anonymous `mSettings`: 200 → public league, 401/403 → private, 404 → wrong league id. */
  anonymousSettings(): Promise<HttpProbeResult>;
  /** The board probe WITHOUT cookies — the control (ADV OBJ-26). Body discarded. */
  anonymousBoard(): Promise<HttpProbeResult>;
  /** `mSettings` with the Cookie header (private league). */
  settingsWithCookies(header: CookieHeader): Promise<HttpProbeResult>;
  /** The board probe with the Cookie header (`topics.limit: 1`, body discarded). */
  boardWithCookies(header: CookieHeader): Promise<HttpProbeResult>;
  /** `mTeam` with the Cookie header, matched against the SWID. */
  resolveTeam(header: CookieHeader, swid: string): Promise<TeamResolution>;
}

/** Non-secret fields setup records in config.json (plan 03 §2.1, §3). null removes a field. */
export interface SetupConfigPatch {
  readonly EFF_CREDENTIAL_STORE?: CredentialStoreKind;
  readonly EFF_CREDENTIAL_FILE?: string;
  readonly keychain_selftest_outcome?: KeychainSelftestOutcome;
  readonly keychain_selftest_at?: string;
  readonly ESPN_TEAM_ID?: string | null;
}

/** config.json, owned by the CLI (atomic write). */
export interface SetupConfigWriter {
  record(patch: SetupConfigPatch): Promise<void>;
}

/** Both backends (constructed lazily by the CLI; the keychain one names its service). */
export interface SetupStores {
  readonly keychain: CredentialStore & { readonly service: string };
  readonly file: CredentialStore;
}

/** What the operator asked for, and what config.json already records. */
export interface SetupRequest {
  /** `--reset`: delete the stored items and the observations. */
  readonly reset: boolean;
  /** `--storage keychain|file` (null = the recorded store, or the self-test on a fresh install). */
  readonly storage: CredentialStoreKind | null;
  /** `--service-name` (test-only; must start `eff-test-`). */
  readonly serviceName: string | null;
  readonly leagueId: string;
  readonly season: number;
  /** `EFF_CREDENTIAL_STORE` as config.json records it (null on a fresh install). */
  readonly recordedStore: CredentialStoreKind | null;
  /** The resolved absolute file-store path (recorded as `EFF_CREDENTIAL_FILE` for the file store). */
  readonly filePath: string;
}

/** Everything setup touches, injected. */
export interface SetupDeps {
  readonly prompt: SetupPrompt;
  /** One line of terminal output (never a value). */
  readonly out: (line: string) => void;
  readonly now: () => string;
  readonly stores: SetupStores;
  /** The launchd-context self-test for a service (selftest.ts runKeychainSelftest, wired by the CLI). */
  readonly runSelftest: (service: string) => Promise<KeychainSelftestResult>;
  readonly network: SetupNetwork;
  readonly config: SetupConfigWriter;
  /** store.sqlite's row (null only in test mode, which records nothing). */
  readonly credentialState: CredentialStateRepository | null;
  readonly registrar: SecretRegistrar;
}

/** What happened. */
export interface SetupResult {
  readonly exitCode: ExitCode;
  readonly state: CredentialState;
  readonly store: CredentialStoreKind | null;
  /** The definitive check: true/false, or null (not run, or the board cannot tell). */
  readonly accepted: boolean | null;
  readonly probe: "settings" | "board" | "skipped" | null;
  readonly teamId: number | null;
  readonly selftest: KeychainSelftestOutcome | null;
}

/** The fixed texts setup prints (plan 03 §2.1). */
// prettier-ignore
export const SETUP_TEXT = Object.freeze({
  instructions: [
    "To connect your ESPN league, copy two cookies from a browser where you are logged in to ESPN:",
    "  1. Open fantasy.espn.com, then DevTools (right-click, Inspect) > Application > Cookies > https://fantasy.espn.com (or espn.com).",
    "  2. Copy the SWID value WITH its braces: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.",
    "  3. Copy the espn_s2 value exactly as shown (URL-encoded, a few hundred characters).",
    "These are full account credentials: never paste them into a chat, an issue or a config file.",
  ],
  askSwid: "SWID (visible as you type): ",
  askEspnS2: "espn_s2 (hidden, nothing appears as you paste): ",
  timeout: "No answer for 10 minutes: run `eff setup` again. Nothing was stored.",
  closed: "Input ended: run `eff setup` again in a terminal. Nothing was stored.",
  tooManyAttempts: "Too many invalid attempts: run `eff setup` again. Nothing was stored.",
  badServiceName: "--service-name is test-only and must start with eff-test- (letters, digits, . _ - after it).",
  serviceNameKeychainOnly: "--service-name applies to the keychain store only; it cannot be combined with --storage file.",
  storeMismatch: "internal: the keychain store does not use the requested service name; nothing was stored.",
  noStateRepo: "internal: store.sqlite is not open; nothing was stored.",
  selftestIntro: "Checking that background jobs can read the macOS Keychain. A Keychain prompt may appear during this test; ignoring it selects the file store.",
  selftestCleanupFailed: "The throwaway self-test Keychain item could not be deleted; `eff uninstall` removes it.",
  configFailed: "config.json could not be written: nothing was stored. Run `eff doctor`.",
  otherStoreFailed: (kind: CredentialStoreKind) => `The ${kind} store still holds a credential that could not be removed (only one store may hold it): nothing was stored. Run \`eff doctor\`.`,
  rowFailed: "store.sqlite could not record the credential state: nothing was kept. Run `eff doctor`.",
  testModeSkipped: "Test service name: the ESPN check and team resolution were skipped (a test item is never sent to ESPN).",
  notDiscriminating: "Stored; this league's board answers the same to anyone, so validity cannot be tested here (state: stored).",
  rejected: "ESPN did not accept these cookies for that league: copy them again from a logged-in browser tab and re-run `eff setup`. Nothing was kept.",
  leagueNotFound: (season: number) => `League id not found for season ${String(season)}: check ESPN_LEAGUE_ID. Nothing was kept.`,
  checkIncomplete: (code: string) => `The ESPN check could not complete (${code}); the cookies stay stored (state: stored). Run \`eff doctor --online\` later.`,
  teamOne: (id: number) => `Your team: id ${String(id)} (recorded as ESPN_TEAM_ID).`,
  teamNone: "No team in this league lists your SWID as an owner: ESPN_TEAM_ID left unset (writes stay off).",
  teamMany: (n: number) => `Your SWID owns ${String(n)} teams in this league: ESPN_TEAM_ID left unset (writes stay off).`,
  teamError: (code: string) => `Could not resolve your team (${code}): ESPN_TEAM_ID unchanged. Run \`eff setup\` again later.`,
  teamConfigFailed: "config.json could not record ESPN_TEAM_ID; the cookies stay stored. Run `eff doctor`.",
  repaste: `Cookie lifetime is unknown: re-run \`eff setup\` if \`eff status\` shows rejected, and consider doing so every ${String(STALE_CREDENTIAL_DAYS)} days.`,
});

/** The self-test line (plan 03 §2.1 step 4: the outcome and, when not ok, why the file store). */
export function selftestLine(r: KeychainSelftestResult, refusedKeychain: boolean): string {
  const why = r.reason === "read_failed" && r.code !== null ? `${r.reason}: ${r.code}` : r.reason;
  if (r.outcome === "ok") return "Keychain check: ok. Credentials go to the macOS Keychain.";
  return refusedKeychain
    ? `Keychain check: ${r.outcome} (${why}). --storage keychain refused: background jobs could not read the Keychain without a prompt. Use --storage file, or re-run with the Keychain unlocked.`
    : `Keychain check: ${r.outcome} (${why}). Using the 0600 file store for this whole install.`;
}

function storeFailureText(e: unknown, kind: CredentialStoreKind): string {
  if (e instanceof CredentialStoreError)
    return `The ${kind} store refused the credential: ${e.message}. Nothing was stored.`;
  return `The ${kind} store could not be written. Nothing was stored.`;
}

type Step<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly exitCode: ExitCode };

/** Runs `eff setup` (or `--reset`). Never throws for an expected failure; returns the exit code. */
export async function runSetup(req: SetupRequest, deps: SetupDeps): Promise<SetupResult> {
  const out = deps.out;
  const testMode = req.serviceName !== null;
  const result = (over: Partial<SetupResult> & { exitCode: ExitCode }): SetupResult => ({
    state: "not_configured",
    store: null,
    accepted: null,
    probe: null,
    teamId: null,
    selftest: null,
    ...over,
  });

  // --- flags (plan 03 §2.1; changelog V8) ----------------------------------------------------
  if (req.serviceName !== null && !isTestServiceName(req.serviceName)) {
    out(SETUP_TEXT.badServiceName);
    return result({ exitCode: EXIT_CODES.usage });
  }
  if (testMode && req.storage === "file") {
    out(SETUP_TEXT.serviceNameKeychainOnly);
    return result({ exitCode: EXIT_CODES.usage });
  }
  if (deps.stores.keychain.service !== (req.serviceName ?? KEYCHAIN_SERVICE)) {
    out(SETUP_TEXT.storeMismatch);
    return result({ exitCode: EXIT_CODES.error });
  }
  const repo = deps.credentialState;
  if (!testMode && repo === null) {
    out(SETUP_TEXT.noStateRepo);
    return result({ exitCode: EXIT_CODES.error });
  }
  if (req.reset) return reset(deps, testMode, repo, result);

  // --- steps 1–3: instructions, SWID (echoed), espn_s2 (hidden) ---------------------------------
  for (const line of SETUP_TEXT.instructions) out(line);
  const swid = await askValid(deps, "swid");
  if (!swid.ok) return result({ exitCode: swid.exitCode });
  const s2 = await askValid(deps, "espn_s2");
  if (!s2.ok) return result({ exitCode: s2.exitCode });
  const cookies: EspnCookies = { espn_s2: s2.value.value, swid: swid.value.value };
  registerCredentialRedaction(deps.registrar, cookies);
  out(`SWID ok (${String(cookies.swid.length)} chars)`);
  out(`espn_s2 ok (${String(cookies.espn_s2.length)} chars)`);
  if (s2.value.warning) out(ESPN_S2_SHORT_WARNING);

  // --- step 4: one store per install (the launchd-context self-test decides) -------------------
  const doSelftest = async (): Promise<KeychainSelftestResult> => {
    out(SETUP_TEXT.selftestIntro);
    const r = await deps.runSelftest(deps.stores.keychain.service);
    if (r.cleanup === "failed") out(SETUP_TEXT.selftestCleanupFailed);
    return r;
  };
  let selftest: KeychainSelftestResult | null = null;
  let kind: CredentialStoreKind;
  let refused = false;
  if (req.storage === "file") kind = "file";
  else if (req.storage === "keychain" || testMode) {
    selftest = await doSelftest();
    refused = selftest.outcome !== "ok";
    out(selftestLine(selftest, refused));
    kind = "keychain";
  } else if (req.recordedStore !== null) kind = req.recordedStore;
  else {
    selftest = await doSelftest();
    out(selftestLine(selftest, false));
    kind = storeForSelftest(selftest.outcome);
  }
  const st = selftest?.outcome ?? null;
  if (!testMode) {
    const patch: SetupConfigPatch = {
      ...(selftest === null
        ? {}
        : { keychain_selftest_outcome: selftest.outcome, keychain_selftest_at: selftest.at }),
      ...(refused ? {} : { EFF_CREDENTIAL_STORE: kind }),
      ...(refused || kind !== "file" ? {} : { EFF_CREDENTIAL_FILE: req.filePath }),
    };
    try {
      await deps.config.record(patch);
    } catch {
      out(SETUP_TEXT.configFailed);
      return result({ exitCode: EXIT_CODES.error, selftest: st });
    }
  }
  if (refused) return result({ exitCode: EXIT_CODES.error, selftest: st });

  const store = kind === "keychain" ? deps.stores.keychain : deps.stores.file;
  if (!testMode) {
    // switching store deletes the other store's items first: exactly one store holds a value
    const otherKind: CredentialStoreKind = kind === "keychain" ? "file" : "keychain";
    const other = kind === "keychain" ? deps.stores.file : deps.stores.keychain;
    try {
      await other.delete();
    } catch (e) {
      if (!(e instanceof CredentialStoreError && e.reason === "unavailable")) {
        out(SETUP_TEXT.otherStoreFailed(otherKind));
        return result({ exitCode: EXIT_CODES.error, selftest: st });
      }
    }
  }

  const meta = metaFor(cookies, deps.now());
  try {
    await store.write(cookies, meta);
  } catch (e) {
    await deleteQuietly(store);
    out(storeFailureText(e, kind));
    const usage = e instanceof CredentialStoreError && e.reason === "insecure_location";
    return result({ exitCode: usage ? EXIT_CODES.usage : EXIT_CODES.error, selftest: st });
  }

  if (testMode || repo === null) {
    out(SETUP_TEXT.testModeSkipped);
    return result({
      exitCode: EXIT_CODES.ok,
      state: "stored",
      store: kind,
      probe: "skipped",
      selftest: st,
    });
  }

  // the row: `stored` with fresh observations (setup_stored / setup_rerun → stored)
  const storedRow: CredentialStateRow = {
    league_id: req.leagueId,
    state: "stored",
    store: kind,
    stored_at: meta.storedAt,
    last_accepted_at: null,
    last_rejected_at: null,
    rejected_since: null,
    next_probe_at: null,
    rejected_view: null,
    board_probe_discriminates: null,
    updated_at: meta.storedAt,
    updated_by: "setup",
  };
  try {
    repo.transition(() => storedRow);
  } catch {
    await deleteQuietly(store);
    out(SETUP_TEXT.rowFailed);
    return result({ exitCode: EXIT_CODES.error, store: kind, selftest: st });
  }

  const kept = (over: Partial<SetupResult> & { exitCode: ExitCode }): SetupResult =>
    result({ state: "stored", store: kind, selftest: st, ...over });
  const discard = async (
    exitCode: ExitCode,
    line: string,
    probe: "settings" | "board",
  ): Promise<SetupResult> => {
    await deleteQuietly(store);
    try {
      repo.clear();
    } catch {
      // the value is gone; a stale row reads as not_configured on the next load (state.ts)
    }
    out(line);
    return result({
      exitCode,
      accepted: exitCode === EXIT_CODES.credentials ? false : null,
      probe,
      selftest: st,
    });
  };

  // --- step 5: the definitive check (plan 02 §2.1; ADV OBJ-14, OBJ-26) ------------------------
  const header = buildCookieHeader(cookies);
  const vis = await deps.network.anonymousSettings();
  if ("error" in vis) {
    out(SETUP_TEXT.checkIncomplete(safeCode(vis.error)));
    return kept({ exitCode: EXIT_CODES.error });
  }
  if (vis.status === 404)
    return discard(EXIT_CODES.usage, SETUP_TEXT.leagueNotFound(req.season), "settings");
  let plan: ProbePlan;
  if (vis.status === 200) {
    const control = await deps.network.anonymousBoard();
    if ("error" in control) {
      out(SETUP_TEXT.checkIncomplete(safeCode(control.error)));
      return kept({ exitCode: EXIT_CODES.error, probe: "board" });
    }
    const discriminates = boardControlDiscriminates(control.status) === true;
    try {
      repo.transition((cur) =>
        cur === null ? cur : { ...cur, board_probe_discriminates: discriminates },
      );
    } catch {
      // the control is re-run by the next setup; the probe below still decides this run
    }
    plan = { kind: "board", view: BOARD_PROBE_VIEW, discriminates };
  } else if (vis.status === 401 || vis.status === 403) {
    plan = { kind: "settings", view: SETTINGS_PROBE_VIEW, discriminates: true };
  } else {
    out(SETUP_TEXT.checkIncomplete(`http_${String(vis.status)}`));
    return kept({ exitCode: EXIT_CODES.error });
  }

  let accepted: boolean | null = null;
  const probeKind = plan.kind === "board" ? "board" : "settings";
  if (!plan.discriminates) {
    out(SETUP_TEXT.notDiscriminating);
  } else {
    const res =
      plan.kind === "board"
        ? await deps.network.boardWithCookies(header)
        : await deps.network.settingsWithCookies(header);
    if ("error" in res) {
      out(SETUP_TEXT.checkIncomplete(safeCode(res.error)));
      return kept({ exitCode: EXIT_CODES.error, probe: probeKind });
    }
    const verdict = probeVerdict(plan, res.status);
    if (verdict.observation === "rejected")
      return discard(EXIT_CODES.credentials, SETUP_TEXT.rejected, probeKind);
    if (verdict.observation === "league_not_found")
      return discard(EXIT_CODES.usage, SETUP_TEXT.leagueNotFound(req.season), probeKind);
    if (verdict.accepted !== true) {
      out(SETUP_TEXT.checkIncomplete(`http_${String(res.status)}`));
      return kept({ exitCode: EXIT_CODES.error, probe: probeKind });
    }
    accepted = true;
    try {
      repo.transition((cur) =>
        cur === null
          ? cur
          : applyObservation(cur, {
              kind: "accepted",
              at: deps.now(),
              by: "setup",
              upstream_status: res.status,
              view: plan.view,
            }),
      );
    } catch {
      // the acceptance is re-observed by the first cookie-bearing call (state.ts)
    }
    out(
      `Stored: SWID ok (${String(cookies.swid.length)} chars), espn_s2 ok (${String(cookies.espn_s2.length)} chars), league check ok (private: ${plan.kind === "settings" ? "yes" : "no"}; probe: ${probeKind}), age 0d.`,
    );
  }
  const state: CredentialState = accepted === true ? "validated" : "stored";

  // --- step 6: the user's team (ESPN_TEAM_ID; the Own team gate of plan 02 §3.2) ---------------
  let teamId: number | null = null;
  let exitCode: ExitCode = EXIT_CODES.ok;
  const team = await deps.network.resolveTeam(header, cookies.swid);
  let teamPatch: SetupConfigPatch | null = null;
  if (
    team.kind === "one" &&
    Number.isSafeInteger(team.teamId) &&
    team.teamId > 0 &&
    team.teamId <= TEAM_ID_MAX
  ) {
    teamPatch = { ESPN_TEAM_ID: String(team.teamId) };
    teamId = team.teamId;
  } else if (team.kind === "none" || team.kind === "many") {
    teamPatch = { ESPN_TEAM_ID: null };
  }
  if (teamPatch !== null) {
    try {
      await deps.config.record(teamPatch);
      if (team.kind === "one") out(SETUP_TEXT.teamOne(team.teamId));
      else if (team.kind === "many") out(SETUP_TEXT.teamMany(team.count));
      else out(SETUP_TEXT.teamNone);
    } catch {
      teamId = null;
      exitCode = EXIT_CODES.error;
      out(SETUP_TEXT.teamConfigFailed);
    }
  } else {
    out(SETUP_TEXT.teamError(team.kind === "error" ? safeCode(team.code) : "invalid_team_id"));
  }

  // --- step 7 ------------------------------------------------------------------------------------
  out(SETUP_TEXT.repaste);
  return kept({ exitCode, state, accepted, probe: probeKind, teamId });
}

async function deleteQuietly(store: CredentialStore): Promise<void> {
  try {
    await store.delete();
  } catch {
    // reported by the caller's message; `eff doctor` #6 finds what is left
  }
}

async function askValid(
  deps: SetupDeps,
  field: "swid" | "espn_s2",
): Promise<Step<{ value: string; warning: boolean }>> {
  for (let attempt = 0; attempt < SETUP_MAX_ATTEMPTS; attempt++) {
    const a = await deps.prompt.ask(field === "swid" ? SETUP_TEXT.askSwid : SETUP_TEXT.askEspnS2, {
      hidden: field === "espn_s2",
      timeoutMs: SETUP_PROMPT_TIMEOUT_MS,
    });
    if (a.kind === "timeout") {
      deps.out(SETUP_TEXT.timeout);
      return { ok: false, exitCode: EXIT_CODES.error };
    }
    if (a.kind === "closed") {
      deps.out(SETUP_TEXT.closed);
      return { ok: false, exitCode: EXIT_CODES.error };
    }
    const value = normalizePastedValue(a.value);
    const verdict = field === "swid" ? validateSwid(value) : validateEspnS2(value);
    if (verdict.ok) return { ok: true, value: { value, warning: verdict.warning !== null } };
    deps.out(formatRefusalText(verdict));
  }
  deps.out(SETUP_TEXT.tooManyAttempts);
  return { ok: false, exitCode: EXIT_CODES.usage };
}

/** `--reset`: delete the stored items and the observations (plan 03 §2.1). */
async function reset(
  deps: SetupDeps,
  testMode: boolean,
  repo: CredentialStateRepository | null,
  result: (over: Partial<SetupResult> & { exitCode: ExitCode }) => SetupResult,
): Promise<SetupResult> {
  const targets: [CredentialStoreKind, CredentialStore][] = testMode
    ? [["keychain", deps.stores.keychain]]
    : [
        ["keychain", deps.stores.keychain],
        ["file", deps.stores.file],
      ];
  let failed = false;
  for (const [kind, store] of targets) {
    try {
      await store.delete();
      deps.out(`Removed the ${kind} store's credential (if any).`);
    } catch (e) {
      if (e instanceof CredentialStoreError && e.reason === "unavailable") continue;
      failed = true;
      deps.out(`The ${kind} store's credential could not be removed. Run \`eff doctor\`.`);
    }
  }
  if (!testMode && repo !== null) {
    try {
      repo.clear();
    } catch {
      failed = true;
      deps.out("store.sqlite could not clear the credential state. Run `eff doctor`.");
    }
  }
  deps.out(
    failed
      ? "Reset incomplete."
      : "Reset done: state not_configured. Run `eff setup` to store new cookies.",
  );
  return result({ exitCode: failed ? EXIT_CODES.error : EXIT_CODES.ok });
}
