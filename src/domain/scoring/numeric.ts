// numeric.ts — float hygiene for the engine: plan 08 §4.6 (exact values compared at 2 dp, no
// cumulative drift — A-3), P11 (non-finite and absurd magnitudes refused before a score exists).
// Ported from sibling @cf3b015, adapted (ESPN numbers are numbers: no string coercion on the wire).

/** The largest |stat value| the engine accepts (a season of anything is far below it). */
export const MAX_ABS_STAT = 1e9;
/** The largest |points| or |override| the engine accepts. */
export const MAX_ABS_MODIFIER = 1e6;

/**
 * Removes binary-float noise by rounding to 15 significant digits (`0.04 × 312` = 12.48, not
 * 12.480000000000002). Never changes a value by more than 1 part in 10^15; maps −0 to 0.
 */
export function denoise(x: number): number {
  if (x === 0) return 0;
  return denoiseFast(x) ?? denoiseReference(x);
}

/** The definition: `Number(x.toPrecision(15))` (string round trip — correct, but slow). */
export function denoiseReference(x: number): number {
  return Number(x.toPrecision(15)); // −0 prints "0.000…" → 0
}

/** 10^k for k = 0..22, parsed (every one is exactly representable; `10 ** k` need not be exact). */
const POW10: readonly number[] = Array.from({ length: 23 }, (_, k) => Number(`1e${String(k)}`));

/**
 * The same value as `denoiseReference` without a string, or null when it cannot be proved equal
 * (the caller then takes the reference path). For |x| in [1e-8, 1e15), k = 14 − ⌊log10|x|⌋ and
 * t = |x|·10^k (10^k exact, t < 2^50, so every multiple of ½ is a double). Correct rounding is
 * monotone and fixes representable points, so t lies on the same side of every half-integer as the
 * exact product — only t landing exactly ON a half is undecidable. Otherwise m = ⌊t⌉ is the exact
 * 15-digit mantissa and m / 10^k is the double nearest m·10^−k — what `toPrecision(15)` parses to.
 * A mis-estimated exponent (log10 near a power of ten) puts m outside (1e14, 1e15) and is refused.
 */
function denoiseFast(x: number): number | null {
  const a = Math.abs(x);
  const k = 14 - Math.floor(Math.log10(a));
  const s = POW10[k];
  if (s === undefined) return null; // |x| ≥ 1e15, |x| < 1e-8, or not finite
  const t = a * s;
  const floor = Math.floor(t);
  const frac = t - floor;
  if (frac === 0.5) return null; // on a half: a tie or not, undecidable from t
  const m = frac < 0.5 ? floor : floor + 1;
  if (m <= 1e14 || m >= 1e15) return null; // 1e14 itself may be a rounded-up mis-estimate
  const y = m / s;
  return x < 0 ? -y : y;
}

/** Neumaier-compensated sum (Kahan–Babuška): order-robust, no cumulative drift. */
export function stableSum(xs: readonly number[]): number {
  let sum = 0;
  let c = 0;
  for (const x of xs) {
    const t = sum + x;
    if (Math.abs(sum) >= Math.abs(x)) c += sum - t + x;
    else c += x - t + sum;
    sum = t;
  }
  return sum + c;
}

/** Rounds half away from zero to 2 decimals on the denoised value (`1.005` → 1.01, `−0.125` → −0.13). */
export function round2(x: number): number {
  const scaled = denoise(Math.abs(x) * 100);
  const r = Math.round(scaled) / 100;
  return x < 0 && r !== 0 ? -r : r;
}

/** A finite number with |x| ≤ max (the one range check every input passes through). */
export function finiteWithin(x: unknown, max: number): x is number {
  return typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= max;
}

/**
 * `xs[i]` for an index the caller has already bounded — throws RangeError instead of yielding
 * `undefined`, so an index bug surfaces loudly (and the engine needs no non-null assertions).
 */
export function at<T>(xs: readonly T[], i: number): T {
  if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new RangeError("index out of range");
  return xs[i] as T;
}
