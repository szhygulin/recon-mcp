/**
 * Bit-exactness regression for the local Uniswap V3 math ports
 * (`src/modules/lp/uniswap-v3/{tick-math,sqrt-price-math,position-math}.ts`).
 *
 * Reference values are locked in from `@uniswap/v3-sdk@3.30.0` — the
 * same SDK we replaced — captured once, then asserted against forever.
 * If a future "simplification" of the ported math drifts from the
 * SDK's output, this test fails before any LP tx encoded against drifted
 * math leaves the codebase.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  TICK_SPACINGS,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  nearestUsableTick,
} from "../src/modules/lp/uniswap-v3/tick-math.js";
import {
  Q96,
  Q192,
  sqrtBigInt,
  mulDivRoundingUp,
  encodeSqrtRatioX96,
  getAmount0DeltaRoundUp,
  getAmount1DeltaRoundUp,
} from "../src/modules/lp/uniswap-v3/sqrt-price-math.js";
import {
  maxLiquidityForAmounts,
  mintAmounts,
  mintAmountsWithSlippage,
} from "../src/modules/lp/uniswap-v3/position-math.js";

describe("tick-math constants", () => {
  it("MIN_TICK / MAX_TICK match the SDK", () => {
    expect(MIN_TICK).toBe(-887_272);
    expect(MAX_TICK).toBe(887_272);
  });
  it("MIN_SQRT_RATIO / MAX_SQRT_RATIO match the SDK", () => {
    expect(MIN_SQRT_RATIO).toBe(4_295_128_739n);
    expect(MAX_SQRT_RATIO).toBe(
      1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n,
    );
  });
  it("TICK_SPACINGS match the protocol", () => {
    expect(TICK_SPACINGS[100]).toBe(1);
    expect(TICK_SPACINGS[500]).toBe(10);
    expect(TICK_SPACINGS[3_000]).toBe(60);
    expect(TICK_SPACINGS[10_000]).toBe(200);
  });
});

describe("getSqrtRatioAtTick (bit-exact vs SDK 3.30.0)", () => {
  // Reference table generated with `TickMath.getSqrtRatioAtTick(...)` from
  // `@uniswap/v3-sdk@3.30.0`. If the port drifts, this fails first.
  const cases: Array<[number, bigint]> = [
    [-887_272, 4_295_128_739n],
    [-887_270, 4_295_558_252n],
    [-200_000, 3_598_751_819_609_688_046_946_419n],
    [-100, 78_833_030_112_140_176_575_862_854_579n],
    [-1, 79_224_201_403_219_477_170_569_942_574n],
    [0, 79_228_162_514_264_337_593_543_950_336n],
    [1, 79_232_123_823_359_799_118_286_999_568n],
    [100, 79_625_275_426_524_748_796_330_556_128n],
    [100_000, 11_755_562_826_496_067_164_730_007_768_450n],
    [887_270, 1_461_300_573_427_867_316_570_072_651_998_408_279_850_435_624_081n],
    [887_272, 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n],
  ];
  it.each(cases)("tick=%i", (tick, expected) => {
    expect(getSqrtRatioAtTick(tick)).toBe(expected);
  });
  it("rejects out-of-range ticks", () => {
    expect(() => getSqrtRatioAtTick(-887_273)).toThrow(/out of range/);
    expect(() => getSqrtRatioAtTick(887_273)).toThrow(/out of range/);
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(/out of range/);
  });
});

describe("getTickAtSqrtRatio (bit-exact vs SDK 3.30.0)", () => {
  // Reference table from the SDK.
  const cases: Array<[bigint, number]> = [
    [4_295_128_740n, -887_272], // MIN_SQRT_RATIO + 1
    [79_228_162_514_264_337_593_543_950_336n, 0], // tick=0 sqrtRatio
    [3_262_820_378_846_468_593_912_909n, -201_960], // USDC/WETH near $3000/ETH
    // MAX_SQRT_RATIO - 1
    [
      1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n,
      887_271,
    ],
  ];
  it.each(cases)("sqrtRatioX96=%s", (sqrtRatio, expected) => {
    expect(getTickAtSqrtRatio(sqrtRatio)).toBe(expected);
  });
  it("getSqrtRatioAtTick ↔ getTickAtSqrtRatio round-trips on representative ticks", () => {
    for (const t of [-100_000, -100, 0, 100, 100_000]) {
      const sr = getSqrtRatioAtTick(t);
      expect(getTickAtSqrtRatio(sr)).toBe(t);
    }
  });
  it("rejects out-of-range sqrtRatios", () => {
    expect(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(/out of range/);
    expect(() => getTickAtSqrtRatio(MAX_SQRT_RATIO)).toThrow(/out of range/);
  });
});

describe("nearestUsableTick", () => {
  it.each([
    [123, 60, 120],
    [-123, 60, -120],
    [60, 60, 60],
    [30, 60, 60], // half-up rounds 30/60=0.5 to 1 → 60
    [-30, 60, 0], // -30/60 = -0.5; Math.round(-0.5) = 0 (banker's) → 0
    [887_272, 200, 887_200], // clamped within MAX_TICK by stepping back
    [-887_272, 200, -887_200], // clamped within MIN_TICK by stepping forward
  ])("(%i, %i) → %i", (tick, spacing, expected) => {
    expect(nearestUsableTick(tick, spacing)).toBe(expected);
  });
});

describe("sqrt-price-math primitives", () => {
  it("Q96 = 2^96, Q192 = 2^192", () => {
    expect(Q96).toBe(1n << 96n);
    expect(Q192).toBe(1n << 192n);
  });
  it("sqrtBigInt: small inputs use Math.sqrt branch", () => {
    expect(sqrtBigInt(0n)).toBe(0n);
    expect(sqrtBigInt(1n)).toBe(1n);
    expect(sqrtBigInt(99n)).toBe(9n);
    expect(sqrtBigInt(100n)).toBe(10n);
    expect(sqrtBigInt(2n)).toBe(1n); // floor(sqrt(2))
  });
  it("sqrtBigInt: large input uses Newton iteration", () => {
    const big = 10n ** 60n;
    const root = sqrtBigInt(big);
    // root² ≤ value < (root+1)²
    expect(root * root <= big).toBe(true);
    expect((root + 1n) * (root + 1n) > big).toBe(true);
  });
  it("sqrtBigInt rejects negatives", () => {
    expect(() => sqrtBigInt(-1n)).toThrow(/negative/);
  });
  it("mulDivRoundingUp: rounds up when there's a remainder", () => {
    expect(mulDivRoundingUp(10n, 10n, 3n)).toBe(34n); // 100/3 = 33.33... → 34
    expect(mulDivRoundingUp(9n, 10n, 3n)).toBe(30n); // 90/3 = 30 exact, no round
  });
  it("encodeSqrtRatioX96(1, 1) is the tick=0 sqrtRatio", () => {
    expect(encodeSqrtRatioX96(1n, 1n)).toBe(getSqrtRatioAtTick(0));
  });
});

describe("getAmount0DeltaRoundUp / getAmount1DeltaRoundUp", () => {
  // Sanity: Δamount0 across a range that brackets tick=0 with L=2^96
  // should yield amount0 ≈ L*(sqrtB - sqrtA) / (sqrtA*sqrtB) — too
  // gnarly to assert closed-form, but bracket comparisons are easy:
  // larger L → larger amount; same L over a wider range → larger amount.
  const sA = getSqrtRatioAtTick(-100);
  const sB = getSqrtRatioAtTick(100);
  it("monotonic in liquidity", () => {
    const a = getAmount0DeltaRoundUp(sA, sB, 1_000_000n);
    const b = getAmount0DeltaRoundUp(sA, sB, 2_000_000n);
    expect(b).toBeGreaterThan(a);
  });
  it("symmetric in tick order (A vs B can be swapped)", () => {
    const a = getAmount0DeltaRoundUp(sA, sB, 1_000_000n);
    const b = getAmount0DeltaRoundUp(sB, sA, 1_000_000n);
    expect(a).toBe(b);
  });
  it("amount1Delta is monotonic in price gap", () => {
    const a = getAmount1DeltaRoundUp(sA, sB, 1_000_000n);
    const wider = getAmount1DeltaRoundUp(
      getSqrtRatioAtTick(-1000),
      getSqrtRatioAtTick(1000),
      1_000_000n,
    );
    expect(wider).toBeGreaterThan(a);
  });
});

describe("maxLiquidityForAmounts + mintAmounts (round-trip sanity)", () => {
  // For an in-range position, derive liquidity from desired amounts,
  // then re-derive the actual amount0/amount1 needed to mint that
  // liquidity. The "actual" amounts must be ≤ the desired (the imprecise
  // router rounds down on liquidity then rounds up on the amounts;
  // mintAmounts ≤ desired by construction).
  const FAKE_TICK = -201_960;
  const sqrtCurrent = getSqrtRatioAtTick(FAKE_TICK);
  it("amount0 + amount1 mint round-trip stays ≤ desired", () => {
    const tickLower = -202_020; // tickSpacing=60 aligned
    const tickUpper = -201_900;
    const desired0 = 100_000_000n; // 100 USDC
    const desired1 = 50_000_000_000_000_000n; // 0.05 WETH
    const liquidity = maxLiquidityForAmounts({
      sqrtRatioCurrentX96: sqrtCurrent,
      sqrtRatioAX96: getSqrtRatioAtTick(tickLower),
      sqrtRatioBX96: getSqrtRatioAtTick(tickUpper),
      amount0: desired0,
      amount1: desired1,
      useFullPrecision: true,
    });
    const actual = mintAmounts({
      pool: {
        fee: 3_000,
        sqrtRatioX96: sqrtCurrent,
        tickCurrent: FAKE_TICK,
        tickSpacing: 60,
      },
      tickLower,
      tickUpper,
      liquidity,
    });
    // Round-up math means actual.amount0 may be 1 wei above the
    // strict desired. The invariant is: liquidity must round-trip
    // close enough to satisfy the on-chain min-amount check.
    expect(actual.amount0).toBeLessThanOrEqual(desired0 + 1n);
    expect(actual.amount1).toBeLessThanOrEqual(desired1 + 1n);
  });
});

describe("mintAmountsWithSlippage (bit-exact vs SDK 3.30.0)", () => {
  // Reference values captured from `Position.fromAmounts(...)
  // .mintAmountsWithSlippage(Percent(50, 10000))` against the SDK
  // BEFORE we dropped it. The math in the port produces these same
  // numbers; if a future "simplification" drifts from them, this
  // test fails first.
  //
  // The case is asymmetric: tickCurrent is closer to tickLower than
  // tickUpper (60 ticks above lower vs. 60 below upper, but the
  // sqrt-ratio scale is geometric, so this slice is not perfectly
  // symmetric). The position is heavily token1-bottlenecked at this
  // price — that's why amount0Min ends up much smaller than the 100M
  // desired (the position will only pull ~17M USDC). amount1Min
  // collapses to 1 wei at the lower-bound counterfactual pool because
  // the slippage-shifted price moves the position out of token1's
  // dominance there.
  const tickCurrent = -201_960;
  const sqrtCurrent = getSqrtRatioAtTick(tickCurrent);
  it("amount0Min + amount1Min match SDK reference at 50 bps", () => {
    const result = mintAmountsWithSlippage({
      pool: {
        fee: 3_000,
        sqrtRatioX96: sqrtCurrent,
        tickCurrent,
        tickSpacing: 60,
      },
      tickLower: -202_020,
      tickUpper: -201_900,
      amount0Desired: 100_000_000n,
      amount1Desired: 50_000_000_000_000_000n,
      slippageBps: 50,
    });
    // SDK reference values:
    expect(result.amount0).toBe(16_849_117n);
    expect(result.amount1).toBe(1n);
    expect(result.liquidity).toBe(1_374_881n);
  });
  it("higher slippage → looser (smaller) min amounts", () => {
    const args = {
      pool: {
        fee: 3_000,
        sqrtRatioX96: sqrtCurrent,
        tickCurrent,
        tickSpacing: 60,
      },
      tickLower: -202_020,
      tickUpper: -201_900,
      amount0Desired: 100_000_000n,
      amount1Desired: 50_000_000_000_000_000n,
    };
    const tight = mintAmountsWithSlippage({ ...args, slippageBps: 50 });
    const loose = mintAmountsWithSlippage({ ...args, slippageBps: 500 });
    expect(loose.amount0).toBeLessThan(tight.amount0);
    // amount1 already collapsed to 1 at 50 bps in this asymmetric
    // case — at 500 bps it's also 1. The amount0 monotonicity is what
    // proves the slippage knob is wired through.
    expect(loose.amount1).toBeLessThanOrEqual(tight.amount1);
  });
});
