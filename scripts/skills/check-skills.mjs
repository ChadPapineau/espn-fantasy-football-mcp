#!/usr/bin/env node
// @ts-check
// check-skills.mjs — Lane 1 of the Skills eval plan (plan 09 §5.1 items 1–6, K4–K7; research 06
// §C.3, §E.3; plan 10 A14a): zero tokens, every push. Items 7–10 (the fixture dry run, tool-level
// injection invariance, the mocks, `claude plugin validate`) need the server and live with the
// integration tests; this script validates every tool_sequence.json so the dry run has well-formed
// input (tool-sequences.mjs is its loader). Zero dependencies. Ported from sibling @c696e47,
// adapted (ESPN tool grammar and the P1-labelled-step rule; the eight disallowed-tools strings; both
// guardrail sentences; error-code and identifier rules; the skill-creator evals.json schema).
// Phase 2 (plan 09 §3.8 usage branch, §3.3 live P(win), §3.9–§3.13; plan 10 B10, B11): the five P1
// Skills validated under `full` with their Step 0 stop under `core`, a P0 Skill's P1 sequences and
// cases under `full` (the toolset stated per sequence and per case), and the collision check across
// all thirteen.
//
// Usage: node scripts/skills/check-skills.mjs [--root <repo root>] [--no-scan]
// Exit:  0 clean · 1 findings · 2 usage error.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildSkills } from "./build-skills.mjs";
import {
  ESPN_FREE_TEXT_CLAUSE,
  REPO_ROOT,
  SKILLS_DIR,
  TOOL_VERBS,
  beginMarker,
  errMsg,
  isMain,
  isRecord,
  listSkillDirs,
  parseFrontmatter,
  readErrorCodes,
  readExpectedTools,
  readManifest,
  readMandatorySentences,
  readPackageVersion,
  readRegistryContract,
  walkFiles,
} from "./_lib.mjs";

/** plan 09 §2 / §5.1 item 1 (sib ADV OBJ-08): the listing budget per Skill. */
export const DESCRIPTION_MAX = 350;
/** The platform's hard cap on `description` (research 06 §A.0). */
export const DESCRIPTION_HARD_MAX = 1024;
/** Claude Code truncates description + when_to_use at 1 536 characters. */
export const LISTING_MAX = 1536;
/** plan 07 §5.1 [A-4]: the whole Skills listing (every description) ≤ 4 600 characters. */
export const SKILLS_LISTING_MAX = 4600;
/** plan 09 §2: SKILL.md body ≤ 500 lines. */
export const BODY_MAX_LINES = 500;
/** plan 04 §4.2: no file over 200 KB. */
export const FILE_MAX_BYTES = 200 * 1024;
/** plan 09 §5.1 item 5: ≥ 6 positives and ≥ 6 negatives per trigger_eval.json. */
export const MIN_TRIGGERS = 6;
/** plan 09 §2: ≥ 2 negatives naming another platform. */
export const MIN_OTHER_PLATFORM_NEGATIVES = 2;
/** The brief: ≥ 3 Lane 2 cases per Skill, one of them `-INJ` (plan 09 K7). */
export const MIN_CASES = 3;
/** Near-duplicate threshold for positives of two different Skills (token Jaccard). */
export const NEAR_DUPLICATE_JACCARD = 0.75;
/** The words every description carries (plan 09 §2; research 06 §C.3 item 2). */
export const PLATFORM_PHRASE = "in the user's ESPN league";
/** Frontmatter keys a SKILL.md may carry (standard + the Claude Code extensions plan 09 §2 uses). */
export const ALLOWED_FRONTMATTER = Object.freeze([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "disallowed-tools",
  "disable-model-invocation",
  "metadata",
  "license",
  "compatibility",
]);
/** The output-contract headings (plan 09 §2 `output-template.md`). */
export const OUTPUT_HEADINGS = Object.freeze([
  "Recommendation",
  "Numbers",
  "Why",
  "What would change my mind",
  "Confidence & freshness",
  "Deadline",
  "Log",
  "Attribution",
]);
/** The shared files stamped into a body (guardrails verbatim in every body — plan 09 §2). */
export const GUARDRAILS_BLOCK = "guardrails.md";
export const TEMPLATE_BLOCK = "output-template.md";
/** Skills whose answer is not a recommendation (plan 09 §3.6 manual steps; §3.7 one status line). */
export const NO_TEMPLATE_SKILLS = Object.freeze(["apply", "session-check"]);
/** The cookie guardrail (plan 09 §2 guardrail 5): every body carries it. */
export const COOKIE_LINE = "Never ask for, accept, echo or forward `espn_s2` or `SWID` in chat";
/** The Phase W seam marker (plan 10 §3.W; D11) — the apply Skill declares it. */
export const SEAM_MARKER = "PHASE W SEAM — NOT IMPLEMENTED";
/** The time-blind game-day prompts that must route to start-sit and nothing else (plan 09 §3.3). */
export const GAME_DAY_PROMPTS = Object.freeze([
  "who should I start?",
  "X is inactive, who goes in?",
  "what can I still change?",
  "what are my odds right now?",
]);
/** The Skill that owns the game-day prompts. */
export const GAME_DAY_OWNER = "start-sit";
/**
 * The P1 Skills' Step 0 stop under `core` (plan 09 §2 `orient.md`; plan 10 B10; ADV OBJ-18) —
 * every P1 body carries it verbatim, so a `core` user is told how to turn the Skill on.
 */
export const TOOLSET_STOP =
  "this Skill needs the full toolset — set `EFF_TOOLSET=full` in the server's env and restart the client";
/** ESPN's injury statuses (src/domain/league/types.ts) a `$player` template may filter on. */
export const INJURY_STATUSES = Object.freeze([
  "ACTIVE",
  "QUESTIONABLE",
  "DOUBTFUL",
  "OUT",
  "INJURY_RESERVE",
  "DAY_TO_DAY",
  "SUSPENSION",
]);
/** A Lane 2 case that checks a P1 Skill's Step 0 stop under `core` (plan 10 B10). */
export const CORE_CASE_RE = /-CORE$/;
/** Another platform, named by a negative trigger (plan 09 §2). */
export const OTHER_PLATFORM_RE = /\b(?:yahoo|sleeper)\b/i;
/** A line that labels a P1 step inside a P0 Skill (plan 09 §2 `orient.md`; changelog F45). */
export const P1_LABEL_RE = /\(P1\b|\*\*P1\b|\bP1:/;
/** Lane 2 grader kinds (plan 09 §5.2; research 06 §D.0 — the free three plus the paid `llm`). */
export const GRADERS = Object.freeze([
  "tool_used",
  "tool_order",
  "regex",
  "regex_absent",
  "llm",
  "file_exists",
]);

/** @typedef {{ id: string, tool: string, args: Record<string, unknown>, expect: string[] }} SeqStep */
/**
 * A validated sequence: `toolset` is the one it runs under — the file's, or `full` for a P0 Skill's
 * P1 sequence (plan 09 §5.1 item 3: a P1-labelled step inside a P0 Skill is validated under `full`).
 * @typedef {{ id: string, toolset: string, fixture_variant: string | null, steps: SeqStep[] }} Sequence
 */
/**
 * `p1Cases`: a P0 Skill's Lane 2 cases that exercise its P1 branch and so run under `full`;
 * `bodyAbsent`: words the body must not use (news-check: no "posterior" at P1 — plan 09 §3.13).
 * @typedef {{ prefix: string, kinds: string[], records: boolean, requiredCases: string[],
 *   p1Cases?: string[], body: RegExp[], bodyAbsent?: RegExp[],
 *   sequences: (seqs: Sequence[]) => string[] }} SkillRule
 */

/**
 * @param {Sequence} seq
 * @param {string} tool
 */
const stepsOf = (seq, tool) => seq.steps.filter((s) => s.tool === tool);
/**
 * @param {Sequence} seq
 * @param {string} a
 * @param {string} b
 */
const before = (seq, a, b) => {
  const ia = seq.steps.findIndex((s) => s.tool === a);
  const ib = seq.steps.findIndex((s) => s.tool === b);
  return ia !== -1 && ib !== -1 && ia < ib;
};
/**
 * True when `seq` calls the tools in this order (a subsequence).
 * @param {Sequence} seq
 * @param {string[]} order
 */
const inOrder = (seq, order) => {
  let at = 0;
  for (const s of seq.steps) if (s.tool === order[at]) at++;
  return at === order.length;
};
/** @param {unknown} pos */
const isKdst = (pos) =>
  Array.isArray(pos) && pos.length > 0 && pos.every((p) => p === "K" || p === "D/ST");

/**
 * The log `kind` a producer's `data.rec` must be recorded under (sibling QA-1-065: the
 * retrospective scores swap regret only for `lineup`, so a lineup rec logged as anything else is
 * never judged). K/D-ST streaming is `stream`; every other waiver rec is `waiver`.
 * @param {SeqStep} producer
 * @returns {string | undefined}
 */
export function recKindOf(producer) {
  switch (producer.tool) {
    case "espn_analyze_lineup":
      return "lineup";
    case "espn_analyze_retrospective":
      return "retro";
    case "espn_analyze_waivers":
      return isKdst(producer.args["positions"]) ? "stream" : "waiver";
    case "espn_analyze_matchup":
      return "matchup";
    case "espn_analyze_trade":
      return "trade";
    case "espn_analyze_injury_cascade":
      return "cascade";
    case "espn_analyze_schedule":
      return "schedule";
    case "espn_analyze_roster":
      return "roster";
    case "espn_analyze_evidence":
      return "evidence";
    default:
      return undefined;
  }
}

/**
 * A literal integer in [lo, hi] or a `$`-template (resolved at run time).
 * @param {unknown} v
 * @param {number} lo
 * @param {number} hi
 */
const intOrTemplate = (v, lo, hi) =>
  (isRecord(v) && Object.keys(v).some((k) => k.startsWith("$"))) ||
  (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi);

/**
 * Plan 07 E6's `offer` (`{ partner_team_id, give: player_id[1..6], get: player_id[1..6] }`) and
 * `find_partners` (`{ need_position, max_partners?: 1..4 }`) — the problems in one call's arguments.
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
export function tradeArgProblems(args) {
  /** @type {string[]} */
  const e = [];
  const o = args["offer"];
  const f = args["find_partners"];
  if ((o === undefined) === (f === undefined)) {
    e.push("espn_analyze_trade takes exactly one of `offer` and `find_partners` (plan 07 E6)");
  }
  if (o !== undefined) {
    if (!isRecord(o)) e.push("espn_analyze_trade.offer must be an object");
    else {
      const extra = Object.keys(o).filter((k) => !["partner_team_id", "give", "get"].includes(k));
      if (extra.length) e.push(`espn_analyze_trade.offer has unknown keys ${extra.join(", ")}`);
      if (!intOrTemplate(o["partner_team_id"], 1, 999))
        e.push("espn_analyze_trade.offer.partner_team_id must be a team id");
      for (const side of ["give", "get"]) {
        const ids = o[side];
        // a whole-list template is a partner search's proposal (`partners[].proposal.give`)
        if (isRecord(ids) && Object.keys(ids).some((k) => k.startsWith("$"))) continue;
        if (
          !Array.isArray(ids) ||
          ids.length < 1 ||
          ids.length > 6 ||
          !ids.every((x) => intOrTemplate(x, 1, 2147483647))
        ) {
          e.push(`espn_analyze_trade.offer.${side} must list 1–6 player ids`);
        }
      }
    }
  }
  if (f !== undefined) {
    if (!isRecord(f)) e.push("espn_analyze_trade.find_partners must be an object");
    else {
      const extra = Object.keys(f).filter((k) => !["need_position", "max_partners"].includes(k));
      if (extra.length)
        e.push(`espn_analyze_trade.find_partners has unknown keys ${extra.join(", ")}`);
      if (
        typeof f["need_position"] !== "string" ||
        !/^[A-Za-z][A-Za-z/]{0,9}$/.test(f["need_position"])
      )
        e.push("espn_analyze_trade.find_partners.need_position must be a position name");
      if (f["max_partners"] !== undefined && !intOrTemplate(f["max_partners"], 1, 4))
        e.push("espn_analyze_trade.find_partners.max_partners must be 1–4 (plan 09 §3.9)");
    }
  }
  return e;
}

/**
 * Plan 07 E10's `claim` (`{ text ≤ 400, source? ≤ 64, time?, type? }`) — the problems in it. The
 * text is the user's own pasted words: a literal here, never a template that could copy an outlook,
 * a headline or a name out of an earlier result into a tool argument (plan 02 §6.4).
 * @param {unknown} claim
 * @returns {string[]}
 */
export function claimProblems(claim) {
  if (claim === undefined) return [];
  if (!isRecord(claim)) return ["espn_analyze_evidence.claim must be an object"];
  /** @type {string[]} */
  const e = [];
  const extra = Object.keys(claim).filter((k) => !["text", "source", "time", "type"].includes(k));
  if (extra.length) e.push(`espn_analyze_evidence.claim has unknown keys ${extra.join(", ")}`);
  const t = claim["text"];
  if (typeof t !== "string" || t.trim() === "" || t.length > 400) {
    e.push(
      "espn_analyze_evidence.claim.text must be the user's own words, 1–400 characters — never a value copied from a tool result",
    );
  }
  const s = claim["source"];
  if (s !== undefined && (typeof s !== "string" || s.length === 0 || s.length > 64))
    e.push("espn_analyze_evidence.claim.source must be 1–64 characters");
  const tm = claim["time"];
  if (tm !== undefined && (typeof tm !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(tm)))
    e.push("espn_analyze_evidence.claim.time must be an ISO instant");
  return e;
}

/**
 * The kinds a SKILL.md body tells the model to log: every `` `kind: "x"` `` on a line that names
 * `espn_record_recommendation`.
 * @param {string} body
 */
export function bodyRecordKinds(body) {
  /** @type {Set<string>} */
  const kinds = new Set();
  for (const line of body.split("\n")) {
    if (!line.includes("espn_record_recommendation")) continue;
    for (const m of line.matchAll(/`kind: "([a-z_]+)"`/g)) kinds.add(m[1] ?? "");
  }
  return [...kinds].sort();
}

/** The six `weekly` sections (plan 09 §3.2 "six sections each compressed to one table"). */
export const WEEKLY_HEADINGS = Object.freeze([
  "Last week",
  "This week's matchup and lineup",
  "Waivers",
  "K and D/ST",
  "Injuries and byes",
  "League activity",
]);

/** @param {string} h */
const heading = (h) => new RegExp(`^#{2,4} ${h.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m");

/** Per-Skill promises (plan 09 §3 "Evals — Lane 1"; plan 10 A9b case lists). */
export const SKILL_RULES = /** @type {Readonly<Record<string, SkillRule>>} */ (
  Object.freeze({
    onboard: {
      prefix: "ON",
      kinds: ["onboarding"],
      records: true,
      requiredCases: ["ON-1", "ON-2", "ON-3", "ON-4-E", "ON-5-E", "ON-INJ"],
      body: [
        /\bmismatch\b/,
        /\bmatch\b/,
        /\bIR\b/,
        /eff setup --seeding/,
        /seeding_evidence/,
        /mismatch_share/,
      ],
      sequences: (seqs) =>
        seqs.some((s) =>
          inOrder(s, [
            "espn_get_league",
            "espn_get_roster",
            "espn_get_box_score",
            "espn_record_recommendation",
          ]),
        )
          ? []
          : [
              "no sequence calls espn_get_league → espn_get_roster → espn_get_box_score → espn_record_recommendation",
            ],
    },
    weekly: {
      prefix: "WK",
      kinds: ["lineup", "waiver", "stream"],
      records: true,
      requiredCases: ["WK-1", "WK-2", "WK-3", "WK-4-E", "WK-5-E", "WK-INJ"],
      body: [
        ...WEEKLY_HEADINGS.map(heading),
        /never re-fetch/i,
        /next_execution/,
        /last_execution/,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => before(s, "espn_project_players", "espn_analyze_lineup"))) {
          e.push("no sequence calls espn_project_players before espn_analyze_lineup");
        }
        for (const s of seqs) {
          if (stepsOf(s, "espn_analyze_lineup").length > 1) {
            e.push(`sequence ${s.id}: espn_analyze_lineup at most once per briefing`);
          }
        }
        return e;
      },
    },
    "start-sit": {
      prefix: "SS",
      kinds: ["lineup", "matchup"],
      records: true,
      requiredCases: [
        "SS-1",
        "SS-2",
        "SS-3",
        "SS-4",
        "SS-5-E",
        "SS-6-E",
        "SS-7",
        "SS-8",
        "SS-9",
        "SS-10-E",
        "SS-11-E",
        "SS-INJ",
        "SS-INJ-2",
      ],
      p1Cases: ["SS-11-E"],
      body: [
        /only_unlocked/,
        /lineup_locked/,
        /lock_schedule/,
        /coin flip/i,
        /option value/i,
        /percent_started/,
        /espn_get_live_scoreboard/,
        /win_probability_espn/,
        /mode: "live"/,
        /final, live and pending|final \/ live \/ pending/,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => before(s, "espn_project_players", "espn_analyze_lineup"))) {
          e.push("no sequence calls espn_project_players before espn_analyze_lineup");
        }
        const gameDay = seqs.filter((s) => s.id.startsWith("game_day"));
        const pre = seqs.filter((s) => !s.id.startsWith("game_day"));
        if (
          !pre.some((s) =>
            stepsOf(s, "espn_analyze_lineup").some((x) => x.args["objective"] === "auto"),
          )
        ) {
          e.push('the pre-game espn_analyze_lineup must carry objective: "auto" (plan 09 §3.3)');
        }
        const lineups = seqs.flatMap((s) => stepsOf(s, "espn_analyze_lineup"));
        if (
          !lineups.some((x) => Array.isArray(x.args["compare"]) && x.args["compare"].length > 0)
        ) {
          e.push("no espn_analyze_lineup step shows `compare` for a named pair");
        }
        if (!seqs.some((s) => s.id === "game_day"))
          e.push("no `game_day` sequence (the branch selected by lineup_locked/lock_schedule)");
        for (const gd of gameDay) {
          if (!stepsOf(gd, "espn_analyze_lineup").some((x) => x.args["only_unlocked"] === true)) {
            e.push(`the ${gd.id} sequence's espn_analyze_lineup must carry only_unlocked: true`);
          }
          if (stepsOf(gd, "espn_get_live_scoreboard").length === 0) {
            e.push(`the ${gd.id} sequence must call espn_get_live_scoreboard`);
          }
          if (
            stepsOf(gd, "espn_get_roster").filter((x) => x.args["force_refresh"] === true).length >
            1
          ) {
            e.push(`the ${gd.id} sequence forces a roster refresh at most once`);
          }
          for (const m of stepsOf(gd, "espn_analyze_matchup")) {
            if (m.args["mode"] !== "live")
              e.push(`the ${gd.id} sequence's espn_analyze_matchup must carry mode: "live"`);
          }
        }
        // the P1 live-P(win) branch (plan 09 §3.3 game-day step 5; plan 10 B9)
        const live = seqs.find((s) => s.id === "game_day_live");
        if (!live) e.push("no `game_day_live` sequence (the P1 live P(win) branch under full)");
        else {
          if (live.toolset !== "full")
            e.push('the game_day_live sequence runs under toolset "full" (it calls a P1 tool)');
          if (!before(live, "espn_analyze_matchup", "espn_analyze_lineup"))
            e.push(
              "game_day_live: espn_analyze_matchup (mode live) comes before espn_analyze_lineup",
            );
          const kinds = stepsOf(live, "espn_record_recommendation").map((x) => x.args["kind"]);
          if (!kinds.includes("matchup") || !kinds.includes("lineup"))
            e.push("game_day_live logs both the matchup rec and the lineup rec");
        }
        for (const s of pre) {
          if (stepsOf(s, "espn_analyze_matchup").length)
            e.push(`sequence ${s.id}: espn_analyze_matchup belongs to the game-day branch`);
        }
        return e;
      },
    },
    "stream-kdef": {
      prefix: "KD",
      kinds: ["stream"],
      records: true,
      requiredCases: ["KD-1", "KD-2", "KD-3", "KD-4-E", "KD-INJ"],
      body: [/look_ahead: 2/, /implied total/i, /two weeks/i, /fa_add_after_run/, /hold_vs_stream/],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        const all = seqs.flatMap((s) => stepsOf(s, "espn_analyze_waivers"));
        if (all.length === 0) e.push("no espn_analyze_waivers step");
        for (const s of seqs) {
          if (
            stepsOf(s, "espn_analyze_waivers").length &&
            !before(s, "espn_get_schedule", "espn_analyze_waivers")
          ) {
            e.push(`sequence ${s.id}: espn_get_schedule must come before espn_analyze_waivers`);
          }
        }
        for (const w of all) {
          if (w.args["look_ahead"] !== 2) e.push("espn_analyze_waivers must carry look_ahead: 2");
          const pos = w.args["positions"];
          if (!isKdst(pos)) e.push("espn_analyze_waivers positions must be a subset of [K, D/ST]");
          else if (Array.isArray(pos) && pos.length !== 1) {
            // one hold_vs_stream and one rec per result (plan 07 E5): one position per call
            e.push("espn_analyze_waivers must rank exactly one position per call (K, then D/ST)");
          }
        }
        return e;
      },
    },
    retro: {
      prefix: "RT",
      kinds: ["retro"],
      records: true,
      requiredCases: ["RT-1", "RT-2", "RT-3", "RT-4-E", "RT-INJ"],
      body: [
        /regret/i,
        /Brier|CRPS/,
        /followed/,
        /provisional/i,
        /n too small/i,
        /not informative in v1/,
      ],
      sequences: (seqs) =>
        seqs.some((s) => stepsOf(s, "espn_analyze_retrospective").length)
          ? []
          : ["no espn_analyze_retrospective step"],
    },
    apply: {
      prefix: "AP",
      kinds: [],
      records: false,
      requiredCases: ["AP-2", "AP-4", "AP-INJ"],
      body: [
        /PHASE W SEAM — NOT IMPLEMENTED/,
        /\bFLEX\b/,
        /\bBE\b/,
        /\bIR\b/,
        /Roster → Edit lineup/,
        /capabilities\.write/,
        /next_execution/,
      ],
      sequences: (seqs) =>
        seqs.some((s) => stepsOf(s, "espn_record_recommendation").length)
          ? [
              "apply records nothing in read-only mode: the source recommendation already holds a log_id",
            ]
          : [],
    },
    "session-check": {
      prefix: "SC",
      kinds: [],
      records: false,
      requiredCases: ["SC-1", "SC-2", "SC-3", "SC-4", "SC-INJ"],
      body: [/DevTools/, /eff setup/, /espn_check_auth/, /once/i, /fantasy\.espn\.com/],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        for (const s of seqs) {
          if (stepsOf(s, "espn_check_auth").length > 1)
            e.push(`sequence ${s.id}: espn_check_auth at most once`);
          if (stepsOf(s, "espn_record_recommendation").length) {
            e.push(`sequence ${s.id}: session-check logs no recommendation (plan 09 §3.7)`);
          }
        }
        return e;
      },
    },
    waivers: {
      prefix: "WV",
      kinds: ["waiver"],
      records: true,
      requiredCases: ["WV-1", "WV-2", "WV-3-E", "WV-4-E", "WV-5-E", "WV-6-E", "WV-7-E", "WV-INJ"],
      p1Cases: ["WV-2", "WV-3-E"],
      body: [
        /marginal/,
        /premium_band/,
        /scramble/i,
        /next_execution/,
        /value_basis/,
        /s_with_ir_move/,
        /cold_start_table/,
        /xfp_gap/,
        /signals\[\]/,
        /bid curve/i,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => before(s, "espn_list_players", "espn_analyze_waivers"))) {
          e.push("no sequence calls espn_list_players before espn_analyze_waivers");
        }
        // the P1 usage branch (plan 09 §3.8 Lane 1: espn_get_player_usage before the decision)
        const usage = seqs.filter((s) => stepsOf(s, "espn_get_player_usage").length > 0);
        if (!usage.some((s) => before(s, "espn_get_player_usage", "espn_analyze_waivers"))) {
          e.push(
            "no sequence calls espn_get_player_usage before espn_analyze_waivers (the P1 usage branch)",
          );
        }
        for (const s of usage) {
          if (s.toolset !== "full")
            e.push(`sequence ${s.id}: the usage branch runs under toolset "full"`);
        }
        if (!seqs.some((s) => s.fixture_variant === "faab" && s.toolset === "full")) {
          e.push('no sequence on the faab variant under toolset "full" (the P1 bid curve)');
        }
        for (const s of seqs) {
          for (const w of stepsOf(s, "espn_analyze_waivers")) {
            if (w.args["mode"] !== "auto")
              e.push(`sequence ${s.id}: espn_analyze_waivers must carry mode: "auto"`);
          }
          if (
            stepsOf(s, "espn_analyze_waivers").length &&
            !before(s, "espn_analyze_waivers", "espn_record_recommendation")
          ) {
            e.push(
              `sequence ${s.id}: espn_analyze_waivers must come before espn_record_recommendation`,
            );
          }
        }
        return e;
      },
    },
    // --- the five P1 Skills (plan 09 §3.9–§3.13; plan 10 B11) — every sequence runs under full ---
    trade: {
      prefix: "TR",
      kinds: ["trade"],
      records: true,
      requiredCases: ["TR-1", "TR-2", "TR-3", "TR-4", "TR-5-E", "TR-INJ", "TR-CORE"],
      body: [
        /devil's advocate/i,
        /delta_u/,
        /why_they_accept/,
        /implied_drop/,
        /veto/,
        /rules\.trade\.deadline/,
        /espn\.team\.trade_block/,
        /crowd_value_espn/,
        /seeding_mode: "both"/,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        const trades = seqs.flatMap((s) => stepsOf(s, "espn_analyze_trade"));
        if (!trades.some((t) => t.args["offer"] !== undefined))
          e.push("no espn_analyze_trade step evaluates an `offer`");
        if (!trades.some((t) => t.args["find_partners"] !== undefined))
          e.push("no espn_analyze_trade step runs a partner search (`find_partners`)");
        for (const s of seqs) {
          for (const t of stepsOf(s, "espn_analyze_trade"))
            for (const p of tradeArgProblems(t.args)) e.push(`sequence ${s.id}: ${p}`);
          if (!stepsOf(s, "espn_analyze_trade").length) continue;
          if (!before(s, "espn_project_players", "espn_analyze_trade"))
            e.push(`sequence ${s.id}: espn_project_players comes before espn_analyze_trade`);
          if (!before(s, "espn_analyze_replacement", "espn_analyze_trade"))
            e.push(`sequence ${s.id}: espn_analyze_replacement comes before espn_analyze_trade`);
          for (const p of stepsOf(s, "espn_project_players")) {
            if (p.args["horizon"] !== "ros")
              e.push(`sequence ${s.id}: a trade is valued rest-of-season — horizon: "ros"`);
          }
        }
        return e;
      },
    },
    "injury-cascade": {
      prefix: "IC",
      kinds: ["cascade"],
      records: true,
      requiredCases: ["IC-1", "IC-2", "IC-3", "IC-INJ", "IC-CORE"],
      body: [
        /news-check/,
        /hypothesis_only/,
        /ir_consequence/,
        /p_role_holds/,
        /1:1/,
        /expected_weeks/,
        /structured_disagrees/,
        /`OUT` or `INJURY_RESERVE`/,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => stepsOf(s, "espn_analyze_injury_cascade").length))
          e.push("no espn_analyze_injury_cascade step");
        for (const s of seqs) {
          if (!stepsOf(s, "espn_analyze_injury_cascade").length) continue;
          if (!before(s, "espn_get_depth_chart", "espn_analyze_injury_cascade"))
            e.push(
              `sequence ${s.id}: espn_get_depth_chart comes before espn_analyze_injury_cascade`,
            );
          if (!before(s, "espn_get_player_usage", "espn_analyze_injury_cascade"))
            e.push(
              `sequence ${s.id}: espn_get_player_usage comes before espn_analyze_injury_cascade`,
            );
          for (const u of stepsOf(s, "espn_get_player_usage")) {
            if (u.args["window"] !== 6 || u.args["include_prior_season"] !== true)
              e.push(
                `sequence ${s.id}: the team's usage reads window: 6 with include_prior_season: true`,
              );
          }
          for (const w of stepsOf(s, "espn_analyze_waivers")) {
            if (w.args["mode"] !== "auto")
              e.push(`sequence ${s.id}: espn_analyze_waivers must carry mode: "auto"`);
            if (!before(s, "espn_analyze_injury_cascade", "espn_analyze_waivers"))
              e.push(`sequence ${s.id}: the beneficiaries are priced after the cascade`);
          }
        }
        if (!seqs.some((s) => before(s, "espn_analyze_injury_cascade", "espn_analyze_waivers")))
          e.push("no sequence prices the beneficiaries with espn_analyze_waivers");
        return e;
      },
    },
    "schedule-plan": {
      prefix: "SP",
      kinds: ["schedule"],
      records: true,
      requiredCases: ["SP-1", "SP-2", "SP-3", "SP-4-E", "SP-5-E", "SP-INJ", "SP-CORE"],
      body: [
        /marginal-values table/i,
        /coast/i,
        /seeding_mode: "both"/,
        /shrink_w/,
        /week 17/i,
        /playoff_pct_espn/,
        /pf_per_win/,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => stepsOf(s, "espn_analyze_schedule").length))
          e.push("no espn_analyze_schedule step");
        for (const s of seqs) {
          for (const m of stepsOf(s, "espn_analyze_matchup")) {
            if (m.args["mode"] !== "season")
              e.push(`sequence ${s.id}: espn_analyze_matchup carries mode: "season"`);
          }
          if (
            stepsOf(s, "espn_analyze_schedule").length &&
            !before(s, "espn_analyze_matchup", "espn_analyze_schedule")
          ) {
            e.push(
              `sequence ${s.id}: espn_analyze_matchup (mode season) comes before espn_analyze_schedule`,
            );
          }
        }
        if (
          !seqs.some(
            (s) =>
              s.fixture_variant === "seeding-unknown" &&
              stepsOf(s, "espn_analyze_matchup").some((m) => m.args["seeding_mode"] === "both"),
          )
        ) {
          e.push(
            'no sequence on seeding-unknown passes seeding_mode: "both" explicitly (ADV OBJ-13)',
          );
        }
        return e;
      },
    },
    "roster-audit": {
      prefix: "RA",
      kinds: ["roster"],
      records: true,
      requiredCases: ["RA-1", "RA-2", "RA-3-E", "RA-4-E", "RA-INJ", "RA-CORE"],
      body: [
        /ir\.invalid/,
        /hidden-bench/i,
        /three risks/i,
        /bench_template/,
        /streamability/,
        /after the (?:waiver )?run/,
        /eliminated/,
        /acquisition/i,
      ],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => stepsOf(s, "espn_analyze_roster").length))
          e.push("no espn_analyze_roster step");
        for (const s of seqs) {
          if (
            stepsOf(s, "espn_analyze_roster").length &&
            !before(s, "espn_analyze_replacement", "espn_analyze_roster")
          ) {
            e.push(`sequence ${s.id}: espn_analyze_replacement comes before espn_analyze_roster`);
          }
          for (const p of stepsOf(s, "espn_list_players")) {
            if ((p.args["offset"] ?? 0) !== 0)
              e.push(`sequence ${s.id}: the pool is read one page per position (no offset)`);
          }
        }
        if (!seqs.some((s) => s.fixture_variant === "ir-invalid"))
          e.push("no sequence on ir-invalid (the IR section first when the roster is invalid)");
        return e;
      },
    },
    "news-check": {
      prefix: "NC",
      kinds: ["evidence"],
      records: true,
      requiredCases: ["NC-1", "NC-2", "NC-3", "NC-4-E", "NC-INJ", "NC-INJ-2", "NC-CORE"],
      body: [
        /priors are hand-set/,
        /structured_disagrees/,
        /what_would_confirm/,
        /store\.recommendation_log/,
        /espn\.player\.outlook/,
        /calibration_state/,
      ],
      bodyAbsent: [/posterior/i],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        const ev = seqs.flatMap((s) => stepsOf(s, "espn_analyze_evidence"));
        if (ev.length === 0) e.push("no espn_analyze_evidence step");
        for (const s of seqs) {
          for (const x of stepsOf(s, "espn_analyze_evidence"))
            for (const p of claimProblems(x.args["claim"])) e.push(`sequence ${s.id}: ${p}`);
          if (
            stepsOf(s, "espn_analyze_evidence").length &&
            !before(s, "espn_get_player_outlook", "espn_analyze_evidence")
          ) {
            e.push(`sequence ${s.id}: espn_get_player_outlook comes before espn_analyze_evidence`);
          }
        }
        if (!ev.some((x) => x.args["claim"] !== undefined))
          e.push("no espn_analyze_evidence step checks a pasted claim");
        if (!ev.some((x) => x.args["claim"] === undefined))
          e.push("no espn_analyze_evidence step checks ESPN's own outlook (no claim)");
        if (!seqs.some((s) => stepsOf(s, "espn_list_recommendations").length))
          e.push("no sequence reads the log back (espn_list_recommendations — NC-INJ-2)");
        return e;
      },
    },
  })
);

// --- trigger evals ---------------------------------------------------------------------------------

// abbreviations that are also English words ("sat", "sun") are left out on purpose
const WEEKDAYS =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu|thurs?|fri)s?\b/i;
const NIGHT_GAMES = /\b(?:tnf|snf|mnf)\b/i;
const CLOCK = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i;
const DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
const RELATIVE_DAY =
  /\b(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening)|weekend)\b/i;

/**
 * A trigger prompt must not depend on a clock the model is not given (plan 09 §2, §5.1 item 5).
 * @param {string} q
 * @returns {string | null} the reason it is not time-blind, or null
 */
export function timeReference(q) {
  const s = q.normalize("NFKC");
  if (WEEKDAYS.test(s)) return "names a weekday";
  if (NIGHT_GAMES.test(s)) return "names a night-game slot";
  if (CLOCK.test(s)) return "names a clock time";
  if (DATE.test(s)) return "names a date";
  if (RELATIVE_DAY.test(s)) return "names a day relative to now";
  return null;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "x",
  "n",
  "s",
  "and",
  "or",
]);

/**
 * Lower-case, drop apostrophes, split on anything else that is not a letter or digit, drop
 * stopwords and placeholders, strip a plural `s` (> 3 chars, not `ss`).
 * @param {string} s
 * @returns {string[]}
 */
export function tokenize(s) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/['’ʼ`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "" && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/**
 * The `when_to_use` phrases as token sets (comma-separated in the frontmatter).
 * @param {string} whenToUse
 * @returns {string[][]}
 */
export function phrases(whenToUse) {
  return whenToUse
    .split(",")
    .map((p) => tokenize(p))
    .filter((t) => t.length > 0);
}

/**
 * How many of a Skill's phrases a prompt contains (every token of the phrase present).
 * @param {string[][]} skillPhrases
 * @param {string} prompt
 */
export function routeScore(skillPhrases, prompt) {
  const toks = new Set(tokenize(prompt));
  return skillPhrases.filter((p) => p.every((t) => toks.has(t))).length;
}

/** @param {string} s */
const norm = (s) => tokenize(s).join(" ");

/**
 * @param {string[]} a
 * @param {string[]} b
 */
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * @typedef {{ query: string, should_trigger: boolean }} TriggerCase
 * @typedef {{ name: string, whenToUse: string, triggers: TriggerCase[] }} TriggerSkill
 */

/**
 * The pairwise trigger-collision heuristic (plan 09 §5.1 item 5). Rules:
 * (a) a prompt listed twice, or as both positive and negative, in one Skill;
 * (b) the same positive (after normalisation) in two Skills;
 * (c) near-duplicate positives across Skills (token Jaccard ≥ NEAR_DUPLICATE_JACCARD);
 * (d) a positive that matches more of another Skill's `when_to_use` phrases than of its own;
 * (e) a negative that matches its own Skill's phrases at least as well as any other Skill's
 *     (negatives naming Yahoo or Sleeper are exempt: the platform words decide those);
 * (f) the same `when_to_use` phrase in two Skills;
 * (g) the game-day prompts: positives of GAME_DAY_OWNER and of no other Skill;
 * (h) a positive that matches none of its own Skill's `when_to_use` phrases.
 * @param {TriggerSkill[]} skills
 * @param {{ gameDayPrompts?: readonly string[], gameDayOwner?: string }} [opts]
 * @returns {string[]}
 */
export function triggerCollisions(skills, opts = {}) {
  /** @type {string[]} */
  const errors = [];
  const table = skills.map((s) => ({ ...s, phrases: phrases(s.whenToUse) }));
  for (const s of table) {
    /** @type {Map<string, boolean>} */
    const seen = new Map();
    for (const t of s.triggers) {
      const k = norm(t.query);
      const prev = seen.get(k);
      if (prev === undefined) seen.set(k, t.should_trigger);
      else if (prev === t.should_trigger)
        errors.push(`${s.name}: trigger prompt listed twice: "${t.query}"`);
      else errors.push(`${s.name}: "${t.query}" is both a positive and a negative`);
    }
  }
  for (let i = 0; i < table.length; i++) {
    for (let j = i + 1; j < table.length; j++) {
      const a = /** @type {(typeof table)[number]} */ (table[i]);
      const b = /** @type {(typeof table)[number]} */ (table[j]);
      for (const pa of a.triggers.filter((t) => t.should_trigger)) {
        for (const pb of b.triggers.filter((t) => t.should_trigger)) {
          const ta = tokenize(pa.query);
          const tb = tokenize(pb.query);
          if (ta.join(" ") === tb.join(" ")) {
            errors.push(`collision: "${pa.query}" is a positive of both ${a.name} and ${b.name}`);
          } else if (jaccard(ta, tb) >= NEAR_DUPLICATE_JACCARD) {
            errors.push(
              `collision: near-duplicate positives "${pa.query}" (${a.name}) and "${pb.query}" (${b.name})`,
            );
          }
        }
      }
      const pa = new Set(a.phrases.map((p) => p.join(" ")));
      for (const p of b.phrases) {
        if (pa.has(p.join(" "))) {
          errors.push(
            `collision: when_to_use phrase "${p.join(" ")}" is in both ${a.name} and ${b.name}`,
          );
        }
      }
    }
  }
  for (const s of table) {
    for (const t of s.triggers) {
      const own = routeScore(s.phrases, t.query);
      let best = 0;
      let bestName = "";
      for (const o of table) {
        if (o.name === s.name) continue;
        const sc = routeScore(o.phrases, t.query);
        if (sc > best) {
          best = sc;
          bestName = o.name;
        }
      }
      if (t.should_trigger && own === 0) {
        errors.push(
          `collision: positive "${t.query}" of ${s.name} matches none of ${s.name}'s when_to_use phrases`,
        );
      }
      if (t.should_trigger && best > own) {
        errors.push(
          `collision: positive "${t.query}" of ${s.name} matches ${bestName}'s when_to_use (${String(best)}) better than its own (${String(own)})`,
        );
      }
      // a negative naming another platform is told apart by the description's platform words
      // ("in the user's ESPN league"), not by the phrases, so it may match them (plan 09 §2)
      if (!t.should_trigger && own > 0 && own >= best && !OTHER_PLATFORM_RE.test(t.query)) {
        errors.push(
          `collision: negative "${t.query}" of ${s.name} matches ${s.name}'s own when_to_use phrases (${String(own)})`,
        );
      }
    }
  }
  const owner = opts.gameDayOwner ?? GAME_DAY_OWNER;
  const prompts = opts.gameDayPrompts ?? GAME_DAY_PROMPTS;
  const ownerSkill = table.find((s) => s.name === owner);
  if (ownerSkill) {
    for (const p of prompts) {
      const k = norm(p);
      if (!ownerSkill.triggers.some((t) => t.should_trigger && norm(t.query) === k)) {
        errors.push(`${owner}: the game-day prompt "${p}" must be a positive (plan 09 §3.3)`);
      }
      for (const o of table) {
        if (o.name !== owner && o.triggers.some((t) => t.should_trigger && norm(t.query) === k)) {
          errors.push(`${o.name}: the game-day prompt "${p}" must route to ${owner} only`);
        }
      }
    }
  }
  return errors;
}

/**
 * Parse and validate one trigger_eval.json.
 * @param {unknown} raw
 * @param {string} where
 * @returns {{ triggers: TriggerCase[], errors: string[] }}
 */
export function validateTriggers(raw, where) {
  /** @type {string[]} */
  const errors = [];
  /** @type {TriggerCase[]} */
  const triggers = [];
  if (!Array.isArray(raw))
    return { triggers, errors: [`${where}: must be an array of { query, should_trigger }`] };
  raw.forEach((t, i) => {
    const w = `${where}[${String(i)}]`;
    if (
      !isRecord(t) ||
      typeof t["query"] !== "string" ||
      typeof t["should_trigger"] !== "boolean"
    ) {
      errors.push(`${w}: needs a string \`query\` and a boolean \`should_trigger\``);
      return;
    }
    const extra = Object.keys(t).filter((k) => k !== "query" && k !== "should_trigger");
    if (extra.length) errors.push(`${w}: unknown keys ${extra.join(", ")}`);
    const q = t["query"];
    if (q.trim() === "" || q.length > 500) errors.push(`${w}: query must be 1–500 chars`);
    const why = timeReference(q);
    if (why) errors.push(`${w}: "${q}" is not time-blind (${why}; plan 09 §2)`);
    if (t["should_trigger"] && OTHER_PLATFORM_RE.test(q)) {
      errors.push(`${w}: a positive must not name another platform: "${q}"`);
    }
    triggers.push({ query: q, should_trigger: t["should_trigger"] });
  });
  const pos = triggers.filter((t) => t.should_trigger).length;
  const neg = triggers.length - pos;
  if (pos < MIN_TRIGGERS || neg < MIN_TRIGGERS) {
    errors.push(
      `${where}: needs ≥ ${String(MIN_TRIGGERS)} positives and ≥ ${String(MIN_TRIGGERS)} negatives (has ${String(pos)}/${String(neg)})`,
    );
  }
  const other = triggers.filter((t) => !t.should_trigger && OTHER_PLATFORM_RE.test(t.query)).length;
  if (other < MIN_OTHER_PLATFORM_NEGATIVES) {
    errors.push(
      `${where}: needs ≥ ${String(MIN_OTHER_PLATFORM_NEGATIVES)} negatives naming Yahoo or Sleeper (has ${String(other)})`,
    );
  }
  return { triggers, errors };
}

// --- tool sequences --------------------------------------------------------------------------------

const STEP_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const REF_RE = /^([a-z][a-z0-9_]{0,31})((?:\.[A-Za-z0-9_]+)+)$/;
/** The `$` forms an argument template may use (skills/README.md "Tool sequences"). */
export const TEMPLATE_KEYS = Object.freeze([
  "$ref",
  "$source_calls",
  "$opponent",
  "$player",
  "$ids",
]);
/** `$ids` collects at most this many ids (plan 07 E5 `candidates` 1..25). */
export const IDS_MAX = 25;

/**
 * Walk `args` checking every `$`-object: `{ $ref: "<earlier step>.<path>" }`,
 * `{ $source_calls: [earlier step ids] }`, `{ $opponent: "<earlier step>" }` (the other team of
 * the user's matchup in that step's scoreboard), `{ $player: { step, slot, eligible?,
 * injury_status? } }` (the first player of an earlier roster step in that slot, optionally eligible
 * for another slot and carrying an ESPN injury status) or `{ $ids: { from: "<earlier step>.<path>",
 * key, max? } }` (the distinct numeric `key` values of the array at that path, at most `max`); any
 * other `$` key is an error.
 * @param {unknown} v
 * @param {Map<string, string>} earlier step id → tool
 * @param {string} where
 * @param {string[]} errors
 */
function checkRefs(v, earlier, where, errors) {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      checkRefs(x, earlier, `${where}[${String(i)}]`, errors);
    });
    return;
  }
  if (!isRecord(v)) return;
  const dollar = Object.keys(v).filter((k) => k.startsWith("$"));
  if (dollar.length) {
    if (dollar.length !== 1 || Object.keys(v).length !== 1) {
      errors.push(`${where}: a $-object must have exactly one key`);
      return;
    }
    const k = dollar[0] ?? "";
    const val = v[k];
    if (k === "$ref") {
      const m = typeof val === "string" ? REF_RE.exec(val) : null;
      if (!m) errors.push(`${where}: $ref must be "<step id>.<path>"`);
      else if (!earlier.has(m[1] ?? ""))
        errors.push(`${where}: $ref "${String(val)}" names no earlier step`);
    } else if (k === "$source_calls") {
      if (!Array.isArray(val) || val.length === 0)
        errors.push(`${where}: $source_calls must list step ids`);
      else {
        for (const id of val) {
          if (typeof id !== "string" || !earlier.has(id)) {
            errors.push(`${where}: $source_calls names no earlier step "${String(id)}"`);
          }
        }
        if (new Set(val).size !== val.length)
          errors.push(`${where}: $source_calls lists a step twice`);
      }
    } else if (k === "$opponent") {
      if (typeof val !== "string" || earlier.get(val) !== "espn_get_scoreboard") {
        errors.push(`${where}: $opponent must name an earlier espn_get_scoreboard step`);
      }
    } else if (k === "$player") {
      const ok =
        isRecord(val) &&
        typeof val["step"] === "string" &&
        earlier.get(val["step"]) === "espn_get_roster" &&
        typeof val["slot"] === "string" &&
        SLOT_NAMES.includes(val["slot"]) &&
        (val["eligible"] === undefined ||
          (typeof val["eligible"] === "string" && SLOT_NAMES.includes(val["eligible"]))) &&
        (val["injury_status"] === undefined ||
          (typeof val["injury_status"] === "string" &&
            INJURY_STATUSES.includes(val["injury_status"]))) &&
        Object.keys(val).every((x) => ["step", "slot", "eligible", "injury_status"].includes(x));
      if (!ok)
        errors.push(
          `${where}: $player must be { step: <earlier espn_get_roster step>, slot, eligible?, injury_status? } with ESPN slot names and statuses`,
        );
    } else if (k === "$ids") {
      const from = isRecord(val) ? val["from"] : undefined;
      const m = typeof from === "string" ? REF_RE.exec(from) : null;
      const max = isRecord(val) ? val["max"] : undefined;
      const ok =
        isRecord(val) &&
        m !== null &&
        typeof val["key"] === "string" &&
        /^[a-z][a-z0-9_]{0,39}$/.test(val["key"]) &&
        (max === undefined ||
          (typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= IDS_MAX)) &&
        Object.keys(val).every((x) => ["from", "key", "max"].includes(x));
      if (!ok)
        errors.push(
          `${where}: $ids must be { from: "<step id>.<path>", key: <field>, max?: 1..${String(IDS_MAX)} }`,
        );
      else if (!earlier.has(m[1] ?? ""))
        errors.push(`${where}: $ids "${String(from)}" names no earlier step`);
    } else errors.push(`${where}: unknown ${k} (only ${TEMPLATE_KEYS.join(", ")})`);
    return;
  }
  for (const [k, x] of Object.entries(v)) checkRefs(x, earlier, `${where}.${k}`, errors);
}

/** ESPN's lineup slot names (research 03 §B.2; skills/_shared/references/espn-vocabulary.md). */
export const SLOT_NAMES = Object.freeze(["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K", "BE", "IR"]);

/** @param {unknown} v */
const isTemplate = (v) => isRecord(v) && Object.keys(v).some((k) => k.startsWith("$"));

/**
 * Validate one literal argument value against a `manifest.inputs` type (template values pass).
 * @param {unknown} v
 * @param {string} type
 * @returns {string | null} the problem, or null
 */
export function checkArgType(v, type) {
  if (isTemplate(v)) return null;
  const [kind = "", spec = ""] = type.split(/:(.*)/s);
  /** @param {unknown} x @param {boolean} int */
  const inRange = (x, int) => {
    const [lo = "", hi = ""] = spec.split("..");
    return (
      typeof x === "number" &&
      Number.isFinite(x) &&
      (!int || Number.isInteger(x)) &&
      x >= Number(lo) &&
      x <= Number(hi)
    );
  };
  switch (kind) {
    case "bool":
      return typeof v === "boolean" ? null : "must be a boolean";
    case "string":
      return typeof v === "string" && v.length > 0 && v.length <= 400
        ? null
        : "must be a non-empty string";
    case "string[]":
      return Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => isTemplate(x) || (typeof x === "string" && x.length > 0))
        ? null
        : "must be a non-empty string array";
    case "object":
      return isRecord(v) ? null : "must be an object";
    case "array":
      return Array.isArray(v) ? null : "must be an array";
    case "selector": {
      // plan 07 legend: `PlayerSelector` (ids ≤ 25); `:single` — E7/E10/D4's one player;
      // `:outlook` — C4's ≤ 12 ids or a team (src/mcp/bounds.ts)
      const label =
        spec === "single"
          ? "single-player selector"
          : spec === "outlook"
            ? "outlook selector"
            : "PlayerSelector";
      if (!isRecord(v) || Object.keys(v).length !== 1)
        return `must be a ${label} (exactly one key)`;
      const key = Object.keys(v)[0] ?? "";
      const keys =
        spec === "single"
          ? ["player_ids", "gsis_ids"]
          : spec === "outlook"
            ? ["player_ids", "team_id"]
            : ["player_ids", "gsis_ids", "team_id", "nfl_team", "pool"];
      if (!keys.includes(key)) return `${label} has no \`${key}\``;
      const ids = v[key];
      if ((key === "player_ids" || key === "gsis_ids") && !isTemplate(ids)) {
        const max = spec === "single" ? 1 : spec === "outlook" ? 12 : 25;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > max)
          return `${label}.${key} must list 1–${String(max)} ids`;
      }
      return null;
    }
    case "int":
      return inRange(v, true) ? null : `must be an integer in ${spec}`;
    case "number":
      return inRange(v, false) ? null : `must be a number in ${spec}`;
    case "int[]":
      return Array.isArray(v) && v.length > 0 && v.every((x) => isTemplate(x) || inRange(x, true))
        ? null
        : `must be a non-empty array of integers in ${spec}`;
    case "enum":
      return typeof v === "string" && spec.split("|").includes(v) ? null : `must be one of ${spec}`;
    case "enum[]":
      return Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === "string" && spec.split("|").includes(x))
        ? null
        : `must be a non-empty array of ${spec}`;
    default:
      return `unknown type ${type}`;
  }
}

/**
 * Validate one tool_sequence.json.
 * @param {unknown} raw
 * @param {{ skill: string, where: string, manifest: import("./_lib.mjs").Manifest,
 *   errorCodes: string[], rule?: SkillRule }} ctx
 * @returns {{ sequences: Sequence[], errors: string[] }}
 */
export function validateToolSequence(raw, ctx) {
  const { where, manifest } = ctx;
  /** @type {string[]} */
  const errors = [];
  /** @type {Sequence[]} */
  const sequences = [];
  if (!isRecord(raw)) return { sequences, errors: [`${where}: must be a JSON object`] };
  const extraTop = Object.keys(raw).filter(
    (k) =>
      ![
        "$comment",
        "schema_version",
        "skill",
        "tool_contract",
        "toolset",
        "fixture",
        "sequences",
      ].includes(k),
  );
  if (extraTop.length) errors.push(`${where}: unknown keys ${extraTop.join(", ")}`);
  if (raw["schema_version"] !== 1) errors.push(`${where}: schema_version must be 1`);
  if (raw["skill"] !== ctx.skill) errors.push(`${where}: skill must be "${ctx.skill}"`);
  if (raw["tool_contract"] !== manifest.tool_contract) {
    errors.push(
      `${where}: tool_contract ${String(raw["tool_contract"])} ≠ manifest ${String(manifest.tool_contract)}`,
    );
  }
  const isP1Skill = manifest.p1_skills.includes(ctx.skill);
  const toolset = raw["toolset"];
  if (toolset !== (isP1Skill ? "full" : "core")) {
    errors.push(
      `${where}: toolset must be "${isP1Skill ? "full" : "core"}" (P0 Skills under core, P1 under full — ADV OBJ-18)`,
    );
  }
  /** @param {unknown} ts */
  const toolsOf = (ts) => (ts === "full" ? [...manifest.core, ...manifest.p1] : manifest.core);
  const fx = raw["fixture"];
  if (!isRecord(fx)) errors.push(`${where}: fixture is required`);
  else {
    if (fx["league"] !== manifest.fixture_league)
      errors.push(`${where}: fixture.league must be "${manifest.fixture_league}"`);
    const env = fx["env"];
    if (
      !isRecord(env) ||
      env["EFF_FIXTURE_DIR"] !== manifest.fixture_dir ||
      env["ESPN_LEAGUE_ID"] !== "0" ||
      env["EFF_TOOLSET"] !== toolset
    ) {
      errors.push(
        `${where}: fixture.env must set EFF_FIXTURE_DIR "${manifest.fixture_dir}", ESPN_LEAGUE_ID "0" and EFF_TOOLSET "${String(toolset)}"`,
      );
    }
    for (const k of ["team_id", "week"]) {
      if (typeof fx[k] !== "number" || !Number.isInteger(fx[k]))
        errors.push(`${where}: fixture.${k} must be an integer`);
    }
  }
  const seqs = raw["sequences"];
  if (!Array.isArray(seqs) || seqs.length === 0) {
    errors.push(`${where}: sequences must be a non-empty array`);
    return { sequences, errors };
  }
  const allowed = new Set(["ok", ...ctx.errorCodes]);
  /** @type {Set<string>} */
  const seqIds = new Set();
  seqs.forEach((s, si) => {
    const sw = `${where} sequences[${String(si)}]`;
    if (!isRecord(s)) {
      errors.push(`${sw}: must be an object`);
      return;
    }
    const extra = Object.keys(s).filter(
      (k) => !["id", "when", "fixture_variant", "toolset", "steps"].includes(k),
    );
    if (extra.length) errors.push(`${sw}: unknown keys ${extra.join(", ")}`);
    // a P0 Skill's P1 branch (a `(P1; …)` step in its body) is a sequence of its own under `full`;
    // a P1 Skill's sequences all run under the file's `full` (plan 09 §5.1 item 3; ADV OBJ-18)
    const st = s["toolset"];
    if (st !== undefined && (isP1Skill || st !== "full")) {
      errors.push(
        isP1Skill
          ? `${sw}: a P1 Skill's sequences all run under the file's toolset "full" — drop the sequence toolset`
          : `${sw}: a sequence toolset may only be "full" (a P0 Skill's P1 branch)`,
      );
    }
    const seqToolset = st === "full" ? "full" : String(toolset);
    const tools = toolsOf(seqToolset);
    const id = s["id"];
    if (typeof id !== "string" || !STEP_ID_RE.test(id)) errors.push(`${sw}: bad id`);
    else if (seqIds.has(id)) errors.push(`${sw}: duplicate id ${id}`);
    else seqIds.add(id);
    if (typeof s["when"] !== "string" || s["when"].trim() === "")
      errors.push(`${sw}: \`when\` must say when it applies`);
    const fv = s["fixture_variant"];
    if (fv !== undefined && (typeof fv !== "string" || !manifest.variants.includes(fv))) {
      errors.push(
        `${sw}: fixture_variant must be one of the fx-10h variants (scripts/skills/manifest.json)`,
      );
    }
    const steps = s["steps"];
    if (!Array.isArray(steps) || steps.length === 0) {
      errors.push(`${sw}: steps must be a non-empty array`);
      return;
    }
    /** @type {SeqStep[]} */
    const parsed = [];
    /** @type {Map<string, string>} */
    const earlier = new Map();
    steps.forEach((st, i) => {
      const w = `${sw}.steps[${String(i)}]`;
      if (!isRecord(st)) {
        errors.push(`${w}: must be an object`);
        return;
      }
      const sid = st["id"];
      const tool = st["tool"];
      const args = st["args"];
      if (typeof sid !== "string" || !STEP_ID_RE.test(sid)) errors.push(`${w}: bad step id`);
      else if (earlier.has(sid)) errors.push(`${w}: duplicate step id ${sid}`);
      if (typeof tool !== "string" || !tools.includes(tool)) {
        errors.push(
          manifest.write_tools.includes(String(tool))
            ? `${w}: ${String(tool)} is a write tool — PHASE W SEAM — NOT IMPLEMENTED; no sequence may call one`
            : manifest.p1.includes(String(tool))
              ? `${w}: ${String(tool)} is a P1 tool; this sequence runs under EFF_TOOLSET=${seqToolset}`
              : `${w}: ${String(tool)} is not a registered tool`,
        );
      }
      if (!isRecord(args)) errors.push(`${w}: args must be an object`);
      else {
        checkRefs(args, earlier, `${w}.args`, errors);
        const spec = typeof tool === "string" ? manifest.inputs[tool] : undefined;
        if (spec) {
          for (const [k, v] of Object.entries(args)) {
            const type = spec[k];
            if (type === undefined)
              errors.push(`${w}: ${String(tool)} has no input \`${k}\` (plan 07)`);
            else {
              const problem = checkArgType(v, type);
              if (problem) errors.push(`${w}: ${String(tool)}.${k} ${problem}`);
            }
          }
          for (const k of manifest.required_inputs[String(tool)] ?? []) {
            if (!(k in args)) errors.push(`${w}: ${String(tool)} needs \`${k}\``);
          }
        }
      }
      const exp = st["expect"];
      /** @type {string[]} */
      let expect = ["ok"];
      if (exp !== undefined) {
        if (
          !Array.isArray(exp) ||
          exp.length === 0 ||
          !exp.every((x) => typeof x === "string" && allowed.has(x))
        ) {
          errors.push(`${w}: expect must list "ok" and/or plan 01 §4.3 error codes`);
        } else expect = /** @type {string[]} */ (exp);
      }
      const extraStep = Object.keys(st).filter(
        (k) => !["id", "tool", "args", "expect", "note"].includes(k),
      );
      if (extraStep.length) errors.push(`${w}: unknown keys ${extraStep.join(", ")}`);
      if (typeof sid === "string") earlier.set(sid, String(tool));
      parsed.push({
        id: String(sid),
        tool: String(tool),
        args: isRecord(args) ? args : {},
        expect,
      });
    });
    if (parsed[0]?.tool !== "espn_get_status")
      errors.push(`${sw}: the first step must be espn_get_status (Step 0)`);
    const firstRecord = parsed.findIndex((p) => p.tool === "espn_record_recommendation");
    parsed.forEach((p, i) => {
      if (firstRecord !== -1 && i > firstRecord && p.tool !== "espn_record_recommendation") {
        errors.push(
          `${sw}: ${p.tool} after espn_record_recommendation — record before rendering, nothing after`,
        );
      }
      if (p.tool !== "espn_record_recommendation") return;
      const kind = p.args["kind"];
      if (ctx.rule && !ctx.rule.kinds.includes(String(kind))) {
        errors.push(
          `${sw}: record kind "${String(kind)}" is not one of ${ctx.rule.kinds.join(", ") || "(none)"}`,
        );
      }
      for (const k of ["rec", "source_calls", "settings_hash", "week"]) {
        if (!(k in p.args)) errors.push(`${sw}: espn_record_recommendation needs \`${k}\``);
      }
      const ref = isRecord(p.args["rec"]) ? p.args["rec"]["$ref"] : undefined;
      const m = typeof ref === "string" ? /^([^.]+)\.data\.rec$/.exec(ref) : null;
      const producer = m ? parsed.find((x) => x.id === m[1]) : undefined;
      const want = producer === undefined ? undefined : recKindOf(producer);
      if (want !== undefined && kind !== want) {
        errors.push(
          `${sw}: logs ${String(producer?.tool)}'s rec as kind "${String(kind)}" — it is a "${want}" rec`,
        );
      }
    });
    if (st === "full" && !isP1Skill && !parsed.some((p) => manifest.p1.includes(p.tool))) {
      errors.push(`${sw}: a sequence under toolset "full" in a P0 Skill must call a P1 tool`);
    }
    sequences.push({
      id: String(id),
      toolset: seqToolset,
      fixture_variant: typeof fv === "string" ? fv : null,
      steps: parsed,
    });
  });
  const records = sequences.some((s) =>
    s.steps.some((p) => p.tool === "espn_record_recommendation"),
  );
  if (ctx.rule?.records !== false && !records) {
    errors.push(`${where}: no sequence records the recommendation (espn_record_recommendation)`);
  }
  if (ctx.rule) for (const e of ctx.rule.sequences(sequences)) errors.push(`${where}: ${e}`);
  return { sequences, errors };
}

// --- Lane 2 cases (skill-creator evals.json) --------------------------------------------------------

const CASE_NAME_RE = /^([A-Z]{2})-(?:\d{1,2}(?:-E)?|INJ(?:-\d)?|CORE)$/;
const FILES_RE = /^evals\/fixtures\/fx-10h(?:\/([a-zA-Z0-9-]{1,64}))?$/;
const GRADER_TAG_RE = /\(([a-z_]+)(?:[\s:,][^()]*)?\)\s*$/;
const REGEX_TAG_RE = /\((regex|regex_absent):\s*`([^`]+)`\)\s*$/;

/**
 * The grader of one expectation (the parenthesised tag at its end, research 06 §D.0), or null.
 * @param {string} e
 */
export function graderOf(e) {
  const rx = REGEX_TAG_RE.exec(e); // the pattern may itself hold parentheses
  if (rx) return rx[1] ?? null;
  const m = GRADER_TAG_RE.exec(e);
  return m && GRADERS.includes(m[1] ?? "") ? (m[1] ?? null) : null;
}

/**
 * Validate one evals.json (skill-creator schema plus `name` and `toolset` per case).
 * @param {unknown} raw
 * @param {{ skill: string, where: string, manifest: import("./_lib.mjs").Manifest, rule?: SkillRule }} ctx
 * @returns {string[]}
 */
export function validateEvals(raw, ctx) {
  const { where, manifest } = ctx;
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(raw)) return [`${where}: must be a JSON object`];
  const extraTop = Object.keys(raw).filter((k) => !["$comment", "skill_name", "evals"].includes(k));
  if (extraTop.length) errors.push(`${where}: unknown keys ${extraTop.join(", ")}`);
  if (raw["skill_name"] !== ctx.skill) errors.push(`${where}: skill_name must be "${ctx.skill}"`);
  const evals = raw["evals"];
  if (!Array.isArray(evals) || evals.length < MIN_CASES) {
    return [...errors, `${where}: evals must hold ≥ ${String(MIN_CASES)} cases`];
  }
  /** @type {Set<number>} */
  const ids = new Set();
  /** @type {Set<string>} */
  const names = new Set();
  const isP1Skill = manifest.p1_skills.includes(ctx.skill);
  evals.forEach((c, i) => {
    const w = `${where} evals[${String(i)}]`;
    if (!isRecord(c)) {
      errors.push(`${w}: must be an object`);
      return;
    }
    const extra = Object.keys(c).filter(
      (k) =>
        !["id", "name", "toolset", "prompt", "expected_output", "files", "expectations"].includes(
          k,
        ),
    );
    if (extra.length) errors.push(`${w}: unknown keys ${extra.join(", ")}`);
    const id = c["id"];
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
      errors.push(`${w}: id must be a positive integer`);
    else if (ids.has(id)) errors.push(`${w}: duplicate id ${String(id)}`);
    else ids.add(id);
    const name = c["name"];
    const nm = typeof name === "string" ? CASE_NAME_RE.exec(name) : null;
    if (!nm) errors.push(`${w}: name must look like "XX-1", "XX-4-E" or "XX-INJ"`);
    else {
      if (ctx.rule && nm[1] !== ctx.rule.prefix)
        errors.push(`${w}: name must start with ${ctx.rule.prefix}-`);
      if (names.has(String(name))) errors.push(`${w}: duplicate name ${String(name)}`);
      names.add(String(name));
    }
    const toolset = c["toolset"];
    const isCore = typeof name === "string" && CORE_CASE_RE.test(name);
    const p1Cases = ctx.rule?.p1Cases ?? [];
    if (toolset !== "core" && toolset !== "full")
      errors.push(`${w}: toolset must be "core" or "full" (ADV OBJ-18)`);
    else if (isP1Skill) {
      if (isCore && toolset !== "core")
        errors.push(`${w}: the -CORE case checks the Step 0 stop, so it runs under toolset "core"`);
      else if (!isCore && toolset !== "full")
        errors.push(
          `${w}: a P1 Skill's cases run under toolset "full" (only its -CORE case under "core")`,
        );
    } else if (isCore) {
      errors.push(`${w}: a -CORE case belongs to a P1 Skill (its Step 0 stop under core)`);
    } else if (typeof name === "string" && p1Cases.includes(name)) {
      if (toolset !== "full")
        errors.push(
          `${w}: ${name} exercises the Skill's P1 branch, so it runs under toolset "full"`,
        );
    } else if (toolset !== "core") {
      errors.push(
        `${w}: a P0 Skill's cases run under toolset "core" (its P1 cases: ${p1Cases.join(", ") || "none"})`,
      );
    }
    if (isCore && Array.isArray(c["expectations"])) {
      const says = c["expectations"].some(
        (x) => typeof x === "string" && /\(regex: `[^`]*EFF_TOOLSET[^`]*`\)\s*$/.test(x),
      );
      if (!says)
        errors.push(
          `${w}: the -CORE case needs a regex expectation that the reply names EFF_TOOLSET=full (plan 10 B10)`,
        );
    }
    const p = c["prompt"];
    if (typeof p !== "string" || p.trim() === "" || p.length > 2000)
      errors.push(`${w}: prompt must be 1–2000 chars`);
    const eo = c["expected_output"];
    if (typeof eo !== "string" || eo.trim().length < 20)
      errors.push(`${w}: expected_output must describe success`);
    const files = c["files"];
    if (!Array.isArray(files) || files.length !== 1)
      errors.push(`${w}: files must name exactly one fixture`);
    else {
      const fm = typeof files[0] === "string" ? FILES_RE.exec(files[0]) : null;
      if (!fm)
        errors.push(
          `${w}: files[0] must be "evals/fixtures/fx-10h" or "evals/fixtures/fx-10h/<variant>"`,
        );
      else if (fm[1] !== undefined && !manifest.variants.includes(fm[1])) {
        errors.push(`${w}: unknown fixture variant "${fm[1]}"`);
      }
    }
    const tools = toolset === "full" ? [...manifest.core, ...manifest.p1] : manifest.core;
    const exps = c["expectations"];
    if (!Array.isArray(exps) || exps.length === 0) {
      errors.push(`${w}: expectations must be a non-empty array`);
      return;
    }
    let pairedBase = false;
    exps.forEach((x, k) => {
      const ew = `${w}.expectations[${String(k)}]`;
      if (typeof x !== "string" || x.trim().length < 10) {
        errors.push(`${ew}: must be a verifiable sentence`);
        return;
      }
      const g = graderOf(x);
      if (g === null)
        errors.push(`${ew}: must end with a grader tag (${GRADERS.join(" | ")}), e.g. "(llm)"`);
      if (g === "regex" || g === "regex_absent") {
        const pm = REGEX_TAG_RE.exec(x);
        if (!pm) errors.push(`${ew}: a ${g} grader carries its pattern: "(${g}: \`…\`)"`);
        else {
          try {
            new RegExp(pm[2] ?? "", "i");
          } catch (e) {
            errors.push(`${ew}: pattern does not compile: ${errMsg(e)}`);
          }
        }
      }
      if (g === "llm" && /base fixture/i.test(x)) pairedBase = true;
      for (const t of toolRefs(x)) {
        if (t.wildcard) {
          if (!t.tool.startsWith("espn_analyze_") && !t.tool.startsWith("espn_get_")) {
            errors.push(`${ew}: wildcard ${t.tool}* is not allowed in an expectation`);
          }
        } else if (manifest.write_tools.includes(t.tool)) {
          errors.push(
            `${ew}: names the write tool ${t.tool} — say "write tool" (PHASE W SEAM — NOT IMPLEMENTED)`,
          );
        } else if (!tools.includes(t.tool)) {
          errors.push(`${ew}: ${t.tool} is not a registered tool under toolset ${String(toolset)}`);
        }
      }
    });
    if (typeof name === "string" && /-INJ/.test(name) && !pairedBase) {
      errors.push(
        `${w}: an -INJ case needs an llm expectation comparing the reply with the base fixture's (plan 09 K7)`,
      );
    }
  });
  if (![...names].some((n) => /-INJ/.test(n)))
    errors.push(`${where}: needs an -INJ case (plan 09 K7)`);
  if (isP1Skill && ![...names].some((n) => CORE_CASE_RE.test(n)))
    errors.push(
      `${where}: a P1 Skill needs a -CORE case (its Step 0 stop under core — plan 10 B10)`,
    );
  for (const req of ctx.rule?.requiredCases ?? []) {
    if (!names.has(req)) errors.push(`${where}: missing case ${req} (plan 09 §3; plan 10 A9b)`);
  }
  return errors;
}

// --- Markdown: links, tool references, constants, identifiers -------------------------------------

/**
 * Strip fenced code blocks and inline code spans (links inside them are examples).
 * @param {string} text
 */
function stripCode(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

/**
 * Local link targets in a Markdown text (inline links and images; external and fragment-only
 * links are skipped).
 * @param {string} text
 * @returns {string[]}
 */
export function localLinks(text) {
  const out = [];
  for (const m of stripCode(text).matchAll(
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  )) {
    const t = m[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//") || t.startsWith("#")) continue;
    out.push(t);
  }
  return out;
}

/**
 * `decodeURI` that returns the input unchanged on a malformed escape.
 * @param {string} s
 */
function safeDecode(s) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

const VERB_ALT = TOOL_VERBS.join("|");
const TOOL_REF_RE = new RegExp(`(?<![A-Za-z0-9_])espn_(?:${VERB_ALT})_[a-z_]*(?:\\*)?`, "g");

/**
 * Tool names referenced in a text: every `espn_<verb>_…` token (code spans included — that is
 * where Skills name tools). `espn_s2`, `espn_rule`, `espn_ros`, `espn_game_id` and other
 * `espn_`-prefixed field names and enum values are not tool references (no verb).
 * @param {string} text
 * @returns {{ tool: string, wildcard: boolean, index: number }[]}
 */
export function toolRefs(text) {
  /** @type {{ tool: string, wildcard: boolean, index: number }[]} */
  const out = [];
  for (const m of text.matchAll(TOOL_REF_RE)) {
    const raw = m[0];
    const wildcard = raw.endsWith("*");
    out.push({ tool: wildcard ? raw.slice(0, -1) : raw, wildcard, index: m.index });
  }
  return out;
}

/**
 * Tool-name rules over one Markdown text (plan 09 §5.1 items 3–4; K4): every `espn_<verb>_…` name
 * is a registered tool; a P1 tool appears in a P0 Skill only on a P1-labelled line; no Skill names
 * a write tool in this build (PHASE W SEAM — NOT IMPLEMENTED); no qualified form in prose.
 * @param {string} text
 * @param {string} file
 * @param {{ manifest: import("./_lib.mjs").Manifest, p1Skill: boolean }} ctx
 * @param {string[]} errors
 */
export function checkToolRefs(text, file, ctx, errors) {
  const { manifest } = ctx;
  /** @type {Set<string>} */
  const reported = new Set();
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  /** @param {number} idx */
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= idx) lo = mid;
      else hi = mid - 1;
    }
    const start = lineStarts[lo] ?? 0;
    const end = text.indexOf("\n", start);
    return text.slice(start, end === -1 ? text.length : end);
  };
  const all = [...manifest.core, ...manifest.p1, ...manifest.write_tools];
  for (const r of toolRefs(text)) {
    const key = `${r.tool}:${String(r.wildcard)}`;
    if (r.wildcard) {
      if (reported.has(key)) continue;
      reported.add(key);
      if (!r.tool.endsWith("_"))
        errors.push(`${file}: wildcard "${r.tool}*" must end at a name segment`);
      else if (!all.some((t) => t.startsWith(r.tool)))
        errors.push(`${file}: wildcard "${r.tool}*" matches no tool`);
      else if (manifest.write_tools.some((t) => t.startsWith(r.tool))) {
        errors.push(
          `${file}: names the write tools "${r.tool}*" — PHASE W SEAM — NOT IMPLEMENTED (plan 09 K4)`,
        );
      }
      continue;
    }
    if (manifest.core.includes(r.tool)) continue;
    if (manifest.p1.includes(r.tool)) {
      if (ctx.p1Skill || P1_LABEL_RE.test(lineOf(r.index))) continue;
      if (!reported.has(key))
        errors.push(`${file}: ${r.tool} is a P1 tool — label the step "(P1; …)" or "**P1:**"`);
      reported.add(key);
      continue;
    }
    if (reported.has(key)) continue;
    reported.add(key);
    if (manifest.write_tools.includes(r.tool)) {
      errors.push(
        `${file}: names the write tool ${r.tool} — PHASE W SEAM — NOT IMPLEMENTED (plan 09 K4)`,
      );
    } else errors.push(`${file}: ${r.tool} is not a registered tool`);
  }
  if (/\bmcp__[a-z]/.test(text)) {
    errors.push(
      `${file}: a qualified tool name (mcp__…) in prose — bare names only (plan 09 convention; T-02)`,
    );
  }
}

/**
 * The P1 tools a body names on its P1-labelled lines (`(P1; …)`, `**P1:**`), sorted.
 * @param {string} body
 * @param {import("./_lib.mjs").Manifest} manifest
 * @returns {string[]}
 */
export function p1StepTools(body, manifest) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const line of body.split("\n")) {
    if (!P1_LABEL_RE.test(line)) continue;
    for (const r of toolRefs(line)) if (!r.wildcard && manifest.p1.includes(r.tool)) out.add(r.tool);
  }
  return [...out].sort();
}

/**
 * Backticked UPPER_SNAKE tokens that are neither error codes nor allowed constants (research 06
 * §C.3 item 7: a Skill never invents an error code).
 * @param {string} text
 * @param {{ errorCodes: string[], constants: string[], prefixes: string[] }} ctx
 * @returns {string[]} the unknown tokens
 */
export function unknownConstants(text, ctx) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const m of text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) {
    const t = m[1] ?? "";
    if (ctx.errorCodes.includes(t) || ctx.constants.includes(t)) continue;
    if (ctx.prefixes.some((p) => t.startsWith(p))) continue;
    out.add(t);
  }
  return [...out].sort();
}

/** The fake member-GUID range (CLAUDE.md; research 03 §F.3). */
const FAKE_GUID = /^0{8}-0{4}-4000-8000-0{10}[0-9a-f]{2}$/i;

/**
 * Identifier findings in one text (plan 09 §5.1 item 6; plan 04 §4.3): cookie values, GUIDs outside
 * the fake range, IPv4 literals, league ids other than 0, email addresses, home-directory paths.
 * Returns rule ids and line numbers only — never the matched value.
 * @param {string} text
 * @returns {string[]} `<line>: <rule>`
 */
export function identifierFindings(text) {
  /** @type {string[]} */
  const out = [];
  text.split("\n").forEach((line, i) => {
    const n = String(i + 1);
    if (/\b(?:espn_s2|swid)\b["']?\s*[=:]\s*["']?(?![<$])[A-Za-z0-9%{}+/=-]{8,}/i.test(line))
      out.push(`${n}: cookie-value`);
    for (const m of line.matchAll(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    )) {
      if (!FAKE_GUID.test(m[0])) out.push(`${n}: guid-outside-fake-range`);
    }
    if (/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/.test(line)) out.push(`${n}: ipv4-literal`);
    for (const m of line.matchAll(
      /\b(?:league[_-]?id|leagueid|espn_league_id)\b["']?\s*[=:]\s*["']?(\d+)/gi,
    )) {
      if (m[1] !== "0") out.push(`${n}: league-id`);
    }
    for (const m of line.matchAll(/\/leagues\/(\d+)/g))
      if (m[1] !== "0") out.push(`${n}: league-id`);
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      if (!/^(?:example\.(?:com|org|net)|users\.noreply\.github\.com)$/i.test(m[1] ?? ""))
        out.push(`${n}: email`);
    }
    if (/(?:^|[\s"'(=])\/(?:Users|home)\/[A-Za-z0-9._-]+/.test(line)) out.push(`${n}: home-path`);
  });
  return out;
}

// --- the whole check ---------------------------------------------------------------------------------

/**
 * Run every Lane 1 check.
 * @param {{ root?: string, scan?: boolean, scanEnv?: Record<string, string> }} [opts]
 * @returns {{ errors: string[], notes: string[], skills: string[] }}
 */
export function checkSkills(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const skillsRoot = path.join(root, SKILLS_DIR);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];
  if (!existsSync(skillsRoot)) return { errors: ["skills/: missing"], notes, skills: [] };

  // 0. generated sections are current (plan 09 §4: check:skills runs the build in dry-run mode)
  const build = buildSkills({ root, check: true });
  errors.push(...build.errors.map((e) => `build: ${e}`));
  for (const c of build.changed)
    errors.push(`stale generated file: ${c} (run node scripts/skills/build-skills.mjs)`);

  /** @type {import("./_lib.mjs").Manifest | null} */
  let manifest = null;
  try {
    manifest = readManifest(root);
  } catch (e) {
    errors.push(errMsg(e));
  }
  /** @type {{ untrusted: string, estimate: string } | null} */
  let sentences = null;
  try {
    sentences = readMandatorySentences(root);
  } catch (e) {
    errors.push(errMsg(e));
  }
  /** @type {string[]} */
  let errorCodes = [];
  try {
    errorCodes = readErrorCodes(root);
  } catch (e) {
    errors.push(errMsg(e));
  }
  /** @type {string | null} */
  let version = null;
  try {
    version = readPackageVersion(root);
  } catch (e) {
    errors.push(errMsg(e));
  }

  // registry cross-checks (plan 09 K6): only when the MCP layer has landed
  if (manifest) {
    const reg = readRegistryContract(root);
    if (!reg.found)
      notes.push("src/mcp/registry.ts not found — tool_contract checked against the manifest only");
    else if (reg.value === null)
      notes.push(
        "src/mcp/registry.ts exports no TOOL_CONTRACT — tool_contract checked against the manifest only",
      );
    else if (reg.value !== manifest.tool_contract) {
      errors.push(
        `tool_contract: manifest ${String(manifest.tool_contract)} ≠ src/mcp/registry.ts TOOL_CONTRACT ${String(reg.value)}`,
      );
    }
    const exp = readExpectedTools(root);
    if (!exp.found)
      notes.push(
        "tests/smoke/expected-tools.json not found — tool names checked against the manifest only",
      );
    else if (exp.error || !exp.core)
      errors.push(`tests/smoke/expected-tools.json: ${exp.error ?? "unreadable"}`);
    else {
      /** @param {string[]} a @param {string[]} b */
      const diff = (a, b) => a.filter((t) => !b.includes(t));
      const m = manifest;
      const missing = diff(m.core, exp.core);
      const extra = diff(exp.core, m.core);
      if (missing.length || extra.length) {
        errors.push(
          `manifest tools.core ≠ tests/smoke/expected-tools.json core (missing there: ${missing.join(", ") || "none"}; not in manifest: ${extra.join(", ") || "none"})`,
        );
      }
      if (exp.p1) {
        const mp = diff(m.p1, exp.p1);
        const ep = diff(exp.p1, m.p1);
        if (mp.length || ep.length) {
          errors.push(
            `manifest tools.p1 ≠ tests/smoke/expected-tools.json full − core (missing there: ${mp.join(", ") || "none"}; not in manifest: ${ep.join(", ") || "none"})`,
          );
        }
      }
    }
  }

  // the carriers of the sentences (plan 09 §2; ADV OBJ-24)
  const sharedRefs = path.join(skillsRoot, "_shared", "references");
  const sheet = path.join(sharedRefs, "tool-outputs.md");
  if (!existsSync(sheet)) errors.push("skills/_shared/references/tool-outputs.md: missing");
  else if (sentences) {
    const t = readFileSync(sheet, "utf8");
    if (!t.includes(sentences.untrusted))
      errors.push(
        "skills/_shared/references/tool-outputs.md: the untrusted-text rule is not in it verbatim",
      );
    if (!t.includes(sentences.estimate))
      errors.push(
        "skills/_shared/references/tool-outputs.md: the ESPN estimate sentence is not in it verbatim",
      );
  }
  for (const f of [
    "orient.md",
    "guardrails.md",
    "output-template.md",
    "log.md",
    "espn-vocabulary.md",
    "priority-waivers.md",
  ]) {
    if (!existsSync(path.join(sharedRefs, f)))
      errors.push(`skills/_shared/references/${f}: missing (plan 09 §4)`);
  }

  const listed = listSkillDirs(skillsRoot);
  errors.push(...listed.errors);
  if (manifest) {
    const want = [...manifest.p0_skills, ...manifest.p1_skills];
    const missing = want.filter((s) => !listed.skills.includes(s));
    const extra = listed.skills.filter((s) => !want.includes(s));
    if (missing.length) errors.push(`manifest skills with no directory: ${missing.join(", ")}`);
    if (extra.length) errors.push(`Skill directories not in the manifest: ${extra.join(", ")}`);
  }

  /** @type {TriggerSkill[]} */
  const triggerSkills = [];
  let listingChars = 0;
  for (const skill of listed.skills) {
    const dir = path.join(skillsRoot, skill);
    const rel = `skills/${skill}`;
    const rule = SKILL_RULES[skill];
    const p1Skill = manifest?.p1_skills.includes(skill) ?? false;
    const text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    /** @type {import("./_lib.mjs").Frontmatter | null} */
    let fm = null;
    try {
      fm = parseFrontmatter(text);
    } catch (e) {
      errors.push(`${rel}/SKILL.md: ${errMsg(e)}`);
    }
    const lines = text.split("\n");
    const body = fm ? lines.slice(fm.bodyStart).join("\n") : text;
    let whenToUse = "";
    if (fm) {
      const r = checkFrontmatter(fm.data, { skill, rel, version, manifest, errors });
      whenToUse = r.whenToUse;
      listingChars += r.descriptionChars;
    }

    // body (plan 09 §5.1 item 2)
    const bodyLines = fm ? lines.length - fm.bodyStart : lines.length;
    if (bodyLines > BODY_MAX_LINES)
      errors.push(
        `${rel}/SKILL.md: body is ${String(bodyLines)} lines (max ${String(BODY_MAX_LINES)})`,
      );
    if (sentences && !body.includes(sentences.untrusted)) {
      errors.push(
        `${rel}/SKILL.md: the plan 02 §6.3 untrusted-text sentence is not in the body verbatim`,
      );
    }
    if (!body.includes(ESPN_FREE_TEXT_CLAUSE))
      errors.push(
        `${rel}/SKILL.md: the ESPN clause (research 06 §A.3 rule 5) is not in the body verbatim`,
      );
    if (!body.includes(COOKIE_LINE))
      errors.push(`${rel}/SKILL.md: the "never ask for a cookie" line is missing`);
    if (!body.includes(beginMarker(GUARDRAILS_BLOCK)))
      errors.push(
        `${rel}/SKILL.md: the generated block from _shared/references/${GUARDRAILS_BLOCK} is missing`,
      );
    if (!NO_TEMPLATE_SKILLS.includes(skill)) {
      if (!body.includes(beginMarker(TEMPLATE_BLOCK)))
        errors.push(
          `${rel}/SKILL.md: the generated block from _shared/references/${TEMPLATE_BLOCK} is missing`,
        );
      for (const h of OUTPUT_HEADINGS) {
        if (!heading(h).test(body))
          errors.push(`${rel}/SKILL.md: output-contract heading "${h}" is missing`);
      }
      if (!body.includes("`basis`"))
        errors.push(`${rel}/SKILL.md: the output contract must print the distribution \`basis\``);
    }
    if (skill !== "session-check" && !body.includes("espn_record_recommendation")) {
      errors.push(`${rel}/SKILL.md: no espn_record_recommendation step (log discipline)`);
    }
    if (!body.includes("Step 0") || !body.includes("references/orient.md")) {
      errors.push(`${rel}/SKILL.md: the body must run Step 0 of references/orient.md`);
    }
    for (const re of rule?.body ?? []) {
      if (!re.test(body))
        errors.push(`${rel}/SKILL.md: body must mention ${String(re)} (plan 09 §3 Lane 1)`);
    }
    for (const re of rule?.bodyAbsent ?? []) {
      if (re.test(body))
        errors.push(`${rel}/SKILL.md: body must not mention ${String(re)} (plan 09 §3 Lane 1)`);
    }
    // a P1 Skill under `core` stops in Step 0 and says how to turn it on (plan 10 B10; ADV OBJ-18)
    if (p1Skill && !body.includes(TOOLSET_STOP)) {
      errors.push(
        `${rel}/SKILL.md: a P1 Skill's Step 0 must carry the toolset stop verbatim: "${TOOLSET_STOP}"`,
      );
    }

    // files: size, symlinks, links, tool references, constants
    const { files, links } = walkFiles(dir, root);
    for (const l of links) errors.push(`${l}: symlinks are not allowed in a Skill`);
    for (const f of files) {
      const abs = path.join(root, f);
      if (statSync(abs).size > FILE_MAX_BYTES) errors.push(`${f}: larger than 200 KB`);
      if (!f.endsWith(".md")) continue;
      const md = readFileSync(abs, "utf8");
      const scanned = f === `${rel}/SKILL.md` ? body : md;
      const inRefs = f.startsWith(`${rel}/references/`);
      for (const target of localLinks(scanned)) {
        const clean = safeDecode(target.split("#")[0] ?? "");
        const resolved = path.resolve(path.dirname(abs), clean);
        const relToSkill = path.relative(dir, resolved).split(path.sep).join("/");
        if (relToSkill.startsWith("..") || path.isAbsolute(relToSkill)) {
          errors.push(
            `${f}: link "${target}" leaves the Skill directory (a Skill must be self-contained)`,
          );
        } else if (!existsSync(resolved)) {
          errors.push(`${f}: link "${target}" points to a missing file`);
        } else if (inRefs && clean !== "") {
          errors.push(
            `${f}: references must not link to other files (one level deep): "${target}"`,
          );
        } else if (relToSkill.startsWith("references/") && relToSkill.split("/").length > 2) {
          errors.push(`${f}: link "${target}" is more than one level deep`);
        }
      }
      if (manifest) {
        checkToolRefs(scanned, f, { manifest, p1Skill }, errors);
        for (const c of unknownConstants(scanned, {
          errorCodes,
          constants: manifest.constants,
          prefixes: manifest.constant_prefixes,
        })) {
          errors.push(
            `${f}: \`${c}\` is not an error code in src/mcp/errors.ts nor an allowed constant (research 06 §C.3 item 7)`,
          );
        }
      }
    }

    // evals
    /** @param {string} name */
    const readEval = (name) => {
      const p = path.join(dir, "evals", name);
      if (!existsSync(p)) {
        errors.push(`${rel}/evals/${name}: missing`);
        return undefined;
      }
      try {
        return /** @type {unknown} */ (JSON.parse(readFileSync(p, "utf8")));
      } catch (e) {
        errors.push(`${rel}/evals/${name}: invalid JSON: ${errMsg(e)}`);
        return undefined;
      }
    };
    const seq = readEval("tool_sequence.json");
    if (seq !== undefined && manifest) {
      const v = validateToolSequence(seq, {
        skill,
        where: `${rel}/evals/tool_sequence.json`,
        manifest,
        errorCodes,
        ...(rule ? { rule } : {}),
      });
      errors.push(...v.errors);
      // the body logs exactly the kinds its sequences record (one source of the kind)
      const seqKinds = new Set(
        v.sequences.flatMap((q) =>
          q.steps
            .filter((st) => st.tool === "espn_record_recommendation")
            .map((st) => String(st.args["kind"])),
        ),
      );
      // a P0 Skill's P1-labelled steps are validated under full (plan 09 §5.1 item 3): every P1
      // tool its body names on a P1 line is called by one of its full sequences
      if (!p1Skill) {
        const inFull = new Set(
          v.sequences.filter((q) => q.toolset === "full").flatMap((q) => q.steps.map((x) => x.tool)),
        );
        for (const t of p1StepTools(body, manifest).filter((x) => !inFull.has(x))) {
          errors.push(
            `${rel}/evals/tool_sequence.json: the body's P1 step ${t} is in no sequence under toolset "full"`,
          );
        }
      }
      const said = bodyRecordKinds(body);
      for (const k of said.filter((x) => !seqKinds.has(x)))
        errors.push(`${rel}/SKILL.md: logs kind "${k}" but no tool_sequence records it`);
      for (const k of [...seqKinds].filter((x) => !said.includes(x)).sort()) {
        errors.push(
          `${rel}/SKILL.md: the tool_sequence records kind "${k}" but the body never logs it`,
        );
      }
    }
    const evals = readEval("evals.json");
    if (evals !== undefined && manifest) {
      errors.push(
        ...validateEvals(evals, {
          skill,
          where: `${rel}/evals/evals.json`,
          manifest,
          ...(rule ? { rule } : {}),
        }),
      );
    }
    const trig = readEval("trigger_eval.json");
    if (trig !== undefined) {
      const v = validateTriggers(trig, `${rel}/evals/trigger_eval.json`);
      errors.push(...v.errors);
      triggerSkills.push({ name: skill, whenToUse, triggers: v.triggers });
    }
  }
  errors.push(...triggerCollisions(triggerSkills));
  if (listingChars > SKILLS_LISTING_MAX) {
    errors.push(
      `the Skills listing is ${String(listingChars)} description characters (plan 07 §5.1 [A-4] ceiling ${String(SKILLS_LISTING_MAX)})`,
    );
  }

  // every file under skills/: size, identifiers and the secret scanner (plan 09 §5.1 item 6)
  const all = walkFiles(skillsRoot, root);
  for (const l of all.links)
    if (!errors.some((e) => e.startsWith(l)))
      errors.push(`${l}: symlinks are not allowed under skills/`);
  for (const f of all.files) {
    const abs = path.join(root, f);
    if (statSync(abs).size > FILE_MAX_BYTES) {
      if (!errors.some((e) => e.startsWith(f))) errors.push(`${f}: larger than 200 KB`);
      continue;
    }
    for (const finding of identifierFindings(readFileSync(abs, "utf8")))
      errors.push(`${f}:${finding} (plan 09 §5.1 item 6)`);
  }
  if (opts.scan !== false) errors.push(...scanSecrets(root, all.files, opts.scanEnv));
  return { errors, notes, skills: listed.skills };
}

/**
 * Frontmatter rules (plan 09 §2, §5.1 item 1; research 06 §A.0). Returns `when_to_use` and the
 * description's length (for the listing total).
 * @param {Record<string, import("./_lib.mjs").FmValue>} data
 * @param {{ skill: string, rel: string, version: string | null,
 *   manifest: import("./_lib.mjs").Manifest | null, errors: string[] }} ctx
 * @returns {{ whenToUse: string, descriptionChars: number }}
 */
export function checkFrontmatter(data, ctx) {
  const { skill, errors } = ctx;
  const f = `${ctx.rel}/SKILL.md`;
  for (const k of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER.includes(k)) errors.push(`${f}: unknown frontmatter key \`${k}\``);
  }
  const name = data["name"];
  if (name !== skill)
    errors.push(`${f}: name "${String(name)}" must equal the directory name "${skill}"`);
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    errors.push(`${f}: name must be lowercase letters, digits and hyphens, ≤ 64 chars`);
  } else if (/anthropic|claude/.test(name))
    errors.push(`${f}: name may not contain a reserved word`);
  const d = data["description"];
  let descriptionChars = 0;
  if (typeof d !== "string" || d.trim() === "") errors.push(`${f}: description is required`);
  else {
    descriptionChars = [...d].length;
    if (descriptionChars > DESCRIPTION_HARD_MAX) {
      errors.push(
        `${f}: description is ${String(descriptionChars)} chars (platform max ${String(DESCRIPTION_HARD_MAX)})`,
      );
    } else if (descriptionChars > DESCRIPTION_MAX) {
      errors.push(
        `${f}: description is ${String(descriptionChars)} chars (plan 09 cap ${String(DESCRIPTION_MAX)})`,
      );
    }
    if (!d.includes(PLATFORM_PHRASE))
      errors.push(`${f}: description must contain "${PLATFORM_PHRASE}" (plan 09 §2)`);
    if (/<\/?[A-Za-z]/.test(d)) errors.push(`${f}: description may not contain XML tags`);
    if (/\b(?:I|I'm|me|my|mine|we|our|us|you|your|yours)\b/i.test(d)) {
      errors.push(`${f}: description must be third person (no I/me/my/we/our/you/your)`);
    }
  }
  const w = data["when_to_use"];
  let whenToUse = "";
  if (typeof w !== "string" || w.trim() === "")
    errors.push(`${f}: when_to_use is required (the trigger phrases)`);
  else {
    whenToUse = w;
    if (typeof d === "string" && [...d].length + [...w].length > LISTING_MAX) {
      errors.push(
        `${f}: description + when_to_use is ${String([...d].length + [...w].length)} chars (max ${String(LISTING_MAX)})`,
      );
    }
  }
  const hint = data["argument-hint"];
  if (hint !== undefined && (typeof hint !== "string" || hint.length > 80))
    errors.push(`${f}: argument-hint must be a short string`);
  const meta = data["metadata"];
  if (!isRecord(meta)) errors.push(`${f}: metadata { version, tool_contract } is required`);
  else {
    const extra = Object.keys(meta).filter((k) => k !== "version" && k !== "tool_contract");
    if (extra.length) errors.push(`${f}: metadata has unknown keys ${extra.join(", ")}`);
    if (ctx.version !== null && meta["version"] !== ctx.version) {
      errors.push(
        `${f}: metadata.version ${String(meta["version"])} ≠ package.json ${ctx.version}`,
      );
    }
    if (ctx.manifest && meta["tool_contract"] !== ctx.manifest.tool_contract) {
      errors.push(
        `${f}: metadata.tool_contract ${String(meta["tool_contract"])} ≠ manifest ${String(ctx.manifest.tool_contract)}`,
      );
    }
  }
  const dis = data["disallowed-tools"];
  const dmi = data["disable-model-invocation"];
  if (skill === "apply") {
    if (dmi !== true)
      errors.push(`${f}: apply must set disable-model-invocation: true (plan 09 K4)`);
  } else if (dmi !== undefined) {
    errors.push(`${f}: only apply sets disable-model-invocation (plan 09 §2)`);
  }
  if (dis !== undefined && !Array.isArray(dis))
    errors.push(`${f}: disallowed-tools must be a list`);
  if (skill !== "apply" && ctx.manifest) {
    const list = Array.isArray(dis) ? dis : [];
    for (const t of ctx.manifest.disallowed_tools) {
      if (!list.includes(t))
        errors.push(`${f}: disallowed-tools must list ${t} (plan 09 K4; research 06 §C.3 item 1)`);
    }
  }
  return { whenToUse, descriptionChars };
}

/**
 * Run scripts/dev/scan-secrets.mjs over the given files (repository-relative paths): the ESPN
 * cookie, GUID, league-id, IPv4, home-path and email rules plus the owner's local deny-list.
 * @param {string} root
 * @param {string[]} files
 * @param {Record<string, string>} [env]
 * @returns {string[]}
 */
export function scanSecrets(root, files, env) {
  const scanner = path.join(root, "scripts", "dev", "scan-secrets.mjs");
  if (!existsSync(scanner)) return ["scripts/dev/scan-secrets.mjs not found — cannot scan skills/"];
  if (files.length === 0) return [];
  try {
    execFileSync(process.execPath, [scanner, "--", ...files], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
      maxBuffer: 16 * 1024 * 1024,
    });
    return [];
  } catch (e) {
    const err = /** @type {{ status?: number, stderr?: string }} */ (e);
    const lines = String(err.stderr ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("scan-secrets:"));
    return [
      `scan-secrets: exit ${String(err.status ?? "?")} over skills/`,
      ...lines.map((l) => `scan-secrets: ${l}`),
    ];
  }
}

/**
 * CLI entry.
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  /** @type {string | undefined} */
  let root;
  let scan = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1] !== undefined) root = path.resolve(argv[++i] ?? "");
    else if (a === "--no-scan") scan = false;
    else {
      process.stderr.write(
        `check-skills: unexpected argument ${String(a)}\nusage: check-skills.mjs [--root <dir>] [--no-scan]\n`,
      );
      return 2;
    }
  }
  const r = checkSkills({ ...(root ? { root } : {}), scan });
  for (const n of r.notes) process.stdout.write(`check-skills: note: ${n}\n`);
  if (r.errors.length) {
    process.stderr.write(`check-skills: ${String(r.errors.length)} problem(s):\n`);
    for (const e of r.errors) process.stderr.write(`  ${e}\n`);
    return 1;
  }
  process.stdout.write(
    `check-skills: OK — ${String(r.skills.length)} Skill(s): ${r.skills.join(", ")}\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
