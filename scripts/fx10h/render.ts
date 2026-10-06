// render.ts — the fx-10h model rendered as ESPN view bodies (research 03 §A.2 shapes, as recorded in
// fixtures/espn/recorded/league-b): mSettings, mNav, mTeam+mStandings, mMatchup, mMatchupScore and
// mBoxscore per week, mRoster per week, the player pool (kona_player_info, answered by the
// derived-league fetch from one pool file), mTransactions2, mPendingTransactions, the pro schedule
// and last season's standings. Every scoring field — appliedStats, appliedTotal, team totals,
// winners, records, points for/against, seeds — is re-derived here from the raw lines under the
// reference settings (plan 05 §3 fixture law line 2; R3 nit (b)), so the scoreboard, the standings
// and the seeding simulator agree with the box scores.
import { arr, clone, isObj, num, obj, round2, round6, type Json, type Obj } from "./json.js";
import { recorded, referenceScoringSettings, SEASON, type PlayerRecord } from "./inputs.js";
import {
  ALL_WEEKS,
  CURRENT_WEEK,
  FINAL_WEEKS,
  kickoffOf,
  LAST_WEEK,
  LINEUP_SLOT_COUNTS,
  ms,
  PLAYOFF_TEAMS,
  REGULAR_SEASON_PERIODS,
  rosteredIn,
  SLOT,
  teamOf,
  type MatchupModel,
  type Model,
  type Seat,
} from "./model.js";
import { scaleRaw, type Applied } from "./score.js";

export type Scorer = (raw: Obj, position: number) => Applied;

const TRADE_DEADLINE = "2026-12-02T17:00:00.000Z";
/** Every day but Tuesday (as the recorded 10-team league: the Wednesday run clears the week). */
const PROCESS_DAYS = ["SATURDAY", "SUNDAY", "THURSDAY", "WEDNESDAY", "MONDAY", "FRIDAY"];

const isStarter = (slot: number): boolean => slot !== SLOT.BE && slot !== SLOT.IR;

/** The ownership keys a roster view carries (as recorded in league-b's mRoster). */
const OWNERSHIP_KEYS = [
  "auctionValueAverage",
  "averageDraftPosition",
  "percentChange",
  "percentOwned",
  "percentStarted",
] as const;

/**
 * A pool entry in kona_player_info's recorded shape (research 03 §B.3): no `appliedStatTotal` on
 * the entry, no `universeId` on the player, and stat splits without `appliedStats` (the totals are
 * still the engine's).
 */
function konaShape(entry: Obj): Obj {
  const out = { ...entry };
  delete out.appliedStatTotal;
  const player = isObj(out.player) ? { ...out.player } : null;
  if (player !== null) {
    delete player.universeId;
    if (Array.isArray(player.stats))
      player.stats = player.stats.map((st) => {
        if (!isObj(st)) return st;
        const copy = { ...st };
        delete copy.appliedStats;
        return copy;
      });
    out.player = player;
  }
  return out;
}

/**
 * ESPN's `winProbability` stand-in (0–1, research 03 §B.4): a normal approximation on the projected
 * margin with a 25-point spread (plumbing — ESPN's model is not public). 0.5 without projections.
 */
function winProbability(margin: number, known: boolean): number {
  if (!known) return 0.5;
  const z = margin / 25;
  // Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  const cdf = z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  return Math.round(cdf * 1e4) / 1e4;
}

/** The renderer over one model. */
export class Renderer {
  private readonly m: Model;
  private readonly score: Scorer;
  private readonly totals = new Map<string, number>();

  constructor(model: Model, scorer: Scorer) {
    this.m = model;
    this.score = scorer;
  }

  private positionOf(p: PlayerRecord): number {
    return typeof p.player.defaultPositionId === "number" ? p.player.defaultPositionId : 0;
  }

  private proTeam(p: PlayerRecord): number {
    return typeof p.player.proTeamId === "number" ? p.player.proTeamId : 0;
  }

  /** The week-`w` actual raw line (week 5 only for a player whose game started — live variants). */
  actualRaw(p: PlayerRecord, w: number): Obj | undefined {
    if (w === CURRENT_WEEK) return this.m.live.get(p.id);
    return p.actual.get(w);
  }

  /** The week-`w` projected raw line, scaled where a variant says so (week 5 only). */
  projectedRaw(p: PlayerRecord, w: number): Obj | undefined {
    const raw = p.projected.get(w);
    if (raw === undefined) return undefined;
    const f = w === CURRENT_WEEK ? this.m.projectionScale.get(p.id) : undefined;
    return f === undefined ? raw : scaleRaw(raw, f);
  }

  /** The actual points a player scored in week `w` (0 when they did not play). */
  actualPoints(pid: number, w: number): number {
    const p = this.m.players.get(pid);
    if (p === undefined) return 0;
    const raw = this.actualRaw(p, w);
    return raw === undefined ? 0 : this.score(raw, this.positionOf(p)).appliedTotal;
  }

  /** A team's week-`w` total: its starters' points (bench and IR score nothing). */
  teamTotal(teamId: number, w: number): number {
    const key = `${String(teamId)}:${String(w)}`;
    const hit = this.totals.get(key);
    if (hit !== undefined) return hit;
    const seats = this.m.rosters.get(w)?.get(teamId) ?? [];
    let sum = 0;
    for (const s of seats) if (isStarter(s.lineupSlotId)) sum += this.actualPoints(s.playerId, w);
    const total = round2(sum);
    this.totals.set(key, total);
    return total;
  }

  /** The winner of a final matchup. */
  winnerOf(m: MatchupModel): "HOME" | "AWAY" | "TIE" | "UNDECIDED" {
    if (m.period > FINAL_WEEKS.length) return "UNDECIDED";
    const h = this.teamTotal(m.home, m.period);
    const a = this.teamTotal(m.away, m.period);
    return h > a ? "HOME" : a > h ? "AWAY" : "TIE";
  }

  // --- stats entries --------------------------------------------------------------------------

  private statEntry(p: PlayerRecord, raw: Obj, sp: number, source: number, split: number): Obj {
    const a = this.score(raw, this.positionOf(p));
    let externalId = `${String(SEASON)}${sp === 0 ? "" : String(sp)}`;
    let proTeamId = 0;
    if (source === 0 && split === 1) {
      proTeamId = this.proTeam(p);
      const game = this.gameId(proTeamId, sp);
      if (game !== null) externalId = String(game);
    }
    return {
      // a copy: the scorer memoises, and a variant's post-render edit must never reach the base
      appliedStats: { ...a.appliedStats },
      appliedTotal: a.appliedTotal,
      externalId,
      id: `${String(source)}${String(split)}${externalId}`,
      proTeamId,
      scoringPeriodId: sp,
      seasonId: SEASON,
      statSourceId: source,
      statSplitTypeId: split,
      stats: clone(raw),
    };
  }

  private gameId(proTeamId: number, week: number): number | null {
    for (const t of arr(obj(this.m.proSchedule.settings, "settings").proTeams, "proTeams")) {
      const team = obj(t, "proTeam");
      if (team.id !== proTeamId) continue;
      const games = team.proGamesByScoringPeriod;
      if (!isObj(games)) return null;
      const g = arr(games[String(week)] ?? [], "games")[0];
      return g !== undefined && isObj(g) && typeof g.id === "number" ? g.id : null;
    }
    return null;
  }

  /** The weekly splits of the given weeks (actual where played, projected where projected). */
  weeklyStats(p: PlayerRecord, weeks: readonly number[]): Obj[] {
    const out: Obj[] = [];
    for (const w of weeks) {
      const a = this.actualRaw(p, w);
      if (a !== undefined) out.push(this.statEntry(p, a, w, 0, 1));
      const pr = this.projectedRaw(p, w);
      if (pr !== undefined) out.push(this.statEntry(p, pr, w, 1, 1));
    }
    return out;
  }

  /**
   * The season splits. To date (0:0) is the sum of the engine-scored weekly actual lines (raw and
   * applied summed per stat id — what ESPN's season line is). The season and rest-of-season
   * projections (1:0, 1:2) keep the recorded raw stats and are engine-scored; where the engine
   * refuses an aggregate (a D/ST line's summed points-allowed tiers exceed 1 — engine.ts
   * bracket_exclusivity), the applied total is the mean derived weekly projection times the weeks
   * the split spans, with no per-stat split (plumbing; ESPN's own season split is never copied).
   */
  seasonStats(p: PlayerRecord): Obj[] {
    const out: Obj[] = [];
    const pos = this.positionOf(p);
    const raw: Obj = {};
    const applied: Record<string, number> = {};
    let total = 0;
    let played = 0;
    for (const w of FINAL_WEEKS) {
      const line = this.actualRaw(p, w);
      if (line === undefined) continue;
      played++;
      for (const [k, v] of Object.entries(line))
        if (typeof v === "number") raw[k] = round6((typeof raw[k] === "number" ? raw[k] : 0) + v);
      const a = this.score(line, pos);
      for (const [k, v] of Object.entries(a.appliedStats))
        applied[k] = round6((applied[k] ?? 0) + v);
      total += a.appliedTotal;
    }
    if (played > 0)
      out.push({
        appliedAverage: round6(total / played),
        appliedStats: applied,
        appliedTotal: round6(total),
        externalId: String(SEASON),
        id: `00${String(SEASON)}`,
        proTeamId: 0,
        scoringPeriodId: 0,
        seasonId: SEASON,
        statSourceId: 0,
        statSplitTypeId: 0,
        stats: raw,
      });
    for (const [key, line] of [...p.season.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [source, split] = key.split(":").map(Number);
      if (source !== 1 || (split !== 0 && split !== 2)) continue;
      try {
        out.push(this.statEntry(p, line, 0, source, split));
      } catch {
        const weekly = [...ALL_WEEKS]
          .map((w) => this.projectedRaw(p, w))
          .filter((x): x is Obj => x !== undefined)
          .map((x) => this.score(x, pos).appliedTotal);
        const mean = weekly.length === 0 ? 0 : weekly.reduce((a, b) => a + b, 0) / weekly.length;
        const span = split === 2 ? LAST_WEEK - FINAL_WEEKS.length : LAST_WEEK;
        out.push({
          appliedStats: {},
          appliedTotal: round6(mean * span),
          externalId: String(SEASON),
          id: `${String(source)}${String(split)}${String(SEASON)}`,
          proTeamId: 0,
          scoringPeriodId: 0,
          seasonId: SEASON,
          statSourceId: source,
          statSplitTypeId: split,
          stats: clone(line),
        });
      }
    }
    return out;
  }

  /** The player object of a view: the recorded template plus the model's overrides and stats. */
  playerObject(p: PlayerRecord, stats: Obj[]): Obj {
    const out = clone(p.player);
    delete out.lastVideoDate;
    delete out.outlooks;
    delete out.jersey;
    out.rankings = {};
    if (isObj(out.ownership)) {
      const own: Obj = {};
      for (const k of OWNERSHIP_KEYS) if (out.ownership[k] !== undefined) own[k] = out.ownership[k];
      out.ownership = own;
    }
    const ranks = out.draftRanksByRankType;
    if (isObj(ranks)) {
      const keep: Obj = {};
      if (ranks.STANDARD !== undefined) keep.STANDARD = ranks.STANDARD;
      out.draftRanksByRankType = keep;
    }
    const injury = this.m.injury.get(p.id);
    if (injury !== undefined) {
      out.injuryStatus = injury;
      out.injured = !["ACTIVE", "NORMAL"].includes(injury);
    }
    const outlook = this.m.outlook.get(p.id);
    if (outlook !== undefined) out.seasonOutlook = outlook;
    const weekly = this.m.weeklyOutlook.get(p.id);
    if (weekly !== undefined) out.outlooks = { outlooksByWeek: { ...weekly } };
    out.stats = stats;
    return out;
  }

  private poolEntry(p: PlayerRecord, week: number, stats: Obj[]): Obj {
    const onTeamId = teamOf(this.m, week, p.id);
    const base = clone(p.poolEntry);
    delete base.droppedByEliminatedTeam;
    delete base.draftAuctionValue;
    delete base.waiverDate;
    const proj = this.projectedRaw(p, week);
    return {
      ...base,
      appliedStatTotal: proj === undefined ? 0 : this.score(proj, this.positionOf(p)).appliedTotal,
      id: p.id,
      keeperValue: typeof base.keeperValue === "number" ? base.keeperValue : 0,
      keeperValueFuture: typeof base.keeperValueFuture === "number" ? base.keeperValueFuture : 0,
      lineupLocked: week < CURRENT_WEEK || this.m.locked.has(p.id),
      onTeamId,
      player: this.playerObject(p, stats),
      rosterLocked: week < CURRENT_WEEK || this.m.locked.has(p.id),
      status: onTeamId !== 0 ? "ONTEAM" : week === CURRENT_WEEK ? this.m.poolStatus : "FREEAGENT",
      tradeLocked: false,
    };
  }

  // --- common pieces --------------------------------------------------------------------------

  status(): Obj {
    const s = clone(obj(recorded("league-b/mSettings.json").status, "status"));
    const runs: Obj = {
      "2026-09-16T07:30:00.000+00:00": 4,
      "2026-09-23T07:30:00.000+00:00": 6,
      "2026-09-30T07:30:00.000+00:00": 5,
    };
    if (ms(this.m.waiverLast) > ms("2026-10-01T00:00:00.000Z"))
      runs[this.m.waiverLast.replace("Z", "+00:00")] = 3;
    return {
      ...s,
      currentMatchupPeriod: CURRENT_WEEK,
      finalScoringPeriod: LAST_WEEK,
      firstScoringPeriod: 1,
      isActive: true,
      isPlayoffMatchupEdited: this.m.playoffMatchupEdited,
      isWaiverOrderEdited: false,
      latestScoringPeriod: CURRENT_WEEK,
      previousSeasons: this.m.lastSeason === null ? [] : [SEASON - 1],
      standingsUpdateDate: ms("2026-10-06T08:00:00.000Z"),
      teamsJoined: this.m.teams.length,
      transactionScoringPeriod: CURRENT_WEEK,
      waiverLastExecutionDate: ms(this.m.waiverLast),
      waiverNextExecutionDate: ms(this.m.waiverNext),
      waiverProcessStatus: runs,
    };
  }

  private top(sp: number): Obj {
    return {
      draftDetail: { drafted: true, inProgress: false },
      gameId: 1,
      id: 0,
      scoringPeriodId: sp,
      seasonId: SEASON,
      segmentId: 0,
      status: this.status(),
    };
  }

  private settings(): Obj {
    const rec = clone(obj(recorded("league-b/mSettings.json").settings, "settings"));
    const roster = obj(rec.rosterSettings, "rosterSettings");
    const counts: Obj = {};
    for (const k of Object.keys(obj(roster.lineupSlotCounts, "lineupSlotCounts")))
      counts[k] = LINEUP_SLOT_COUNTS[Number(k)] ?? 0;
    roster.lineupSlotCounts = counts;
    const matchupPeriods: Obj = {};
    for (let w = 1; w <= LAST_WEEK; w++) matchupPeriods[String(w)] = [w];
    return {
      ...rec,
      acquisitionSettings: {
        acquisitionBudget: this.m.usesBudget ? this.m.budget : 0,
        acquisitionLimit: -1,
        acquisitionType: "WAIVERS_TRADITIONAL",
        finalPlaceTransactionEligible: 0,
        isUsingAcquisitionBudget: this.m.usesBudget,
        matchupAcquisitionLimit: 0,
        matchupLimitPerScoringPeriod: false,
        minimumBid: this.m.usesBudget ? 1 : 0,
        transactionLockingEnabled: false,
        waiverHours: 24,
        waiverOrderReset: false,
        waiverProcessDays: [...PROCESS_DAYS],
        waiverProcessHour: 3,
      },
      draftSettings: { ...obj(rec.draftSettings, "draftSettings"), keeperCount: 0 },
      isPublic: this.m.isPublic,
      name: this.m.leagueName,
      rosterSettings: roster,
      scheduleSettings: {
        consolationLadderDisabled: false,
        divisions: [{ id: 0, name: this.m.divisionName, size: this.m.teams.length }],
        matchupPeriodCount: REGULAR_SEASON_PERIODS,
        matchupPeriodLength: 1,
        matchupPeriods,
        periodTypeId: 1,
        playoffMatchupPeriodLength: 1,
        playoffReseed: false,
        playoffSeedingRule: "TOTAL_POINTS_SCORED",
        playoffSeedingRuleBy: 0,
        playoffTeamCount: PLAYOFF_TEAMS,
        variablePlayoffMatchupPeriodLength: false,
      },
      scoringSettings: referenceScoringSettings(),
      size: this.m.teams.length,
      tradeSettings: {
        allowOutOfUniverse: false,
        deadlineDate: ms(TRADE_DEADLINE),
        max: -1,
        revisionHours: 24,
        vetoVotesRequired: 4,
      },
    };
  }

  private membersBody(): Obj[] {
    return this.m.members.map((mm, i) => ({
      displayName: mm.displayName,
      firstName: "",
      id: mm.id,
      isLeagueCreator: i === 0,
      isLeagueManager: i === 0,
      lastName: "",
    }));
  }

  // --- records and standings --------------------------------------------------------------------

  /** Overall, home and away records through the final weeks, and the streak. */
  records(): Map<
    number,
    { overall: Obj; home: Obj; away: Obj; pf: number; pa: number; wins: number }
  > {
    const acc = new Map<
      number,
      {
        w: number;
        l: number;
        t: number;
        pf: number;
        pa: number;
        hw: number;
        hl: number;
        ht: number;
        aw: number;
        al: number;
        at: number;
        results: string[];
      }
    >();
    for (const t of this.m.teams)
      acc.set(t.id, {
        w: 0,
        l: 0,
        t: 0,
        pf: 0,
        pa: 0,
        hw: 0,
        hl: 0,
        ht: 0,
        aw: 0,
        al: 0,
        at: 0,
        results: [],
      });
    for (const m of this.m.schedule) {
      if (m.period > FINAL_WEEKS.length) continue;
      const h = this.teamTotal(m.home, m.period);
      const a = this.teamTotal(m.away, m.period);
      const H = acc.get(m.home);
      const A = acc.get(m.away);
      if (H === undefined || A === undefined) continue;
      H.pf += h;
      H.pa += a;
      A.pf += a;
      A.pa += h;
      if (h > a) {
        H.w++;
        H.hw++;
        A.l++;
        A.al++;
        H.results.push("W");
        A.results.push("L");
      } else if (a > h) {
        A.w++;
        A.aw++;
        H.l++;
        H.hl++;
        A.results.push("W");
        H.results.push("L");
      } else {
        H.t++;
        A.t++;
        H.ht++;
        A.at++;
        H.results.push("T");
        A.results.push("T");
      }
    }
    const leaderWins = Math.max(...[...acc.values()].map((r) => r.w));
    const out = new Map<
      number,
      { overall: Obj; home: Obj; away: Obj; pf: number; pa: number; wins: number }
    >();
    for (const [id, r] of acc) {
      const last = r.results[r.results.length - 1] ?? null;
      let streak = 0;
      for (let i = r.results.length - 1; i >= 0 && r.results[i] === last; i--) streak++;
      const rec = (w: number, l: number, t: number, pf: number, pa: number): Obj => ({
        gamesBack: leaderWins - r.w,
        losses: l,
        percentage: w + l + t === 0 ? 0 : (w + t / 2) / (w + l + t),
        pointsAgainst: round2(pa),
        pointsFor: round2(pf),
        streakLength: streak,
        streakType: last === "W" ? "WIN" : last === "L" ? "LOSS" : last === "T" ? "TIE" : "NONE",
        ties: t,
        wins: w,
      });
      out.set(id, {
        overall: rec(r.w, r.l, r.t, r.pf, r.pa),
        home: rec(r.hw, r.hl, r.ht, 0, 0),
        away: rec(r.aw, r.al, r.at, 0, 0),
        pf: round2(r.pf),
        pa: round2(r.pa),
        wins: r.w,
      });
    }
    return out;
  }

  /** Current seeds by ESPN's rule (record, then total points — D1). */
  seeds(): Map<number, number> {
    const recs = this.records();
    const order = [...recs.entries()].sort(
      ([ia, a], [ib, b]) => b.wins - a.wins || b.pf - a.pf || ia - ib,
    );
    return new Map(order.map(([id], i) => [id, i + 1]));
  }

  // --- views ------------------------------------------------------------------------------------

  mSettings(): Obj {
    return { ...this.top(CURRENT_WEEK), settings: this.settings() };
  }

  mNav(): Obj {
    const s = this.settings();
    return {
      ...this.top(CURRENT_WEEK),
      members: this.membersBody(),
      settings: {
        acquisitionSettings: { isUsingAcquisitionBudget: this.m.usesBudget },
        draftSettings: { keeperCount: 0 },
        isCustomizable: true,
        isPublic: s.isPublic ?? false,
        name: this.m.leagueName,
        rosterSettings: { isUsingUndroppableList: true },
        scoringSettings: { scoringType: "H2H_POINTS" },
      },
      teams: this.m.teams.map((t) => ({
        abbrev: t.abbrev,
        id: t.id,
        logo: "",
        logoType: "VECTOR",
        name: t.name,
        owners: [...t.owners],
      })),
    };
  }

  private teamObjects(): Obj[] {
    const recs = this.records();
    const seeds = this.seeds();
    return this.m.teams.map((t) => {
      const r = recs.get(t.id);
      const tpl = clone(t.template);
      const counter = isObj(tpl.transactionCounter) ? tpl.transactionCounter : {};
      return {
        ...tpl,
        abbrev: t.abbrev,
        divisionId: 0,
        isActive: true,
        logo: "",
        name: t.name,
        owners: [...t.owners],
        playoffSeed: seeds.get(t.id) ?? 0,
        points: r?.pf ?? 0,
        pointsAdjusted: 0,
        pointsDelta: 0,
        primaryOwner: t.owners[0] ?? "",
        rankCalculatedFinal: 0,
        rankFinal: 0,
        record:
          r === undefined
            ? (tpl.record ?? null)
            : { away: r.away, division: r.overall, home: r.home, overall: r.overall },
        tradeBlock: t.tradeBlockNote === null ? {} : { note: t.tradeBlockNote },
        transactionCounter: {
          ...counter,
          acquisitionBudgetSpent: this.m.budgetSpent.get(t.id) ?? 0,
        },
        waiverRank: t.waiverRank,
      };
    });
  }

  /** A player's ESPN projection for week `w` (0 without one). */
  projectedPoints(pid: number, w: number): number {
    const p = this.m.players.get(pid);
    if (p === undefined) return 0;
    const raw = this.projectedRaw(p, w);
    return raw === undefined ? 0 : this.score(raw, this.positionOf(p)).appliedTotal;
  }

  /** A team's projected week-`w` total (starters' ESPN projections). */
  projectedTotal(teamId: number, w: number, onlyNotStarted = false): number {
    let sum = 0;
    for (const s of this.m.rosters.get(w)?.get(teamId) ?? []) {
      if (!isStarter(s.lineupSlotId)) continue;
      const p = this.m.players.get(s.playerId);
      if (p === undefined) continue;
      if (onlyNotStarted && this.m.live.has(p.id)) continue;
      const raw = this.projectedRaw(p, w);
      if (raw !== undefined) sum += this.score(raw, this.positionOf(p)).appliedTotal;
    }
    return round6(sum);
  }

  private sideTotals(m: MatchupModel, side: "home" | "away"): Obj {
    const teamId = side === "home" ? m.home : m.away;
    const final = m.period <= FINAL_WEEKS.length;
    const base = {
      adjustment: 0,
      cumulativeScore: { losses: 0, statBySlot: null, ties: 0, wins: 0 },
      eliminationMatchupPeriod: 0,
      teamId,
      tiebreak: 0,
    };
    if (final) {
      const total = this.teamTotal(teamId, m.period);
      return { ...base, pointsByScoringPeriod: { [String(m.period)]: total }, totalPoints: total };
    }
    if (m.period !== CURRENT_WEEK) return { ...base, totalPoints: 0 };
    // the current week (research 03 §B.4: current-period rows only): live and projected totals
    const live = this.teamTotal(teamId, m.period);
    const projected = this.projectedTotal(teamId, m.period);
    const other = side === "home" ? m.away : m.home;
    const otherProjected = this.projectedTotal(other, m.period);
    const liveProjected = round6(live + this.projectedTotal(teamId, m.period, true));
    const otherLiveProjected = round6(
      this.teamTotal(other, m.period) + this.projectedTotal(other, m.period, true),
    );
    return {
      ...base,
      cumulativeScoreLive: { losses: 0, statBySlot: null, ties: 0, wins: 0 },
      pointsByScoringPeriod: { [String(m.period)]: live },
      totalPoints: 0,
      totalPointsLive: live,
      totalProjectedPoints: projected,
      totalProjectedPointsLive: liveProjected,
      winProbability: winProbability(liveProjected - otherLiveProjected, otherProjected > 0),
    };
  }

  mTeam(): Obj {
    return {
      ...this.top(CURRENT_WEEK),
      members: this.membersBody(),
      schedule: this.m.schedule.map((m) => ({
        away: {
          gamesPlayed: 0,
          teamId: m.away,
          totalPoints: this.sideTotals(m, "away").totalPoints ?? 0,
        },
        home: {
          gamesPlayed: 0,
          teamId: m.home,
          totalPoints: this.sideTotals(m, "home").totalPoints ?? 0,
        },
        matchupPeriodId: m.period,
      })),
      teams: this.teamObjects(),
    };
  }

  /** A box-score style roster side for week `w` (each entry carries that week's two splits). */
  private boxSide(teamId: number, w: number): Obj {
    const seats = this.m.rosters.get(w)?.get(teamId) ?? [];
    const entries = seats.map((s) => this.boxEntry(s, w));
    return { appliedStatTotal: this.teamTotal(teamId, w), entries };
  }

  /** mMatchupScore's slim roster (research 03 §B.4: `lineupSlotId` + `player.stats` only). */
  private slimSide(teamId: number, w: number): Obj {
    const seats = this.m.rosters.get(w)?.get(teamId) ?? [];
    return {
      appliedStatTotal: this.teamTotal(teamId, w),
      entries: seats.map((s) => {
        const p = this.m.players.get(s.playerId);
        return {
          lineupSlotId: s.lineupSlotId,
          playerPoolEntry: {
            player: {
              stats: (p === undefined ? [] : this.weeklyStats(p, [w])).map((st) => {
                const copy = { ...st };
                delete copy.id;
                delete copy.externalId;
                return copy;
              }),
            },
          },
        };
      }),
    };
  }

  private boxEntry(s: Seat, w: number): Obj {
    const p = this.m.players.get(s.playerId);
    if (p === undefined) throw new Error(`fx-10h: unknown player ${String(s.playerId)}`);
    const stats = this.weeklyStats(p, [w]);
    const full = this.playerObject(p, stats);
    const player: Obj = {};
    for (const k of [
      "defaultPositionId",
      "eligibleSlots",
      "firstName",
      "fullName",
      "id",
      "lastName",
      "proTeamId",
      "stats",
      "universeId",
    ])
      if (full[k] !== undefined) player[k] = full[k];
    return {
      lineupSlotId: s.lineupSlotId,
      playerId: s.playerId,
      playerPoolEntry: {
        appliedStatTotal: this.actualPoints(s.playerId, w),
        id: s.playerId,
        player,
      },
    };
  }

  mMatchup(): Obj {
    // mMatchup's sides carry only these keys (research 03 §B.4, as recorded)
    const slim = (o: Obj): Obj => {
      const out: Obj = { cumulativeScore: o.cumulativeScore ?? null, gamesPlayed: 0 };
      if (o.pointsByScoringPeriod !== undefined)
        out.pointsByScoringPeriod = o.pointsByScoringPeriod;
      out.teamId = o.teamId ?? 0;
      out.totalPoints = o.totalPoints ?? 0;
      return out;
    };
    return {
      ...this.top(CURRENT_WEEK),
      schedule: this.m.schedule.map((m) => {
        const home = slim(this.sideTotals(m, "home"));
        const away = slim(this.sideTotals(m, "away"));
        return {
          away,
          home,
          id: m.id,
          matchupPeriodId: m.period,
          winner: this.winnerOf(m),
        };
      }),
      teams: this.m.teams.map((t) => ({ id: t.id })),
    };
  }

  mMatchupScore(sp: number): Obj {
    return {
      ...this.top(sp),
      schedule: this.m.schedule.map((m) => {
        const base = {
          away: this.sideTotals(m, "away"),
          home: this.sideTotals(m, "home"),
          id: m.id,
          matchupPeriodId: m.period,
          playoffTierType: "NONE",
          winner: this.winnerOf(m),
        };
        if (m.period !== sp) return base;
        return {
          ...base,
          away: { ...base.away, rosterForCurrentScoringPeriod: this.slimSide(m.away, sp) },
          home: { ...base.home, rosterForCurrentScoringPeriod: this.slimSide(m.home, sp) },
        };
      }),
    };
  }

  mBoxscore(sp: number): Obj {
    const recs = this.records();
    return {
      ...this.top(sp),
      schedule: this.m.schedule
        .filter((m) => m.period === sp)
        .map((m) => {
          const side = (s: "home" | "away"): Obj => {
            const teamId = s === "home" ? m.home : m.away;
            const totals = this.sideTotals(m, s);
            return {
              cumulativeScore: { losses: 0, statBySlot: null, ties: 0, wins: 0 },
              ...(totals.pointsByScoringPeriod === undefined
                ? {}
                : { pointsByScoringPeriod: totals.pointsByScoringPeriod }),
              rosterForCurrentScoringPeriod: this.boxSide(teamId, sp),
              rosterForMatchupPeriod: { appliedStatTotal: totals.totalPoints ?? 0, entries: [] },
              teamId,
              tiebreak: 0,
              totalPoints: totals.totalPoints ?? 0,
            };
          };
          return { away: side("away"), home: side("home"), id: m.id, matchupPeriodId: m.period };
        }),
      settings: {
        isCustomizable: true,
        isPublic: this.m.isPublic,
        scheduleSettings: {
          divisions: [{ id: 0, name: this.m.divisionName }],
          matchupPeriods: obj(
            obj(this.settings().scheduleSettings, "scheduleSettings").matchupPeriods,
            "matchupPeriods",
          ),
        },
      },
      teams: this.m.teams.map((t) => ({
        abbrev: t.abbrev,
        divisionId: 0,
        id: t.id,
        logo: "",
        name: t.name,
        rankCalculatedFinal: 0,
        record: {
          overall: {
            losses: num(obj(recs.get(t.id)?.overall, "overall").losses, "losses"),
            ties: num(obj(recs.get(t.id)?.overall, "overall").ties, "ties"),
            wins: num(obj(recs.get(t.id)?.overall, "overall").wins, "wins"),
          },
        },
      })),
    };
  }

  /** The weeks a view for `sp` carries splits of (the recorded rhythm: the week before and the week). */
  private viewWeeks(sp: number): number[] {
    return sp <= 1 ? [sp] : [sp - 1, sp];
  }

  mRoster(sp: number): Obj {
    const weeks = this.viewWeeks(sp);
    return {
      ...this.top(sp),
      teams: this.m.teams.map((t) => {
        const seats = this.m.rosters.get(sp)?.get(t.id) ?? [];
        const entries = seats.map((s) => {
          const p = this.m.players.get(s.playerId);
          if (p === undefined) throw new Error(`fx-10h: unknown player ${String(s.playerId)}`);
          const stats = [...this.seasonStats(p), ...this.weeklyStats(p, weeks)];
          return {
            acquisitionDate: null,
            acquisitionType: null,
            injuryStatus: "NORMAL",
            lineupSlotId: s.lineupSlotId,
            pendingTransactionIds: null,
            playerId: s.playerId,
            playerPoolEntry: this.poolEntry(p, sp, stats),
            status: "NORMAL",
          };
        });
        return {
          id: t.id,
          roster: {
            appliedStatTotal: sp <= FINAL_WEEKS.length ? this.teamTotal(t.id, sp) : 0,
            entries,
            tradeReservedEntries: 0,
          },
        };
      }),
    };
  }

  /**
   * The player pool for kona_player_info (one file; the derived-league fetch filters, sorts and
   * pages it and keeps the season splits plus weeks sp−1 and sp of each player for a request of
   * scoring period sp). Every player with a recorded raw line is in it: the rostered ones ONTEAM,
   * the rest at the model's pool status.
   */
  pool(): Obj {
    const rostered = rosteredIn(this.m, CURRENT_WEEK);
    const players = [...this.m.players.values()]
      .filter((p) => rostered.has(p.id) || p.actual.size + p.projected.size > 0)
      .sort((a, b) => a.id - b.id);
    const kona = recorded("league-b/kona_player_info.json");
    return {
      $comment:
        "fx-10h player pool (derived: true): kona_player_info answers are filtered, sorted and paged from these entries by the derived-league fixture fetch (src/providers/espn/fixture-league.ts); each entry carries every week's splits and a request for scoring period N receives the season splits plus weeks N-1 and N.",
      season: SEASON,
      response: { positionAgainstOpponent: kona.positionAgainstOpponent ?? null },
      entries: players.map((p) =>
        konaShape(
          this.poolEntry(p, CURRENT_WEEK, [
            ...this.seasonStats(p),
            ...this.weeklyStats(p, [...ALL_WEEKS]),
          ]),
        ),
      ),
    };
  }

  mTransactions2(): Obj {
    return { ...this.top(CURRENT_WEEK), transactions: clone(this.m.transactions) };
  }

  mPendingTransactions(): Obj {
    return { ...this.top(CURRENT_WEEK), pendingTransactions: clone(this.m.pending) };
  }

  /** Last season's final standings (the seeding evidence's input), or null (no previous season). */
  lastSeasonStandings(): Obj | null {
    const rows = this.m.lastSeason;
    if (rows === null) return null;
    return {
      draftDetail: { drafted: true, inProgress: false },
      gameId: 1,
      id: 0,
      scoringPeriodId: LAST_WEEK,
      seasonId: SEASON - 1,
      segmentId: 0,
      status: {
        currentMatchupPeriod: LAST_WEEK,
        finalScoringPeriod: LAST_WEEK,
        firstScoringPeriod: 1,
        isActive: false,
        isPlayoffMatchupEdited: this.m.playoffMatchupEdited,
        latestScoringPeriod: LAST_WEEK,
        previousSeasons: [],
      },
      members: this.membersBody(),
      teams: rows.map((r) => {
        const t = this.m.teams.find((x) => x.id === r.teamId);
        return {
          abbrev: t?.abbrev ?? "",
          divisionId: 0,
          id: r.teamId,
          logo: "",
          name: t?.name ?? "",
          owners: [...(t?.owners ?? [])],
          playoffSeed: r.seed,
          points: r.pointsFor,
          rankCalculatedFinal: r.seed,
          rankFinal: r.seed,
          transactionCounter: {
            acquisitionBudgetSpent: 0,
            acquisitions: 0,
            drops: 0,
            matchupAcquisitionTotals: {},
            misc: 0,
            moveToActive: 0,
            moveToIR: 0,
            paid: 0,
            teamCharges: 0,
            trades: 0,
          },
          record: {
            overall: {
              gamesBack: 0,
              losses: r.losses,
              percentage: r.wins / (r.wins + r.losses),
              pointsAgainst: r.pointsAgainst,
              pointsFor: r.pointsFor,
              streakLength: 1,
              streakType: r.seed <= PLAYOFF_TEAMS ? "WIN" : "LOSS",
              ties: 0,
              wins: r.wins,
            },
          },
          waiverRank: 0,
        };
      }),
    };
  }

  /** The kickoff of a player's week-`w` game (epoch ms) or null. */
  kickoff(pid: number, w: number): number | null {
    const p = this.m.players.get(pid);
    return p === undefined ? null : kickoffOf(this.m, w, this.proTeam(p));
  }
}

export type { Json, Obj };
