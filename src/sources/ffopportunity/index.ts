// index.ts — the ffopportunity DataSources (plan 10 §3.2: ffopportunity `ep_weekly`; plan 06 §1.3
// `refresh ffopportunity`; research 04 §B.3 — CC-BY-SA 4.0): the current-season source and its
// history twin (the two prior seasons for the soft backtests).
import type { DataSource } from "../source.js";
import type { HistoryDataSource } from "../nflverse/phase2.js";
import { epWeeklyHistorySource, epWeeklySource } from "./ep-weekly.js";

export {
  EP_NO_PLAYER,
  FFOPPORTUNITY_RELEASE_BASE,
  FFOPPORTUNITY_TAG,
  epWeeklyHistorySource,
  epWeeklySource,
  epWeeklySources,
  parseFfopportunityTimestamp,
} from "./ep-weekly.js";

/** Every ffopportunity DataSource, by id (the runner's registry for `eff refresh ffopportunity`). */
export const FFOPPORTUNITY_SOURCES: Readonly<Record<"ffopportunity:ep_weekly", DataSource>> =
  Object.freeze({ "ffopportunity:ep_weekly": epWeeklySource });

/** The ffopportunity history twin, by id. */
export const FFOPPORTUNITY_HISTORY_SOURCES: Readonly<
  Record<"ffopportunity:ep_weekly_history", HistoryDataSource>
> = Object.freeze({ "ffopportunity:ep_weekly_history": epWeeklyHistorySource });
