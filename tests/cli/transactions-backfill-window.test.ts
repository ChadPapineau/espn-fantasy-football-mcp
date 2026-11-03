// transactions-backfill-window.test.ts — `eff transactions --backfill` against the limiter's 30/min
// window (src/cli/espn-pacing.ts; plan 01 §6 and D7; the install defect of 2026-11-02: the default
// run's ~37 reads died RATE_LIMITED part-way and were finished one `--seasons` at a time by hand).
// On fake time — a fixed clock moved only by the injected sleep (io.sleep: the provider's limiter
// waits and the run's own) and by each request's latency — through the real store's limiter table:
//  - the default run's 37 reads complete while another process fills the window part-way: the
//    refusal is waited out with one stderr line, the same read is retried, every send obeys the
//    windows (≤ 30 in any minute, ≤ 1 a second, counted with the other process's rows) and the
//    run's own reads are paced RUN_PACE_MS apart;
//  - a refusal storm stops at its bound (five refusals in a row) and fails as before (exit 1, `eff
//    transactions-backfill: RATE_LIMITED`), saying what it stored; a re-run resumes and stores
//    nothing twice;
//  - a spent daily cap fails at once and a second concurrency refusal in a row fails as before;
//  - Ctrl-C during a wait (the command's claim on SIGINT) ends the run at once, no request after it;
//  - the progress line carries counts and seconds only;
//  - the verifiers' findings on 4141144: a re-run two days later — every week cached past its 1-day
//    hard limit, so the provider's stale fallback turns a refusal into STALE_ONLY — still waits out a
//    full window (a burst landing just after the run looked) and another process's Retry-After hold,
//    and stores nothing twice (F1); a window another process filled 40.3 s before the first read is
//    waited for before the read, so the send keeps its whole deadline and a slow answer (1 s, real
//    time) is not cut short (F2: it timed out in the last 299 ms and the run died);
//  - the verifier's findings on fbbd705: Ctrl-C while the limiter itself waits inside a read — for
//    an in-flight slot another process holds, or for a window a burst filled just after the run
//    looked — sends nothing after the signal: the read is refused before its slot, no row is
//    written, and the run ends with its interrupt line, exit 1, no failure recorded (F1); with every
//    request's first attempt answered 503, the run's own requests, retries included, stay within
//    RUN_SHARE_PER_MINUTE in any minute — the waits are the share's, before a read — and the run
//    completes, each week stored once (F2).
// No request leaves the process; the transactions are crafted in the fake GUID range.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFileBody } from "../../src/auth/file.js";
import { metaFor } from "../../src/auth/upgrade.js";
import {
  MAX_CONSECUTIVE_REFUSALS,
  RUN_PACE_MS,
  RUN_SHARE_PER_MINUTE,
  WINDOW_WAIT_MARGIN_MS,
  waitBudgetMs,
} from "../../src/cli/espn-pacing.js";
import { createInterrupts, type SignalHost } from "../../src/cli/interrupt.js";
import { readJobState } from "../../src/cli/job-state.js";
import { main } from "../../src/cli/main.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { transactionsBackfill } from "../../src/cli/snapshot.js";
import { openStore } from "../../src/cli/store-access.js";
import { fixedClock } from "../../src/domain/clock.js";
import { transactionsBySeason } from "../../src/domain/analytics/waiver-fit/history.js";
import { cachedRetryAfter } from "../../src/providers/espn/cache.js";
import { composeBodies } from "../../src/providers/espn/index.js";
import { IN_FLIGHT_POLL_MS, type Sleep } from "../../src/providers/espn/limiter.js";
import { storeFactory } from "../../src/store/index.js";
import type {
  LimiterRepository,
  LimiterVerdict,
  Store,
  StoreFactory,
} from "../../src/store/types.js";
import { fakeCookies } from "../auth/helpers.js";
import { ROOT, fakeFetch, fakePackage, makeIo, sandbox, type Sandbox } from "./helpers.js";
import { ESPN_LIMITER, ESPN_READ_HOST_DEFAULT } from "../../src/config/schema.js";

let sb: Sandbox;
const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  sb.cleanup();
});

const REC = path.join(ROOT, "fixtures", "espn", "recorded");
const rec = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(REC, rel), "utf8")) as Record<string, unknown>;
const jsonRes = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const COOKIES = fakeCookies("cli-backfill-window");
const ENV = { ESPN_LEAGUE_ID: "0", EFF_CREDENTIAL_STORE: "file", ESPN_SEASON: "2026" };
const START = "2026-10-06T18:00:00.000Z";
/** A request's fake latency. */
const LATENCY_MS = 200;
/** The default run: the league read, then per season one settings read and 17 weeks. */
const DEFAULT_READS = 1 + 2 * (1 + 17);

const txId = (season: number, week: number): string =>
  `00000000-0000-4000-8000-${String(season % 100).padStart(4, "0")}${String(week).padStart(8, "0")}`;

/** Read through a call: a hook run between two checks may abort the signal. */
const isAborted = (signal: AbortSignal | null): boolean => signal?.aborted === true;

/** Fake time: the clock moves only by the sleeps and the requests' latency. */
function fakeTime(start: string) {
  const clock = fixedClock(start);
  const sleeps: number[] = [];
  let hook: ((ms: number) => void) | null = null;
  const sleep: Sleep = (ms, signal) => {
    if (isAborted(signal)) return Promise.reject(new DOMException("aborted", "AbortError"));
    sleeps.push(ms);
    hook?.(ms);
    if (isAborted(signal)) return Promise.reject(new DOMException("aborted", "AbortError"));
    clock.advance(Math.max(0, ms));
    return Promise.resolve();
  };
  return {
    clock,
    sleeps,
    sleep,
    onSleep: (h: (ms: number) => void) => {
      hook = h;
    },
  };
}

interface Send {
  readonly at: number;
  readonly season: number;
  readonly week: number | null;
  readonly view: string;
}

/** league-a as each season, one waiver claim per scoring period; each send recorded at its instant. */
function history(
  time: ReturnType<typeof fakeTime>,
  onSend: (s: Send, n: number) => void = () => undefined,
) {
  const sends: Send[] = [];
  const f = fakeFetch((url) => {
    const u = new URL(url);
    const season = Number(/\/seasons\/(\d{4})\//.exec(u.pathname)?.[1] ?? "0");
    const views = u.searchParams.getAll("view");
    const weekParam = u.searchParams.get("scoringPeriodId");
    const send: Send = {
      at: time.clock.nowMs(),
      season,
      week: weekParam === null ? null : Number(weekParam),
      view: views.join("+"),
    };
    sends.push(send);
    onSend(send, sends.length);
    time.clock.advance(LATENCY_MS);
    if (!u.pathname.includes("/leagues/0")) return new Response(null, { status: 404 });
    const settings = { ...rec("league-a/mSettings.json"), seasonId: season };
    if (views.includes("mTransactions2")) {
      const week = Number(weekParam ?? "1");
      const at = Date.UTC(season, 8, 8) + (week - 1) * 7 * 86_400_000;
      return jsonRes({
        ...settings,
        scoringPeriodId: week,
        transactions: [
          {
            id: txId(season, week),
            type: "WAIVER",
            status: "EXECUTED",
            teamId: 1,
            scoringPeriodId: week,
            proposedDate: at - 3_600_000,
            processDate: at,
            bidAmount: 0,
            isPending: false,
            items: [
              {
                type: "ADD",
                playerId: 1000 + week,
                fromTeamId: 0,
                toTeamId: 1,
                fromLineupSlotId: -1,
                toLineupSlotId: 20,
                isKeeper: false,
              },
            ],
          },
        ],
      });
    }
    let body: unknown = settings;
    if (views.includes("mNav")) body = composeBodies(body, rec("league-a/mNav.json"));
    if (views.includes("mTeam")) body = composeBodies(body, rec("league-a/mTeam.json"));
    return jsonRes(body);
  });
  return { ...f, sends };
}

function plantCookies(): void {
  mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(sb.configDir, "session.json"),
    sessionFileBody(COOKIES, metaFor(COOKIES, "2026-10-01T00:00:00.000Z")),
    { mode: 0o600 },
  );
}

function ioFor(
  time: ReturnType<typeof fakeTime>,
  f: { fetch: ReturnType<typeof fakeFetch>["fetch"] },
) {
  return makeIo(sb, {
    fetch: f.fetch,
    clock: time.clock,
    sleep: time.sleep,
    packageRoot: fakePackage(sb),
    env: ENV,
  });
}

/** A second store handle: another process's view of the shared limiter table. */
async function otherProcess(io: ReturnType<typeof ioFor>): Promise<Store> {
  const { config, log } = await loadRuntime(io);
  const s = openStore(config, io.clock, log, { migrate: true });
  opened.push(s);
  return s;
}

/** `n` finished requests of another process at `atMs` (the MCP server's burst): the window fills. */
function burst(store: Store, atMs: number, n = 30): number[] {
  const at: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = store.repos.limiter.tryRecord({
      at: new Date(atMs).toISOString(),
      keyless: false,
      origin: "server",
      windows: [],
      dailyCap: null,
    });
    if (v.ok) {
      store.repos.limiter.recordOutcome(v.id, "ok");
      at.push(atMs);
    }
  }
  return at;
}

/**
 * Every one of `ours` was admitted as the store's limiter admits: fewer than 30 rows (ours and the
 * other process's) in the minute before it and none in the second before it, each window counted
 * from its start millisecond inclusive.
 */
function assertWindows(ours: readonly number[], others: readonly number[]): void {
  const all = [...ours, ...others];
  for (const t of ours) {
    expect(all.filter((s) => s >= t - 60_000 && s < t).length).toBeLessThanOrEqual(29);
    expect(all.filter((s) => s >= t - 1_000 && s < t).length).toBe(0);
  }
}

const stderrLines = (text: string): string[] =>
  text.split("\n").filter((l) => l !== "" && !l.startsWith("{"));

const WAIT_LINE =
  /^transactions-backfill: [A-Za-z ,()-]+(?:30 a minute, shared with the server and the jobs\) is (?:full|near full \(the run keeps six free\)))? — waiting (\d+) s, then (?:retrying the same read|reading) \(\d+ read\(s\) done; wait \d+, at most (\d+) s of waiting in all\)$/;

function storedIds(store: Store): string[] {
  return store.repos.transactionsSeen.list(null, 1000).map((t) => t.transaction_id);
}

describe("eff transactions --backfill under a full window (the 2026-11-02 install defect)", () => {
  it("the default run's 37 reads complete while another process fills the window part-way", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    let other: Store | null = null;
    let planted: number[] = [];
    const io0 = ioFor(time, { fetch: fakeFetch().fetch });
    const f = history(time, (s, n) => {
      // the 12th request: the MCP server's burst fills the shared window
      if (n === 12 && other !== null) planted = burst(other, s.at);
    });
    other = await otherProcess(io0);
    const io = ioFor(time, f);
    const code = await main(["transactions", "--backfill"], io);
    expect(io.err.text).not.toMatch(/^eff /m);
    expect(code).toBe(0);
    expect(io.out.text).toContain("season 2025: 17 week(s) read, 17 transaction(s), 17 new");
    expect(io.out.text).toContain("season 2024: 17 week(s) read, 17 transaction(s), 17 new");
    expect(f.sends).toHaveLength(DEFAULT_READS);
    // the refusal was waited out with one line per wait, each within a window plus the margin
    const waits = stderrLines(io.err.text);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.length).toBeLessThanOrEqual(MAX_CONSECUTIVE_REFUSALS);
    let total = 0;
    for (const l of waits) {
      const m = WAIT_LINE.exec(l);
      expect(m, l).not.toBeNull();
      const s = Number(m?.[1]);
      expect(s).toBeLessThanOrEqual(61);
      expect(Number(m?.[2])).toBe(waitBudgetMs(1 + 2 * 19) / 1000);
      // each is a stated wait plus the margin: a sleep of k s + 500 ms
      expect(
        time.sleeps.some((ms) => ms % 1000 === WINDOW_WAIT_MARGIN_MS && Math.ceil(ms / 1000) === s),
      ).toBe(true);
      total += s;
    }
    expect(total * 1000).toBeLessThanOrEqual(waitBudgetMs(DEFAULT_READS) + waits.length * 1000);
    // no request went faster than the limiter permits, the other process's rows counted
    const ours = f.sends.map((s) => s.at);
    expect(planted).toHaveLength(30);
    assertWindows(ours, planted);
    // the first send after the burst waited for the burst to leave the window
    const after = ours.filter((t) => t > (planted[0] ?? 0));
    expect((after[0] ?? 0) - (planted[0] ?? 0)).toBeGreaterThan(60_000);
    // the run's own reads are paced, RUN_PACE_MS start to start: away from the refusal every
    // send is that far from the last, and in any minute the run sends 24 at the most (25 with the
    // retried read, whose send the limiter held inside its call)
    const paced = ours.slice(1).filter((t, i) => t - (ours[i] ?? 0) >= RUN_PACE_MS);
    expect(paced.length).toBeGreaterThanOrEqual(ours.length - 1 - 2 * waits.length);
    for (let i = 1; i < ours.length; i++)
      expect((ours[i] ?? 0) - (ours[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    for (const t of ours)
      expect(ours.filter((s) => s > t - 60_000 && s <= t).length).toBeLessThanOrEqual(
        RUN_SHARE_PER_MINUTE + 1,
      );
    // every week stored once
    const store = await otherProcess(io);
    const bySeason = transactionsBySeason(store.repos.transactionsSeen.list(null, 1000));
    expect(bySeason.get(2025)).toHaveLength(17);
    expect(bySeason.get(2024)).toHaveLength(17);
  }, 60_000);

  it("the progress line carries counts and seconds only — no cookie, member, team or league value", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    let other: Store | null = null;
    const f = history(time, (s, n) => {
      if (n === 5 && other !== null) burst(other, s.at);
    });
    other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    const io = ioFor(time, f);
    expect(await main(["transactions", "--backfill"], io)).toBe(0);
    const lines = stderrLines(io.err.text);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const settings = rec("league-a/mSettings.json") as { settings?: { name?: string } };
    const leagueName = settings.settings?.name ?? "";
    for (const l of lines) {
      expect(l).toMatch(WAIT_LINE);
      for (const secret of [COOKIES.espn_s2, COOKIES.swid, COOKIES.swid.slice(1, -1)])
        expect(l).not.toContain(secret);
      if (leagueName !== "") expect(l).not.toContain(leagueName);
      expect(l).not.toMatch(/Team|\{|\}|20\d\d|leagues|seasons|http/);
    }
  }, 60_000);

  it("a refusal storm stops at its bound and fails as before; a re-run resumes, storing nothing twice", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    let other: Store | null = null;
    let storming = false;
    const f = history(time, (s) => {
      // the window fills at 2024 week 6 and stays full: another process keeps refilling it
      if (s.season === 2024 && s.week === 6 && other !== null) {
        burst(other, s.at);
        storming = true;
      }
    });
    time.onSleep((ms) => {
      if (storming && other !== null && ms > RUN_PACE_MS) burst(other, time.clock.nowMs() + ms);
    });
    other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    const io = ioFor(time, f);
    const code = await main(["transactions", "--backfill"], io);
    // the exit and the failure line are what a RATE_LIMITED failure always gave
    expect(code).toBe(1);
    expect(io.err.text).toMatch(/^eff transactions-backfill: RATE_LIMITED$/m);
    expect(io.out.text).toMatch(
      /transactions-backfill: stopped — ESPN's request limit kept refusing \(\d+ wait\(s\), \d+ s of waiting\); \d+ read\(s\) done, 23 new transaction\(s\) stored so far; run `eff transactions --backfill` again later to resume \(it is safe to repeat\)/,
    );
    expect(io.out.text).not.toContain("fits its premium");
    const waits = stderrLines(io.err.text).filter((l) => WAIT_LINE.test(l));
    // the window never empties: the run waits for it — seen full before the read, then refused —
    // until a bound (five waits in a row for the read, or the budget: here the budget, each wait a
    // whole window), then stops
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.length).toBeLessThanOrEqual(MAX_CONSECUTIVE_REFUSALS);
    const waited = waits.reduce((a, l) => a + Number(WAIT_LINE.exec(l)?.[1]), 0);
    expect(waited * 1000).toBeLessThanOrEqual(waitBudgetMs(1 + 2 * 19) + waits.length * 1000);
    const stated = /\((\d+) wait\(s\), (\d+) s of waiting\)/.exec(io.out.text);
    expect(Number(stated?.[1])).toBe(waits.length);
    expect(Number(stated?.[2]) * 1000).toBeLessThanOrEqual(waitBudgetMs(1 + 2 * 19));
    // nothing after 2024 week 6 was read
    expect(f.sends.some((s) => s.season === 2024 && (s.week ?? 0) > 6)).toBe(false);
    expect(readJobState(sb.cacheDir)["run.transactions-backfill.error"]).toBe("RATE_LIMITED");
    const first = await otherProcess(io);
    expect(storedIds(first)).toHaveLength(23);

    // the re-run, the window free again: it resumes, every week re-read stores nothing twice
    const later = fakeTime("2026-10-06T19:00:00.000Z");
    const g = history(later);
    const io2 = ioFor(later, g);
    expect(await main(["transactions", "--backfill"], io2)).toBe(0);
    expect(io2.out.text).toContain("season 2025: 17 week(s) read, 17 transaction(s), 0 new");
    expect(io2.out.text).toContain("season 2024: 17 week(s) read, 17 transaction(s), 11 new");
    expect(io2.out.text).toContain("11 new transaction(s) stored");
    const ids = storedIds(await otherProcess(io2));
    expect(ids).toHaveLength(34);
    expect(new Set(ids).size).toBe(34);
    // a third run stores nothing at all
    const io3 = ioFor(fakeTime("2026-10-06T20:00:00.000Z"), history(fakeTime(START)));
    expect(await main(["transactions", "--backfill"], io3)).toBe(0);
    expect(io3.out.text).toContain("0 new transaction(s) stored");
  }, 60_000);

  it("Ctrl-C during a wait ends the run at once: no request after it, the lock released, no failure recorded", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    let other: Store | null = null;
    const f = history(time, (s, n) => {
      if (n === 8 && other !== null) burst(other, s.at);
    });
    const listeners = new Map<string, () => void>();
    let raised = 0;
    const host: SignalHost = {
      on: (sig, l) => {
        listeners.set(sig, l);
      },
      off: (sig) => {
        listeners.delete(sig);
      },
      raise: () => {
        raised++;
      },
      exit: () => {
        raised++;
      },
    };
    let sendsAtSignal = -1;
    let sleepsAtSignal = -1;
    time.onSleep((ms) => {
      if (ms > RUN_PACE_MS && sendsAtSignal < 0) {
        sendsAtSignal = f.sends.length;
        sleepsAtSignal = time.sleeps.length;
        listeners.get("SIGINT")?.();
      }
    });
    other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    const io = ioFor(time, f);
    const started = performance.now();
    const code = await main(["transactions", "--backfill"], io, {
      interrupts: createInterrupts(host),
    });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(code).toBe(1);
    expect(sendsAtSignal).toBe(8);
    expect(f.sends).toHaveLength(sendsAtSignal);
    expect(time.sleeps).toHaveLength(sleepsAtSignal);
    expect(raised).toBe(0);
    expect(io.err.text).toMatch(
      /^eff transactions-backfill: interrupted — \d+ read\(s\) done, \d+ new transaction\(s\) stored so far; run `eff transactions --backfill` again to resume \(it is safe to repeat\)$/m,
    );
    expect(io.err.text).not.toMatch(/: RATE_LIMITED$/m);
    expect(readJobState(sb.cacheDir)["run.transactions-backfill.ok"]).toBeUndefined();
    // the lock was released: the next run is not refused
    const later = fakeTime("2026-10-06T19:00:00.000Z");
    const io2 = ioFor(later, history(later));
    expect(await main(["transactions", "--backfill"], io2)).toBe(0);
    expect(io2.out.text).not.toContain("another run holds the job lock");
    expect(storedIds(await otherProcess(io2))).toHaveLength(34);
  }, 60_000);
});

/**
 * A store factory whose limiter repository runs the armed hook once, right after the next look at its
 * newest rows has returned them (the run's look before a read is the first one after its pacing
 * sleep): another process's burst landing just after the run looked.
 */
function afterNextLook(): { factory: StoreFactory; arm: (hook: () => void) => void } {
  let armed: (() => void) | null = null;
  return {
    arm: (hook) => {
      armed = hook;
    },
    factory: {
      open: (o) => {
        const s = storeFactory.open(o);
        const real = s.repos.limiter;
        const limiter: LimiterRepository = {
          ...real,
          recentOutcomes: (limit) => {
            const rows = real.recentOutcomes(limit);
            const hook = armed;
            armed = null;
            hook?.();
            return rows;
          },
        };
        return { ...s, repos: { ...s.repos, limiter } };
      },
      openPublisher: (o) => storeFactory.openPublisher(o),
    },
  };
}

describe("a re-run two days later: the cached weeks are past their 1-day hard limit (F1)", () => {
  /** The first run, complete on 2026-10-06: every week cached and stored. */
  async function firstRun(): Promise<void> {
    sb = sandbox();
    plantCookies();
    const t1 = fakeTime(START);
    const io1 = ioFor(t1, history(t1));
    expect(await main(["transactions", "--backfill"], io1)).toBe(0);
    expect(storedIds(await otherProcess(io1))).toHaveLength(34);
  }
  const LATER = "2026-10-08T18:00:00.000Z";

  it("a burst landing just after the run looked: the refusal behind STALE_ONLY is waited out", async () => {
    await firstRun();
    const time = fakeTime(LATER);
    const other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    const f = history(time);
    const look = afterNextLook();
    let planted: number[] = [];
    let armedAt = -1;
    time.onSleep(() => {
      // the pacing sleep before the 7th read (a 2025 week, upstream: its entry is 2 days old)
      if (armedAt < 0 && f.sends.length === 6) {
        armedAt = f.sends.length;
        look.arm(() => {
          planted = burst(other, time.clock.nowMs());
        });
      }
    });
    const io = ioFor(time, f);
    const { config, log } = await loadRuntime(io);
    const code = await transactionsBackfill(io, config, log, {
      notify: false,
      seasons: undefined,
      factory: look.factory,
    });
    expect(io.err.text).not.toMatch(/STALE_ONLY/);
    expect(code).toBe(0);
    expect(planted).toHaveLength(30);
    // the refusal was the limiter's (the look had seen the window free), waited out, the same read
    // retried: the refusal's wait (until the window's oldest row leaves it — one of the run's own),
    // then the look before the retry for the rest; one window in all
    const lines = stderrLines(io.err.text);
    expect(lines.length, lines.join("\n")).toBeGreaterThanOrEqual(1);
    expect(lines.length, lines.join("\n")).toBeLessThanOrEqual(2);
    for (const l of lines) {
      expect(l).toMatch(WAIT_LINE);
      expect(l).toMatch(/is full — waiting \d+ s, then retrying the same read \(6 read\(s\) done;/);
    }
    const waited = lines.reduce((a, l) => a + Number(WAIT_LINE.exec(l)?.[1]), 0);
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(waited).toBeLessThanOrEqual(61 + lines.length);
    expect(f.sends).toHaveLength(DEFAULT_READS);
    assertWindows(
      f.sends.map((s) => s.at),
      planted,
    );
    // every week re-read, nothing stored twice
    expect(io.out.text).toContain("season 2025: 17 week(s) read, 17 transaction(s), 0 new");
    expect(io.out.text).toContain("season 2024: 17 week(s) read, 17 transaction(s), 0 new");
    expect(io.out.text).toContain("0 new transaction(s) stored");
    const ids = storedIds(await otherProcess(io));
    expect(ids).toHaveLength(34);
    expect(new Set(ids).size).toBe(34);
  }, 60_000);

  it("another process's Retry-After hold: the refusal behind STALE_ONLY is waited out", async () => {
    await firstRun();
    const time = fakeTime(LATER);
    const other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    let heldUntil = -1;
    const f = history(time, (s, n) => {
      // the 6th request: ESPN answered another process's read with Retry-After: 30, kept for all
      if (n === 6) {
        heldUntil = s.at + 30_000;
        cachedRetryAfter(other.repos.espnCache, ESPN_READ_HOST_DEFAULT, time.clock).save(heldUntil);
      }
    });
    const io = ioFor(time, f);
    expect(await main(["transactions", "--backfill"], io)).toBe(0);
    expect(io.err.text).not.toMatch(/STALE_ONLY/);
    const lines = stderrLines(io.err.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^transactions-backfill: ESPN asked for a pause \(Retry-After\) — waiting \d+ s, then retrying the same read \(6 read\(s\) done;/,
    );
    // nothing went out before the hold ended
    expect(f.sends.filter((s) => s.at > (f.sends[5]?.at ?? 0) && s.at < heldUntil)).toEqual([]);
    expect(f.sends).toHaveLength(DEFAULT_READS);
    expect(io.out.text).toContain("0 new transaction(s) stored");
    expect(storedIds(await otherProcess(io))).toHaveLength(34);
  }, 60_000);
});

describe("a window another process filled is waited for before the read (F2)", () => {
  it("30 rows 40.3 s before the first read: waited for here; a 1 s answer is not cut short", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    const t0 = time.clock.nowMs();
    const other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    // the MCP server's 30 reads, 40.3 s before the run's first read: the window frees in 19.7 s —
    // the limiter, waiting for it inside the read, sent with 299 ms of the deadline left
    const planted = burst(other, t0 - 40_300);
    const base = history(time);
    let n = 0;
    const slowFirst: typeof base.fetch = async (url, init) => {
      if (n++ === 0)
        // ESPN answering in 1 s of real time, honouring the attempt's abort
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      return base.fetch(url, init);
    };
    const io = ioFor(time, { fetch: slowFirst });
    const code = await main(["transactions", "--backfill"], io);
    expect(io.err.text).not.toMatch(/^eff /m);
    expect(code).toBe(0);
    const lines = stderrLines(io.err.text);
    expect(lines).toEqual([
      "transactions-backfill: the ESPN request window (30 a minute, shared with the server and the jobs) is full — waiting 21 s, then reading (0 read(s) done; wait 1, at most 180 s of waiting in all)",
    ]);
    // the first send went out once the burst had left the window, and no send passed a window
    const ours = base.sends.map((s) => s.at);
    expect(ours).toHaveLength(DEFAULT_READS);
    expect((ours[0] ?? 0) - (planted[0] ?? 0)).toBeGreaterThan(60_000);
    assertWindows(ours, planted);
    // the slow answer was not timed out: no request failed, so none counted against the breaker
    const store = await otherProcess(io);
    expect(
      store.repos.limiter
        .recentOutcomes(100)
        .filter((r) => r.outcome !== "ok")
        .map((r) => r.outcome),
    ).toEqual([]);
    expect(storedIds(store)).toHaveLength(34);
  }, 60_000);
});

/** A store factory whose limiter answers `verdict` after its first `admit` sends. */
function refusingFactory(admit: number, verdict: LimiterVerdict): StoreFactory {
  return {
    open: (o) => {
      const s = storeFactory.open(o);
      const real = s.repos.limiter;
      let n = 0;
      const limiter: LimiterRepository = {
        ...real,
        tryRecord: (req) => (n++ < admit ? real.tryRecord(req) : verdict),
      };
      return { ...s, repos: { ...s.repos, limiter } };
    },
    openPublisher: (o) => storeFactory.openPublisher(o),
  };
}

describe("the refusals that still fail as before", () => {
  async function backfillWith(verdict: LimiterVerdict) {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    const f = history(time);
    const io = ioFor(time, f);
    const { config, log } = await loadRuntime(io);
    const code = await transactionsBackfill(io, config, log, {
      notify: false,
      seasons: undefined,
      factory: refusingFactory(6, verdict),
    });
    return { code, io, f, time };
  }

  it("a spent daily cap fails at once: no wait, no retry, the same exit and line", async () => {
    const { code, io, f, time } = await backfillWith({
      ok: false,
      reason: "daily_cap",
      retry_after_ms: 6 * 3_600_000,
    });
    expect(code).toBe(1);
    expect(stderrLines(io.err.text)).toEqual(["eff transactions-backfill: RATE_LIMITED"]);
    expect(io.out.text).toBe("");
    expect(f.sends).toHaveLength(6);
    // only the run's pacing waited (≤ RUN_PACE_MS each); nothing near the cap's hours
    expect(time.sleeps.every((ms) => ms <= RUN_PACE_MS)).toBe(true);
  }, 60_000);

  it("concurrency: retried once, then the second refusal in a row fails as before", async () => {
    const { code, io, f } = await backfillWith({
      ok: false,
      reason: "concurrency",
      retry_after_ms: 250,
    });
    expect(code).toBe(1);
    const lines = stderrLines(io.err.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /two ESPN requests are still in flight in another process — waiting 2 s/,
    );
    expect(lines[1]).toBe("eff transactions-backfill: RATE_LIMITED");
    expect(io.out.text).toBe("");
    expect(f.sends).toHaveLength(6);
  }, 60_000);
});

/** A signal host whose SIGINT the test fires (no process is touched). */
function signalHost() {
  const listeners = new Map<string, () => void>();
  let raised = 0;
  const host: SignalHost = {
    on: (sig, l) => {
      listeners.set(sig, l);
    },
    off: (sig) => {
      listeners.delete(sig);
    },
    raise: () => {
      raised++;
    },
    exit: () => {
      raised++;
    },
  };
  return { host, fire: () => listeners.get("SIGINT")?.(), raised: () => raised };
}

const INTERRUPTED_8 =
  "eff transactions-backfill: interrupted — 8 read(s) done, 6 new transaction(s) stored so far; run `eff transactions --backfill` again to resume (it is safe to repeat)";

describe("Ctrl-C while the limiter waits inside a read: no request after it (verifier F1 on fbbd705)", () => {
  it("in the limiter's poll for an in-flight slot: refused before its slot, no row written, the run's interrupt", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    const other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    const f = history(time);
    const sig = signalHost();
    // another process's two requests in flight, recorded during the pacing sleep before the 9th
    // read: the run's look sees no full window (pending rows are no window), the limiter polls for
    // an in-flight slot inside the read; Ctrl-C at the 2nd poll, the two finish at the 4th
    const pending: number[] = [];
    let polls = 0;
    let sendsAtSignal = -1;
    time.onSleep((ms) => {
      if (pending.length === 0 && f.sends.length === 8) {
        for (let i = 0; i < ESPN_LIMITER.concurrency; i++) {
          const v = other.repos.limiter.tryRecord({
            at: new Date(time.clock.nowMs()).toISOString(),
            keyless: false,
            origin: "server",
            windows: [],
            dailyCap: null,
          });
          if (v.ok) pending.push(v.id);
        }
        return;
      }
      if (pending.length === 0 || ms !== IN_FLIGHT_POLL_MS) return;
      polls++;
      if (polls === 2) {
        sendsAtSignal = f.sends.length;
        sig.fire();
      }
      if (polls === 4) for (const id of pending) other.repos.limiter.recordOutcome(id, "ok");
    });
    const io = ioFor(time, f);
    const code = await main(["transactions", "--backfill"], io, {
      interrupts: createInterrupts(sig.host),
    });
    expect(pending).toHaveLength(ESPN_LIMITER.concurrency);
    expect(sendsAtSignal).toBe(8);
    expect(f.sends).toHaveLength(sendsAtSignal);
    expect(code).toBe(1);
    expect(sig.raised()).toBe(0);
    // the run's interrupt line, never a failure (no RATE_LIMITED, no job failure recorded)
    expect(stderrLines(io.err.text)).toEqual([INTERRUPTED_8]);
    expect(readJobState(sb.cacheDir)["run.transactions-backfill.error"]).toBeUndefined();
    // no row after the signal: the run's 8 sends and the other process's 2 — which, once finished,
    // leave none pending (the run left none of its own)
    expect(polls).toBeLessThan(4);
    for (const id of pending) other.repos.limiter.recordOutcome(id, "ok");
    const rows = other.repos.limiter.recentOutcomes(500);
    expect(rows).toHaveLength(f.sends.length + pending.length);
    expect(rows.filter((r) => r.outcome === "pending")).toEqual([]);
  }, 60_000);

  it("in the limiter's wait for the window (a burst just after the run looked): refused, no row, the run's interrupt", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    const other = await otherProcess(ioFor(time, { fetch: fakeFetch().fetch }));
    const f = history(time);
    const look = afterNextLook();
    const ac = new AbortController();
    let armed = false;
    let planted: number[] = [];
    let sendsAtSignal = -1;
    let limiterWait = -1;
    time.onSleep((ms) => {
      // the pacing sleep before the 9th read: 30 rows of another process land just after the run's
      // look, 44.7 s old — they leave the window in 15.3 s, inside the read's 20 s deadline, so the
      // limiter itself waits for them inside the read
      if (!armed && f.sends.length === 8) {
        armed = true;
        look.arm(() => {
          planted = burst(other, time.clock.nowMs() - 44_700);
        });
        return;
      }
      if (planted.length > 0 && sendsAtSignal < 0 && ms > RUN_PACE_MS) {
        sendsAtSignal = f.sends.length;
        limiterWait = ms;
        ac.abort();
      }
    });
    const io = ioFor(time, f);
    const { config, log } = await loadRuntime(io);
    const code = await transactionsBackfill(io, config, log, {
      notify: false,
      seasons: undefined,
      factory: look.factory,
      signal: ac.signal,
    });
    expect(planted).toHaveLength(30);
    expect(sendsAtSignal).toBe(8);
    // the limiter's own wait (the run's are whole seconds plus the margin)
    expect(limiterWait % 1000).not.toBe(WINDOW_WAIT_MARGIN_MS);
    expect(limiterWait).toBeLessThan(20_000);
    expect(f.sends).toHaveLength(sendsAtSignal);
    expect(code).toBe(1);
    expect(stderrLines(io.err.text)).toEqual([INTERRUPTED_8]);
    expect(readJobState(sb.cacheDir)["run.transactions-backfill.error"]).toBeUndefined();
    const rows = other.repos.limiter.recentOutcomes(500);
    expect(rows).toHaveLength(f.sends.length + planted.length);
    expect(rows.filter((r) => r.outcome === "pending")).toEqual([]);
  }, 60_000);
});

describe("a read's retries count against the run's share (verifier F2 on fbbd705)", () => {
  it("every request's first attempt answered 503: the run's own sends stay within its share in any minute; exit 0, each week stored once", async () => {
    sb = sandbox();
    plantCookies();
    const time = fakeTime(START);
    const ok = history(time);
    const seen = new Set<string>();
    const sendsAt: number[] = [];
    const fetch: typeof ok.fetch = async (url, init) => {
      sendsAt.push(time.clock.nowMs());
      if (!seen.has(url)) {
        seen.add(url);
        time.clock.advance(LATENCY_MS);
        return new Response("upstream", { status: 503, headers: { "content-type": "text/plain" } });
      }
      return ok.fetch(url, init);
    };
    const io = ioFor(time, { fetch });
    const code = await main(["transactions", "--backfill"], io);
    expect(io.err.text).not.toMatch(/^eff /m);
    expect(code).toBe(0);
    // each read went out twice (the 503, then its retry): 74 requests, 37 answers
    expect(seen.size).toBe(DEFAULT_READS);
    expect(sendsAt).toHaveLength(2 * DEFAULT_READS);
    expect(ok.sends).toHaveLength(DEFAULT_READS);
    // the run's own requests — first attempts and retries — never pass its share in any minute
    // (each window counted from its start millisecond inclusive, as the store counts), and every
    // send obeys the limiter's windows
    for (const t of sendsAt)
      expect(sendsAt.filter((s) => s >= t - 60_000 && s <= t).length).toBeLessThanOrEqual(
        RUN_SHARE_PER_MINUTE,
      );
    assertWindows(sendsAt, []);
    // the waits were the share's, before a read, announced in the fixed vocabulary: never the
    // window the run filled itself, never a refusal
    const lines = stderrLines(io.err.text);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const l of lines) {
      expect(l).toMatch(WAIT_LINE);
      expect(l).toContain("is near full (the run keeps six free) — waiting");
      expect(l).toContain(", then reading (");
    }
    // every week stored once, no row left pending
    const store = await otherProcess(io);
    const ids = storedIds(store);
    expect(ids).toHaveLength(34);
    expect(new Set(ids).size).toBe(34);
    expect(store.repos.limiter.recentOutcomes(500).filter((r) => r.outcome === "pending")).toEqual(
      [],
    );
  }, 60_000);
});
