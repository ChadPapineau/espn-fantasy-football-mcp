// weather.ts — weather, only where the evidence supports it (sibling research 05 §1 step 7; the PFF
// and 4for4 figures in constants.ts WEATHER_V2): outdoors (or an open roof) only; wind ≥ 10 mph and
// cold < 30 °F and likely precipitation lower completion; wind lowers yards per completion for QBs
// and pass-catchers (deep passes most); cold adds yards per carry for RBs; bad weather moves targets
// toward RBs. Never applied to the implied total — the market moves on forecasts (step 1). Pure. New here.
import { WEATHER_V2 } from "./constants.js";
import type { V2Position, V2Weather, V2WeatherEffect } from "./types.js";

const NONE: V2WeatherEffect = Object.freeze({
  applied: false,
  cmp_delta: 0,
  yards_mult: 1,
  ypc_delta: 0,
  rb_target_mult: 1,
  reasons: Object.freeze([]),
});

const fin = (x: number | null | undefined): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** The weather terms for one position at one venue (NONE indoors, unknown, or calm). */
export function weatherEffect(
  w: V2Weather | null | undefined,
  position: V2Position,
): V2WeatherEffect {
  if (w === null || w === undefined) return NONE;
  if (w.roof === "dome" || w.roof === "closed") return NONE;
  const reasons: string[] = [];
  let cmp = 0;
  let yards = 1;
  let ypc = 0;
  let bad = false;
  const passGame = position !== "RB";
  if (fin(w.wind_mph) && w.wind_mph >= WEATHER_V2.windMph) {
    cmp += WEATHER_V2.windCmpDelta;
    if (passGame) yards *= WEATHER_V2.windYardsMult;
    reasons.push("wind_10mph");
    if (w.wind_mph > WEATHER_V2.strongWindMph) {
      if (passGame) yards *= WEATHER_V2.strongWindYardsMult;
      bad = true;
      reasons.push("wind_13mph");
    }
  }
  if (fin(w.temp_f) && w.temp_f < WEATHER_V2.coldF) {
    cmp += WEATHER_V2.coldCmpDelta;
    if (position === "RB") ypc += WEATHER_V2.coldYpcDelta;
    reasons.push("cold_30f");
  }
  if (fin(w.precip_prob) && w.precip_prob >= WEATHER_V2.precipProb) {
    cmp += WEATHER_V2.precipCmpDelta;
    bad = true;
    reasons.push("precipitation");
  }
  if (reasons.length === 0) return NONE;
  return {
    applied: true,
    cmp_delta: cmp,
    yards_mult: yards,
    ypc_delta: ypc,
    rb_target_mult: bad && position === "RB" ? WEATHER_V2.badWeatherRbTargetMult : 1,
    reasons,
  };
}
