// @ts-check
// tool-sequences.mjs — the loader and argument resolver for the Lane 1 fixture dry run (plan 09 §5.1
// item 7; plan 10 A14a): reads every Skill's evals/tool_sequence.json (validated by check-skills),
// and turns a step's argument template into concrete tool arguments from the results of the earlier
// steps. The dry run itself (the server in fixture mode, EFF_FIXTURE_DIR=fixtures/espn/fx-10h) lives
// with the integration tests. Zero dependencies. Ported from sibling @c696e47, adapted (`$opponent`;
// the fixture env block).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SKILL_RULES, validateToolSequence } from "./check-skills.mjs";
import {
  REPO_ROOT,
  SKILLS_DIR,
  isRecord,
  listSkillDirs,
  readErrorCodes,
  readManifest,
} from "./_lib.mjs";

/**
 * @typedef {{ id: string, when: string, fixture_variant: string | null,
 *   steps: import("./check-skills.mjs").SeqStep[] }} LoadedSequence
 * @typedef {{ skill: string, toolset: string, env: Record<string, string>,
 *   fixture: Record<string, unknown>, sequences: LoadedSequence[] }} SkillSequences
 * @typedef {{ tool: string, result: unknown }} StepResult  the step's tool and its full envelope
 */

/**
 * Load and validate every Skill's tool_sequence.json. Throws with every problem listed when any
 * file is invalid — the dry run must never replay a sequence the checker would reject.
 * @param {string} [root]
 * @returns {SkillSequences[]}
 */
export function loadToolSequences(root = REPO_ROOT) {
  const skillsRoot = path.join(root, SKILLS_DIR);
  const manifest = readManifest(root);
  const errorCodes = readErrorCodes(root);
  const listed = listSkillDirs(skillsRoot);
  /** @type {string[]} */
  const errors = [...listed.errors];
  /** @type {SkillSequences[]} */
  const out = [];
  for (const skill of listed.skills) {
    const file = path.join(skillsRoot, skill, "evals", "tool_sequence.json");
    const where = `skills/${skill}/evals/tool_sequence.json`;
    if (!existsSync(file)) {
      errors.push(`${where}: missing`);
      continue;
    }
    /** @type {unknown} */
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${where}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const rule = SKILL_RULES[skill];
    const v = validateToolSequence(raw, {
      skill,
      where,
      manifest,
      errorCodes,
      ...(rule ? { rule } : {}),
    });
    errors.push(...v.errors);
    if (v.errors.length || !isRecord(raw)) continue;
    const rawSeqs = /** @type {Record<string, unknown>[]} */ (raw["sequences"]);
    const fixture = /** @type {Record<string, unknown>} */ (raw["fixture"]);
    out.push({
      skill,
      toolset: String(raw["toolset"]),
      env: /** @type {Record<string, string>} */ (fixture["env"]),
      fixture,
      sequences: v.sequences.map((s, i) => {
        const r = rawSeqs[i] ?? {};
        const fv = r["fixture_variant"];
        return {
          id: s.id,
          when: String(r["when"]),
          fixture_variant: typeof fv === "string" ? fv : null,
          steps: s.steps,
        };
      }),
    });
  }
  if (errors.length) throw new Error(`tool sequences are invalid:\n  ${errors.join("\n  ")}`);
  return out;
}

/**
 * Read `a.b.c` (the path after the step id) out of a result envelope.
 * @param {unknown} value
 * @param {string[]} keys
 * @param {string} ref for errors
 * @returns {unknown}
 */
function pick(value, keys, ref) {
  let cur = value;
  for (const k of keys) {
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)];
    else if (isRecord(cur) && Object.hasOwn(cur, k)) cur = cur[k];
    else throw new Error(`$ref "${ref}": no \`${k}\` in the result`);
  }
  if (cur === undefined) throw new Error(`$ref "${ref}" resolved to undefined`);
  return cur;
}

/**
 * The other team of the user's matchup in a scoreboard result (plan 07 A3: `matchups[]` with
 * `home`/`away` each carrying `team_id` and `is_mine`). Throws when the user has no matchup or a bye.
 * @param {unknown} result an espn_get_scoreboard envelope
 * @param {string} id the step id, for errors
 * @returns {number}
 */
export function opponentOf(result, id) {
  const matchups =
    isRecord(result) && isRecord(result["data"]) ? result["data"]["matchups"] : undefined;
  if (!Array.isArray(matchups))
    throw new Error(`$opponent "${id}": the result has no data.matchups`);
  for (const m of matchups) {
    if (!isRecord(m)) continue;
    const home = m["home"];
    const away = m["away"];
    const mine = (/** @type {unknown} */ side) => isRecord(side) && side["is_mine"] === true;
    const team = (/** @type {unknown} */ side) => (isRecord(side) ? side["team_id"] : undefined);
    if (mine(home) || mine(away)) {
      const other = mine(home) ? team(away) : team(home);
      if (typeof other !== "number")
        throw new Error(`$opponent "${id}": the user's matchup has no opponent (a bye?)`);
      return other;
    }
  }
  throw new Error(`$opponent "${id}": no matchup is the user's`);
}

/**
 * The first player of a roster result in `slot` (plan 07 B1: `data.players[]` with `slot`,
 * `eligible_slots[]`, `player_id`), optionally one also eligible for `eligible`.
 * @param {unknown} result an espn_get_roster envelope
 * @param {{ step: string, slot: string, eligible?: string }} spec
 * @returns {number}
 */
export function playerOf(result, spec) {
  const players =
    isRecord(result) && isRecord(result["data"]) ? result["data"]["players"] : undefined;
  if (!Array.isArray(players))
    throw new Error(`$player "${spec.step}": the result has no data.players`);
  for (const p of players) {
    if (!isRecord(p) || p["slot"] !== spec.slot) continue;
    const slots = p["eligible_slots"];
    if (spec.eligible !== undefined && !(Array.isArray(slots) && slots.includes(spec.eligible)))
      continue;
    if (typeof p["player_id"] === "number") return p["player_id"];
  }
  throw new Error(
    `$player "${spec.step}": no player in ${spec.slot}${spec.eligible ? ` eligible for ${spec.eligible}` : ""}`,
  );
}

/**
 * Resolve a step's argument template: every `{ $ref: "<step>.<path>" }` becomes the value at that
 * path of that step's result envelope; every `{ $source_calls: [ids] }` becomes
 * `[{ tool, request_id }]` from those steps (`meta.request_id`); every `{ $opponent: "<step>" }`
 * becomes the opponent's `team_id` from that scoreboard step; every `{ $player: { step, slot,
 * eligible? } }` becomes a `player_id` from that roster step. Plain values are deep-copied.
 * @param {unknown} template
 * @param {ReadonlyMap<string, StepResult>} results completed steps by id
 * @returns {unknown}
 */
export function resolveArgs(template, results) {
  if (Array.isArray(template)) return template.map((x) => resolveArgs(x, results));
  if (!isRecord(template)) return template;
  if (Object.hasOwn(template, "$ref")) {
    const ref = template["$ref"];
    if (typeof ref !== "string") throw new Error("$ref must be a string");
    const [id = "", ...keys] = ref.split(".");
    const done = results.get(id);
    if (!done) throw new Error(`$ref "${ref}": step ${id} has no result`);
    return structuredClone(pick(done.result, keys, ref));
  }
  if (Object.hasOwn(template, "$source_calls")) {
    const list = template["$source_calls"];
    if (!Array.isArray(list)) throw new Error("$source_calls must be an array of step ids");
    return list.map((id) => {
      const done = results.get(String(id));
      if (!done) throw new Error(`$source_calls: step ${String(id)} has no result`);
      const requestId = pick(done.result, ["meta", "request_id"], `${String(id)}.meta.request_id`);
      return { tool: done.tool, request_id: requestId };
    });
  }
  if (Object.hasOwn(template, "$opponent")) {
    const id = template["$opponent"];
    if (typeof id !== "string") throw new Error("$opponent must be a step id");
    const done = results.get(id);
    if (!done) throw new Error(`$opponent "${id}": step has no result`);
    return opponentOf(done.result, id);
  }
  if (Object.hasOwn(template, "$player")) {
    const spec = template["$player"];
    if (!isRecord(spec) || typeof spec["step"] !== "string" || typeof spec["slot"] !== "string") {
      throw new Error("$player must be { step, slot, eligible? }");
    }
    const done = results.get(spec["step"]);
    if (!done) throw new Error(`$player "${spec["step"]}": step has no result`);
    const eligible = spec["eligible"];
    return playerOf(done.result, {
      step: spec["step"],
      slot: spec["slot"],
      ...(typeof eligible === "string" ? { eligible } : {}),
    });
  }
  // Object.fromEntries defines own properties, so a `__proto__` key stays a key (an assignment
  // would set the prototype and drop it)
  return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, resolveArgs(v, results)]));
}

/**
 * Whether a step's outcome is one its `expect` list allows: `"ok"` for a success, or the error code.
 * @param {{ expect: readonly string[] }} step
 * @param {string} outcome `"ok"` or a plan 01 §4.3 error code
 */
export function outcomeAllowed(step, outcome) {
  return step.expect.includes(outcome);
}
