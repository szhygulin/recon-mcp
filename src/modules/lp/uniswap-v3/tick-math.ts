/**
 * Pure-bigint port of Uniswap V3's `TickMath` + `nearestUsableTick` +
 * `TICK_SPACINGS` constant table, originally in `@uniswap/v3-sdk` at
 * `dist/cjs/src/utils/tickMath.js` and `nearestUsableTick.js`. The SDK
 * was dropped from this repo's dep tree because it transitively pulls
 * in `@ethersproject/*` v5, `jsbi`, and `@uniswap/swap-router-contracts`
 * (which itself drags in hardhat, mocha, sentry, solc, undici…). None
 * of that runs in our codepath, but it sits in `node_modules` and
 * Snyk flags every CVE in the tail. See PR #334 history.
 *
 * Math is identical to the SDK's, native-bigint instead of JSBI. The
 * Q64.96 magic-constants table is verbatim from `tickMath.ts` —
 * verified bit-exact by the round-trip tests in
 * `test/uniswap-v3-tick-math.test.ts` against pre-computed reference
 * values.
 */

/** The minimum tick that can be used on any pool. */
export const MIN_TICK = -887_272;
/** The maximum tick. */
export const MAX_TICK = 887_272;
/** sqrtRatioX96 at MIN_TICK (verbatim from the SDK). */
export const MIN_SQRT_RATIO = 4_295_128_739n;
/** sqrtRatioX96 at MAX_TICK (verbatim from the SDK). */
export const MAX_SQRT_RATIO =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

/** Fee-tier → tickSpacing constant table (Uniswap V3 protocol-defined). */
export const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  3_000: 60,
  10_000: 200,
};

const Q32 = 1n << 32n;
const MAX_UINT_256 = (1n << 256n) - 1n;

function mulShift(val: bigint, mulBy: bigint): bigint {
  // Signed right shift by 128 of (val * mulBy). JS bigint `>>` is
  // arithmetic (signed), matching the SDK's `JSBI.signedRightShift`.
  return (val * mulBy) >> 128n;
}

/**
 * Returns the sqrt ratio as a Q64.96 for the given tick, computed as
 * sqrt(1.0001)^tick. Verbatim port of the SDK's `getSqrtRatioAtTick`.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (
    !Number.isInteger(tick) ||
    tick < MIN_TICK ||
    tick > MAX_TICK
  ) {
    throw new Error(`getSqrtRatioAtTick: tick out of range (got ${tick}).`);
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = MAX_UINT_256 / ratio;
  // Back to Q96. Round up if there's any remainder so the ratio is the
  // smallest Q96 that is ≥ the true value (matches the SDK's behavior).
  return ratio % Q32 > 0n ? ratio / Q32 + 1n : ratio / Q32;
}

/**
 * msb(x) — index of the highest set bit (0-indexed). Used by
 * getTickAtSqrtRatio. Native-bigint port of the SDK helper.
 */
function mostSignificantBit(x: bigint): number {
  if (x <= 0n) {
    throw new Error("mostSignificantBit: x must be positive");
  }
  if (x > MAX_UINT_256) {
    throw new Error("mostSignificantBit: x exceeds 2^256 - 1");
  }
  let msb = 0;
  for (const power of [128, 64, 32, 16, 8, 4, 2, 1]) {
    const min = 1n << BigInt(power);
    if (x >= min) {
      x = x >> BigInt(power);
      msb += power;
    }
  }
  return msb;
}

/**
 * Returns the tick whose `getSqrtRatioAtTick(tick)` is the largest
 * value ≤ `sqrtRatioX96`. Verbatim port of the SDK's
 * `getTickAtSqrtRatio`. Used by `mintAmountsWithSlippage` to construct
 * counterfactual pools at slippage-shifted prices.
 */
export function getTickAtSqrtRatio(sqrtRatioX96: bigint): number {
  if (sqrtRatioX96 < MIN_SQRT_RATIO || sqrtRatioX96 >= MAX_SQRT_RATIO) {
    throw new Error(
      `getTickAtSqrtRatio: sqrtRatioX96 ${sqrtRatioX96} out of range ` +
        `[${MIN_SQRT_RATIO}, ${MAX_SQRT_RATIO}).`,
    );
  }
  const sqrtRatioX128 = sqrtRatioX96 << 32n;
  const msb = mostSignificantBit(sqrtRatioX128);
  let r: bigint;
  if (BigInt(msb) >= 128n) {
    r = sqrtRatioX128 >> BigInt(msb - 127);
  } else {
    r = sqrtRatioX128 << BigInt(127 - msb);
  }
  let log_2 = (BigInt(msb) - 128n) << 64n;
  for (let i = 0; i < 14; i += 1) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log_2 = log_2 | (f << BigInt(63 - i));
    r = r >> f;
  }
  const log_sqrt10001 = log_2 * 255_738_958_999_603_826_347_141n;
  const tickLow = Number(
    (log_sqrt10001 - 3_402_992_956_809_132_418_596_140_100_660_247_210n) >> 128n,
  );
  const tickHigh = Number(
    (log_sqrt10001 + 291_339_464_771_989_622_907_027_621_153_398_088_495n) >> 128n,
  );
  if (tickLow === tickHigh) return tickLow;
  return getSqrtRatioAtTick(tickHigh) <= sqrtRatioX96 ? tickHigh : tickLow;
}

/**
 * Returns the closest tick that is divisible by `tickSpacing` and
 * within [MIN_TICK, MAX_TICK]. Match the SDK's `nearestUsableTick`
 * semantics — half-up rounding via `Math.round`, then clamp.
 */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("nearestUsableTick: tickSpacing must be a positive integer");
  }
  // `+ 0` strips the `-0` JS produces from `Math.round(-0.5) * spacing`.
  // Test ergonomics — `Object.is(-0, 0)` is false; downstream consumers
  // never care about the sign of zero.
  const rounded = Math.round(tick / tickSpacing) * tickSpacing + 0;
  if (rounded < MIN_TICK) return rounded + tickSpacing;
  if (rounded > MAX_TICK) return rounded - tickSpacing;
  return rounded;
}
