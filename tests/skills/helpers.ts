// helpers.ts — temporary repository trees for the Skills tooling tests (plan 09 §4, §5.1; plan 05 §2
// "adversarial by default"): a copy of the real skills/ bundle plus the files the scripts read, so
// every failure case mutates a private copy and never the working tree. Ported from sibling @c696e47,
// adapted (the manifest beside the scripts; an empty scanner deny-list).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The eight P0 Skills (plan 09 §1; plan 10 §3.1a). */
export const SKILLS = [
  "apply",
  "onboard",
  "retro",
  "session-check",
  "start-sit",
  "stream-kdef",
  "waivers",
  "weekly",
] as const;

/**
 * An empty, readable scanner deny-list, so the tests never read the developer's real one and stay
 * identical locally and in CI (scripts/dev/scan-secrets.mjs reads $EFF_SCAN_DENYLIST first).
 */
export function emptyDenylist(): { env: Record<string, string>; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-skills-deny-")));
  const file = path.join(dir, "deny.txt");
  writeFileSync(file, "# no terms\n");
  return {
    env: { EFF_SCAN_DENYLIST: file },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh temporary repository: `cleanup()` removes it. */
export interface TempRepo {
  readonly root: string;
  readonly cleanup: () => void;
  /** Absolute path of a repository-relative file. */
  readonly p: (rel: string) => string;
  readonly read: (rel: string) => string;
  readonly write: (rel: string, body: string | object) => void;
  /** Replace `from` (must occur) with `to` in a file. */
  readonly edit: (rel: string, from: string | RegExp, to: string) => void;
  readonly readJson: (rel: string) => unknown;
  /** Read, mutate in place and write back a JSON file (the callback's return value is ignored). */
  readonly editJson: (rel: string, fn: (j: Record<string, unknown>) => unknown) => void;
}

/**
 * Copy the real skills/ bundle and the files the scripts read (package.json, src/mcp/envelope.ts,
 * src/mcp/errors.ts, scripts/skills/, scripts/dev/scan-secrets.mjs) into a temp directory.
 */
export function tempRepo(opts: { skills?: boolean } = {}): TempRepo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "eff-skills-")));
  const copy = (rel: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  };
  copy("package.json");
  copy("src/mcp/envelope.ts");
  copy("src/mcp/errors.ts");
  copy("scripts/skills");
  copy("scripts/dev/scan-secrets.mjs");
  if (opts.skills !== false) copy("skills");
  const p = (rel: string) => path.join(root, rel);
  const read = (rel: string) => readFileSync(p(rel), "utf8");
  const write = (rel: string, body: string | object) => {
    mkdirSync(path.dirname(p(rel)), { recursive: true });
    writeFileSync(p(rel), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  };
  const readJson = (rel: string) => JSON.parse(read(rel)) as unknown;
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
    p,
    read,
    write,
    edit: (rel, from, to) => {
      const cur = read(rel);
      const next = cur.replace(from, to);
      if (next === cur) throw new Error(`edit: pattern not found in ${rel}: ${String(from)}`);
      write(rel, next);
    },
    readJson,
    editJson: (rel, fn) => {
      const j = readJson(rel) as Record<string, unknown>;
      fn(j);
      write(rel, j);
    },
  };
}

/** Run one of scripts/skills/*.mjs as a child process (argument array, no shell). */
export function runScript(
  script: "build-skills.mjs" | "check-skills.mjs",
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "skills", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A tool_sequence.json step, as the tests read it. */
export interface SeqStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  expect?: string[];
  note?: string;
}
/** A tool_sequence.json file, as the tests read it. */
export interface SeqFile {
  skill: string;
  toolset: string;
  fixture: Record<string, unknown>;
  sequences: { id: string; when: string; fixture_variant?: string; steps: SeqStep[] }[];
}

/** Read a Skill's tool_sequence.json from the real tree. */
export function readSequence(skill: string): SeqFile {
  return JSON.parse(
    readFileSync(path.join(ROOT, "skills", skill, "evals", "tool_sequence.json"), "utf8"),
  ) as SeqFile;
}
