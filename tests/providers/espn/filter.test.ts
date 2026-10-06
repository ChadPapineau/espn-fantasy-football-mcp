// filter.test.ts — src/providers/espn/filter.ts, a 100 %-coverage module (plan 05 §2 `providers/espn/
// filter`, §7): `limit` present ⇒ a sort present, else VALIDATION (never sent); limit ≤ 100; offset ≤
// 5 000; ≤ 50 ids; entity nesting on league paths, root on `/players`; canonical serialisation (equal
// specs → byte-equal headers); unknown keys refused; the builder reproduces the RECORDED requests.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  boardProbeFilter,
  canonicalJson,
  playerFilter,
  playerFilterObject,
  scheduleFilter,
  sortTerms,
  transactionsFilter,
  type PlayerFilterSpec,
} from "../../../src/providers/espn/filter.js";
import { EspnRequestError } from "../../../src/providers/espn/path.js";
import {
  FILTER_IDS_MAX,
  FILTER_LIMIT_MAX,
  FILTER_OFFSET_MAX,
  PLAYER_SORTS,
} from "../../../src/providers/espn/types.js";
import { loadFixture } from "./helpers.js";

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EspnRequestError);
    return (e as EspnRequestError).effDetails.reason;
  }
  throw new Error("expected a refusal");
};

interface ManifestFile {
  path: string;
  request: { filter: unknown };
}
const manifest = loadFixture("manifest.json") as { files: ManifestFile[] };
const recordedFilter = (p: string): unknown =>
  manifest.files.find((f) => f.path === p)?.request.filter;

describe("the builder reproduces the recorded requests byte for byte (canonical)", () => {
  it("kona_player_info page: AVAILABLE, percOwned, limit 25, offset 0", () => {
    const f = playerFilter(
      {
        filterStatus: ["WAIVERS", "FREEAGENT"],
        limit: 25,
        offset: 0,
        sorts: sortTerms("percOwned", 2026, 4),
      },
      "league",
    );
    expect(f).toBe(canonicalJson(recordedFilter("recorded/league-a/kona_player_info.json")));
  });
  it("kona_player_info by filterIds and kona_playercard with the stat splits", () => {
    const rec = recordedFilter("recorded/league-a/kona_player_info.ids.json") as {
      players: { filterIds: { value: number[] } };
    };
    const ids = [...rec.players.filterIds.value].reverse();
    expect(playerFilter({ filterIds: ids }, "league")).toBe(canonicalJson(rec));
    const card = recordedFilter("recorded/league-a/kona_playercard.json");
    expect(
      playerFilter(
        {
          filterIds: ids,
          filterStatsForTopScoringPeriodIds: {
            value: 17,
            additionalValue: ["002026", "102026", "002025"],
          },
        },
        "league",
      ),
    ).toBe(canonicalJson(card));
  });
  it("players_wl root-level filterActive and the box-score schedule filter", () => {
    expect(playerFilter({ filterActive: true }, "root")).toBe(
      canonicalJson(recordedFilter("recorded/season/players_wl.json")),
    );
    expect(scheduleFilter([1])).toBe(
      canonicalJson(recordedFilter("recorded/league-a/mBoxscore.sp1.json")),
    );
  });
});

describe("refusals (VALIDATION, never sent)", () => {
  const base: PlayerFilterSpec = { limit: 10, sorts: sortTerms("percOwned", 2026, 1) };
  it("limit without a sort — the FILTER_LIMIT_MISSING_SORT 400 made impossible", () => {
    expect(refused(() => playerFilter({ limit: 10 }, "league"))).toBe("limit_without_sort");
    expect(refused(() => playerFilter({ limit: 10, sorts: [] }, "league"))).toBe(
      "limit_without_sort",
    );
  });
  it.each([0, FILTER_LIMIT_MAX + 1, 5000, 1.5, -1])("limit %d", (limit) => {
    expect(refused(() => playerFilter({ ...base, limit }, "league"))).toBe("limit_out_of_range");
  });
  it.each([-1, FILTER_OFFSET_MAX + 1, 2.5])("offset %d", (offset) => {
    expect(refused(() => playerFilter({ ...base, offset }, "league"))).toBe("offset_out_of_range");
  });
  it("offset without limit; a limit on the root route", () => {
    expect(refused(() => playerFilter({ offset: 5, filterActive: true }, "league"))).toBe(
      "offset_without_limit",
    );
    expect(refused(() => playerFilter({ ...base, filterActive: true }, "root"))).toBe(
      "root_filter_limit_refused",
    );
  });
  it("ids: empty, > 50, non-integer, out of the id grammar", () => {
    expect(refused(() => playerFilter({ filterIds: [] }, "league"))).toBe("filter_ids_invalid");
    expect(
      refused(() =>
        playerFilter(
          { filterIds: Array.from({ length: FILTER_IDS_MAX + 1 }, (_, i) => i + 1) },
          "league",
        ),
      ),
    ).toBe("filter_ids_invalid");
    for (const bad of [0, -1, 1.5, 100_000_000, -20000, Number.NaN])
      expect(refused(() => playerFilter({ filterIds: [bad] }, "league"))).toBe(
        "filter_ids_invalid",
      );
    expect(playerFilter({ filterIds: [-16034, 5, 5] }, "league")).toBe(
      '{"players":{"filterIds":{"value":[-16034,5]}}}',
    );
  });
  it("status, slot ids, active, stat splits", () => {
    expect(refused(() => playerFilter({ filterStatus: [] }, "league"))).toBe(
      "filter_status_invalid",
    );
    expect(
      refused(() => playerFilter({ filterStatus: ["ONTEAM", "BOGUS" as never] }, "league")),
    ).toBe("filter_status_invalid");
    expect(refused(() => playerFilter({ filterSlotIds: [26] }, "league"))).toBe(
      "filter_slot_ids_invalid",
    );
    expect(refused(() => playerFilter({ filterSlotIds: [] }, "league"))).toBe(
      "filter_slot_ids_invalid",
    );
    expect(playerFilter({ filterSlotIds: [23, 0, 23] }, "league")).toBe(
      '{"players":{"filterSlotIds":{"value":[0,23]}}}',
    );
    expect(refused(() => playerFilter({ filterActive: "yes" as never }, "league"))).toBe(
      "filter_active_invalid",
    );
    expect(
      refused(() =>
        playerFilter(
          { filterStatsForTopScoringPeriodIds: { value: 23, additionalValue: ["002026"] } },
          "league",
        ),
      ),
    ).toBe("filter_stats_invalid");
    expect(
      refused(() =>
        playerFilter(
          { filterStatsForTopScoringPeriodIds: { value: 17, additionalValue: ["2026"] } },
          "league",
        ),
      ),
    ).toBe("filter_stats_invalid");
    expect(
      refused(() =>
        playerFilter(
          { filterStatsForTopScoringPeriodIds: { value: 17, additionalValue: [] } },
          "league",
        ),
      ),
    ).toBe("filter_stats_invalid");
  });
  it("sorts: unknown key, duplicate key, bad priority/asc/value, too many", () => {
    const t = sortTerms("percOwned", 2026, 1)[0]!;
    expect(
      refused(() =>
        playerFilter({ limit: 5, sorts: [{ ...t, key: "sortByName" as never }] }, "league"),
      ),
    ).toBe("sort_invalid");
    expect(refused(() => playerFilter({ limit: 5, sorts: [t, t] }, "league"))).toBe("sort_invalid");
    expect(
      refused(() => playerFilter({ limit: 5, sorts: [{ ...t, priority: 0 }] }, "league")),
    ).toBe("sort_invalid");
    expect(
      refused(() => playerFilter({ limit: 5, sorts: [{ ...t, asc: "no" as never }] }, "league")),
    ).toBe("sort_invalid");
    expect(
      refused(() => playerFilter({ limit: 5, sorts: [{ ...t, value: "lower case" }] }, "league")),
    ).toBe("sort_invalid");
    expect(
      refused(() =>
        playerFilter({ limit: 5, sorts: Array.from({ length: 5 }, () => t) }, "league"),
      ),
    ).toBe("sort_invalid");
    expect(refused(() => playerFilter({ limit: 5, sorts: "x" as never }, "league"))).toBe(
      "sort_invalid",
    );
  });
  it("unknown keys, a non-object spec, an empty spec", () => {
    expect(refused(() => playerFilter({ filterInjured: true } as never, "league"))).toBe(
      "filter_key_unknown",
    );
    expect(refused(() => playerFilterObject(null as never))).toBe("filter_not_object");
    expect(refused(() => playerFilter({}, "league"))).toBe("filter_empty");
  });
  it("transactions, schedule", () => {
    expect(transactionsFilter(["WAIVER", "FREEAGENT"])).toBe(
      '{"transactions":{"filterType":{"value":["FREEAGENT","WAIVER"]}}}',
    );
    expect(refused(() => transactionsFilter([]))).toBe("transaction_types_invalid");
    expect(refused(() => transactionsFilter(["NOT_A_TYPE"]))).toBe("transaction_types_invalid");
    expect(refused(() => scheduleFilter([0]))).toBe("matchup_period_invalid");
    expect(refused(() => scheduleFilter([]))).toBe("matchup_period_invalid");
    expect(scheduleFilter([3, 2, 3])).toBe(
      '{"schedule":{"filterMatchupPeriodIds":{"value":[2,3]}}}',
    );
  });
});

describe("sortTerms (PLAYER_SORT_MAP)", () => {
  it("every C2 sort maps to a primary term; the draft-rank tie-break is added unless primary", () => {
    for (const s of PLAYER_SORTS) {
      const terms = sortTerms(s, 2026, 4);
      expect(terms[0]?.priority).toBe(1);
      if (s === "draftRank") expect(terms).toHaveLength(1);
      else
        expect(terms[1]).toEqual({
          key: "sortDraftRanks",
          asc: true,
          priority: 100,
          value: "STANDARD",
        });
    }
    expect(sortTerms("projection_week", 2026, 4)[0]?.value).toBe("1120264");
    expect(sortTerms("projection_ros", 2026, 4)[0]?.value).toBe("102026");
    expect(sortTerms("draftRank", 2026, 4)[0]).toMatchObject({ value: "STANDARD", asc: true });
    expect(sortTerms("name", 2026, 4)[0]?.key).toBe("sortPercOwned");
  });
  it("the board probe filter is fixed", () => {
    expect(boardProbeFilter()).toBe(
      '{"topics":{"limit":1,"sortMessageDate":{"sortAsc":false,"sortPriority":1}}}',
    );
  });
});

describe("properties", () => {
  const spec = fc.record(
    {
      filterStatus: fc.subarray(["FREEAGENT", "WAIVERS", "ONTEAM"] as const, { minLength: 1 }),
      filterSlotIds: fc.array(fc.integer({ min: 0, max: 25 }), { minLength: 1, maxLength: 10 }),
      limit: fc.integer({ min: 1, max: FILTER_LIMIT_MAX }),
      offset: fc.integer({ min: 0, max: FILTER_OFFSET_MAX }),
      sort: fc.constantFrom(...PLAYER_SORTS),
    },
    { requiredKeys: ["limit", "sort"] },
  );
  it("limit ⇒ a sort key in the header; limit ≤ 100; key order never changes the bytes", () => {
    fc.assert(
      fc.property(spec, (s) => {
        const built: PlayerFilterSpec = {
          ...(s.filterStatus === undefined ? {} : { filterStatus: s.filterStatus }),
          ...(s.filterSlotIds === undefined ? {} : { filterSlotIds: s.filterSlotIds }),
          limit: s.limit,
          ...(s.offset === undefined ? {} : { offset: s.offset }),
          sorts: sortTerms(s.sort, 2026, 4),
        };
        const a = playerFilter(built, "league");
        const reversed = Object.fromEntries(Object.entries(built).reverse()) as PlayerFilterSpec;
        expect(playerFilter(reversed, "league")).toBe(a);
        const inner = (JSON.parse(a) as { players: Record<string, unknown> }).players;
        expect(Object.keys(inner).some((k) => k.startsWith("sort"))).toBe(true);
        expect(inner.limit).toBeLessThanOrEqual(FILTER_LIMIT_MAX);
        expect(canonicalJson(JSON.parse(a))).toBe(a);
      }),
    );
  });
  it("canonicalJson is key-order independent and round-trips", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const s = canonicalJson(v);
        expect(canonicalJson(JSON.parse(s))).toBe(s);
      }),
    );
  });
});
