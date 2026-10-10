// run-calibrate-qb.ts — moment-matches the QB game-efficiency draw on the TRAINING season (2023;
// research 05 §3.2: turnovers widen the QB's left tail because bad games carry them): for each
// (cv_eff_qb, int_eff_power) on a grid, the 2023 QB cases' simulated draws give the within-case CV
// of yards per attempt and corr(INT, non-turnover points); the real within-player figures of the
// same population are printed beside them. Not a test and never run by CI.
//
//   scripts/dev/with-node.sh npx tsx tests/domain/analytics/projections-v2/helpers/run-calibrate-qb.ts
import {
  backtestCases,
  priorsBefore,
} from "../../../../../src/domain/analytics/projections-v2/backtest.js";
import { DEFAULT_V2_PARAMS } from "../../../../../src/domain/analytics/projections-v2/constants.js";
import { expectV2 } from "../../../../../src/domain/analytics/projections-v2/expectation.js";
import {
  lineAt,
  SAMPLE_WIDTH,
  simulateInto,
} from "../../../../../src/domain/analytics/projections-v2/simulate.js";
import type { V2Params } from "../../../../../src/domain/analytics/projections-v2/types.js";
import {
  indexTeamGames,
  teamGameKey,
} from "../../../../../src/domain/analytics/projections-v2/window.js";
import { seededRng } from "../../../../../src/domain/clock.js";
import { buildWorld, referenceLeagueSettings } from "./data.js";

const world = buildWorld("reference", referenceLeagueSettings());
const idx = indexTeamGames(world.team_games);
const cases = backtestCases(world, 2023, 4, 17).filter((c) => c.relevant && c.position === "QB");
const priors = priorsBefore(world, 2023);
const corr = (a: number[], b: number[]): number => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += ((a[i] ?? 0) - ma) * ((b[i] ?? 0) - mb);
    da += ((a[i] ?? 0) - ma) ** 2;
    db += ((b[i] ?? 0) - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
};
const nonTo = (v: Readonly<Record<string, number>>): number =>
  (v.pass_yd ?? 0) * 0.04 + (v.pass_td ?? 0) * 5 + (v.rush_yd ?? 0) * 0.1 + (v.rush_td ?? 0) * 6;
// the real within-player figures of the same cases (QBs with ≥ 20 attempts)
const byId = new Map(world.players.map((p) => [p.gsis_id, p]));
const realI: number[] = [];
const realP: number[] = [];
const ypaCv: number[] = [];
const realA: number[] = [];
const realY: number[] = [];
for (const id of new Set(cases.map((c) => c.gsis_id))) {
  const gs = (byId.get(id)?.games ?? []).filter((g) => g.season === 2023 && g.pass_att >= 20);
  if (gs.length < 6) continue;
  const pts = gs.map((g) => g.pass_yd * 0.04 + g.pass_td * 5 + g.rush_yd * 0.1 + g.rush_td * 6);
  const mi = gs.reduce((s, g) => s + g.pass_int, 0) / gs.length;
  const mp = pts.reduce((s, x) => s + x, 0) / gs.length;
  gs.forEach((g, i) => {
    realI.push(g.pass_int - mi);
    realP.push((pts[i] ?? 0) - mp);
  });
  const y = gs.map((g) => g.pass_yd / g.pass_att);
  const m = y.reduce((s, x) => s + x, 0) / y.length;
  const ma = gs.reduce((s, g) => s + g.pass_att, 0) / gs.length;
  gs.forEach((g, i) => {
    realA.push(g.pass_att - ma);
    realY.push((y[i] ?? 0) - m);
  });
  ypaCv.push(Math.sqrt(y.reduce((s, x) => s + (x - m) ** 2, 0) / (y.length - 1)) / m);
}
ypaCv.sort((a, b) => a - b);
const out: unknown[] = [
  {
    real: {
      corr_int_points: corr(realI, realP),
      corr_att_ypa: corr(realA, realY),
      ypa_cv_median: ypaCv[ypaCv.length >> 1],
      qbs: ypaCv.length,
      cases: cases.length,
    },
  },
];
for (const coupling of [0.75, 1])
  for (const driveTd of [0, 0.1, 0.2, 0.3]) {
    const roleScale = 0.5;
    const power = 1;
    const cvEff = 0.05;
    const params: V2Params = {
      ...DEFAULT_V2_PARAMS,
      sim: {
        ...DEFAULT_V2_PARAMS.sim,
        qb_role_scale: roleScale,
        cv_eff_qb: cvEff,
        int_eff_power: power,
        script_coupling: coupling,
        int_drive_td: driveTd,
        int_drive_yards: 120 * driveTd,
      },
    };
    const I: number[] = [];
    const P: number[] = [];
    const cvs: number[] = [];
    const attCv: number[] = [];
    const AA: number[] = [];
    const YY: number[] = [];
    const buf = new Float64Array(SAMPLE_WIDTH);
    for (const c of cases) {
      const tg = idx.get(teamGameKey(c.team, c.season, c.week)) ?? null;
      const r = expectV2(
        { position: "QB", position_id: 1, team: c.team, games: byId.get(c.gsis_id)?.games ?? [] },
        {
          season: c.season,
          week: c.week,
          team_index: idx,
          team_games: world.team_games,
          market: tg === null ? null : { implied: tg.implied, spread: tg.spread, total: tg.total },
          weather: null,
          opponent: tg?.opponent ?? null,
          matchup: null,
          priors,
          params,
        },
      );
      if (typeof r === "string") continue;
      const rng = seededRng(5).fork(`${c.gsis_id}:${String(c.week)}`);
      const ci: number[] = [];
      const cp: number[] = [];
      const ypa: number[] = [];
      const att: number[] = [];
      for (let i = 0; i < 200; i++) {
        simulateInto(r.expectation, 1, params, rng, buf, 0);
        const v = lineAt(buf, 0, 1).values;
        if ((v.pass_att ?? 0) < 20) continue;
        ci.push(v.pass_int ?? 0);
        cp.push(nonTo(v));
        ypa.push((v.pass_yd ?? 0) / (v.pass_att ?? 1));
        att.push(v.pass_att ?? 0);
      }
      const mi = ci.reduce((s, x) => s + x, 0) / ci.length;
      const mp = cp.reduce((s, x) => s + x, 0) / cp.length;
      ci.forEach((x, i) => {
        I.push(x - mi);
        P.push((cp[i] ?? 0) - mp);
      });
      const m = ypa.reduce((s, x) => s + x, 0) / ypa.length;
      const ma = att.reduce((s, x) => s + x, 0) / att.length;
      attCv.push(Math.sqrt(att.reduce((s, x) => s + (x - ma) ** 2, 0) / (att.length - 1)) / ma);
      att.forEach((x, i) => {
        AA.push(x - ma);
        YY.push((ypa[i] ?? 0) - m);
      });
      cvs.push(Math.sqrt(ypa.reduce((s, x) => s + (x - m) ** 2, 0) / (ypa.length - 1)) / m);
    }
    cvs.sort((a, b) => a - b);
    attCv.sort((a, b) => a - b);
    out.push({
      int_drive_td: driveTd,
      qb_role_scale: roleScale,
      att_cv_median: attCv[attCv.length >> 1],
      cv_eff_qb: cvEff,
      script_coupling: coupling,
      int_eff_power: power,
      corr_int_points: corr(I, P),
      corr_att_ypa: corr(AA, YY),
      ypa_cv_median: cvs[cvs.length >> 1],
    });
  }
console.log(JSON.stringify(out));
