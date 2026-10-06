#!/usr/bin/env -S npx tsx
// probe.ts — the standalone ESPN drift probe (Phase 0): plan 06 §1.2 (keyless host probe on
// proTeamSchedules_wl + optional public-league shape probe on mSettings&mNav&mTeam, exit 4 on drift
// with the JSON path), plan 01 §7 (required keys, skeleton detection, host moved), plan 10 §3.0 Z4.
//
// Usage:  scripts/dev/with-node.sh npx tsx scripts/probe.ts [--season <year>] [--host-only]
//                                                         [--manifest <file>] [--rebaseline]
//   EFF_PROBE_LEAGUE_ID=<id> (environment only — never an argument, never printed) enables the shape
//   probe on that PUBLIC league; no cookie is ever sent. --rebaseline is offline: it rewrites the
//   probes' `observed` key sets and regenerates the per-view `views` section (entity keys, enums,
//   array lengths — plan 05 §3.1 step 4) from the recorded fixtures (a human step after re-recording).
// Output: ONE JSON line on stdout; a one-line human summary on stderr when something is wrong.
// Exit: 0 green or additive-only · 1 error · 2 usage/config · 4 drift (red) · 6 host moved ·
//       7 unreachable (network, timeout, 429/5xx). It writes nothing (except --rebaseline).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentSha256, isObject, parseJsonStrict, type Json } from "./espn-fixture/canonical.js";
import { isEspnView } from "../src/providers/espn/types.js";
import {
  classifyResponse,
  diffBody,
  observeBodies,
  observeKeys,
  validateManifest,
  type DriftManifest,
  type Finding,
  type ProbeSpec,
} from "./espn-fixture/drift.js";
import { formatJson } from "./espn-fixture/format-json.js";
import {
  REPO_ROOT,
  TransportError,
  defaultSeason,
  isLeagueId,
  isSeason,
  leagueUrl,
  politeClient,
  seasonUrl,
  userAgent,
  type FetchLike,
} from "./espn-fixture/http.js";

export const DEFAULT_MANIFEST = path.join(REPO_ROOT, "fixtures", "drift", "manifest.json");
export const EXIT = { ok: 0, error: 1, config: 2, drift: 4, hostMoved: 6, unreachable: 7 } as const;
const MAX_FINDINGS = 50;

export type CheckStatus =
  "green" | "additive" | "red" | "host_moved" | "unreachable" | "error" | "config" | "skipped";

export interface CheckResult {
  name: "host" | "shape";
  views: string[];
  status: CheckStatus;
  http?: number;
  bytes?: number;
  ms?: number;
  reason?: string;
  findings: Finding[];
  findings_truncated: number;
}

export interface ProbeLine {
  probe: "espn-drift";
  schema: 1;
  at: string;
  season: number;
  host: string;
  status: CheckStatus;
  exit: number;
  manifest_sha256: string;
  checks: CheckResult[];
}

export interface ProbeDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds for request spacing (tests); defaults to Date.now. */
  clock?: () => number;
}

const RANK: Record<CheckStatus, number> = {
  host_moved: 7,
  red: 6,
  unreachable: 5,
  error: 4,
  config: 3,
  additive: 2,
  green: 1,
  skipped: 0,
};
const EXIT_OF: Record<CheckStatus, number> = {
  host_moved: EXIT.hostMoved,
  red: EXIT.drift,
  unreachable: EXIT.unreachable,
  error: EXIT.error,
  config: EXIT.config,
  additive: EXIT.ok,
  green: EXIT.ok,
  skipped: EXIT.ok,
};

export function loadManifest(file: string): { manifest: DriftManifest; sha256: string } {
  const value = parseJsonStrict(readFileSync(file, "utf8"));
  validateManifest(value);
  return { manifest: value, sha256: contentSha256(value) };
}

/** Removes every occurrence of the configured league id from free text (defence in depth). */
function redact(text: string, leagueId: string | null): string {
  return leagueId ? text.split(leagueId).join("<league>") : text;
}

async function runCheck(
  name: "host" | "shape",
  spec: ProbeSpec,
  url: string,
  host: string,
  client: ReturnType<typeof politeClient>,
  leagueId: string | null,
): Promise<CheckResult> {
  const base: CheckResult = {
    name,
    views: [...spec.views],
    status: "error",
    findings: [],
    findings_truncated: 0,
  };
  let res;
  try {
    res = await client.get(url);
  } catch (e) {
    if (e instanceof TransportError && e.kind !== "too_large")
      return { ...base, status: "unreachable", reason: redact(e.message, leagueId) };
    return {
      ...base,
      status: "error",
      reason: redact(e instanceof Error ? e.message : String(e), leagueId),
    };
  }
  const meta = { http: res.status, bytes: res.bytes, ms: res.ms };
  const cls = classifyResponse(res, host);
  switch (cls.kind) {
    case "host_moved":
      return { ...base, ...meta, status: "host_moved", reason: redact(cls.reason, leagueId) };
    case "unreachable":
      return { ...base, ...meta, status: "unreachable", reason: cls.reason };
    case "not_found":
      return {
        ...base,
        ...meta,
        status: "config",
        reason:
          name === "shape"
            ? `${cls.reason}: the probe league does not exist for this season`
            : `${cls.reason}: the season is not served (check --season / ESPN_SEASON)`,
      };
    case "forbidden":
      return {
        ...base,
        ...meta,
        status: name === "shape" ? "config" : "host_moved",
        reason:
          name === "shape"
            ? `${cls.reason}: the probe league is not public (the probe never sends cookies)`
            : `${cls.reason}: the keyless season route refused an anonymous read`,
      };
    case "error":
      return { ...base, ...meta, status: "error", reason: cls.reason };
    case "json": {
      const findings = diffBody(spec, cls.body);
      const red = findings.some((f) => f.severity === "red");
      return {
        ...base,
        ...meta,
        status: red ? "red" : findings.length ? "additive" : "green",
        findings: findings.slice(0, MAX_FINDINGS),
        findings_truncated: Math.max(0, findings.length - MAX_FINDINGS),
      };
    }
  }
}

/** Runs the probe; never throws for an ESPN-side problem (that is an exit code and a JSON line). */
export async function runProbe(
  argv: readonly string[],
  deps: ProbeDeps = {},
): Promise<{ exit: number; line: ProbeLine | null; usage?: string }> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  let manifestFile = DEFAULT_MANIFEST;
  let season: number | null = null;
  let hostOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--season") {
      season = Number(argv[++i]);
      if (!isSeason(season))
        return { exit: EXIT.config, line: null, usage: "--season needs a year from 2018" };
    } else if (a === "--manifest") {
      const v = argv[++i];
      if (!v) return { exit: EXIT.config, line: null, usage: "--manifest needs a file" };
      manifestFile = path.resolve(v);
    } else if (a === "--host-only") hostOnly = true;
    else
      return {
        exit: EXIT.config,
        line: null,
        usage: `unknown argument ${JSON.stringify(String(a).slice(0, 40))} (the league id is read from EFF_PROBE_LEAGUE_ID only)`,
      };
  }
  if (season === null) {
    const fromEnv = env.ESPN_SEASON;
    if (fromEnv !== undefined && fromEnv !== "") {
      season = Number(fromEnv);
      if (!isSeason(season))
        return { exit: EXIT.config, line: null, usage: "ESPN_SEASON must be a year from 2018" };
    } else season = defaultSeason(now());
  }
  const rawLeague = env.EFF_PROBE_LEAGUE_ID?.trim() ?? "";
  if (rawLeague && !isLeagueId(rawLeague))
    return {
      exit: EXIT.config,
      line: null,
      usage: "EFF_PROBE_LEAGUE_ID must be a positive integer",
    };
  const leagueId = rawLeague || null;

  let manifest: DriftManifest;
  let manifestSha: string;
  try {
    ({ manifest, sha256: manifestSha } = loadManifest(manifestFile));
  } catch (e) {
    return {
      exit: EXIT.error,
      line: null,
      usage: `cannot load the drift manifest: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const client = politeClient({
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.clock ? { now: deps.clock } : {}),
    maxRequests: 2,
    userAgent: userAgent("drift probe"),
  });
  const checks: CheckResult[] = [];
  checks.push(
    await runCheck(
      "host",
      manifest.probes.host,
      seasonUrl(season, manifest.probes.host.views),
      manifest.host,
      client,
      leagueId,
    ),
  );
  if (hostOnly || !leagueId) {
    checks.push({
      name: "shape",
      views: [...manifest.probes.shape.views],
      status: "skipped",
      reason: hostOnly ? "--host-only" : "EFF_PROBE_LEAGUE_ID is not set",
      findings: [],
      findings_truncated: 0,
    });
  } else {
    checks.push(
      await runCheck(
        "shape",
        manifest.probes.shape,
        leagueUrl(season, leagueId, manifest.probes.shape.views),
        manifest.host,
        client,
        leagueId,
      ),
    );
  }
  const worst = checks.reduce<CheckStatus>(
    (w, c) => (RANK[c.status] > RANK[w] ? c.status : w),
    "skipped",
  );
  const status: CheckStatus = worst === "skipped" ? "green" : worst;
  const line: ProbeLine = {
    probe: "espn-drift",
    schema: 1,
    at: now().toISOString(),
    season,
    host: manifest.host,
    status,
    exit: EXIT_OF[status],
    manifest_sha256: manifestSha,
    checks,
  };
  return { exit: line.exit, line };
}

/** One human line for stderr (the notification text of plan 06 §1.2): "ESPN drift: <view>: removed <path>". */
export function summarize(line: ProbeLine): string | null {
  if (line.exit === EXIT.ok) return null;
  const parts: string[] = [];
  for (const c of line.checks) {
    if (c.status === "red") {
      const f = c.findings.find((x) => x.severity === "red");
      parts.push(`ESPN drift: ${c.views.join("+")}: ${f ? `${f.kind} ${f.path}` : "red"}`);
    } else if (c.status === "host_moved")
      parts.push(`ESPN host moved: ${c.views.join("+")}: ${c.reason ?? ""}`);
    else if (c.status === "unreachable" || c.status === "error" || c.status === "config")
      parts.push(`ESPN probe ${c.status}: ${c.views.join("+")}: ${c.reason ?? ""}`);
  }
  return parts.join(" | ") || null;
}

/** The recording manifest the per-view observations are generated from (plan 05 §3.1 step 4). */
export const RECORDING_MANIFEST = path.join(REPO_ROOT, "fixtures", "espn", "manifest.json");

/**
 * The recorded fixtures of each whitelisted view, relative to `fixtures/`, from the recording
 * manifest: every 200 body recorded as that view ALONE; a composite body (`mSettings&mNav&mTeam`)
 * serves only a view that has no solo recording (mNav today). Skeletons (an unknown view) and
 * error bodies are never a source. Sorted, deterministic.
 */
export function viewSources(recordingManifestFile: string): Record<string, string[]> {
  const raw = parseJsonStrict(readFileSync(recordingManifestFile, "utf8"));
  const files = isObject(raw) && Array.isArray(raw.files) ? raw.files : [];
  const solo = new Map<string, string[]>();
  const composite = new Map<string, string[]>();
  for (const f of files) {
    if (!isObject(f) || f.status !== 200 || typeof f.path !== "string") continue;
    const views = Array.isArray(f.views)
      ? f.views.filter((v): v is string => typeof v === "string")
      : [];
    if (!views.length || !views.every(isEspnView)) continue;
    const rel = `espn/${f.path}`;
    const into = views.length === 1 ? solo : composite;
    for (const v of views) into.set(v, [...(into.get(v) ?? []), rel]);
  }
  const out: Record<string, string[]> = {};
  for (const v of [...new Set([...solo.keys(), ...composite.keys()])].sort())
    out[v] = [...(solo.get(v) ?? composite.get(v) ?? [])].sort();
  return out;
}

/**
 * Offline re-baseline: rewrites every probe's `observed` key sets from the fixtures named in
 * `$sources`, and regenerates `views` (entity keys, enums, array lengths per recorded view) from
 * `viewSrc` (default: the recording manifest). A human step after re-recording (plan 01 §7).
 */
export async function rebaseline(
  manifestFile: string,
  sources: { host: string[]; shape: string[] },
  viewSrc: Record<string, string[]> = viewSources(RECORDING_MANIFEST),
): Promise<DriftManifest> {
  const { manifest } = loadManifest(manifestFile);
  const m = manifest as unknown as {
    probes: Record<
      "host" | "shape",
      { observed: Record<string, string[]> } & DriftManifest["probes"]["host"]
    >;
    views: Record<string, unknown>;
  };
  for (const name of ["host", "shape"] as const) {
    const spec = m.probes[name];
    const bodies = sources[name].map((f) => parseJsonStrict(readFileSync(f, "utf8")));
    const patterns = [
      ...new Set([...Object.keys(spec.required), ...Object.keys(spec.observed)]),
    ].sort();
    spec.observed = observeKeys(patterns, bodies);
  }
  const views: Record<string, unknown> = {};
  for (const [view, rels] of Object.entries(viewSrc).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const bodies = rels.map((rel) =>
      parseJsonStrict(readFileSync(path.join(REPO_ROOT, "fixtures", rel), "utf8")),
    );
    views[view] = { sources: rels, ...observeBodies(bodies) };
  }
  m.views = views;
  validateManifest(manifest);
  writeFileSync(manifestFile, await formatJson(manifest as unknown as Json));
  return manifest;
}

/** The recorded fixtures a re-baseline reads (the drift manifest names them under `$sources`). */
export function rebaselineSources(manifestFile: string): { host: string[]; shape: string[] } {
  const raw = parseJsonStrict(readFileSync(manifestFile, "utf8"));
  const src = isObject(raw) ? raw.$sources : null;
  const list = (k: string): string[] => {
    const v = isObject(src) ? src[k] : null;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
      throw new Error(`$sources.${k} missing`);
    return v.map((rel) => path.join(REPO_ROOT, "fixtures", rel));
  };
  return { host: list("host"), shape: list("shape") };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--rebaseline")) {
    const rest = argv.filter((a) => a !== "--rebaseline");
    const file = rest[0] === "--manifest" && rest[1] ? path.resolve(rest[1]) : DEFAULT_MANIFEST;
    await rebaseline(file, rebaselineSources(file));
    process.stderr.write(
      `probe: observed key sets rewritten in ${path.relative(REPO_ROOT, file)}\n`,
    );
    return;
  }
  const { exit, line, usage } = await runProbe(argv);
  if (usage) process.stderr.write(`probe: ${usage}\n`);
  if (line) {
    process.stdout.write(`${JSON.stringify(line)}\n`);
    const s = summarize(line);
    if (s) process.stderr.write(`${s}\n`);
  }
  process.exitCode = exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`probe: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = EXIT.error;
  });
}
