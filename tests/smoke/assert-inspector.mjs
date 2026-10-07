// @ts-check
// assert-inspector.mjs — checks the JSON the MCP Inspector CLI printed in the CI `smoke` job (plan
// 10 A3a; B10; plan 04 §4.1): `node tests/smoke/assert-inspector.mjs [--toolset core|full]
// <tools.json> <resources.json> <templates.json> <prompts.json>`. tools/list must equal the
// toolset's list in tests/smoke/expected-tools.json (+ espn_debug_echo, fixture mode) with no
// espn_prepare_*/espn_commit_* and the pointer on every description; resources and templates must be
// the ten, prompts the toolset's (8 under core, 13 under full). Cache hints are checked only when the
// Inspector negotiated the 2026-07-28 era (they are present in its list results). Exit 0 = pass, 1 =
// fail, 2 = usage. Ported from sibling @0a0c7a5, adapted.
import { readFileSync } from "node:fs";
import {
  checkDescriptions,
  checkPrompts,
  checkResources,
  checkToolNames,
  inspectorResult,
  readExpectedTools,
  toolsetArg,
} from "./smoke-lib.mjs";

const argv = process.argv.slice(2);
const toolset = argv[0] === "--toolset" ? toolsetArg(argv[1]) : "core";
const files = argv[0] === "--toolset" ? argv.slice(2) : argv;
if (files.length !== 4 || toolset === null) {
  process.stderr.write(
    "usage: assert-inspector.mjs [--toolset core|full] <tools.json> <resources.json> <templates.json> <prompts.json>\n",
  );
  process.exit(2);
}
/** @param {string} f */
const load = (f) => inspectorResult(JSON.parse(readFileSync(f, "utf8")));
const [tools, resources, templates, prompts] = files.map(load);
/** @type {string[]} */
const problems = [];
const toolList = Array.isArray(tools?.tools) ? tools.tools : null;
if (toolList === null) problems.push("tools/list: no `tools` array in the Inspector output");
else {
  problems.push(
    ...checkToolNames(
      toolList.map((t) =>
        typeof t === "object" && t !== null ? /** @type {{ name?: unknown }} */ (t).name : null,
      ),
      readExpectedTools()[toolset],
      { fixtureMode: true },
    ),
    ...checkDescriptions(toolList),
  );
}
problems.push(
  ...checkResources(resources, templates, {
    requireCacheHints: typeof resources?.ttlMs === "number",
  }),
  ...checkPrompts(prompts, toolset),
);
for (const p of problems) process.stderr.write(`inspector smoke: FAIL ${p}\n`);
process.stdout.write(
  problems.length === 0
    ? `inspector smoke: PASS (${toolset}, ${String(toolList?.length ?? 0)} tools)\n`
    : `inspector smoke: ${String(problems.length)} problem(s)\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
