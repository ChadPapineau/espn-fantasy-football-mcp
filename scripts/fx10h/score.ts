// score.ts — every scoring field of fx-10h comes from here (plan 05 §3 fixture law line 2; ADV
// OBJ-21): the engine scores a recorded raw `stats{}` line under the REFERENCE settings, and the
// result is written as ESPN writes it — `appliedStats` (per ESPN stat id, non-zero points only) and
// `appliedTotal` — then re-checked with `verify`, so `espn_get_box_score` answers `match: true` on
// the base league by construction. This is plumbing, never engine evidence: the golden reads only
// fixtures/espn/recorded/.
import {
  score,
  statLineFromEspn,
  verify,
  type ScoringSettings,
} from "../../src/domain/scoring/index.js";
import { FixtureGenError, round6, type Obj } from "./json.js";

/** ESPN's applied fields for one line. */
export interface Applied {
  readonly appliedStats: Record<string, number>;
  readonly appliedTotal: number;
}

/** Scores raw ESPN stats for a player of `position` under `settings` (memoised per input). */
export function makeScorer(settings: ScoringSettings): (raw: Obj, position: number) => Applied {
  const memo = new Map<string, Applied>();
  return (raw, position) => {
    const key = `${String(position)}|${JSON.stringify(raw)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const line = statLineFromEspn({ raw }, position).line;
    const r = score(line, settings);
    const by: Record<string, number> = {};
    for (const c of r.contributions) {
      if (c.points === 0) continue;
      by[c.platform_id] = (by[c.platform_id] ?? 0) + c.points;
    }
    const appliedStats: Record<string, number> = {};
    for (const [k, v] of Object.entries(by)) {
      const p = round6(v);
      if (p !== 0) appliedStats[k] = p;
    }
    const out: Applied = { appliedStats, appliedTotal: round6(r.points) };
    const check = verify(line, settings, { total: out.appliedTotal, by_stat: out.appliedStats });
    if (!check.match)
      throw new FixtureGenError("fx-10h: a derived line does not verify against the engine");
    memo.set(key, out);
    return out;
  };
}

/** Scales a projected raw line (a projection is fractional already; counts stay ≥ 0). */
export function scaleRaw(raw: Obj, factor: number): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) out[k] = typeof v === "number" ? round6(v * factor) : v;
  return out;
}
