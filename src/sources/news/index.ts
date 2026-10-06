// index.ts — the news sources (plan 10 §3.2 RotoWire/ESPN RSS + the CBS fallback; plan 06 §1.3
// `refresh news`; plan 07 D6). The refresh wiring calls `newsSources({ universe, previous })`.
export {
  cleanLink,
  collapse,
  isPromo,
  NEWS_FEED_HOSTS,
  NEWS_FEEDS,
  pubDateMs,
  type NewsFeedSpec,
} from "./feeds.js";
export {
  buildPlayerMatcher,
  MATCH_CONFIDENCE,
  MATCH_TEXT_CAP,
  MAX_REFS_PER_ITEM,
  type NewsPlayerRef,
  type NewsUniversePlayer,
  type PlayerMatcher,
} from "./match.js";
export {
  assertNewsShape,
  buildNewsRows,
  createNewsSource,
  FUTURE_SKEW_MS,
  itemRowOf,
  MAX_NEWS_FILE_BYTES,
  MAX_NEWS_ITEMS,
  MAX_RSS_BYTES,
  MAX_UNIVERSE_PLAYERS,
  NEWS_FILE_FORMAT,
  newsSources,
  previousRowOf,
  quarterHourBucket,
  readNewsFile,
  RSS_ACCEPT,
  universePlayerOf,
  type NewsBuild,
  type NewsFile,
  type NewsSourceOptions,
} from "./source.js";
export { TEAM_HOMES, TEAM_NICKNAMES, TEAM_WORDS, teamsMentioned } from "./teams.js";
export {
  decodeBody,
  decodeXmlText,
  parseRss,
  RSS_IGNORED_CHILDREN,
  RSS_ITEM_FIELDS,
  RSS_LIMITS,
  type RssDocument,
  type RssItem,
  type RssItemField,
  type RssLimits,
} from "./xml.js";
