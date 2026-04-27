/**
 * Pure-bigint port of the slice of Uniswap V3's `SqrtPriceMath` +
 * `FullMath` + `encodeSqrtRatioX96` + `sqrt` helpers we need for LP
 * mint flows. Originally in `@uniswap/v3-sdk` and `@uniswap/sdk-core`.
 *
 * Only the round-up paths are exposed: mint flows always round
 * required-amount up so the user deposits a hair more than the strict
 * minimum (avoiding a 1-wei revert). The round-down counterparts
 * exist on-chain for `burn` / fee-collection flows; we'll add them
 * when those builders land.
 */

/** Q64.96 fixed-point unit. */
export const Q96 = 1n << 96n;
/** Q192 — used by `encodeSqrtRatioX96` to position the price in 192 bits before sqrt. */
export const Q192 = 1n << 192n;

/**
 * Floor square root of a non-negative bigint. Babylonian-method port
 * matching the SDK's `sqrt` in `sdk-core/dist/.../utils/sqrt.js` —
 * uses `Math.sqrt` for small inputs and Newton iteration for large ones.
 */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error("sqrtBigInt: negative input");
  }
  if (value < BigInt(Number.MAX_SAFE_INTEGER)) {
    return BigInt(Math.floor(Math.sqrt(Number(value))));
  }
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

/**
 * Computes (a × b) ÷ denominator, rounding the result up. Used by
 * `getAmount0Delta` in the round-up branch. Verbatim shape of the
 * SDK's `FullMath.mulDivRoundingUp`.
 */
export function mulDivRoundingUp(
  a: bigint,
  b: bigint,
  denominator: bigint,
): bigint {
  const product = a * b;
  let result = product / denominator;
  if (product % denominator !== 0n) result += 1n;
  return result;
}

/**
 * Returns the sqrt ratio as Q64.96 corresponding to a price ratio
 * `amount1 / amount0`. Inversely used by `ratiosAfterSlippage` to
 * convert a slippage-shifted price back to a sqrtRatio for tick
 * lookup.
 */
export function encodeSqrtRatioX96(
  amount1: bigint,
  amount0: bigint,
): bigint {
  const numerator = amount1 << 192n;
  const ratioX192 = numerator / amount0;
  return sqrtBigInt(ratioX192);
}

/**
 * Δamount0 across a price range, rounded up. Used at mint time to
 * determine how much token0 the position needs.
 *
 * SDK reference: `SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, L, true)`.
 */
export function getAmount0DeltaRoundUp(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  // Two nested mulDivRoundingUp calls — first divides by sqrtRatioBX96,
  // then by sqrtRatioAX96, mirroring the SDK.
  return mulDivRoundingUp(
    mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96),
    1n,
    sqrtRatioAX96,
  );
}

/**
 * Δamount1 across a price range, rounded up.
 * SDK reference: `SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, L, true)`.
 */
export function getAmount1DeltaRoundUp(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
}
