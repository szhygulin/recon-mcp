import { describe, it, expect } from "vitest";
import { simulateHealthFactorChange } from "../src/modules/positions/aave.js";
import type { LendingPosition } from "../src/types/index.js";

function basePosition(overrides: Partial<LendingPosition> = {}): LendingPosition {
  return {
    protocol: "aave-v3",
    chain: "ethereum",
    collateral: [],
    debt: [],
    totalCollateralUsd: 10_000,
    totalDebtUsd: 5_000,
    netValueUsd: 5_000,
    healthFactor: 1.65,
    liquidationThreshold: 8250, // 82.5%
    ltv: 8000,
    ...overrides,
  };
}

describe("simulateHealthFactorChange", () => {
  it("adding collateral increases HF", () => {
    const base = basePosition();
    const before = (base.totalCollateralUsd * 0.825) / base.totalDebtUsd; // 1.65
    const res = simulateHealthFactorChange(base, "add_collateral", 5_000);
    expect(res.newHealthFactor).toBeGreaterThan(before);
    expect(res.newCollateralUsd).toBe(15_000);
    expect(res.newDebtUsd).toBe(5_000);
    expect(res.safe).toBe(true);
  });

  it("borrowing reduces HF and flips safe to false past the threshold", () => {
    const base = basePosition({ totalCollateralUsd: 1_000, totalDebtUsd: 500 });
    // Borrow enough to push debt past collateral × liqThresh (1000 × 0.825 = 825).
    const res = simulateHealthFactorChange(base, "borrow", 400);
    expect(res.newDebtUsd).toBe(900);
    expect(res.newHealthFactor).toBeLessThan(1);
    expect(res.safe).toBe(false);
  });

  it("repaying all debt yields effectively-infinite HF", () => {
    const base = basePosition({ totalDebtUsd: 1_000 });
    const res = simulateHealthFactorChange(base, "repay", 1_000);
    expect(res.newDebtUsd).toBe(0);
    // The function caps infinity at 1e18.
    expect(res.newHealthFactor).toBe(1e18);
    expect(res.safe).toBe(true);
  });

  it("remove_collateral cannot go below zero", () => {
    const base = basePosition({ totalCollateralUsd: 100, totalDebtUsd: 0 });
    const res = simulateHealthFactorChange(base, "remove_collateral", 500);
    expect(res.newCollateralUsd).toBe(0);
  });

  it("matches Aave math: HF = (collateral × liqThreshold) / debt", () => {
    const base = basePosition({
      totalCollateralUsd: 20_000,
      totalDebtUsd: 8_000,
      liquidationThreshold: 7500, // 75%
    });
    const res = simulateHealthFactorChange(base, "add_collateral", 0);
    const expected = (20_000 * 0.75) / 8_000; // 1.875
    expect(res.newHealthFactor).toBeCloseTo(expected, 3);
  });
});
