// index.ts — the Sleeper trending source (plan 10 §3.2 "Sleeper trending (secondary)"; plan 06 §1.3
// `refresh sleeper:trending`; research 04 #13, §E non-commercial). The refresh wiring runs
// `SLEEPER_TRENDING_SOURCE` for the `sleeper:trending` job.
import type { DataSource } from "../source.js";
import { createSleeperTrendingSource } from "./trending.js";

export {
  assertTrendingShape,
  buildTrendingRows,
  createSleeperTrendingSource,
  decodeTrendingJson,
  halfHourBucket,
  MAX_TRENDING_BYTES,
  MAX_TRENDING_ENTRIES,
  readTrendingFile,
  SLEEPER_HOST,
  sleeperTrendingUrl,
  TRENDING_FILE_FORMAT,
  TRENDING_KINDS,
  trendingRowsOf,
  type TrendingFile,
  type TrendingKind,
} from "./trending.js";

/** The one `sleeper:trending` source of this build. */
export const SLEEPER_TRENDING_SOURCE: DataSource = createSleeperTrendingSource();
