// @ts-check
// run-smoke.mjs — `npm run smoke`: the A3a / B10 smoke (plan 10 §3.1a, §3.2; plan 04 §4.1) against the
// BUILT server over real stdio, in fixture mode on the derived league fx-10h, under EFF_TOOLSET=core
// AND EFF_TOOLSET=full: `node dist/cli.js serve` spawned by the SDK's StdioClientTransport, once per
// protocol era (legacy `initialize`; 2026-07-28 discovery) per toolset. Asserts tools/list = the
// toolset's list in tests/smoke/expected-tools.json (18 / 34, + espn_debug_echo, fixture mode only),
// no espn_prepare_*/espn_commit_*, every description ends with
// the pointer and carries no mandatory sentence, each mandatory sentence exactly once in the
// instructions, the ten resources (ttlMs + cacheScope in the modern era), the toolset's prompts (8 / 13),
// espn_get_league's untrusted name and source, espn_get_status's credential and write capability,
// G2 answering with no credential, the G3 nonce only in structuredContent, a clean stdin-EOF
// shutdown and no error-level stderr line. No network; temp dirs only. Exit 0 = pass, 1 = a check
// failed, 2 = not built. Ported from sibling @0a0c7a5, adapted.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  DEBUG_TOOL,
  REPO_ROOT,
  checkDescriptions,
  checkInstructions,
  checkPrompts,
  checkResources,
  checkToolNames,
  fixtureEnv,
  readExpectedTools,
  SMOKE_TOOLSETS,
} from "./smoke-lib.mjs";

const ENTRY = path.join(REPO_ROOT, "dist", "cli.js");

/** @param {unknown} r @returns {Record<string, unknown>} */
function bodyOf(r) {
  const content = /** @type {{ content?: { type: string, text: string }[] }} */ (r).content ?? [];
  const first = content[0];
  return first?.type === "text" ? JSON.parse(first.text) : {};
}

/**
 * One era under one toolset: spawn, list, check, close; returns the problems.
 * @param {"legacy" | "modern"} era
 * @param {"core" | "full"} toolset
 * @returns {Promise<string[]>}
 */
async function runEra(era, toolset) {
  const { root, env } = fixtureEnv({ toolset });
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "serve"],
    env,
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (/** @type {Buffer} */ b) => stderr.push(b.toString("utf8")));
  const client = new Client(
    { name: "eff-smoke", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  try {
    const t0 = performance.now();
    await client.connect(transport);
    const connectMs = Math.round(performance.now() - t0);
    const tools = await client.listTools();
    problems.push(
      ...checkToolNames(
        tools.tools.map((t) => t.name),
        readExpectedTools()[toolset],
        { fixtureMode: true },
      ),
      ...checkDescriptions(tools.tools),
      ...checkInstructions(client.getInstructions()),
      ...checkResources(await client.listResources(), await client.listResourceTemplates(), {
        requireCacheHints: era === "modern",
      }),
      ...checkPrompts(await client.listPrompts(), toolset),
    );
    const league = bodyOf(await client.callTool({ name: "espn_get_league", arguments: {} }));
    const data = /** @type {{ league?: { name?: { untrusted_text?: { value?: unknown } } } }} */ (
      league.data ?? {}
    );
    const meta = /** @type {{ source?: unknown[] }} */ (league.meta ?? {});
    if (typeof data.league?.name?.untrusted_text?.value !== "string")
      problems.push("espn_get_league: data.league.name is not untrusted_text");
    if (meta.source?.[0] !== "espn:mSettings")
      problems.push('espn_get_league: meta.source[0] is not "espn:mSettings"');
    const status = await client.callTool({ name: "espn_get_status", arguments: {} });
    if (status.isError === true) problems.push("espn_get_status returned an error");
    const sd =
      /** @type {{ credential?: { present?: unknown }, capabilities?: { write?: { lineup?: unknown } } }} */ (
        bodyOf(status).data ?? {}
      );
    if (sd.credential?.present !== false)
      problems.push("espn_get_status: credential.present is not false");
    if (sd.capabilities?.write?.lineup !== false)
      problems.push("espn_get_status: capabilities.write.lineup is not false");
    const auth = await client.callTool({ name: "espn_check_auth", arguments: {} });
    if (auth.isError === true)
      problems.push("espn_check_auth returned an error with no credential");
    const echo = await client.callTool({ name: DEBUG_TOOL, arguments: {} });
    const sc = /** @type {{ data?: { nonce?: unknown } } | undefined} */ (echo.structuredContent);
    const nonce = sc?.data?.nonce;
    if (typeof nonce !== "string" || !/^[0-9a-f]{12}$/.test(nonce))
      problems.push(`${DEBUG_TOOL}: no nonce in structuredContent`);
    else if (JSON.stringify(echo.content).includes(nonce))
      problems.push(`${DEBUG_TOOL}: the nonce leaked into the text content`);
    process.stdout.write(
      `smoke[${era}/${toolset}]: ${String(client.getNegotiatedProtocolVersion())}, connect ${String(connectMs)} ms, ${String(tools.tools.length)} tools\n`,
    );
  } catch (e) {
    problems.push(`${era}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    rmSync(root, { recursive: true, force: true });
  }
  const lines = stderr.join("").split("\n").filter(Boolean);
  for (const l of lines) {
    /** @type {unknown} */
    let rec;
    try {
      rec = JSON.parse(l);
    } catch {
      problems.push(`${era}: a non-JSON stderr line`);
      continue;
    }
    const level = /** @type {{ level?: unknown }} */ (rec).level;
    if (level === "error" || level === "fatal")
      problems.push(`${era}: stderr error: ${l.slice(0, 200)}`);
  }
  if (!lines.some((l) => l.includes('"event":"serve.shutdown"') && l.includes('"reason":"stdin"')))
    problems.push(`${era}: no clean stdin-EOF shutdown logged`);
  return problems.map((p) => `[${era}/${toolset}] ${p}`);
}

if (!existsSync(ENTRY)) {
  process.stderr.write("smoke: dist/cli.js is missing — run `npm run build` first\n");
  process.exit(2);
}
/** @type {string[]} */
const problems = [];
for (const toolset of SMOKE_TOOLSETS)
  problems.push(...(await runEra("legacy", toolset)), ...(await runEra("modern", toolset)));
for (const p of problems) process.stderr.write(`smoke: FAIL ${p}\n`);
process.stdout.write(
  problems.length === 0 ? "smoke: PASS\n" : `smoke: ${String(problems.length)} problem(s)\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
