// synth.ts — synthetic team-game usage rows and absence events for the cascade-priors tests (no real
// data: teams "T1"/"T2", players "a", "b", …).
import { DEFAULT_ABSENCE_RULES } from "../../../../../src/domain/analytics/cascade-priors/absences.js";
import type {
  AbsenceEvent,
  CascadePriorTable,
  PriorCell,
  AbsenceTeammate,
  BeneficiaryRole,
  ComponentShares,
  ComponentVolume,
  InjuredPosition,
  SkillPosition,
  UsagePosition,
  UsageRow,
} from "../../../../../src/domain/analytics/cascade-priors/types.js";

/** [position, targets, carries, rz_targets?, rz_carries?, depth?] for one player in one week. */
export type Cell = readonly [UsagePosition, number, number, number?, number?, (number | null)?];

/** Rows for one team-season from a week → player → cell map. */
export function teamSeason(
  season: number,
  team: string,
  weeks: Readonly<Record<number, Readonly<Record<string, Cell>>>>,
): UsageRow[] {
  const out: UsageRow[] = [];
  for (const [w, players] of Object.entries(weeks))
    for (const [player, [position, targets, carries, rzt, rzc, depth]] of Object.entries(players))
      out.push({
        season,
        week: Number(w),
        team,
        player,
        position,
        depth: depth ?? null,
        targets,
        carries,
        rz_targets: rzt ?? 0,
        rz_carries: rzc ?? 0,
      });
  return out;
}

const shares = (t: number, c: number, rz: number): ComponentShares => ({
  targets: t,
  carries: c,
  rz,
});

/** One teammate of a synthetic event. */
export function mateOf(
  player: string,
  position: SkillPosition,
  role: BeneficiaryRole,
  pre: readonly [number, number, number],
  post: readonly [number, number, number],
  extra: Partial<AbsenceTeammate> = {},
): AbsenceTeammate {
  return {
    player,
    position,
    role,
    depth: null,
    pre_opportunities: pre[0] * 30 + pre[1] * 25,
    pre: shares(...pre),
    post: shares(...post),
    ...extra,
  };
}

/** A synthetic absence event. */
export function eventOf(
  over: Partial<AbsenceEvent> & {
    readonly position?: InjuredPosition;
    readonly vacated?: readonly [number, number, number];
  } = {},
): AbsenceEvent {
  const { position = "WR", vacated = [0.25, 0, 0.2], ...rest } = over;
  const vol: ComponentVolume = { targets: 30, carries: 25, rz: 6 };
  return {
    season: 2024,
    team: "T1",
    week: 6,
    injured: {
      player: "x",
      position,
      role: position === "RB" ? "RB1" : position === "WR" ? "WR1" : "TE1",
      pre: shares(...vacated),
    },
    team_pre: vol,
    team_post: vol,
    pre_weeks: [2, 3, 4, 5],
    post_weeks: [6, 7],
    games_missed: 2,
    teammates: [],
    ...rest,
  };
}

/** A cell with the same factor per component for the given roles. */
export function cell(f: Partial<Record<BeneficiaryRole, number>>): PriorCell {
  const row = Object.fromEntries(
    Object.entries(f).map(([role, v]) => [role, { f: v, sd: 0, n: 10 }]),
  );
  return { targets: row, carries: row, rz: row };
}

/** A table whose every position reads the given pooled cell (and the given context cells). */
export function tableOf(
  pooled: PriorCell,
  cells: CascadePriorTable["cells"] = { RB: {}, WR: {}, TE: {} },
): CascadePriorTable {
  return {
    version: "cascade-priors-v2",
    seasons: [2023],
    absences: 1,
    absences_by_position: { RB: 0, WR: 1, TE: 0 },
    rules: DEFAULT_ABSENCE_RULES,
    tilt_cut: 0.55,
    hold_cut: { RB: 0.5, WR: 0.21, TE: 0.16 },
    shrink_events: 30,
    role_rule: "successor",
    pooled: { RB: pooled, WR: pooled, TE: pooled },
    cells,
    provenance: [],
  };
}
