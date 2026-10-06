// generate.ts — builds fixtures/espn/fx-10h/** (plan 09 §4 `gen-fixtures.ts`; plan 10 §3.1a
// *Fixtures* class 2; plan 05 §3 fixture law; research 06 §D.0): the base league and every variant,
// as ESPN view bodies plus one manifest per directory that the derived-league fixture fetch serves
// (src/providers/espn/fixture-league.ts). Pure over the recordings: no clock, no randomness, so a
// re-run is byte-identical and `--check` can prove the committed tree current.
//
// Refuses (throws, nothing written) unless the recorded golden is green. Every file is `derived:
// true` in its manifest with the engine (package version) and the reference `settings_hash`; the
// golden never reads any of it (tests/golden/recorded.ts refuses every path outside recorded/).
import { VERSION } from "../../src/version.js";
import { assertRecordedGoldenGreen, referenceSettings, SEASON } from "./inputs.js";
import type { Json, Obj } from "./json.js";
import {
  baseModel,
  CURRENT_WEEK,
  FINAL_WEEKS,
  MY_TEAM_ID,
  ALL_WEEKS,
  type Model,
} from "./model.js";
import { diff, jsonEqual, type PatchOp } from "./patch.js";
import { Renderer } from "./render.js";
import { makeScorer } from "./score.js";
import { VARIANTS } from "./variants.js";

/** The fixture directory, relative to fixtures/espn (every manifest path is relative to it). */
export const FX_DIR = "fx-10h";
/** The manifest format the derived-league fetch reads. */
export const FX_MANIFEST_KIND = "derived_league";
export const FX_MANIFEST_VERSION = 1;

/** One view a manifest serves. */
export interface FxView {
  readonly route: "league" | "season" | "players";
  readonly season: number;
  readonly views: readonly string[];
  readonly scoringPeriodId: number | null;
  /** The body (path relative to fixtures/espn). */
  readonly path: string;
  /** A JSON patch applied to that body (variants only). */
  readonly patch?: string;
  /** kona_player_info: the pool the fetch filters, sorts and pages. */
  readonly pool?: true;
  readonly derived: boolean;
}

/** A key of one rendered body. */
interface Rendered {
  readonly key: string;
  readonly view: Omit<FxView, "path" | "patch" | "derived">;
  readonly file: string;
  readonly body: Json;
  readonly derived: boolean;
}

function renderAll(model: Model, r: Renderer): Rendered[] {
  const league = (
    views: string[],
    sp: number | null,
    file: string,
    body: Json,
    extra: Partial<FxView> = {},
  ): Rendered => ({
    key: `league|${String(SEASON)}|${views.join(",")}|${sp === null ? "-" : String(sp)}`,
    view: { route: "league", season: SEASON, views, scoringPeriodId: sp, ...extra },
    file,
    body,
    derived: true,
  });
  const out: Rendered[] = [
    league(["mSettings"], null, "league/mSettings.json", r.mSettings()),
    league(["mNav"], null, "league/mNav.json", r.mNav()),
    league(["mTeam", "mStandings"], null, "league/mTeam.json", r.mTeam()),
    league(["mMatchup"], null, "league/mMatchup.json", r.mMatchup()),
    league(["mTransactions2"], null, "league/mTransactions2.json", r.mTransactions2()),
    league(
      ["mPendingTransactions"],
      null,
      "league/mPendingTransactions.json",
      r.mPendingTransactions(),
    ),
    league(["kona_player_info"], null, "league/pool.json", r.pool(), { pool: true }),
  ];
  for (const w of ALL_WEEKS) {
    out.push(
      league(["mMatchupScore"], w, `league/mMatchupScore.sp${String(w)}.json`, r.mMatchupScore(w)),
    );
    out.push(league(["mBoxscore"], w, `league/mBoxscore.sp${String(w)}.json`, r.mBoxscore(w)));
    out.push(league(["mRoster"], w, `league/mRoster.sp${String(w)}.json`, r.mRoster(w)));
  }
  const last = r.lastSeasonStandings();
  if (last !== null)
    out.push({
      key: `league|${String(SEASON - 1)}|mTeam,mStandings|-`,
      view: {
        route: "league",
        season: SEASON - 1,
        views: ["mTeam", "mStandings"],
        scoringPeriodId: null,
      },
      file: `history/${String(SEASON - 1)}-mTeam.json`,
      body: last,
      derived: true,
    });
  out.push({
    key: `season|${String(SEASON)}|proTeamSchedules_wl|-`,
    view: {
      route: "season",
      season: SEASON,
      views: ["proTeamSchedules_wl"],
      scoringPeriodId: null,
    },
    file: "season/proTeamSchedules_wl.json",
    body: model.proSchedule,
    derived: true,
  });
  return out;
}

/** The recorded season player index is served as recorded (no scoring field; not derived). */
const PLAYERS_WL: FxView = {
  route: "players",
  season: SEASON,
  views: ["players_wl"],
  scoringPeriodId: null,
  path: "recorded/season/players_wl.json",
  derived: false,
};

/** Waiver order: the user at 2 (D.0), everyone else worst-first by the current seeds. */
function assignWaiverRanks(model: Model, r: Renderer, myRank = 2): void {
  const seeds = r.seeds();
  const others = model.teams
    .filter((t) => t.id !== MY_TEAM_ID)
    .sort((a, b) => (seeds.get(b.id) ?? 0) - (seeds.get(a.id) ?? 0) || a.id - b.id);
  let rank = 1;
  for (const t of others) {
    if (rank === myRank) rank++;
    t.waiverRank = rank++;
  }
  const me = model.teams.find((t) => t.id === MY_TEAM_ID);
  if (me !== undefined) me.waiverRank = myRank;
}

/** Checks the plumbing the Skills' tool sequences need (skills/<name>/evals/tool_sequence.json). */
function assertSkillsPlumbing(model: Model): void {
  const mine = model.rosters.get(CURRENT_WEEK)?.get(MY_TEAM_ID) ?? [];
  const flexStarter = mine.some((s) => s.lineupSlotId === 23);
  const flexBench = mine.some((s) => {
    if (s.lineupSlotId !== 20) return false;
    const e = model.players.get(s.playerId)?.player.eligibleSlots;
    return Array.isArray(e) && e.includes(23);
  });
  if (!flexStarter || !flexBench)
    throw new Error(
      "fx-10h: Team 02's week-5 roster needs a FLEX starter and a FLEX-eligible bench player",
    );
  const opp = model.schedule.find(
    (m) => m.period === CURRENT_WEEK && (m.home === MY_TEAM_ID || m.away === MY_TEAM_ID),
  );
  if (opp === undefined) throw new Error("fx-10h: Team 02 has no week-5 matchup");
}

/** The README counts (how much of the league is derived beyond the recordings). */
function derivationSummary(model: Model): Obj {
  const counts: Record<string, number> = {};
  for (const p of model.players.values())
    for (const d of p.derived) {
      const k = d.replace(/ ← \d+$/, "");
      counts[k] = (counts[k] ?? 0) + 1;
    }
  return counts;
}

export interface Generated {
  /** path (relative to fixtures/espn) → JSON body. */
  readonly files: Map<string, Json>;
  /** The golden gate's line count (for the CLI's report). */
  readonly goldenLines: number;
}

/** Builds every file of fixtures/espn/fx-10h. */
export function generate(): Generated {
  const gate = assertRecordedGoldenGreen();
  const settings = referenceSettings();
  const scorer = makeScorer(settings);
  const files = new Map<string, Json>();

  const base = baseModel();
  const baseRenderer = new Renderer(base, scorer);
  assignWaiverRanks(base, baseRenderer);
  assertSkillsPlumbing(base);
  const baseRendered = renderAll(base, baseRenderer);
  const baseByKey = new Map(baseRendered.map((x) => [x.key, x]));
  const manifestOf = (model: Model, views: FxView[], extra: Obj): Obj => ({
    $comment:
      "Derived fixture league (plan 05 §3 fixture law, class 2 — plumbing, never engine evidence): every scoring field was re-scored by the engine under the reference settings from recorded raw stats; the golden never reads this tree. Generated by `npx tsx scripts/gen-fixtures.ts`; never edit by hand.",
    kind: FX_MANIFEST_KIND,
    version: FX_MANIFEST_VERSION,
    league: model.name,
    derived: true,
    season: SEASON,
    clock: model.clock,
    root: model.name === FX_DIR ? ".." : "../..",
    engine: {
      package_version: VERSION,
      settings_hash: settings.settings_hash,
      rounding: settings.rounding.mode,
    },
    current_week: CURRENT_WEEK,
    final_weeks: [...FINAL_WEEKS],
    my_team_id: MY_TEAM_ID,
    env: model.env,
    harness: model.harness,
    notes: model.notes,
    ...extra,
    views: views as unknown as Json,
  });

  const baseViews: FxView[] = baseRendered.map((x) => {
    const path = `${FX_DIR}/${x.file}`;
    files.set(path, x.body);
    return { ...x.view, path, derived: x.derived };
  });
  baseViews.push(PLAYERS_WL);
  files.set(
    `${FX_DIR}/manifest.json`,
    manifestOf(base, baseViews, {
      golden_gate_lines: gate.lines,
      derivations: derivationSummary(base),
      variants: VARIANTS.map((v) => v.name),
    }),
  );

  for (const v of VARIANTS) {
    const model = baseModel();
    const r0 = new Renderer(model, scorer);
    assignWaiverRanks(model, r0);
    model.name = `${FX_DIR}/${v.name}`;
    v.mutate(model, r0);
    const r = new Renderer(model, scorer);
    // bodies are deep-copied before any post-render edit, so nothing a variant changes is shared
    const rendered = renderAll(model, r).map((x) => ({ ...x, body: structuredClone(x.body) }));
    for (const post of v.postRender ?? [])
      post(
        rendered.map((x) => ({ key: x.key, body: x.body })),
        model,
        r,
      );
    const views: FxView[] = [];
    for (const x of rendered) {
      const b = baseByKey.get(x.key);
      if (b === undefined) {
        const path = `${FX_DIR}/${v.name}/${x.file}`;
        files.set(path, x.body);
        views.push({ ...x.view, path, derived: true });
        continue;
      }
      const basePath = `${FX_DIR}/${b.file}`;
      if (jsonEqual(b.body, x.body)) {
        views.push({ ...x.view, path: basePath, derived: true });
        continue;
      }
      const ops: PatchOp[] = diff(b.body, x.body);
      const patchPath = `${FX_DIR}/${v.name}/${x.file.replace(/\.json$/, ".patch.json")}`;
      files.set(patchPath, ops as unknown as Json);
      views.push({ ...x.view, path: basePath, patch: patchPath, derived: true });
    }
    for (const k of v.removeKeys ?? []) {
      const i = views.findIndex(
        (x) =>
          `${x.route}|${String(x.season)}|${x.views.join(",")}|${x.scoringPeriodId === null ? "-" : String(x.scoringPeriodId)}` ===
          k,
      );
      if (i >= 0) views.splice(i, 1);
    }
    views.push(PLAYERS_WL);
    files.set(
      `${FX_DIR}/${v.name}/manifest.json`,
      manifestOf(model, views, { variant: v.name, describes: v.describes }),
    );
  }
  return { files, goldenLines: gate.lines };
}

export type { Json };
