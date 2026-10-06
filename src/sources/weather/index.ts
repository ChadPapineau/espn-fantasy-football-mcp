// index.ts — the weather DataSource chosen by EFF_WEATHER_SOURCE (plan 01 §5.2 weather row; plan 03
// §3; plan 06 §1.3 `refresh weather`; config/schema.ts WEATHER_SOURCES: Open-Meteo by default, NWS).
// Ported from sibling @cf3b015, adapted (no `off` setting in this build's config).
import type { WeatherSource } from "../../config/schema.js";
import type { DataSource } from "../source.js";
import type { WeatherSourceOptions } from "./common.js";
import { createNwsSource } from "./nws.js";
import { createOpenMeteoSource } from "./open-meteo.js";

export { createNwsSource, NWS_PROVIDER } from "./nws.js";
export { createOpenMeteoSource, OPEN_METEO_PROVIDER } from "./open-meteo.js";
export type { WeatherSourceOptions } from "./common.js";

/** The default weather source (plan 03 §3: Open-Meteo). */
export const DEFAULT_WEATHER_SOURCE: WeatherSource = "open-meteo";

/** The source for an EFF_WEATHER_SOURCE setting. */
export function weatherSourceFor(
  setting: WeatherSource,
  opts: WeatherSourceOptions = {},
): DataSource {
  return setting === "nws" ? createNwsSource(opts) : createOpenMeteoSource(opts);
}
