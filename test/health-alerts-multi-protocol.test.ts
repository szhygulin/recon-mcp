/**
 * Issue #427: `get_health_alerts` was Aave-V3-only despite the generic
 * name — a wallet with no Aave borrows but active borrows on Compound V3
 * / Morpho Blue / MarginFi / Kamino got `atRisk: []` back, which is
 * false safety reassurance.
 *
 * These tests lock the across-protocol coverage by mocking each
 * underlying reader and asserting the unified `atRisk[]` shape +
 * per-protocol HF math:
 *   - Aave V3: passes through `position.healthFactor`.
 *   - Compound V3: computes `Σ(collat_i × CF_i) / debt` from the
 *     market-info collateral table.
 *   - Morpho Blue: computes `(collat × lltv) / debt` from the position's
 *     `lltv` field.
 *   - MarginFi / Kamino: pass through `position.healthFactor`.
 *
 * Also locks the partial-failure shape (one reader throws → the others
 * still return rows + a `notes[]` line so a "no liquidation risk" answer
 * is never silently wrong).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EVM_WALLET = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";
const SOLANA_WALLET = "8axowbY3iTotwSMr1iHsdxLArm6oNB4mhpYJyHrohYf3";

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockAave(positions: unknown[]) {
  vi.doMock("../src/modules/positions/aave.js", () => ({
    getAaveLendingPosition: vi.fn(async (_w: string, chain: string) => {
      const match = (positions as Array<{ chain: string }>).find(
        (p) => p.chain === chain,
      );
      return match ?? null;
    }),
    simulateHealthFactorChange: vi.fn(),
  }));
}

function mockCompound(positions: unknown[], marketInfos: Record<string, unknown>) {
  vi.doMock("../src/modules/compound/index.js", () => ({
    getCompoundPositions: vi.fn(async () => ({ positions })),
  }));
  vi.doMock("../src/modules/compound/market-info.js", () => ({
    getCompoundMarketInfo: vi.fn(async ({ market }: { market: string }) => {
      const info = marketInfos[market.toLowerCase()];
      if (!info) throw new Error(`no mock market info for ${market}`);
      return info;
    }),
  }));
}

function mockMorpho(positions: unknown[]) {
  vi.doMock("../src/modules/morpho/index.js", () => ({
    getMorphoPositions: vi.fn(async () => ({
      wallet: EVM_WALLET,
      positions,
    })),
  }));
}

function mockSolana(marginfi: unknown[], kamino: unknown[]) {
  // readMarginfiAtRisk + readKaminoAtRisk dynamic-import this module.
  vi.doMock("../src/modules/execution/index.js", () => ({
    getMarginfiPositions: vi.fn(async () => ({ positions: marginfi })),
    getKaminoPositions: vi.fn(async () => ({ positions: kamino })),
  }));
}

describe("getHealthAlerts — multi-protocol coverage (#427)", () => {
  it("returns an Aave row when the position's healthFactor is below threshold", async () => {
    mockAave([
      {
        protocol: "aave-v3",
        chain: "ethereum",
        healthFactor: 1.2,
        totalCollateralUsd: 5000,
        totalDebtUsd: 4000,
      },
    ]);
    mockCompound([], {});
    mockMorpho([]);
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    const r = await getHealthAlerts({ wallet: EVM_WALLET, threshold: 1.5 });
    expect(r.atRisk).toHaveLength(1);
    expect(r.atRisk[0]).toMatchObject({
      protocol: "aave-v3",
      chain: "ethereum",
      market: null,
      healthFactor: 1.2,
      collateralUsd: 5000,
      debtUsd: 4000,
    });
    expect(r.atRisk[0].marginToLiquidation).toBeCloseTo(16.67, 1);
  });

  it("computes a Compound V3 health factor from the market info CF table", async () => {
    // Single collateral asset, CF = 0.85 (1e18-scaled = 8.5e17). Collateral
    // $1000 → liquidationCollateralUsd $850. Debt $700 → HF 850/700 ≈ 1.214.
    const market = "0xc3d688b66703497daa19211eedff47f25384cdc3";
    mockAave([]);
    mockCompound(
      [
        {
          protocol: "compound-v3",
          chain: "ethereum",
          marketAddress: market,
          collateral: [{ token: "0xWETH", valueUsd: 1000 }],
          totalCollateralUsd: 1000,
          totalDebtUsd: 700,
        },
      ],
      {
        [market.toLowerCase()]: {
          collateralAssets: [
            {
              asset: "0xWETH",
              liquidateCollateralFactor: (BigInt(85) * 10n ** 16n).toString(),
            },
          ],
        },
      },
    );
    mockMorpho([]);
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    const r = await getHealthAlerts({ wallet: EVM_WALLET, threshold: 1.5 });
    expect(r.atRisk).toHaveLength(1);
    expect(r.atRisk[0].protocol).toBe("compound-v3");
    expect(r.atRisk[0].market).toBe(market);
    expect(r.atRisk[0].healthFactor).toBeCloseTo(1.2143, 3);
  });

  it("computes a Morpho Blue health factor from lltv on the position", async () => {
    // lltv 0.86 (86% of 1e18). Collateral $2000 × 0.86 = $1720. Debt $1500
    // → HF ≈ 1.1467. Below 1.5 threshold.
    mockAave([]);
    mockCompound([], {});
    mockMorpho([
      {
        protocol: "morpho-blue",
        chain: "ethereum",
        marketId: "0xabc123",
        lltv: (BigInt(86) * 10n ** 16n).toString(),
        totalCollateralUsd: 2000,
        totalDebtUsd: 1500,
      },
    ]);
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    const r = await getHealthAlerts({ wallet: EVM_WALLET, threshold: 1.5 });
    expect(r.atRisk).toHaveLength(1);
    expect(r.atRisk[0].protocol).toBe("morpho-blue");
    expect(r.atRisk[0].market).toBe("0xabc123");
    expect(r.atRisk[0].healthFactor).toBeCloseTo(1.1467, 3);
  });

  it("returns MarginFi + Kamino rows from the precomputed healthFactor", async () => {
    mockSolana(
      [
        {
          protocol: "marginfi",
          chain: "solana",
          marginfiAccount: "Mfi1Account",
          totalSuppliedUsd: 1500,
          totalBorrowedUsd: 1100,
          healthFactor: 1.1,
        },
      ],
      [
        {
          protocol: "kamino",
          chain: "solana",
          obligation: "KamObligationXyz",
          totalSuppliedUsd: 800,
          totalBorrowedUsd: 600,
          healthFactor: 1.05,
        },
      ],
    );
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    const r = await getHealthAlerts({
      solanaWallet: SOLANA_WALLET,
      threshold: 1.5,
    });
    expect(r.atRisk.map((a) => a.protocol).sort()).toEqual(["kamino", "marginfi"]);
    const mfi = r.atRisk.find((a) => a.protocol === "marginfi")!;
    expect(mfi).toMatchObject({
      chain: "solana",
      market: "Mfi1Account",
      healthFactor: 1.1,
      collateralUsd: 1500,
      debtUsd: 1100,
    });
  });

  it("filters out positions at or above the threshold", async () => {
    mockAave([
      {
        protocol: "aave-v3",
        chain: "ethereum",
        healthFactor: 2.5, // safe
        totalCollateralUsd: 10_000,
        totalDebtUsd: 1000,
      },
    ]);
    mockCompound([], {});
    mockMorpho([]);
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    const r = await getHealthAlerts({ wallet: EVM_WALLET, threshold: 1.5 });
    expect(r.atRisk).toEqual([]);
  });

  it("captures partial-reader failures in notes[] without dropping other protocols", async () => {
    mockAave([
      {
        protocol: "aave-v3",
        chain: "ethereum",
        healthFactor: 1.2,
        totalCollateralUsd: 5000,
        totalDebtUsd: 4000,
      },
    ]);
    // Compound reader throws — should not fail the whole call.
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: vi.fn(async () => {
        throw new Error("RPC down");
      }),
    }));
    vi.doMock("../src/modules/compound/market-info.js", () => ({
      getCompoundMarketInfo: vi.fn(),
    }));
    mockMorpho([]);
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    const r = await getHealthAlerts({ wallet: EVM_WALLET, threshold: 1.5 });
    expect(r.atRisk).toHaveLength(1);
    expect(r.atRisk[0].protocol).toBe("aave-v3");
    expect(r.notes).toBeDefined();
    expect(r.notes!.some((n) => /Compound V3/.test(n) && /RPC down/.test(n))).toBe(true);
  });

  it("rejects calls that supply neither wallet nor solanaWallet", async () => {
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    await expect(getHealthAlerts({ threshold: 1.5 })).rejects.toThrow(
      /at least one of/i,
    );
  });

  it("does not call EVM readers when only solanaWallet is provided", async () => {
    const aaveSpy = vi.fn();
    vi.doMock("../src/modules/positions/aave.js", () => ({
      getAaveLendingPosition: aaveSpy,
      simulateHealthFactorChange: vi.fn(),
    }));
    const compoundSpy = vi.fn();
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: compoundSpy,
    }));
    vi.doMock("../src/modules/compound/market-info.js", () => ({
      getCompoundMarketInfo: vi.fn(),
    }));
    const morphoSpy = vi.fn();
    vi.doMock("../src/modules/morpho/index.js", () => ({
      getMorphoPositions: morphoSpy,
    }));
    mockSolana([], []);
    const { getHealthAlerts } = await import("../src/modules/positions/index.js");
    await getHealthAlerts({ solanaWallet: SOLANA_WALLET });
    expect(aaveSpy).not.toHaveBeenCalled();
    expect(compoundSpy).not.toHaveBeenCalled();
    expect(morphoSpy).not.toHaveBeenCalled();
  });
});
