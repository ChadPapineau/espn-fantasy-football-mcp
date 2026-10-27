// log-client-ref.test.ts — the Skills' `client_ref` names the result, never the decision (Stage C
// finding skills-log-client-ref-dedups-changed-rec; plan 09 §2 log discipline; plan 07 E12;
// changelog R7-1: the retrospective scores what the user was told). E12 deduplicates on (league,
// season, week, kind, client_ref) alone and never compares the rec (src/store/repos/reclog.ts), so
// log.md's old recipe — "a stable key with the season, week and decision, e.g.
// start-sit-2026-w5-flex" — folded a changed recommendation onto the first entry: start-sit on
// Tuesday, the same FLEX question on Sunday after a downgrade came back `deduplicated: true` and was
// never stored, and E13 then scored the superseded Tuesday call. The recipe is now the producing
// call's own `meta.request_id`: a re-run of the analysis is a new entry, and only the same result
// logged again (a retry) deduplicates. Held three ways: the reference's wording; every Lane 1 record
// step (check-skills refuses any other key, shown on a private copy); and the real tools on fx-10h
// (core, fixture mode, no network, no cookie) — two lineup answers, one standing in for late news.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkSkills, isClientRefOf } from "../../scripts/skills/check-skills.mjs";
import { REQUEST_ID_RE } from "../../src/mcp/envelope.js";
import { CLIENT_REF_RE } from "../../src/domain/reclog/types.js";
import { ESPN_FIXTURES, call, connect, makeWorld, type World } from "../mcp/helpers/world.js";
import { ROOT, SKILLS, readSequence, tempRepo, type TempRepo } from "./helpers.js";

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const LOG = read("skills/_shared/references/log.md");
/** log.md's `client_ref` bullet. */
const RECIPE = LOG.split("\n").find((l) => l.startsWith("- `client_ref`:")) ?? "";

describe("log.md: client_ref is the producing call's request id (Stage C skills-log-client-ref-dedups-changed-rec)", () => {
  it("names the analytics call's meta.request_id, copied verbatim, with a valid example", () => {
    expect(RECIPE).toMatch(
      /^- `client_ref`: the `meta\.request_id` of the analytics call whose `rec` this entry logs, copied verbatim/,
    );
    const example = /for example `([^`]+)`/.exec(RECIPE)?.[1] ?? "";
    expect(example).toMatch(REQUEST_ID_RE);
    // a request id is always a key E12 accepts
    expect(example).toMatch(CLIENT_REF_RE);
  });

  it("says a re-run is a new entry, only the same result deduplicates, and forbids the decision key", () => {
    expect(RECIPE).toMatch(/the same result logged again \(a retry[^)]*\) is deduplicated/);
    expect(RECIPE).toMatch(/a re-run of the analysis[^.]*has a new `request_id`/);
    expect(RECIPE).toMatch(/Never build the key from the season, week or decision/);
    expect(RECIPE).toMatch(
      /`deduplicated: true` in the result means this same result was already logged/,
    );
    // the old recipe and its example are gone from every shipped copy
    for (const s of SKILLS) {
      const copy = read(`skills/${s}/references/log.md`);
      expect(copy, s).toBe(LOG);
      expect(copy).not.toMatch(/a stable key with the season, week and decision/);
      expect(copy).not.toContain("start-sit-2026-w5-flex");
    }
  });

  it("the onboarding entry, which no analytics call produces, keeps its own fixed key", () => {
    expect(RECIPE).toMatch(/The onboarding entry[^)]*keeps the fixed key its own reference gives/);
    expect(read("skills/onboard/references/onboard-log-entry.md")).toContain(
      '"client_ref": "onboard-setup"',
    );
  });
});

describe("Lane 1: every record step's client_ref is its producer's request id", () => {
  it("in every tool_sequence.json, a logged rec's client_ref is { $ref: <producer>.meta.request_id }", () => {
    let checked = 0;
    for (const s of SKILLS) {
      for (const q of readSequence(s).sequences) {
        for (const st of q.steps) {
          if (st.tool !== "espn_record_recommendation") continue;
          const ref = (st.args.rec as { $ref?: unknown } | undefined)?.$ref;
          if (typeof ref !== "string") {
            // onboarding's literal entry (onboard-log-entry.md) has no producer
            expect(st.args.kind, `${s}/${q.id}/${st.id}`).toBe("onboarding");
            continue;
          }
          const producer = ref.replace(/\.data\.rec$/, "");
          expect(st.args.client_ref, `${s}/${q.id}/${st.id}`).toEqual({
            $ref: `${producer}.meta.request_id`,
          });
          expect(isClientRefOf(st.args.client_ref, producer)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  it("check-skills refuses a decision key, another call's request id, or none — and accepts the recipe", () => {
    // one private copy, one checker run: start-sit's three sequences each get one bad key, and the
    // record step left as committed is the control
    repo = tempRepo();
    repo.editJson("skills/start-sit/evals/tool_sequence.json", (j) => {
      const seqs = j.sequences as {
        id: string;
        steps: { id: string; args: Record<string, unknown> }[];
      }[];
      const stepOf = (seq: string, id: string) => {
        const st = seqs.find((q) => q.id === seq)?.steps.find((x) => x.id === id);
        if (st === undefined) throw new Error(`start-sit has no ${seq}/${id}`);
        return st;
      };
      stepOf("pre_game", "record").args.client_ref = "start-sit-2026-w5-flex";
      stepOf("game_day", "record").args.client_ref = { $ref: "roster.meta.request_id" };
      delete stepOf("game_day_live", "record_matchup").args.client_ref;
    });
    const errors = checkSkills({ root: repo.root, scan: false }).errors;
    const recipe = (seq: number, step: string, producer: string): string =>
      `skills/start-sit/evals/tool_sequence.json sequences[${String(seq)}]: ${step}'s client_ref must be { "$ref": "${producer}.meta.request_id" } — the producing call's request id (references/log.md), never a key built from the decision`;
    expect(errors).toContain(recipe(0, "record", "lineup")); // the decision key
    expect(errors).toContain(recipe(1, "record", "lineup")); // another call's request id
    expect(errors).toContain(recipe(2, "record_matchup", "matchup")); // none
    // the control: game_day_live's lineup record keeps the recipe and is not flagged
    expect(errors).not.toContain(recipe(2, "record", "lineup"));
    expect(errors.filter((e) => e.includes("client_ref must be"))).toHaveLength(3);
  });
});

interface Envelope {
  data: Record<string, unknown>;
  meta: { request_id: string };
}

describe("the recipe on the real tools: changed advice is logged, a retry is not (fx-10h, core)", () => {
  const FX = path.join(ESPN_FIXTURES, "fx-10h");
  const manifest = JSON.parse(readFileSync(path.join(FX, "manifest.json"), "utf8")) as {
    clock: string;
    my_team_id: number;
    current_week: number;
  };
  let world: World;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    world = await makeWorld({
      env: { EFF_FIXTURE_DIR: FX },
      teamId: manifest.my_team_id,
      clock: manifest.clock,
    });
    ({ client, close } = await connect(world));
  }, 120_000);
  afterAll(async () => {
    await close();
    world.cleanup();
  });

  async function ok(name: string, args: Record<string, unknown>): Promise<Envelope> {
    const r = await call(client, name, args);
    expect(r.isError, `${name}: ${JSON.stringify(r.body).slice(0, 400)}`).toBe(false);
    return r.body as unknown as Envelope;
  }
  /** espn_record_recommendation as start-sit's `record` step makes it, with this client_ref. */
  const record = (lineup: Envelope, hash: string, clientRef: string) =>
    ok("espn_record_recommendation", {
      kind: "lineup",
      week: manifest.current_week,
      rec: lineup.data.rec,
      alternatives: [],
      source_calls: [{ tool: "espn_analyze_lineup", request_id: lineup.meta.request_id }],
      settings_hash: hash,
      followed_hint: "unknown",
      client_ref: clientRef,
    });

  it("a re-run's changed rec is its own entry; the same result logged again deduplicates onto the first", async () => {
    const week = manifest.current_week;
    const league = await ok("espn_get_league", {});
    const hash = (league.data.scoring as { settings_hash: string }).settings_hash;
    const roster = await ok("espn_get_roster", { week });
    const starter = (
      roster.data.players as { player_id: number; slot: string; lineup_locked: boolean }[]
    ).find((p) => ["RB", "WR", "TE", "FLEX"].includes(p.slot) && !p.lineup_locked);
    expect(starter, "an unlocked starter to rule out").toBeDefined();
    // Tuesday's answer, then the same question after late news (the starter ruled out)
    const before = await ok("espn_analyze_lineup", { week, objective: "auto" });
    const after = await ok("espn_analyze_lineup", {
      week,
      objective: "auto",
      exclude: [starter?.player_id ?? 0],
    });
    expect(JSON.stringify(after.data.rec)).not.toBe(JSON.stringify(before.data.rec));
    expect(after.meta.request_id).not.toBe(before.meta.request_id);

    // the recipe: each result's own request id
    const first = await record(before, hash, before.meta.request_id);
    expect(first.data.deduplicated).toBe(false);
    const second = await record(after, hash, after.meta.request_id);
    expect(second.data.deduplicated, "the changed advice is logged").toBe(false);
    expect(second.data.log_id).not.toBe(first.data.log_id);
    // a retry of the first record (the same result): deduplicated onto the first entry
    const retry = await record(before, hash, before.meta.request_id);
    expect(retry.data.deduplicated).toBe(true);
    expect(retry.data.log_id).toBe(first.data.log_id);
    // both answers the user was given are in the log
    const stored = world.store.repos.recommendationLog;
    expect(stored.get(String(first.data.log_id))?.client_ref).toBe(before.meta.request_id);
    expect(stored.get(String(second.data.log_id))?.client_ref).toBe(after.meta.request_id);

    // why the old recipe had to go: a decision key folds the changed advice onto the first entry
    const a = await ok("espn_analyze_lineup", { week, objective: "mean" });
    const b = await ok("espn_analyze_lineup", {
      week,
      objective: "mean",
      exclude: [starter?.player_id ?? 0],
    });
    const decisionKey = `start-sit-2026-w${String(week)}-flex`;
    expect((await record(a, hash, decisionKey)).data.deduplicated).toBe(false);
    expect((await record(b, hash, decisionKey)).data.deduplicated).toBe(true);
  }, 240_000);
});
