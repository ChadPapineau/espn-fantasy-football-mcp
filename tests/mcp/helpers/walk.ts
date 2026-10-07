// walk.ts — the plan 05 §2 `mcp/envelope` walker for tool outputs (plan 10 A6): every string in
// `data` is wrapped (untrusted_text), listed by path in meta.untrusted_fields, a code (no whitespace),
// or on the server-prose allow-list (fixed engine/tool text, never third-party); every object key
// passes the envelope's key grammar; and nothing anywhere carries a member GUID or an IP literal.
// Ported from sibling @5daa625 (tests/mcp/helpers/walk.ts), adapted (ESPN prose paths, GUID/IP scan).
import { RETRO_METRIC_KEYS } from "../../../src/domain/reclog/retrospective.js";
import { isUntrustedText, objectKeyViolations } from "../../../src/mcp/envelope.js";

/** One string leaf of `data`, outside wrappers, with its normalised path (`[]` for indices). */
export interface Leaf {
  readonly path: string;
  readonly value: string;
}

export function stringLeaves(data: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, p: string, depth: number): void => {
    if (depth > 40) return;
    if (typeof v === "string") {
      out.push({ path: p, value: v });
      return;
    }
    if (typeof v !== "object" || v === null || isUntrustedText(v)) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, `${p}[]`, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`, depth + 1);
  };
  walk(data, "data", 0);
  return out;
}

/** A code-like string: no whitespace, the punctuation keys, dates, slots and ids use. */
export const CODE_LIKE = /^[A-Za-z0-9_:./+@\-]*$/;

/** Server-authored prose paths (fixed engine/tool text, never third-party). */
export const SERVER_PROSE: ReadonlySet<string> = new Set([
  "data.assumptions[].text",
  "data.assumptions[].revisit_trigger",
  "data.projections[].assumptions[].text",
  "data.projections[].assumptions[].revisit_trigger",
  "data.projections[].drivers[].name",
  "data.rec.action",
  "data.rec.drivers[].name",
  "data.rec.assumptions[].text",
  "data.rec.assumptions[].revisit_trigger",
  "data.objective_reason",
  "data.swaps[].option_value.verdict",
  "data.stack_flags[].advice_under_reading",
  "data.candidates[].flip_driver",
  "data.candidates[].invalidators[]",
  "data.candidates[].conditional_drop.activation_warning",
  "data.base_rates_note",
  "data.sample_size_caveats[]",
  "data.scoring.items[].abbr",
  "data.stat_ids[].meaning",
  "data.stat_ids[].abbr",
  "data.classes[].class",
  // the fixed G1 placeholder for the store path (the real path is never shown)
  "data.store.path",
  // the fixed literal "n too small (k of 30)"
  "data.metrics.brier.p_active.ours",
  "data.metrics.brier.p_win.ours",
  "data.metrics.brier.p_win.espn",
  "data.metrics.brier.p_playoffs.ours",
  "data.metrics.brier.p_playoffs.espn",
  "data.metrics.brier.p_role_holds.ours",
  "data.metrics.brier.p_k_win.ours",
  // the P1 tools' fixed server text (plan 10 §3.2): notes, gaps, verdicts, risks — never third-party
  "data.note",
  "data.notes[]",
  "data.players[].data_gaps[]",
  "data.evidence_note",
  "data.why_they_accept[]",
  "data.pass_down_back_note",
  "data.fixes[].action",
  "data.playoff_weeks.evidence_note",
  "data.playoff_weeks.week17_rest_risk.note",
  "data.bench_template.basis",
  "data.stash_values[].verdict",
  "data.stash_values[].playoff_horizon_note",
  "data.handcuff_values[].verdict",
  "data.consolidation_candidates[].target_profile",
  "data.ir.hidden_bench_play.risks[]",
  "data.ir.activation_timing_warning",
  "data.what_would_confirm[]",
  "data.calibration_state.note",
  "data.readings[].scenarios_applied[]",
  // E10's comparator values: a status code, a designation code or a fixed phrase ("IR move", "role
  // up", "official practice: full") — src/domain/analytics/evidence.ts; the user's claim text itself
  // only ever appears wrapped, in evidence[].claim
  "data.structured_disagrees.structured_value",
  "data.structured_disagrees.claim_value",
  // D4's depth-chart group labels: the closed DEPTH_LABELS vocabulary (or OTHER), enforced at publish
  // and again by the reader (src/store/datasets/readers-p2.ts) — never third-party free text
  "data.teams[].groups[].pos_grp",
]);

/** The violations of the A6 rule in one envelope (empty = compliant). */
export function envelopeViolations(env: {
  data: unknown;
  meta: { untrusted_fields: readonly { path: string; source: string }[] };
}): string[] {
  const listed = new Set(env.meta.untrusted_fields.map((f) => f.path));
  const bad: string[] = [];
  for (const l of stringLeaves(env.data)) {
    if (listed.has(l.path)) continue;
    if (CODE_LIKE.test(l.value)) continue;
    if (SERVER_PROSE.has(l.path)) continue;
    bad.push(l.path);
  }
  // E13's `sample_size` keys are the fixed RETRO_METRIC_KEYS vocabulary (dotted metric paths)
  const sampleKeys = Object.keys((env.data as { sample_size?: object }).sample_size ?? {});
  const fixed = sampleKeys.every((k) => (RETRO_METRIC_KEYS as readonly string[]).includes(k));
  const keys = objectKeyViolations(env.data).filter(
    (p) => !(fixed && p === "data.sample_size.{?}"),
  );
  return [...new Set([...bad, ...keys])];
}

/** A brace-GUID (a member id) — never in any result (plan 02 §2.4). */
export const GUID_RE =
  /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/;
/** An IPv4 literal (`lastUpdateInfo.clientAddress`) — never in any result. */
export const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;

/** Whether serialised text carries an identifier a result must never carry. */
export function identifierLeaks(text: string): string[] {
  const out: string[] = [];
  if (GUID_RE.test(text)) out.push("guid");
  if (IPV4_RE.test(text)) out.push("ipv4");
  if (text.includes('"league_id"')) out.push("league_id");
  return out;
}
